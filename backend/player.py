"""One playback channel (PLAY n): drives a CasparCG clean channel/layer and derives UI state from OSC.

Frame units
-----------
API and UI use SOURCE frames (e.g. 29.97 for XDCAM 1080i).  AMCP SEEK/LENGTH/IN/OUT use
CHANNEL frames (1080i5994 -> 59.94/s), so every value goes through _ch().
`out` is exclusive (EDL style): the frame at `out` is not played.  Clip length = out - in.
"""
import asyncio
import logging
import time
from collections import deque

from .amcp import Amcp, AmcpError, quote
from .engine import Engine
from .media import Media

log = logging.getLogger("player")

LOG_SIZE = 200


class Player:
    def __init__(self, cfg_ch: dict, layer: int, amcp: Amcp, engine: Engine, media: Media, emit):
        self.idx = cfg_ch["channel_index"]
        self.name = cfg_ch["name"]
        self.clean = cfg_ch["clean_out"]
        self.osd = cfg_ch.get("osd_out")
        self.layer = layer
        self.amcp, self.engine, self.media = amcp, engine, media
        self.emit = emit  # async callable(msg)
        self.loaded: dict | None = None  # {file, name, info, in, out}
        self.logs: deque = deque(maxlen=LOG_SIZE)
        self.loop_mode = "none"  # none | single | playlist
        self._adopting = False
        self._changed_at = 0.0  # monotonic time of our last load/eject; engine sync waits a bit after it

    @property
    def addr(self) -> str:
        return f"{self.clean}-{self.layer}"

    # ---- frame helpers -------------------------------------------------------
    def _src_fps(self) -> float:
        f = (self.loaded or {}).get("info", {}).get("fps") or [30000, 1001]
        return f[0] / f[1]

    def _chan_fps(self) -> float:
        ch = self.engine.channels.get(self.clean)
        f = ch["fps"] if ch and ch["fps"][0] else [60000, 1001]
        return f[0] / f[1]

    def _ch(self, frame: int) -> int:
        return int(round(frame * self._chan_fps() / self._src_fps()))

    def _length(self) -> int:
        return int((self.loaded or {}).get("info", {}).get("frames") or 0)

    # ---- logging -------------------------------------------------------------
    def logmsg(self, msg: str, level: str = "info"):
        e = {"t": time.time(), "level": level, "msg": msg}
        self.logs.append(e)
        getattr(log, "warning" if level == "error" else "info")("[%s] %s", self.name, msg)
        asyncio.get_running_loop().create_task(self.emit({"type": "log", "ch": self.idx, "entry": e}))

    async def _send(self, cmd: str) -> list[str]:
        try:
            return await self.amcp.send(cmd)
        except AmcpError as e:
            self.logmsg(f"AMCP error: {e.text or e}", "error")
            raise

    # ---- state -----------------------------------------------------------
    def fg(self) -> dict:
        return self.engine.layer_fg(self.clean, self.layer)

    def position(self) -> int | None:
        t = self.fg().get("time")
        if not t or not self.loaded:
            return None
        return int(round(t[0] * self._src_fps()))

    def status(self) -> str:
        fg = self.fg()
        if not self.loaded or not fg or fg.get("producer") in (None, "empty"):
            return "empty" if not self.loaded else "loading"
        if self.loaded["info"]["kind"] == "image":
            return "paused" if fg.get("paused") else "playing"
        pos = self.position()
        # CasparCG holds the last frame at the end of LENGTH with paused=False
        if pos is not None and pos >= self.loaded["out"] - 1 and not fg.get("loop") and not fg.get("paused"):
            return "ended"
        return "paused" if fg.get("paused") else "playing"

    def snapshot(self) -> dict:
        fg = self.fg()
        out = {}
        osc_out = self.engine.channels.get(self.clean, {}).get("outputs", {})
        decklinks = [o.get("decklink/index") for o in osc_out.values() if o.get("consumer") == "decklink"]
        osd_dl = []
        if self.osd:
            osd_dl = [o.get("decklink/index") for o in self.engine.channels.get(self.osd, {}).get("outputs", {}).values()
                      if o.get("consumer") == "decklink"]
        out.update(
            idx=self.idx, name=self.name, clean=self.clean, osd=self.osd, layer=self.layer,
            decklink=decklinks, osd_decklink=osd_dl,
            loaded=self.loaded, status=self.status(), pos=self.position(),
            loop=bool(fg.get("loop")), paused=bool(fg.get("paused")), loop_mode=self.loop_mode,
            t=time.time(),
        )
        return out

    async def sync_with_engine(self):
        """Keep `loaded` consistent with CasparCG when the layer was changed outside this player
        (backend restart, another AMCP client). Skipped for 1.5 s after our own load/eject so
        stale OSC (layers linger STALE seconds) is not mistaken for a new clip."""
        if self._adopting or time.monotonic() - self._changed_at < 1.5:
            return
        fg = self.fg()
        path = fg.get("path")
        if self.loaded and (not fg or fg.get("producer") in (None, "empty")):
            self.logmsg("layer cleared outside this player")
            self.loaded = None
            return
        if self.loaded and isinstance(path, str) and not path.endswith(self.loaded["file"]):
            self.loaded = None  # different clip was loaded externally -> adopt it below
        if self.loaded or not path or not isinstance(path, str):
            return
        self._adopting = True
        try:
            rel = self.media.rel(path)
            info = await self.media.probe(rel)
            clip = fg.get("clip") or [0, info["duration"]]
            fps = info["fps"][0] / info["fps"][1]
            fin = int(round(clip[0] * fps))
            fout = min(info["frames"], fin + int(round(clip[1] * fps))) if clip[1] else info["frames"]
            self.loaded = {"file": rel, "name": fg.get("name") or rel, "info": info, "in": fin, "out": fout}
            self.logmsg(f"synced with engine: {rel}")
        except (ValueError, OSError, RuntimeError) as e:
            log.warning("adopt failed: %s", e)
        finally:
            self._adopting = False

    # ---- commands ----------------------------------------------------------
    async def load(self, file: str, fin: int | None = None, fout: int | None = None, play: bool = False):
        info = await self.media.probe(file)
        n = info["frames"]
        fin = max(0, min(int(fin or 0), max(0, n - 1))) if n else 0
        fout = int(fout) if fout else n
        if n:
            fout = max(fin + 1, min(fout, n))
        prev = self.loaded
        self._changed_at = time.monotonic()
        self.loaded = {"file": file, "name": file.rsplit("/", 1)[-1], "info": info, "in": fin, "out": fout}
        cmd = "PLAY" if play else "LOAD"
        args = ""
        if info["kind"] != "image" and n:
            args = f" SEEK {self._ch(fin)} LENGTH {self._ch(fout - fin)}"
            if self.loop_mode == "single":
                args += " LOOP"
        try:
            await self._send(f"{cmd} {self.addr} {quote(self.media.caspar_name(file))}{args}")
        except AmcpError:
            self.loaded = prev
            raise
        self.logmsg(f"{'PLAY' if play else 'LOAD'} {file}  in {fin} out {fout}")

    async def play(self):
        st = self.status()
        if not self.loaded:
            return
        pos = self.position()
        # CasparCG keeps playing past OUT if resumed from outside [in, out-1)
        if st == "ended" or (pos is not None and self._length() and
                             not self.loaded["in"] <= pos < self.loaded["out"] - 1):
            await self.seek(self.loaded["in"])
        await self._send(f"RESUME {self.addr}")
        self.logmsg("PLAY")

    async def pause(self):
        if self.loaded:
            await self._send(f"PAUSE {self.addr}")
            self.logmsg("PAUSE")

    async def toggle(self):
        await (self.pause() if self.status() == "playing" else self.play())

    async def seek(self, frame: int):
        if not self.loaded or not self._length():
            return
        frame = max(self.loaded["in"], min(int(frame), self.loaded["out"] - 1))
        await self._send(f"CALL {self.addr} SEEK {self._ch(frame)}")

    async def step(self, delta: int):
        pos = self.position()
        if pos is None:
            return
        if self.status() == "playing":
            await self._send(f"PAUSE {self.addr}")
        await self.seek(pos + int(delta))

    async def top(self):
        if self.loaded:
            await self.seek(self.loaded["in"])
            self.logmsg("GOTO TOP")

    async def set_marks(self, fin: int | None = None, fout: int | None = None):
        """Change in/out of the loaded clip live (CALL IN/OUT)."""
        if not self.loaded or not self._length():
            return
        n = self._length()
        a = self.loaded["in"] if fin is None else max(0, min(int(fin), n - 1))
        b = self.loaded["out"] if fout is None else max(1, min(int(fout), n))
        if b <= a:  # new mark crossed the other one -> reset the other side
            if fin is not None:
                b = n
            else:
                a = 0
        self.loaded["in"], self.loaded["out"] = a, b
        await self._send(f"CALL {self.addr} IN {self._ch(a)}")
        await self._send(f"CALL {self.addr} OUT {self._ch(b)}")
        self.logmsg(f"MARK in {a} out {b}")

    async def mark_in(self, frame: int | None = None):
        f = self.position() if frame is None else frame
        if f is not None:
            await self.set_marks(fin=f)

    async def mark_out(self, frame: int | None = None):
        f = self.position() if frame is None else frame
        if f is not None:
            await self.set_marks(fout=f)

    async def clear_marks(self):
        if self.loaded:
            await self.set_marks(0, self._length())

    async def set_loop_mode(self, mode: str):
        if mode not in ("none", "single", "playlist"):
            raise ValueError(f"bad loop mode {mode}")
        self.loop_mode = mode
        if self.loaded and self.loaded["info"]["kind"] != "image":
            await self._send(f"CALL {self.addr} LOOP {1 if mode == 'single' else 0}")
        self.logmsg(f"LOOP {mode}")

    async def eject(self):
        await self._send(f"CLEAR {self.addr}")
        self._changed_at = time.monotonic()
        self.loaded = None
        self.logmsg("EJECT")
