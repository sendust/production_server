"""CasparCG engine state built from OSC.

CasparCG 2.5 resends the whole state every channel frame, so a layer that stops
being reported (CLEAR, EJECT) is dropped after STALE seconds.

Facts verified on this server (2026-11-23):
- /channel/N/mixer/audio/volume : 16 x int32 sample peak per channel; dBFS = 20*log10(v / 2^31)
- .../foreground/file/time      : [position_sec, file_duration_sec]   (position is absolute in file)
- .../foreground/file/clip      : [in_sec, length_sec]   (from SEEK / LENGTH)
- AMCP SEEK / LENGTH are counted in CHANNEL frames (1080i5994 -> 59.94/s), not source frames.
"""
import math
import time

STALE = 0.5
FULL_SCALE = 2 ** 31


def dbfs(v: int) -> float:
    return round(20 * math.log10(v / FULL_SCALE), 1) if v > 0 else -120.0


class Engine:
    def __init__(self):
        self.channels: dict[int, dict] = {}
        self.osc_last = 0.0
        self.osc_rate = 0
        self._osc_count = 0
        self._osc_t0 = time.monotonic()
        self.version = 0  # bumped on every OSC message, used for change detection

    def _ch(self, n: int) -> dict:
        ch = self.channels.get(n)
        if ch is None:
            ch = self.channels[n] = {"format": "", "fps": [0, 1], "volume": [], "vpeak": [], "layers": {}, "outputs": {},
                                     "seen": 0}
        return ch

    def _layer(self, ch: dict, n: int) -> dict:
        ly = ch["layers"].get(n)
        if ly is None:
            ly = ch["layers"][n] = {"fg": {}, "bg": {}, "seen": 0}
        return ly

    def on_osc(self, addr: str, args: list, _src=None):
        now = time.monotonic()
        self.osc_last = now
        self._osc_count += 1
        if now - self._osc_t0 >= 1:
            self.osc_rate = self._osc_count
            self._osc_count, self._osc_t0 = 0, now
        p = addr.split("/")
        if len(p) < 4 or p[1] != "channel" or not p[2].isdigit():
            return
        self.version += 1
        ch = self._ch(int(p[2]))
        ch["seen"] = now
        key = p[3]
        if key == "format":
            ch["format"] = args[0] if args else ""
        elif key == "framerate" and len(args) == 2:
            ch["fps"] = args
        elif key == "mixer" and p[4:6] == ["audio", "volume"]:
            ch["volume"] = args
            vp = ch["vpeak"]  # max since last tick, so short peaks between ticks are not lost
            ch["vpeak"] = [max(a, b) for a, b in zip(args, vp)] if len(vp) == len(args) else list(args)
        elif key == "output" and len(p) >= 7 and p[4] == "port":
            out = ch["outputs"].setdefault(p[5], {})
            out["/".join(p[6:])] = args[0] if len(args) == 1 else args
        elif key == "stage" and len(p) >= 8 and p[4] == "layer" and p[5].isdigit():
            ly = self._layer(ch, int(p[5]))
            ly["seen"] = now
            side = {"foreground": "fg", "background": "bg"}.get(p[6])
            if side is None:
                return
            sub = "/".join(p[7:])
            if sub.startswith("file/streams") or sub.startswith("transition"):
                return
            if sub.startswith("file/"):
                sub = sub[5:]
            ly[side][sub] = args[0] if len(args) == 1 else args

    def take_peaks(self) -> dict[int, list[float]]:
        """dBFS peaks since the previous call (called once per UI tick)."""
        out = {}
        for n, ch in self.channels.items():
            out[n] = [dbfs(v) for v in (ch["vpeak"] or ch["volume"])]
            ch["vpeak"] = []
        return out

    def snapshot(self) -> dict:
        now = time.monotonic()
        out = {}
        for n, ch in self.channels.items():
            layers = {}
            for ln, ly in list(ch["layers"].items()):
                if now - ly["seen"] > STALE:
                    del ch["layers"][ln]
                    continue
                layers[ln] = {"fg": ly["fg"], "bg": ly["bg"]}
            out[n] = {
                "format": ch["format"], "fps": ch["fps"], "volume": [dbfs(v) for v in ch["volume"]],
                "layers": layers, "outputs": ch["outputs"], "alive": now - ch["seen"] < 2,
            }
        return {"channels": out, "osc_alive": now - self.osc_last < 2, "osc_rate": self.osc_rate}

    def layer_fg(self, channel: int, layer: int) -> dict:
        ch = self.channels.get(channel)
        ly = ch and ch["layers"].get(layer)
        if not ly or time.monotonic() - ly["seen"] > STALE:
            return {}
        return ly["fg"]
