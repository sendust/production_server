"""sendust_player.json loader. Missing keys fall back to DEFAULTS (deep merge)."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "sendust_player.json"

DEFAULTS = {
    "title": "sendust playlist",
    "http": {"host": "0.0.0.0", "port": 8300},
    "auth": False,
    "password": "",
    "ext_control": {"enabled": True, "key": "", "osc_port": 9250},
    "casparcg": {
        "host": "127.0.0.1",
        "amcp_port": 5250,
        "osc_port": 6250,
        "media_path": "/mnt/raid0",
        "template_path": "/mnt/raid0/template",
        "video_layer": 10,
        "osd_route_layer": 10,
        "osd_overlay_layer": 20,
    },
    "browser": {"lower_root": "/mnt", "favorites": []},
    "shared_playlist_path": "/mnt/storage1",
    "osd": {
        "timecode": {"enabled": True, "mode": "elapsed", "x": 0.05, "y": 0.86, "size": 0.05},
        "filename": {"enabled": True, "x": 0.05, "y": 0.06, "size": 0.03},
    },
    "zoom_timeline": {"seconds": 5},
    "sdi_preview": {"rtsp_base": "rtsp://127.0.0.1:8554", "webrtc_port": 8889, "args": ""},
    "total_sdi_consumer": 0,
    "channels": [],
}

OSD_TC_MODES = ("elapsed", "remaining", "source")


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = _merge(DEFAULTS, json.load(f))
    for i, ch in enumerate(cfg["channels"]):
        ch.setdefault("channel_index", i)
        ch.setdefault("name", f"PLAY {i + 1}")
        ch.setdefault("osd_out", None)
        if not isinstance(ch.get("clean_out"), int):
            raise ValueError(f"channels[{i}].clean_out must be a CasparCG channel number")
    if cfg["osd"]["timecode"]["mode"] not in OSD_TC_MODES:
        raise ValueError(f"osd.timecode.mode must be one of {OSD_TC_MODES}")
    return cfg
