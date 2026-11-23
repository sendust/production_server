"""SDI preview: a CasparCG ffmpeg (STREAM) consumer per playback channel -> RTSP into mediamtx ->
WebRTC (WHEP) in the browser (www/sdi.html).

CasparCG 2.5 ffmpeg consumer facts (verified on nagoya1):
- options are CasparCG style: -format rtsp, -codec:v, -filter:v, -preset:v ... (-f / -vf are not understood)
- '-an' is not supported, and its argument parser takes the NEXT token as the value of any option,
  so an audio stream is always created; the default (16 ch AAC) fails to open. Audio is therefore reduced
  to mono Opus 32k (negligible), and the viewer only receives the video track.
"""
import logging
import time

from .amcp import Amcp, AmcpError
from .engine import Engine

log = logging.getLogger("sdi")

# The consumer gets 59.94 progressive frames (one per field) from the 1080i5994 channel: keeping every
# other one gives 29.97p without combing and without a deinterlacer. Measured CasparCG CPU while ON:
#   fps only, 1920x1080 (NVENC converts BGRA on the GPU)  +330 %   <- default
#   fps + scale 960x540 fast_bilinear                      +420 %
#   yadif + fps + scale 960x540                            +950 %
DEFAULT_ARGS = ("-format rtsp -rtsp_transport tcp -filter:v fps=30000/1001 "
                "-codec:v h264_nvenc -preset:v p1 -tune:v ull -bf:v 0 -g:v 30 -b:v 3M "
                "-filter:a pan=mono|c0=c0 -codec:a libopus -b:a 32k")
RETRY_SEC = 5.0


class SdiPreview:
    def __init__(self, cfg: dict, amcp: Amcp, engine: Engine, players: list):
        self.cfg = cfg["sdi_preview"]
        self.amcp, self.engine, self.players = amcp, engine, players
        self.want: dict[int, str | None] = {p.idx: None for p in players}   # idx -> 'clean'|'osd'|None
        self._last_try: dict[int, float] = {}

    def path(self, idx: int) -> str:
        return f"{self.cfg.get('path_prefix', 'sendust_ch')}{idx}"

    def url(self, idx: int) -> str:
        return f"{self.cfg['rtsp_base'].rstrip('/')}/{self.path(idx)}"

    def _channel(self, p, source: str | None) -> int:
        return p.osd if source == "osd" and p.osd else p.clean

    def _ports(self, ch: int, url: str) -> list[str]:
        outs = self.engine.channels.get(ch, {}).get("outputs", {})
        return [port for port, o in outs.items() if o.get("consumer") == "ffmpeg" and o.get("file/path") == url]

    def state(self, p) -> dict:
        src = self.want.get(p.idx)
        url = self.url(p.idx)
        active_ch = next((c for c in {p.clean, p.osd} if c and self._ports(c, url)), None)
        return {"enabled": src is not None, "source": src, "active": active_ch is not None, "channel": active_ch,
                "path": self.path(p.idx), "webrtc_port": self.cfg.get("webrtc_port", 8889)}

    async def set(self, p, on: bool, source: str | None = None):
        source = source or ("osd" if p.osd else "clean")
        if source not in ("clean", "osd"):
            raise ValueError("source must be clean or osd")
        if source == "osd" and not p.osd:
            raise ValueError("this channel has no OSD output")
        await self._remove_all(p)
        self.want[p.idx] = source if on else None
        self._last_try.pop(p.idx, None)
        if on:
            await self._add(p)
        p.logmsg(f"SDI preview {'ON (' + source + ')' if on else 'OFF'}")

    async def _remove_all(self, p):
        url = self.url(p.idx)
        for ch in {p.clean, p.osd}:
            if not ch:
                continue
            for port in self._ports(ch, url):
                try:
                    await self.amcp.send(f"REMOVE {ch}-{port}")
                except AmcpError as e:
                    log.warning("remove %s-%s: %s", ch, port, e)

    async def _add(self, p):
        ch = self._channel(p, self.want[p.idx])
        args = self.cfg.get("args") or DEFAULT_ARGS
        self._last_try[p.idx] = time.monotonic()
        await self.amcp.send(f"ADD {ch} STREAM {self.url(p.idx)} {args}")
        log.info("SDI preview ch%d -> %s", ch, self.url(p.idx))

    async def ensure(self):
        """Re-add wanted consumers that disappeared (CasparCG restart, consumer error)."""
        if not self.amcp.connected:
            return
        for p in self.players:
            src = self.want.get(p.idx)
            if src is None:
                continue
            st = self.state(p)
            if st["active"] or time.monotonic() - self._last_try.get(p.idx, 0) < RETRY_SEC:
                continue
            try:
                await self._add(p)
            except AmcpError as e:
                log.warning("SDI preview re-add failed: %s", e)
