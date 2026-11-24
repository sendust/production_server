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
KEY_STALE = 0.25  # OSC repeats every key each channel frame (~60/s)
OUTPUT_STALE = 1.0  # a consumer (output port) not reported for this long is gone
OFFLINE_SEC = 2.0   # a channel that sent no OSC for this long: CasparCG is down / hung
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
                                     "outputs_t": {}, "seen": 0}
        return ch

    def _layer(self, ch: dict, n: int) -> dict:
        ly = ch["layers"].get(n)
        if ly is None:
            ly = ch["layers"][n] = {"fg": {}, "bg": {}, "fg_t": {}, "bg_t": {}, "seen": 0}
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
            ch["outputs_t"][p[5]] = now
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
            ly[side + "_t"][sub] = now

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
                layers[ln] = {"fg": self._fresh(ly, "fg", now), "bg": self._fresh(ly, "bg", now)}
            out[n] = {
                "format": ch["format"], "fps": ch["fps"], "volume": [dbfs(v) for v in ch["volume"]],
                "layers": layers, "outputs": self.outputs(n), "alive": now - ch["seen"] < OFFLINE_SEC,
            }
        return {"channels": out, "osc_alive": now - self.osc_last < 2, "osc_rate": self.osc_rate}

    @staticmethod
    def _fresh(ly: dict, side: str, now: float) -> dict:
        """Keys not refreshed recently belong to a previous producer (e.g. file/time after a
        switch to an image) and are dropped."""
        ts = ly[side + "_t"]
        for k in [k for k, t in ts.items() if now - t > KEY_STALE]:
            ts.pop(k, None)
            ly[side].pop(k, None)
        return ly[side]

    def outputs(self, channel: int) -> dict:
        """Consumers (output ports) of a channel that are still reported; ports of a consumer that
        was removed -- or of a CasparCG process that is gone -- are dropped."""
        ch = self.channels.get(channel)
        if not ch:
            return {}
        now = time.monotonic()
        for port in [k for k, t in ch["outputs_t"].items() if now - t > OUTPUT_STALE]:
            ch["outputs_t"].pop(port, None)
            ch["outputs"].pop(port, None)
        return ch["outputs"]

    def online(self, channel: int) -> bool:
        """CasparCG is reporting this channel (OSC within OFFLINE_SEC)."""
        ch = self.channels.get(channel)
        return bool(ch) and time.monotonic() - ch["seen"] < OFFLINE_SEC

    def reset(self):
        """Forget everything (CasparCG process replaced): the new one starts with empty channels."""
        self.channels.clear()
        self.version += 1

    def layer(self, channel: int, layer: int) -> tuple[dict, dict]:
        ch = self.channels.get(channel)
        ly = ch and ch["layers"].get(layer)
        now = time.monotonic()
        if not ly or now - ly["seen"] > STALE:
            return {}, {}
        return self._fresh(ly, "fg", now), self._fresh(ly, "bg", now)

    def key_age(self, channel: int, layer: int, key: str, side: str = "fg") -> float | None:
        """Seconds since an OSC key of a layer was last received (for client-side interpolation)."""
        ch = self.channels.get(channel)
        ly = ch and ch["layers"].get(layer)
        t = ly and ly[side + "_t"].get(key)
        return time.monotonic() - t if t else None

    def layer_fg(self, channel: int, layer: int) -> dict:
        return self.layer(channel, layer)[0]
