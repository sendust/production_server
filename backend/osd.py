"""OSD channel manager.

For every playback channel with `osd_out`, the OSD CasparCG channel carries
  layer osd_route_layer  : route://<clean channel>         (clean video + audio)
  layer osd_overlay_layer: [HTML] http://127.0.0.1:<port>/osd.html?ch=<idx>   (TC + filename)
The backend computes the TC/filename text and pushes it to the page over SSE /sse/osd (main.py);
the page only displays it.  ensure() is called periodically and
re-creates missing layers, e.g. after a CasparCG restart.
"""
import logging
import time

from .amcp import Amcp, AmcpError, quote
from .engine import Engine

log = logging.getLogger("osd")
RETRY_SEC = 5.0


class Osd:
    def __init__(self, cfg: dict, amcp: Amcp, engine: Engine, players: list, http_port: int):
        self.cfg = cfg
        self.amcp, self.engine, self.players = amcp, engine, players
        self.route_layer = cfg["casparcg"]["osd_route_layer"]
        self.overlay_layer = cfg["casparcg"]["osd_overlay_layer"]
        self.port = http_port
        self._last_try: dict[tuple, float] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.cfg["osd"].get("enabled", True))

    def url(self, idx: int) -> str:
        return f"http://127.0.0.1:{self.port}/osd.html?ch={idx}"

    def state(self, p) -> dict:
        if not p.osd:
            return {"configured": False}
        rfg, _ = self.engine.layer(p.osd, self.route_layer)
        ofg, _ = self.engine.layer(p.osd, self.overlay_layer)
        return {
            "configured": True, "enabled": self.enabled,
            "route": rfg.get("producer") == "route" and rfg.get("route/channel") == p.clean,
            "overlay": ofg.get("producer") == "html" and ofg.get("path") == self.url(p.idx),
        }

    async def ensure(self):
        if not self.enabled or not self.amcp.connected:
            return
        for p in self.players:
            if not p.osd:
                continue
            ch = self.engine.channels.get(p.osd)
            if not ch or not self.engine.snapshot()["channels"].get(p.osd, {}).get("alive"):
                continue  # OSC not reporting this channel yet
            st = self.state(p)
            if not st["route"]:
                await self._play(p.osd, self.route_layer, f"route://{p.clean}")
            if not st["overlay"]:
                await self._play(p.osd, self.overlay_layer, f"[HTML] {quote(self.url(p.idx))}")

    async def _play(self, ch: int, layer: int, what: str):
        key = (ch, layer)
        now = time.monotonic()
        if now - self._last_try.get(key, 0) < RETRY_SEC:
            return
        self._last_try[key] = now
        try:
            await self.amcp.send(f"PLAY {ch}-{layer} {what}")
            log.info("OSD ch%d-%d <- %s", ch, layer, what)
        except AmcpError as e:
            log.warning("OSD ch%d-%d failed: %s", ch, layer, e)
