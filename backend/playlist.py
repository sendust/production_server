"""Playlist data for one playback channel + slot storage.

Slots: '1'..'9' are local to this host (data/playlists/slot_N.json),
       'A'..'D' are shared between hosts (<shared_playlist_path>/sendust_playlist_X.json).
Saved files reference clips by path relative to the CasparCG media path, so another host with
the same media resolves them; missing clips are kept and flagged.
"""
import json
import os
import socket
import time
import uuid
from pathlib import Path

from .config import ROOT
from .media import Media

DATA = ROOT / "data" / "playlists"
LOCAL_SLOTS = [str(i) for i in range(1, 10)]
SHARED_SLOTS = ["A", "B", "C", "D"]
SLOTS = LOCAL_SLOTS + SHARED_SLOTS
DEFAULT_IMAGE_SEC = 10


def _new_id() -> str:
    return uuid.uuid4().hex[:10]


def _atomic_write(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    tmp.replace(path)


class Playlist:
    def __init__(self, ch_idx: int, media: Media, shared_path: str, image_sec: float = DEFAULT_IMAGE_SEC):
        self.ch = ch_idx
        self.media = media
        self.shared = Path(shared_path)
        self.image_sec = image_sec
        self.items: list[dict] = []
        self.enabled = False
        self.slot = "1"
        self.current_id: str | None = None
        self.version = 0
        self._state_file = DATA / f"ch{ch_idx}_current.json"
        self._restore()

    # ---- persistence of the working list -----------------------------------
    def _restore(self):
        try:
            d = json.loads(self._state_file.read_text())
            self.items = d.get("items", [])
            self.enabled = bool(d.get("enabled", False))
            self.slot = d.get("slot", "1") if d.get("slot") in SLOTS else "1"
            self.current_id = d.get("current_id")
        except (OSError, ValueError):
            pass

    def changed(self):
        self.version += 1
        try:
            _atomic_write(self._state_file, {"items": self.items, "enabled": self.enabled, "slot": self.slot,
                                             "current_id": self.current_id})
        except OSError:
            pass

    def view(self) -> dict:
        return {"ch": self.ch, "items": self.items, "enabled": self.enabled, "slot": self.slot,
                "current_id": self.current_id, "version": self.version, "slots": self.slot_info()}

    # ---- lookup -------------------------------------------------------------
    def index(self, item_id: str | None) -> int:
        for i, it in enumerate(self.items):
            if it["id"] == item_id:
                return i
        return -1

    def get(self, item_id: str | None) -> dict | None:
        i = self.index(item_id)
        return self.items[i] if i >= 0 else None

    def next_clip(self, item_id: str | None, wrap: bool, skip_pause: bool = False) -> dict | None:
        """Item that follows item_id. A pause line stops continuous play (returns None) unless
        skip_pause. Missing clips are skipped."""
        n = len(self.items)
        if not n:
            return None
        start = self.index(item_id)
        for step in range(1, n + 1):
            j = start + step
            if j >= n:
                if not wrap:
                    return None
                j %= n
            it = self.items[j]
            if it["type"] == "pause":
                if skip_pause:
                    continue
                return None
            if not it.get("missing"):
                return it
        return None

    def prev_clip(self, item_id: str | None) -> dict | None:
        i = self.index(item_id)
        for j in range(i - 1 if i >= 0 else len(self.items) - 1, -1, -1):
            it = self.items[j]
            if it["type"] == "clip" and not it.get("missing"):
                return it
        return None

    # ---- edits --------------------------------------------------------------
    async def make_item(self, file: str, fin: int | None = None, fout: int | None = None) -> dict:
        info = await self.media.probe(file)
        fps = info["fps"]
        if info["kind"] == "image":
            frames = int(round(self.image_sec * fps[0] / fps[1]))
            a, b = 0, int(fout) if fout else frames
        else:
            frames = info["frames"]
            a = max(0, min(int(fin or 0), max(0, frames - 1)))
            b = int(fout) if fout else frames
            b = max(a + 1, min(b, frames)) if frames else b
        return {
            "id": _new_id(), "type": "clip", "file": file, "name": file.rsplit("/", 1)[-1],
            "kind": info["kind"], "frames": frames, "fps": fps, "drop": info["drop"], "tc_start": info["tc_start"],
            "audio_ch": info["audio"]["channels"], "in": a, "out": b, "missing": False,
        }

    async def add(self, files: list[str], at: int | None = None) -> list[dict]:
        new = [await self.make_item(f) for f in files]
        pos = len(self.items) if at is None or at < 0 or at > len(self.items) else at
        self.items[pos:pos] = new
        self.changed()
        return new

    def add_pause(self, at: int | None = None) -> dict:
        it = {"id": _new_id(), "type": "pause", "name": "── PAUSE ──"}
        pos = len(self.items) if at is None or at < 0 or at > len(self.items) else at
        self.items.insert(pos, it)
        self.changed()
        return it

    def move(self, ids: list[str], to: int):
        """Move items (keeping their order) so the first lands at index `to` of the original list."""
        moving = [it for it in self.items if it["id"] in ids]
        if not moving:
            return
        before = sum(1 for it in self.items[:max(0, to)] if it["id"] in ids)
        rest = [it for it in self.items if it["id"] not in ids]
        pos = max(0, min(len(rest), to - before))
        rest[pos:pos] = moving
        self.items = rest
        self.changed()

    def delete(self, ids: list[str]):
        self.items = [it for it in self.items if it["id"] not in ids]
        self.changed()

    def clear(self):
        self.items = []
        self.current_id = None
        self.changed()

    def set_marks(self, item_id: str, fin: int | None, fout: int | None) -> dict | None:
        it = self.get(item_id)
        if not it or it["type"] != "clip":
            return None
        n = it["frames"] if it["kind"] != "image" else None
        a = it["in"] if fin is None else max(0, int(fin))
        b = it["out"] if fout is None else int(fout)
        if n:
            a = min(a, n - 1)
            b = max(a + 1, min(b, n))
        else:
            b = max(a + 1, b)
        if (a, b) != (it["in"], it["out"]):
            it["in"], it["out"] = a, b
            self.changed()
        return it

    # ---- slots --------------------------------------------------------------
    def slot_path(self, slot: str) -> Path:
        if slot in LOCAL_SLOTS:
            return DATA / f"slot_{slot}.json"
        if slot in SHARED_SLOTS:
            return self.shared / f"sendust_playlist_{slot}.json"
        raise ValueError(f"bad slot {slot}")

    def slot_info(self) -> dict:
        out = {}
        for s in SLOTS:
            try:
                p = self.slot_path(s)
                st = p.stat()
                out[s] = {"mtime": int(st.st_mtime)}
            except (OSError, ValueError):
                out[s] = None
        return out

    def select_slot(self, slot: str):
        if slot not in SLOTS:
            raise ValueError(f"bad slot {slot}")
        self.slot = slot
        self.changed()

    def save(self, slot: str | None = None):
        slot = slot or self.slot
        data = {
            "format": "sendust_playlist/1", "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "host": socket.gethostname(), "media_path": str(self.media.root),
            "items": [{"type": "pause"} if it["type"] == "pause" else
                      {"type": "clip", "file": it["file"], "in": it["in"], "out": it["out"]} for it in self.items],
        }
        _atomic_write(self.slot_path(slot), data)
        self.slot = slot
        self.changed()

    async def load(self, slot: str | None = None) -> int:
        slot = slot or self.slot
        d = json.loads(self.slot_path(slot).read_text())
        items, missing = [], 0
        for e in d.get("items", []):
            if e.get("type") == "pause":
                items.append({"id": _new_id(), "type": "pause", "name": "── PAUSE ──"})
                continue
            try:
                items.append(await self.make_item(e["file"], e.get("in"), e.get("out")))
            except (OSError, ValueError, RuntimeError):
                missing += 1
                items.append({"id": _new_id(), "type": "clip", "file": e["file"], "name": os.path.basename(e["file"]),
                              "kind": "missing", "frames": 0, "fps": [30000, 1001], "drop": True,
                              "tc_start": "00:00:00;00", "audio_ch": 0, "in": e.get("in", 0), "out": e.get("out", 0),
                              "missing": True})
        self.items = items
        self.slot = slot
        self.current_id = None
        self.changed()
        return missing
