"""Program title stamp: commit date/time of HEAD, e.g. '2026-11-23 15:04'."""
import subprocess

from .config import ROOT


def commit_stamp() -> str:
    try:
        out = subprocess.run(["git", "-C", str(ROOT), "log", "-1", "--format=%cd", "--date=format:%Y-%m-%d %H:%M"],
                             capture_output=True, text=True, timeout=3)
        return out.stdout.strip() or "uncommitted"
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
