"""Timecode helpers (same rules as www/js/common.js framesToTc)."""


def frames_to_tc(f: int, fps: list | tuple, drop: bool) -> str:
    nom = round(fps[0] / fps[1])
    neg = f < 0
    f = abs(int(round(f)))
    drop = drop and fps[1] == 1001 and nom in (30, 60)
    if drop:
        dpm = 4 if nom == 60 else 2
        per10, per_min = nom * 600 - dpm * 9, nom * 60 - dpm
        d, m = divmod(f, per10)
        f += dpm * 9 * d + (dpm * ((m - dpm) // per_min) if m > dpm else 0)
    ff, s = f % nom, f // nom
    sep = ";" if drop else ":"
    return f"{'-' if neg else ''}{s // 3600 % 24:02d}:{s // 60 % 60:02d}:{s % 60:02d}{sep}{ff:02d}"


def tc_to_frames(tc: str | None, fps: list | tuple) -> int:
    """'HH:MM:SS:FF' (';' = drop frame) -> frame count; 0 when not a timecode."""
    import re
    m = re.match(r"^(\d+):(\d+):(\d+)[:;.,](\d+)$", tc or "")
    if not m:
        return 0
    hh, mm, ss, ff = map(int, m.groups())
    nom = round(fps[0] / fps[1])
    f = ((hh * 60 + mm) * 60 + ss) * nom + ff
    if ";" in tc and fps[1] == 1001 and nom in (30, 60):
        dpm, tm = (4 if nom == 60 else 2), hh * 60 + mm
        f -= dpm * (tm - tm // 10)
    return f
