"""Settings page backend: CasparCG channel detection, config editing, CasparCG service control.

- detect(): CasparCG channels and their consumers from casparcg.config (works while CasparCG is
  down), plus what OSC reports live (format, consumers actually running).
- save_config(): validates with config.load() on a temp file before replacing sendust_player.json;
  the previous file is kept as sendust_player.json.bak. The backend reads the config at start, so
  a restart applies it (restart_backend()).
- CasparService: systemd *system* unit (deploy/install_casparcg_service.sh installs it with a
  sudoers rule that allows exactly `systemctl start|stop|restart|enable|disable <unit>`).
"""
import asyncio
import copy
import json
import logging
import os
import signal
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from . import config as config_mod
from .config import CONFIG_PATH, ROOT

log = logging.getLogger("settings")
SYSTEMCTL = "/usr/bin/systemctl"
SERVICE_ACTIONS = ("start", "stop", "restart", "enable", "disable")


# ------------------------------------------------------------------ CasparCG channel detection
def read_caspar_config(path: str) -> dict:
    """Channels of casparcg.config: [{n, video_mode, consumers: [{type, device, ...}]}]."""
    out = {"path": path, "channels": [], "media_path": None, "error": None}
    try:
        root = ET.parse(path).getroot()   # comments (the documentation block) are skipped by the parser
    except (OSError, ET.ParseError) as e:
        out["error"] = str(e)
        return out
    mp = root.find("./paths/media-path")
    out["media_path"] = mp.text.strip() if mp is not None and mp.text else None
    for i, ch in enumerate(root.findall("./channels/channel"), start=1):
        mode = (ch.findtext("video-mode") or "").strip()
        cons = []
        for c in list(ch.find("consumers") if ch.find("consumers") is not None else []):
            d = {"type": c.tag}
            for k in ("device", "key-device", "keyer", "embedded-audio", "channel-layout", "path", "args"):
                v = c.findtext(k)
                if v is not None:
                    d[k] = v.strip()
            cons.append(d)
        out["channels"].append({"n": i, "video_mode": mode, "consumers": cons})
    return out


def consumer_label(c: dict) -> str:
    if c.get("type") == "decklink":
        return f"DeckLink {c.get('device', '?')}"
    return c.get("type", "?")


def detect(cfg: dict, engine) -> dict:
    """What CasparCG has, for the channel-plan editor."""
    cc = read_caspar_config(cfg["casparcg"].get("config_path", ""))
    live = engine.snapshot()["channels"]
    for ch in cc["channels"]:
        lv = live.get(ch["n"])
        ch["label"] = ", ".join(consumer_label(c) for c in ch["consumers"]) or "consumer 없음"
        ch["live"] = bool(lv and lv["alive"])
        ch["live_format"] = lv["format"] if lv else None
        ch["live_outputs"] = sorted({str(o.get("consumer")) for o in (lv or {}).get("outputs", {}).values()})
    used = {}
    for c in cfg["channels"]:
        used.setdefault(c["clean_out"], []).append(f'{c["name"]} 클린')
        if c.get("osd_out"):
            used.setdefault(c["osd_out"], []).append(f'{c["name"]} OSD')
    cc["used"] = {str(k): v for k, v in used.items()}
    return cc


# ------------------------------------------------------------------ config file
def _fmt(v, ind: int = 0) -> str:
    """JSON like the hand-written file: small objects on one line, big ones expanded."""
    one = json.dumps(v, ensure_ascii=False, separators=(", ", ": "))
    if not isinstance(v, (dict, list)) or (ind > 0 and len(one) + 2 * ind <= 118):
        return "{ " + one[1:-1] + " }" if isinstance(v, dict) and v else one
    pad, inner = "  " * ind, "  " * (ind + 1)
    if isinstance(v, list):
        return "[\n" + ",\n".join(inner + _fmt(x, ind + 1) for x in v) + f"\n{pad}]"
    items = [f'{inner}{json.dumps(k, ensure_ascii=False)}: {_fmt(x, ind + 1)}' for k, x in v.items()]
    if ind == 0:   # top level: a blank line around multi-line sections, as in the hand-written file
        out = []
        for i, it in enumerate(items):
            if i and ("\n" in it or "\n" in items[i - 1]):
                out.append("")
            out.append(it)
        return "{\n" + ",\n".join(out).replace(",\n,\n", ",\n\n") + "\n}"
    return "{\n" + ",\n".join(items) + f"\n{pad}}}"


def current_file_config() -> dict:
    """sendust_player.json merged with the defaults (what the backend uses after a restart)."""
    return config_mod.load()


def validate(cfg: dict) -> list[str]:
    errs = []
    chans = cfg.get("channels") or []
    if not chans:
        errs.append("재생 채널이 하나도 없습니다")
    seen = {}
    for i, c in enumerate(chans):
        name = c.get("name") or f"#{i + 1}"
        for k in ("clean_out", "osd_out"):
            v = c.get(k)
            if k == "osd_out" and v is None:
                continue
            if not isinstance(v, int) or v < 1:
                errs.append(f"{name}: {k} 는 CasparCG 채널 번호(1 이상)여야 합니다")
                continue
            if v in seen:
                errs.append(f"CasparCG 채널 {v} 를 {seen[v]} 와 {name} 가 함께 씁니다")
            seen[v] = name
        if c.get("tc_mode") not in config_mod.PLAYER_TC_MODES:
            errs.append(f"{name}: tc_mode 는 source / elapsed")
    port = (cfg.get("http") or {}).get("port")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        errs.append("http.port 가 올바르지 않습니다")
    if cfg.get("auth") and not cfg.get("password"):
        errs.append("인증을 켜려면 비밀번호가 필요합니다")
    return errs


