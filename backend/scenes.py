"""Scene-change score + audio peak of every frame around a position (skill: playhead-scene-audio-strip).

Frame k here = SOURCE frame k of the file, i.e. the frame whose pts is start_time + k/fps.
That is exactly what the player shows: OSC file/time * fps, and CasparCG SEEK lands on it
(verified against a burnt-in counter).  Interlaced sources are scored on their first field
(top for tff), so a cut between the two fields of a frame lands where the new shot fully starts.

Analysis is on demand and only for [frame - before, frame + after] (max 30 s each side).
"""
import asyncio
import contextlib
import math
from pathlib import Path

MAX_SIDE_SEC = 30.0


class SceneError(Exception):
    pass


async def _run(args: list[str], timeout: float = 60) -> tuple[int, str, str]:
    p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                             stdin=asyncio.subprocess.DEVNULL)
    try:
        out, err = await asyncio.wait_for(p.communicate(), timeout)
    except asyncio.TimeoutError:
        p.kill()
        raise SceneError("analysis timed out")
    return p.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


async def analyse(path: Path, info: dict, frame: int, before: float, after: float) -> dict:
    """info = Media.probe() result (needs fps, frames, video.field_order, audio.streams, start_time)."""
    if info["kind"] != "video" or not info.get("video"):
        raise SceneError("scene detection needs a video clip")
    fps = info["fps"]
    rate = fps[0] / fps[1]
    before = max(0.5, min(MAX_SIDE_SEC, float(before)))
    after = max(0.5, min(MAX_SIDE_SEC, float(after)))
    n = info["frames"] or 0
    f0 = max(1, round(frame - before * rate))      # frame 0 has no predecessor -> no score
    f1 = round(frame + after * rate)
    if n:
        f1 = min(f1, n - 1)
    if f1 < f0:
        raise SceneError("empty range")
    start = float(info.get("start_time") or 0.0)
    # input seek lands on a GOP boundary at or before x: read from 3 s earlier, keep only f0-1..f1
    x = max(0.0, start + (f0 - 1) / rate - 3.0)
    length = (f1 - f0 + 2) / rate + 3.5
    inp = ["-ss", f"{x:.4f}", "-t", f"{length:.4f}", "-i", str(path)]
    fo = (info["video"].get("field_order") or "progressive").lower()
    field = "" if fo in ("progressive", "unknown", "") else (
        "field=type=bottom," if fo in ("bb", "bt") else "field=type=top,")
    vargs = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-threads", "4", *inp, "-copyts",
             "-map", "0:v:0", "-vf", f"{field}scale=320:-2,select='gte(scene,0)',metadata=print:file=-",
             "-an", "-f", "null", "-"]
    (rc, out, err), peaks = await asyncio.gather(_run(vargs), _peaks(inp, info, start, f0, f1, rate))
    if rc != 0:
        raise SceneError(f"scene analysis failed: {err.strip()[-200:]}")
    frames, k = [], None
    for line in out.splitlines():
        if line.startswith("frame:"):
            k = round((float(line.rsplit("pts_time:", 1)[1]) - start) * rate)
        elif line.startswith("lavfi.scene_score=") and k is not None and f0 <= k <= f1:
            frames.append([k, round(float(line.split("=", 1)[1]), 4)])
    return {"fps": fps, "from": f0, "to": f1, "frames": frames, "peaks": peaks, "frame": frame}


async def _peaks(inp: list[str], info: dict, zero: float, f0: int, f1: int, rate: float) -> list:
    """Peak dBFS per frame f0..f1 of the first two audio tracks together (XDCAM: 8 mono tracks,
    CH1/CH2 = programme L/R); None where there is no audio, -90 for digital silence."""
    peaks: list = [None] * (f1 - f0 + 1)
    na = info.get("audio", {}).get("streams", 0)
    if not na:
        return peaks
    stat = ("asetnsamples=n=160:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level,"
            "ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-")
    if na >= 2:
        graph = ["-filter_complex", f"[0:a:0][0:a:1]amerge=inputs=2,{stat}"]
    else:
        graph = ["-map", "0:a:0", "-af", stat]
    args = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", *inp, "-copyts", *graph, "-vn", "-f", "null", "-"]
    rc, out, _ = await _run(args)
    if rc != 0:
        return peaks
    k = None
    for line in out.splitlines():
        if line.startswith("frame:"):
            k = math.floor((float(line.rsplit("pts_time:", 1)[1]) - zero) * rate + 1e-6) - f0
        elif line.startswith("lavfi.astats.Overall.Peak_level=") and k is not None and 0 <= k < len(peaks):
            with contextlib.suppress(ValueError):
                db = max(-90.0, float(line.split("=", 1)[1]))
                peaks[k] = round(db if peaks[k] is None else max(peaks[k], db), 1)
    return peaks
