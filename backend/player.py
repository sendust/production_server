"""One playback channel (PLAY n): drives a CasparCG clean channel/layer, runs its playlist,
and derives UI state from OSC.

Frame units
-----------
API and UI use SOURCE frames (e.g. 29.97 for XDCAM 1080i).  AMCP SEEK/LENGTH/IN/OUT use
CHANNEL frames (1080i5994 -> 59.94/s), so every value goes through _ch().
`out` is exclusive (EDL style): the frame at `out` is not played.  Clip length = out - in.

Playlist play
-------------
When enabled, the next item is LOADBG ... AUTO'ed PRELOAD_SEC before the current one ends, so
CasparCG switches without a gap.  A pause line (or the end of the list without playlist loop)
means nothing is preloaded and the channel holds the last frame.  The switch is detected from
OSC: background was seen loaded, is now empty, and the foreground path is the preloaded file.
"""
import asyncio
import logging
import time
from collections import deque

from .amcp import Amcp, AmcpError, quote
from .engine import Engine
from .media import Media
from .playlist import Playlist

log = logging.getLogger("player")

LOG_SIZE = 200
PRELOAD_SEC = 5.0
LOOP_MODES = ("none", "single", "playlist")


class Player:
    def __init__(self, cfg_ch: dict, layer: int, amcp: Amcp, engine: Engine, media: Media, emit,
                 shared_path: str, image_sec: float):
        self.idx = cfg_ch["channel_index"]
        self.name = cfg_ch["name"]
        self.clean = cfg_ch["clean_out"]
        self.osd = cfg_ch.get("osd_out")
        self.layer = layer
        self.amcp, self.engine, self.media = amcp, engine, media
        self.emit = emit  # async callable(msg)
        self.loaded: dict | None = None  # {file, name, info, in, out, item_id}
        self.logs: deque = deque(maxlen=LOG_SIZE)
        self.loop_mode = "none"
        self.pl = Playlist(self.idx, media, shared_path, image_sec)
        self.preloaded: dict | None = None  # {item_id, file, in, out, key, bg_seen, loaded}
        self._adopting = False
        self._changed_at = 0.0  # monotonic time of our last load/eject; engine sync waits a bit after it
        self._tick_lock = asyncio.Lock()
        # CasparCG reports no position for images (only frames_left while a background is
        # loaded), so image playback time is clocked here: [accumulated_sec, running_since|None]
        self._img_clock = [0.0, None]

    @property
    def addr(self) -> str:
        return f"{self.clean}-{self.layer}"

    # ---- frame helpers -------------------------------------------------------
    def _fps_of(self, loaded: dict | None) -> float:
        f = (loaded or {}).get("info", {}).get("fps") or [30000, 1001]
        return f[0] / f[1]

    def _src_fps(self) -> float:
        return self._fps_of(self.loaded)

    def _chan_fps(self) -> float:
        ch = self.engine.channels.get(self.clean)
        f = ch["fps"] if ch and ch["fps"][0] else [60000, 1001]
        return f[0] / f[1]

    def _ch(self, frame: int, loaded: dict | None = None) -> int:
        return int(round(frame * self._chan_fps() / self._fps_of(loaded or self.loaded)))

    def _length(self) -> int:
        return int((self.loaded or {}).get("info", {}).get("frames") or 0)

    def _is_image(self) -> bool:
        return bool(self.loaded) and self.loaded["info"]["kind"] == "image"

    # ---- logging / events ------------------------------------------------------
    def logmsg(self, msg: str, level: str = "info"):
        e = {"t": time.time(), "level": level, "msg": msg}
        self.logs.append(e)
        getattr(log, "warning" if level == "error" else "info")("[%s] %s", self.name, msg)
        asyncio.get_running_loop().create_task(self.emit({"type": "log", "ch": self.idx, "entry": e}))

    def pl_changed(self):
        asyncio.get_running_loop().create_task(self.emit({"type": "playlist", "ch": self.idx,
                                                          "playlist": self.pl.view()}))

    async def _send(self, cmd: str) -> list[str]:
        try:
            return await self.amcp.send(cmd)
        except AmcpError as e:
            self.logmsg(f"AMCP error: {e.text or e}", "error")
            raise

    # ---- state ---------------------------------------------------------------
    def fg(self) -> dict:
        return self.engine.layer_fg(self.clean, self.layer)

    def position(self) -> int | None:
        if not self.loaded:
            return None
        fg = self.fg()
        t = fg.get("time")
        if t:
            return int(round(t[0] * self._src_fps()))
        if self._is_image():
            fl = fg.get("frames_left")
            if isinstance(fl, int) and fl >= 0:
                return max(0, self.loaded["out"] - int(round(fl * self._src_fps() / self._chan_fps())))
            acc, since = self._img_clock
            sec = acc + (time.monotonic() - since if since else 0)
            return min(self.loaded["out"] - 1, int(sec * self._src_fps()))
        return None

    def _img_run(self, running: bool, reset: bool = False):
        acc, since = self._img_clock
        now = time.monotonic()
        if reset:
            acc, since = 0.0, None
        elif since:
            acc += now - since
            since = None
        self._img_clock = [acc, now if running else None]

    def status(self) -> str:
        fg = self.fg()
        if not self.loaded or not fg or fg.get("producer") in (None, "empty"):
            return "empty" if not self.loaded else "loading"
        pos = self.position()
        # CasparCG holds the last frame at the end of LENGTH with paused=False
        if pos is not None and pos >= self.loaded["out"] - 1 and not fg.get("loop") and not fg.get("paused"):
            return "ended"
        return "paused" if fg.get("paused") else "playing"

    def snapshot(self) -> dict:
        fg = self.fg()
        osc_out = self.engine.channels.get(self.clean, {}).get("outputs", {})
        decklinks = [o.get("decklink/index") for o in osc_out.values() if o.get("consumer") == "decklink"]
        osd_dl = []
        if self.osd:
            osd_dl = [o.get("decklink/index") for o in self.engine.channels.get(self.osd, {}).get("outputs", {}).values()
                      if o.get("consumer") == "decklink"]
        return dict(
            idx=self.idx, name=self.name, clean=self.clean, osd=self.osd, layer=self.layer,
            decklink=decklinks, osd_decklink=osd_dl,
            loaded=self.loaded, status=self.status(), pos=self.position(),
            loop=bool(fg.get("loop")), paused=bool(fg.get("paused")), loop_mode=self.loop_mode,
            preloaded=self.preloaded["item_id"] if self.preloaded else None,
            t=time.time(),
        )

    # ---- tick: engine sync, auto-switch detection, preload ------------------------
    async def on_tick(self):
        if self._tick_lock.locked():
            return
        async with self._tick_lock:
            try:
                await self._detect_switch()
                await self._preload()
                await self._sync_with_engine()
            except AmcpError:
                pass

    async def _detect_switch(self):
        pre = self.preloaded
        if not pre:
            return
        fg, bg = self.engine.layer(self.clean, self.layer)
        if bg.get("producer") not in (None, "empty"):
            pre["bg_seen"] = True
            return
        path = fg.get("path")
        if pre.get("bg_seen") and isinstance(path, str) and path.endswith(pre["file"]):
            self.loaded = pre["loaded"]
            self._img_run(True, reset=True)
            self.preloaded = None
            self._changed_at = time.monotonic()
            self.pl.current_id = pre["item_id"]
            self.pl.changed()
            self.pl_changed()
            i = self.pl.index(pre["item_id"])
            self.logmsg(f"AUTO → #{i + 1} {self.loaded['name']}")

    def _wanted_next(self) -> dict | None:
        if not self.pl.enabled or self.loop_mode == "single" or not self.loaded:
            return None
        cur = self.loaded.get("item_id")
        if not cur or self.pl.index(cur) < 0:
            return None
        return self.pl.next_clip(cur, wrap=self.loop_mode == "playlist")

    async def _preload(self):
        nxt = self._wanted_next()
        pre = self.preloaded
        key = (nxt["id"], nxt["file"], nxt["in"], nxt["out"]) if nxt else None
        if pre and pre["key"] != key:
            # list/marks/mode changed after preloading: drop the background
            self.preloaded = None
            await self._send(f"LOADBG {self.addr} EMPTY")
            self.logmsg("preload cancelled")
            return
        if pre or not nxt or self.status() != "playing":
            return
        pos = self.position()
        if pos is None:
            return
        remaining = (self.loaded["out"] - pos) / self._src_fps()
        if remaining > PRELOAD_SEC:
            return
        loaded = await self._loaded_from_item(nxt)
        await self._send(f"LOADBG {self.addr} {self._clip_args(loaded)} AUTO")
        self.preloaded = {"item_id": nxt["id"], "file": nxt["file"], "key": key, "bg_seen": False, "loaded": loaded}
        self.logmsg(f"preload #{self.pl.index(nxt['id']) + 1} {nxt['name']}")

    async def _sync_with_engine(self):
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
            self.preloaded = None
            return
        if self.loaded and isinstance(path, str) and not path.endswith(self.loaded["file"]):
            self.loaded = None  # different clip was loaded externally -> adopt it below
            self.preloaded = None
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
            cur = self.pl.get(self.pl.current_id)
            item_id = cur["id"] if cur and cur["file"] == rel else None
            self.loaded = {"file": rel, "name": rel.rsplit("/", 1)[-1], "info": info, "in": fin, "out": fout,
                           "item_id": item_id}
            self.logmsg(f"synced with engine: {rel}")
        except (ValueError, OSError, RuntimeError) as e:
            log.warning("adopt failed: %s", e)
        finally:
            self._adopting = False

    # ---- load helpers -----------------------------------------------------------
    async def _make_loaded(self, file: str, fin: int | None, fout: int | None, item_id: str | None = None) -> dict:
        info = await self.media.probe(file)
        fps = info["fps"][0] / info["fps"][1]
        if info["kind"] == "image":
            n = int(round(self.pl.image_sec * fps))
            fin, fout = 0, int(fout) if fout else n
        else:
            n = info["frames"]
            fin = max(0, min(int(fin or 0), max(0, n - 1))) if n else 0
            fout = int(fout) if fout else n
            if n:
                fout = max(fin + 1, min(fout, n))
        return {"file": file, "name": file.rsplit("/", 1)[-1], "info": info, "in": fin, "out": fout, "item_id": item_id}

    async def _loaded_from_item(self, it: dict) -> dict:
        return await self._make_loaded(it["file"], it["in"], it["out"], it["id"])

    def _clip_args(self, ld: dict, loop: bool = False) -> str:
        name = quote(self.media.caspar_name(ld["file"]))
        if ld["info"]["kind"] == "image":
            return f"{name} LENGTH {self._ch(ld['out'] - ld['in'], ld)}"
        if not ld["info"]["frames"]:
            return name
        a = f"{name} SEEK {self._ch(ld['in'], ld)} LENGTH {self._ch(ld['out'] - ld['in'], ld)}"
        return a + (" LOOP" if loop else "")

    async def _do_load(self, ld: dict, play: bool):
        prev = self.loaded
        self._changed_at = time.monotonic()
        self.loaded = ld
        self._img_run(play, reset=True)
        self.preloaded = None  # LOAD/PLAY with a clip also replaces the background
        try:
            await self._send(f"{'PLAY' if play else 'LOAD'} {self.addr} "
                             f"{self._clip_args(ld, loop=self.loop_mode == 'single')}")
        except AmcpError:
            self.loaded = prev
            raise

    # ---- commands ----------------------------------------------------------------
    async def load(self, file: str, fin: int | None = None, fout: int | None = None, play: bool = False):
        ld = await self._make_loaded(file, fin, fout)
        await self._do_load(ld, play)
        self.logmsg(f"{'PLAY' if play else 'LOAD'} {file}  in {ld['in']} out {ld['out']}")

    async def cue(self, item_id: str, play: bool = False):
        it = self.pl.get(item_id)
        if not it or it["type"] != "clip":
            raise ValueError("not a clip item")
        if it.get("missing"):
            raise ValueError(f"missing clip: {it['file']}")
        await self._do_load(await self._loaded_from_item(it), play)
        self.pl.current_id = it["id"]
        self.pl.changed()
        self.pl_changed()
        self.logmsg(f"{'PLAY' if play else 'LOAD'} #{self.pl.index(it['id']) + 1} {it['name']}")

    async def play(self):
        st = self.status()
        if not self.loaded:
            # nothing loaded: start the selected/current playlist item
            cur = self.pl.get(self.pl.current_id) or self.pl.next_clip(None, wrap=False, skip_pause=True)
            if cur and cur["type"] == "clip":
                await self.cue(cur["id"], play=True)
            return
        if st == "ended" and self.pl.enabled and self.loaded.get("item_id") and self.loop_mode != "single":
            # stopped at a pause line / end of list: PLAY continues with the next clip
            nxt = self.pl.next_clip(self.loaded["item_id"], wrap=self.loop_mode == "playlist", skip_pause=True)
            if nxt:
                await self.cue(nxt["id"], play=True)
                return
        pos = self.position()
        # CasparCG keeps playing past OUT if resumed from outside [in, out-1)
        if st == "ended" or (pos is not None and self._length() and
                             not self.loaded["in"] <= pos < self.loaded["out"] - 1):
            await self.seek(self.loaded["in"])
            if self._is_image():
                # image LENGTH has run out: restart it (RESUME alone does not re-arm LENGTH)
                await self._do_load(self.loaded, play=True)
                self.logmsg("PLAY")
                return
        await self._send(f"RESUME {self.addr}")
        self._img_run(True)
        self.logmsg("PLAY")

    async def pause(self):
        if self.loaded:
            await self._send(f"PAUSE {self.addr}")
            self._img_run(False)
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
            self._img_run(False)
        await self.seek(pos + int(delta))

    async def top(self):
        if self.loaded:
            await self.seek(self.loaded["in"])
            self.logmsg("GOTO TOP")

    async def load_next(self, direction: int = 1):
        """LOAD NEXT / PREVIOUS CLIP (cue only, does not play)."""
        cur = (self.loaded or {}).get("item_id") or self.pl.current_id
        it = (self.pl.next_clip(cur, wrap=self.loop_mode == "playlist", skip_pause=True) if direction > 0
              else self.pl.prev_clip(cur))
        if not it:
            self.logmsg("no next clip" if direction > 0 else "no previous clip")
            return
        await self.cue(it["id"])

    async def set_marks(self, fin: int | None = None, fout: int | None = None):
        """Change in/out of the loaded clip live (CALL IN/OUT) and of its playlist item."""
        if not self.loaded:
            return
        n = self._length() if not self._is_image() else 10 ** 9
        if not n:
            return
        a = self.loaded["in"] if fin is None else max(0, min(int(fin), n - 1))
        b = self.loaded["out"] if fout is None else max(1, min(int(fout), n))
        if b <= a:  # new mark crossed the other one -> reset the other side
            if fin is not None:
                b = self._length() if not self._is_image() else a + int(self.pl.image_sec * self._src_fps())
            else:
                a = 0
        self.loaded["in"], self.loaded["out"] = a, b
        if not self._is_image():
            await self._send(f"CALL {self.addr} IN {self._ch(a)}")
            await self._send(f"CALL {self.addr} OUT {self._ch(b)}")
        if self.loaded.get("item_id") and self.pl.set_marks(self.loaded["item_id"], a, b):
            self.pl_changed()
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
        if self.loaded and not self._is_image():
            await self.set_marks(0, self._length())

    async def set_loop_mode(self, mode: str):
        if mode not in LOOP_MODES:
            raise ValueError(f"bad loop mode {mode}")
        self.loop_mode = mode
        if self.loaded and not self._is_image():
            await self._send(f"CALL {self.addr} LOOP {1 if mode == 'single' else 0}")
        self.logmsg(f"LOOP {mode}")

    async def eject(self):
        await self._send(f"CLEAR {self.addr}")
        self._changed_at = time.monotonic()
        self.loaded = None
        self.preloaded = None
        self.logmsg("EJECT")

    # ---- playlist edits -----------------------------------------------------------
    async def pl_cmd(self, op: str, b) -> dict:
        pl = self.pl
        res: dict = {}
        if op == "add":
            if not b.files:
                raise ValueError("files required")
            new = await pl.add(b.files, b.at)
            self.logmsg(f"playlist + {len(new)} clip(s)")
        elif op == "pause":
            pl.add_pause(b.at)
        elif op == "move":
            pl.move(b.ids or [], b.at if b.at is not None else len(pl.items))
        elif op == "delete":
            ids = b.ids or []
            if self.preloaded and self.preloaded["item_id"] in ids:
                pass  # _preload() notices the key change and drops the background
            pl.delete(ids)
        elif op == "clear":
            pl.clear()
            self.logmsg("playlist cleared")
        elif op == "enable":
            pl.enabled = bool(b.on)
            pl.changed()
            self.logmsg(f"playlist play {'ON' if pl.enabled else 'OFF'}")
        elif op == "marks":
            it = pl.set_marks(b.id, b.fin, b.fout)
            if it is None:
                raise ValueError("no such clip item")
            if self.loaded and self.loaded.get("item_id") == b.id:
                await self.set_marks(it["in"], it["out"])
        elif op == "slot":
            pl.select_slot(b.slot)
        elif op == "save":
            pl.save(b.slot)
            self.logmsg(f"playlist saved to slot {pl.slot}")
        elif op == "load":
            missing = await pl.load(b.slot)
            res["missing"] = missing
            self.logmsg(f"playlist loaded from slot {pl.slot}" + (f" ({missing} missing)" if missing else ""),
                        "error" if missing else "info")
        elif op == "cue":
            await self.cue(b.id, play=bool(b.on))
        else:
            raise ValueError(f"unknown playlist op {op}")
        self.pl_changed()
        res["playlist"] = pl.view()
        return res