def save_config(new: dict, password: str | None) -> dict:
    """Validate and write sendust_player.json. password: None = keep the current one."""
    cur = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    pw = cur.get("password", "") if password is None else password
    cfg = {}
    for k, v in copy.deepcopy(new).items():   # keep "password" right after "auth"
        if k == "password":
            continue
        cfg[k] = v
        if k == "auth":
            cfg["password"] = pw
    cfg.setdefault("password", pw)
    for i, c in enumerate(cfg.get("channels") or []):
        c["channel_index"] = i   # playback channels are numbered in list order
    errs = validate(cfg)
    if errs:
        raise ValueError("\n".join(errs))
    text = _fmt(cfg) + "\n"
    tmp = CONFIG_PATH.with_name(".sendust_player.json.check")
    tmp.write_text(text, encoding="utf-8")
    try:
        config_mod.load(tmp)   # the same checks the backend runs at start
    except (ValueError, KeyError, TypeError) as e:
        tmp.unlink(missing_ok=True)
        raise ValueError(f"설정 검사 실패: {e}")
    if CONFIG_PATH.exists():
        CONFIG_PATH.with_name("sendust_player.json.bak").write_text(CONFIG_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    tmp.replace(CONFIG_PATH)
    return cfg


def restart_backend():
    """./run.sh restart in its own session, so it outlives this process."""
    subprocess.Popen(["setsid", "--fork", str(ROOT / "run.sh"), "restart"], cwd=str(ROOT),
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ------------------------------------------------------------------ CasparCG service
class ServiceError(Exception):
    def __init__(self, msg: str, status: int = 400):
        super().__init__(msg)
        self.status = status


class CasparService:
    def __init__(self, unit: str, caspar_pid):
        self.unit = unit
        self.caspar_pid = caspar_pid   # callable: pid of the running CasparCG server or None

    async def _run(self, *args, timeout: float = 40) -> tuple[int, str]:
        p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(p.communicate(), timeout)
        except asyncio.TimeoutError:
            p.kill()
            return 124, "timeout"
        return p.returncode, out.decode(errors="replace").strip()

    async def status(self) -> dict:
        rc, out = await self._run(SYSTEMCTL, "show", self.unit, "--property=LoadState,ActiveState,SubState,"
                                  "UnitFileState,MainPID,ExecMainStartTimestamp,FragmentPath", timeout=5)
        st = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
        pid = self.caspar_pid()
        in_unit = False
        if pid:
            try:
                in_unit = self.unit in Path(f"/proc/{pid}/cgroup").read_text()
            except OSError:
                pass
        installed = st.get("LoadState") == "loaded"
        return {
            "unit": self.unit, "installed": installed, "load": st.get("LoadState"),
            "active": st.get("ActiveState"), "sub": st.get("SubState"), "enabled": st.get("UnitFileState"),
            "main_pid": int(st.get("MainPID") or 0) or None, "since": st.get("ExecMainStartTimestamp") or None,
            "path": st.get("FragmentPath") or None,
            "caspar_pid": pid, "external": bool(pid and not in_unit),   # running, but not under the service
            "sudo_ok": await self._sudo_ok() if installed else False,
        }

    async def _sudo_ok(self) -> bool:
        rc, _ = await self._run("sudo", "-n", "-l", SYSTEMCTL, "start", self.unit, timeout=5)
        return rc == 0

    async def action(self, act: str, ip: str) -> dict:
        if act not in SERVICE_ACTIONS:
            raise ServiceError(f"unknown action {act}")
        st = await self.status()
        log.info("CasparCG service %s requested (client %s)", act, ip)
        if act == "stop" and st["external"] and st["active"] != "active":
            return await self._stop_external(st["caspar_pid"])
        if act in ("start", "restart") and st["external"]:
            raise ServiceError(f"CasparCG 가 서비스 밖에서 실행 중입니다 (pid {st['caspar_pid']}). 먼저 [정지] 하세요", 409)
        if not st["installed"]:
            raise ServiceError(f"{self.unit} 가 설치되지 않았습니다 (deploy/install_casparcg_service.sh)", 503)
        rc, out = await self._run("sudo", "-n", SYSTEMCTL, act, self.unit)
        if rc != 0:
            if "password" in out.lower():
                raise ServiceError("sudo 권한이 없습니다: deploy/install_casparcg_service.sh 로 sudoers 규칙을 설치하세요", 503)
            raise ServiceError(f"systemctl {act} 실패: {out or rc}", 500)
        log.info("CasparCG service %s done", act)
        return await self.status()

    async def _stop_external(self, pid: int) -> dict:
        """CasparCG started by hand (run_caspar.sh / nohup): stop it so the service can take over."""
        log.info("stopping CasparCG pid %d (not under %s)", pid, self.unit)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return await self.status()
        except PermissionError:
            raise ServiceError(f"pid {pid} 를 정지할 권한이 없습니다", 403)
        t0 = time.monotonic()
        while os.path.exists(f"/proc/{pid}") and time.monotonic() - t0 < 15:
            await asyncio.sleep(0.3)
        if os.path.exists(f"/proc/{pid}"):
            os.kill(pid, signal.SIGKILL)
        await asyncio.sleep(8)   # DeckLink outputs need a moment before another CasparCG can open them
        return await self.status()
