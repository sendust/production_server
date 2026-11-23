"""External control for buttons, MCUs and show controllers.

Two transports, same command set (channel n = PLAY n, 1-based):

  HTTP   GET|POST /ext/v1/<n>/<command>[?key=<key>]      -> 200 "OK"      | 4xx "ERR <reason>"
         GET      /ext/v1/<n>/status[?key=<key>]         -> key=value lines (text/plain)
  OSC    UDP <osc_port>, address /sendust/<n>/<command>  (no reply; an int/float argument 0 = button
         release and is ignored, so momentary buttons that send 1 then 0 fire once)

Commands: play pause toggle top next prev aux1 aux2 (+ stop = pause, eject, cue = load the current item)
aux1/aux2 are mapped in sendust_player.json (ext_control.aux1 / aux2) to one of the other commands.
Auth: HTTP needs ext_control.key (if set) as ?key= or header X-Api-Key. OSC has no key field, so it is
limited by ext_control.allow_ips only (which, if set, also limits HTTP).
"""
import asyncio
import logging

from . import osc
from .common_tc import frames_to_tc

log = logging.getLogger("ext")

COMMANDS = ("play", "pause", "stop", "toggle", "top", "next", "prev", "eject", "cue", "aux1", "aux2")


class ExtError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


class ExtControl:
    def __init__(self, app):
        self.app = app
        self.transport = None

    @property
    def cfg(self) -> dict:
        return self.app.cfg["ext_control"]

    def check(self, ip: str, key: str | None):
        if not self.cfg.get("enabled", True):
            raise ExtError(403, "external control disabled")
        allow = self.cfg.get("allow_ips") or []
        if allow and ip not in allow and ip not in ("127.0.0.1", "::1"):
            raise ExtError(403, f"ip {ip} not allowed")
        want = self.cfg.get("key") or ""
        if want and key != want:
            raise ExtError(401, "bad key")

    def player(self, n: int):
        for p in self.app.players:
            if p.idx == n - 1:
                return p
        raise ExtError(404, f"no channel {n}")

    async def run(self, n: int, cmd: str, src: str) -> str:
        cmd = cmd.lower()
        if cmd not in COMMANDS:
            raise ExtError(404, f"unknown command {cmd}")
        p = self.player(n)
        if cmd in ("aux1", "aux2"):
            mapped = (self.cfg.get(cmd) or "").lower()
            if not mapped:
                raise ExtError(409, f"{cmd} not assigned")
            if mapped not in COMMANDS or mapped.startswith("aux"):
                raise ExtError(500, f"{cmd} mapped to invalid command {mapped}")
            cmd = mapped
        p.logmsg(f"EXT {cmd.upper()} ({src})")
        if cmd == "play":
            await p.play()
        elif cmd in ("pause", "stop"):
            await p.pause()
        elif cmd == "toggle":
            await p.toggle()
        elif cmd == "top":
            await p.top()
        elif cmd == "next":
            await p.load_next(1)
        elif cmd == "prev":
            await p.load_next(-1)
        elif cmd == "eject":
            await p.eject()
        elif cmd == "cue":
            cur = p.pl.get(p.pl.current_id) or p.pl.next_clip(None, wrap=False, skip_pause=True)
            if not cur:
                raise ExtError(409, "playlist empty")
            await p.cue(cur["id"])
        return "OK"

    def status(self, n: int) -> str:
        p = self.player(n)
        s = p.snapshot()
        ld = p.loaded
        lines = {"ch": n, "name": p.name, "status": s["status"], "loop": p.loop_mode,
                 "playlist_play": int(p.pl.enabled)}
        if ld:
            i = ld["info"]
            pos = s["pos"] if s["pos"] is not None else ld["in"]
            lines.update(clip=ld["name"], frame=pos, in_frame=ld["in"], out_frame=ld["out"],
                         elapsed=frames_to_tc(max(0, pos - ld["in"]), i["fps"], i["drop"]),
                         remaining=frames_to_tc(max(0, ld["out"] - pos - 1), i["fps"], i["drop"]))
        clips = [it for it in p.pl.items if it["type"] == "clip"]
        cur = next((k for k, it in enumerate(clips) if it["id"] == p.pl.current_id), None)
        lines["item"] = f"{cur + 1 if cur is not None else 0}/{len(clips)}"
        return "".join(f"{k}={v}\n" for k, v in lines.items())

    # ---- OSC -----------------------------------------------------------------
    async def start_osc(self):
        port = self.cfg.get("osc_port")
        if not port or not self.cfg.get("enabled", True):
            return
        self.transport = await osc.listen(int(port), self._on_osc)
        log.info("OSC control on udp/%s  (/sendust/<n>/<command>)", port)

    def _on_osc(self, addr: str, args: list, src=None):
        parts = [x for x in addr.split("/") if x]
        if len(parts) == 4 and parts[1] == "ch":     # also accept /sendust/ch/<n>/<command>
            parts = [parts[0], parts[2], parts[3]]
        if len(parts) != 3 or parts[0] != "sendust" or not parts[1].isdigit():
            return
        if args and isinstance(args[0], (int, float)) and not isinstance(args[0], bool) and args[0] == 0:
            return   # button release
        ip = src[0] if src else "?"
        try:
            # OSC carries no key: it is limited by allow_ips only (keep the port inside the LAN)
            self.check(ip, self.cfg.get("key") or None)
        except ExtError as e:
            log.warning("OSC from %s refused: %s", ip, e)
            return
        asyncio.get_running_loop().create_task(self._osc_run(int(parts[1]), parts[2], ip))

    async def _osc_run(self, n: int, cmd: str, ip: str):
        try:
            await self.run(n, cmd, f"osc {ip}")
        except Exception as e:  # report, never crash the UDP handler
            log.warning("OSC %s/%s from %s: %s", n, cmd, ip, e)

    def stop(self):
        if self.transport:
            self.transport.close()
