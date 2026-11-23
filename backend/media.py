"""Media listing and ffprobe analysis (cached by path+mtime+size)."""
import asyncio
import json
import os
import subprocess
from fractions import Fraction
from pathlib import Path

from .config import ROOT

VIDEO_EXT = {".mxf", ".mov", ".mp4", ".m4v", ".mkv", ".ts", ".m2ts", ".mts", ".avi", ".mpg", ".mpeg", ".webm", ".wmv", ".flv", ".dv", ".gxf"}
AUDIO_EXT = {".wav", ".mp2", ".m2a", ".ac3", ".mp3", ".aac", ".m4a", ".flac", ".ogg", ".opus", ".aif", ".aiff", ".wma"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tga", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".exr"}
NOMINAL_FPS = (30000, 1001)

CACHE_FILE = ROOT / "data" / "probe_cache.json"
PROBE_VERSION = 2  # bump when _ffprobe() output changes (invalidates the cache)


def kind_of(name: str) -> str | None:
    ext = os.path.splitext(name)[1].lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in IMAGE_EXT:
        return "image"
    return None


class Media:
    def __init__(self, media_path: str):
        self.root = Path(media_path).resolve()
        self._cache: dict[str, dict] = {}
        self._inflight: dict[str, asyncio.Future] = {}
        try:
            self._cache = json.loads(CACHE_FILE.read_text())
        except (OSError, ValueError):
            pass

    # ---- paths -------------------------------------------------------------
    def abs(self, rel: str) -> Path:
        p = (self.root / rel.lstrip("/")).resolve()
        if p != self.root and self.root not in p.parents:
            raise ValueError("path outside media root")
        return p

    def rel(self, p: str | Path) -> str:
        return str(Path(p).resolve().relative_to(self.root))

    @staticmethod
    def caspar_name(rel: str) -> str:
        """CasparCG resolves clips relative to media-path, without extension."""
        return os.path.splitext(rel)[0].replace("\\", "/")

    def list_dir(self, rel: str = "") -> list[dict]:
        base = self.abs(rel)
        out = []
        with os.scandir(base) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                isdir = e.is_dir()
                k = None if isdir else kind_of(e.name)
                if not isdir and k is None:
                    continue
                out.append({"name": e.name, "dir": isdir, "kind": k, "size": st.st_size, "mtime": int(st.st_mtime),
                            "path": self.rel(e.path)})
        out.sort(key=lambda x: (not x["dir"], x["name"].lower()))
        return out

    # ---- probe -------------------------------------------------------------
    async def probe(self, rel: str) -> dict:
        p = self.abs(rel)
        st = p.stat()
        key = str(p)
        c = self._cache.get(key)
        if c and c.get("_mtime") == int(st.st_mtime) and c.get("_size") == st.st_size and c.get("_v") == PROBE_VERSION:
            return c
        if key in self._inflight:
            return await self._inflight[key]
        fut = asyncio.get_running_loop().create_future()
        self._inflight[key] = fut
        try:
            info = await asyncio.to_thread(_ffprobe, p)
            info["_mtime"], info["_size"], info["_v"] = int(st.st_mtime), st.st_size, PROBE_VERSION
            self._cache[key] = info
            self._save()
            fut.set_result(info)
            return info
        except Exception as e:
            fut.set_exception(e)
            fut.exception()  # mark retrieved
            raise
        finally:
            self._inflight.pop(key, None)

    def _save(self):
        try:
            CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = CACHE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._cache))
            tmp.replace(CACHE_FILE)
        except OSError:
            pass


def _ffprobe(p: Path) -> dict:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(p)],
        capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {r.stderr.strip()[:200]}")
    d = json.loads(r.stdout)
    fmt = d.get("format", {})
    streams = d.get("streams", [])
    kind = kind_of(p.name) or "video"
    v = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    auds = [s for s in streams if s.get("codec_type") == "audio"]
    if kind == "video" and v is None:
        kind = "audio"
    fps = NOMINAL_FPS
    if v and kind == "video":
        try:
            fr = Fraction(v.get("r_frame_rate", "0/1"))
            if fr > 0:
                fps = (fr.numerator, fr.denominator)
        except (ValueError, ZeroDivisionError):
            pass
    duration = float(fmt.get("duration") or (v or {}).get("duration") or 0)
    frames = None
    if v and kind == "video":
        if v.get("nb_frames", "").isdigit():
            frames = int(v["nb_frames"])
        elif str(v.get("duration_ts", "")).isdigit() and Fraction(v.get("time_base", "0/1") or "0/1") == Fraction(fps[1], fps[0]):
            frames = int(v["duration_ts"])
    if frames is None:
        frames = int(round(duration * fps[0] / fps[1])) if kind != "image" else 0
    tc = (fmt.get("tags", {}).get("timecode") or (v or {}).get("tags", {}).get("timecode")
          or next((s.get("tags", {}).get("timecode") for s in streams if s.get("tags", {}).get("timecode")), None))
    return {
        "kind": kind,
        "format": fmt.get("format_name", ""),
        "duration": duration,
        "frames": frames,
        "fps": list(fps),
        "tc_start": tc or "00:00:00:00",
        "drop": bool(tc and ";" in tc) or (tc is None and fps == NOMINAL_FPS),
        "bitrate": int(fmt.get("bit_rate", 0) or 0),
        "start_time": float(fmt.get("start_time") or 0.0),
        "video": None if not v or kind != "video" else {
            "codec": v.get("codec_name"), "profile": v.get("profile"), "width": v.get("width"), "height": v.get("height"),
            "pix_fmt": v.get("pix_fmt"), "field_order": v.get("field_order"),
            "bitrate": int(v.get("bit_rate", 0) or 0),
        },
        "audio": {
            "streams": len(auds),
            "channels": sum(int(a.get("channels", 0) or 0) for a in auds),
            "codec": auds[0].get("codec_name") if auds else None,
            "sample_rate": int(auds[0].get("sample_rate", 0) or 0) if auds else 0,
        },
        "size": p.stat().st_size,
    }
