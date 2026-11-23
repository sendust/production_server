"""sendust playlist backend.  Run: ./run.sh  (or .venv/bin/python -m backend.main)"""
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

import socket
from urllib.parse import quote as urlquote

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config as config_mod
from . import osc
from .amcp import Amcp, AmcpError
from .auth import COOKIE, MAX_AGE, Auth
from .ext import ExtControl, ExtError
from .config import ROOT
from .engine import Engine
from .fsops import Conflict, FsError, Jobs, Roots
from .media import Media
from .osd import Osd
from . import scenes as scenes_mod
from .player import Player
from .sdi_preview import SdiPreview
from .version import commit_stamp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("main")

TICK_HZ = 20
DATA = ROOT / "data"


class Hub:
    """WebSocket fan-out. Every client gets a full 'hello' then 'tick' / event messages."""

    def __init__(self):
        self.clients: set[WebSocket] = set()

    async def send(self, ws: WebSocket, msg: dict):
        try:
            await ws.send_text(json.dumps(msg, separators=(",", ":")))
        except Exception:
            self.clients.discard(ws)

    async def broadcast(self, msg: dict):
        if self.clients:
            text = json.dumps(msg, separators=(",", ":"))
            for ws in list(self.clients):
                try:
                    await ws.send_text(text)
                except Exception:
                    self.clients.discard(ws)


class JsonStore:
    """Small JSON file (favorites, per-client-IP sessions)."""

    def __init__(self, path: Path, default):
        self.path = path
        try:
            self.data = json.loads(path.read_text())
        except (OSError, ValueError):
            self.data = default

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1))
        tmp.replace(self.path)


class App:
    def __init__(self):
        self.cfg = config_mod.load()
        self.stamp = commit_stamp()
        self.engine = Engine()
        self.hub = Hub()
        c = self.cfg["casparcg"]
        self.amcp = Amcp(c["host"], c["amcp_port"], on_state=self._amcp_state)
        self.media = Media(c["media_path"])
        self.roots = Roots(c["media_path"], self.cfg["browser"]["lower_root"])
        self.jobs = Jobs(self.roots, self.hub.broadcast)
        self.players = [Player(ch, c["video_layer"], self.amcp, self.engine, self.media, self.hub.broadcast,
                               self.cfg["shared_playlist_path"], self.cfg["playlist"]["image_sec"])
                        for ch in self.cfg["channels"]]
        self.osd = Osd(self.cfg, self.amcp, self.engine, self.players, self.cfg["http"]["port"])
        self.sdi = SdiPreview(self.cfg, self.amcp, self.engine, self.players)
        self.auth = Auth(self.cfg)
        self.ext = ExtControl(self)
        self.favorites = JsonStore(DATA / "favorites.json", list(self.cfg["browser"].get("favorites", [])))
        self.sessions = JsonStore(DATA / "sessions.json", {})
        self.osc_transport = None

    def player(self, idx: int) -> Player:
        for p in self.players:
            if p.idx == idx:
                return p
        raise HTTPException(404, f"no channel {idx}")

    def _amcp_state(self, connected: bool):
        asyncio.get_event_loop().create_task(self.hub.broadcast({"type": "amcp", "connected": connected}))

    def info(self) -> dict:
        return {
            "api_version": 1, "host": socket.gethostname(), "auth": self.auth.enabled,
            "title": self.cfg["title"], "stamp": self.stamp,
            "channels": self.cfg["channels"], "osd": self.cfg["osd"],
            "zoom_timeline": self.cfg["zoom_timeline"],
            "media_path": str(self.roots.base("media")), "host_root": str(self.roots.base("host")),
            "video_layer": self.cfg["casparcg"]["video_layer"],
            "image_sec": self.cfg["playlist"]["image_sec"],
        }

    async def start(self):
        self.osc_transport = await osc.listen(self.cfg["casparcg"]["osc_port"], self.engine.on_osc)
        self.amcp.start()
        await self.ext.start_osc()
        self._ticker = asyncio.create_task(self._tick())
        self._osd_task = asyncio.create_task(self._osd_loop())

    async def _osd_loop(self):
        while True:
            await asyncio.sleep(1)
            for name, fn in (("osd", self.osd.ensure), ("sdi", self.sdi.ensure)):
                try:
                    await fn()
                except Exception as e:  # keep the loop alive whatever happens
                    log.warning("%s ensure: %s", name, e)

    async def stop(self):
        self._ticker.cancel()
        self._osd_task.cancel()
        await self.amcp.stop()
        self.ext.stop()
        if self.osc_transport:
            self.osc_transport.close()

    async def _tick(self):
        last = -1
        while True:
            await asyncio.sleep(1 / TICK_HZ)
            if self.engine.version != last or not self.engine.osc_last:
                last = self.engine.version
                for p in self.players:
                    asyncio.create_task(p.on_tick())
                await self.hub.broadcast(self.tick_msg())

    def tick_msg(self) -> dict:
        peaks = self.engine.take_peaks()
        players = []
        for p in self.players:
            s = p.snapshot()
            s["volume"] = peaks.get(p.clean, [])
            s["osd_state"] = self.osd.state(p)
            s["sdi_preview"] = self.sdi.state(p)
            players.append(s)
        return {"type": "tick", "engine": self.engine.snapshot(), "amcp": self.amcp.connected, "players": players}


app_state = App()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await app_state.start()
    yield
    await app_state.stop()


api = FastAPI(title="sendust playlist", lifespan=lifespan)

if app_state.cfg["gang"].get("allow_origins"):
    # gang control UI served from another host calls this API from the browser (X-Api-Key)
    api.add_middleware(CORSMiddleware, allow_origins=app_state.cfg["gang"]["allow_origins"],
                       allow_methods=["*"], allow_headers=["*"])


@api.middleware("http")
async def auth_guard(request: Request, call_next):
    a = app_state.auth
    if a.enabled and request.method != "OPTIONS":
        path = request.url.path
        if not a.allowed(path, client_ip(request), request.cookies.get(COOKIE), request.headers.get("x-api-key")):
            if path.startswith(("/api/", "/media/", "/ws")):
                return JSONResponse({"detail": "login required"}, status_code=401)
            nxt = path + (f"?{request.url.query}" if request.url.query else "")
            return RedirectResponse(f"/login.html?next={urlquote(nxt)}")
    return await call_next(request)


def ws_allowed(ws: WebSocket) -> bool:
    return app_state.auth.allowed(ws.url.path, client_ip(ws), ws.cookies.get(COOKIE), ws.headers.get("x-api-key"))


class Login(BaseModel):
    password: str


@api.post("/api/v1/login")
async def login(b: Login, request: Request):
    if not app_state.auth.enabled:
        return {"ok": True, "auth": False}
    if not app_state.auth.check_password(b.password):
        log.warning("login failed from %s", client_ip(request))
        await asyncio.sleep(1)   # slow down guessing
        raise HTTPException(401, "wrong password")
    r = JSONResponse({"ok": True})
    r.set_cookie(COOKIE, app_state.auth.make_token(), max_age=MAX_AGE, httponly=True, samesite="lax")
    log.info("login from %s", client_ip(request))
    return r


@api.post("/api/v1/logout")
async def logout():
    r = JSONResponse({"ok": True})
    r.delete_cookie(COOKIE)
    return r


# ---------------------------------------------------------------- external control (MCU / show controller)
@api.api_route("/ext/v1/{n}/{cmd}", methods=["GET", "POST"], response_class=PlainTextResponse)
async def ext_cmd(n: int, cmd: str, request: Request, key: str | None = None):
    ext = app_state.ext
    try:
        ext.check(client_ip(request), key or request.headers.get("x-api-key"))
        if cmd == "status":
            return PlainTextResponse(ext.status(n))
        return PlainTextResponse(await ext.run(n, cmd, f"http {client_ip(request)}") + "\n")
    except ExtError as e:
        return PlainTextResponse(f"ERR {e}\n", status_code=e.status)
    except AmcpError as e:
        return PlainTextResponse(f"ERR casparcg {e.text or e}\n", status_code=502)
    except (ValueError, OSError, RuntimeError) as e:
        return PlainTextResponse(f"ERR {e}\n", status_code=400)


@api.get("/api/v1/status")
async def status_all():
    """Compact state of every channel (gang control polls this)."""
    out = []
    for p in app_state.players:
        s = p.snapshot()
        ld = p.loaded
        out.append({
            "idx": p.idx, "n": p.idx + 1, "name": p.name, "status": s["status"], "pos": s["pos"],
            "clip": ld["file"] if ld else None, "in": ld["in"] if ld else None, "out": ld["out"] if ld else None,
            "fps": ld["info"]["fps"] if ld else None, "loop_mode": p.loop_mode, "playlist_play": p.pl.enabled,
            "current_id": p.pl.current_id, "items": sum(1 for i in p.pl.items if i["type"] == "clip"),
        })
    return {"host": socket.gethostname(), "amcp": app_state.amcp.connected,
            "osc": app_state.engine.snapshot()["osc_alive"], "channels": out}


def client_ip(req: Request | WebSocket) -> str:
    return req.client.host if req.client else "unknown"


@api.get("/api/v1/info")
async def get_info():
    return app_state.info()


@api.get("/api/v1/engine")
async def get_engine():
    return {"engine": app_state.engine.snapshot(), "amcp": app_state.amcp.connected}


class RawCmd(BaseModel):
    cmd: str


@api.post("/api/v1/amcp")
async def raw_amcp(body: RawCmd):
    try:
        return {"ok": True, "data": await app_state.amcp.send(body.cmd)}
    except AmcpError as e:
        raise HTTPException(502, str(e))


# ---------------------------------------------------------------- media
@api.get("/api/v1/media/list")
async def media_list(dir: str = ""):
    try:
        return {"dir": dir, "root": str(app_state.media.root), "items": app_state.media.list_dir(dir)}
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@api.get("/api/v1/media/probe")
async def media_probe(file: str):
    try:
        return await app_state.media.probe(file)
    except (ValueError, OSError, RuntimeError) as e:
        raise HTTPException(400, str(e))


class ScenesReq(BaseModel):
    file: str
    frame: int
    before: float = 5
    after: float = 5


@api.post("/api/v1/media/scenes")
async def media_scenes(b: ScenesReq):
    """Scene score + audio peak per source frame around `frame` (see scenes.py)."""
    try:
        info = await app_state.media.probe(b.file)
        t0 = time.monotonic()
        r = await scenes_mod.analyse(app_state.media.abs(b.file), info, b.frame, b.before, b.after)
        r["file"] = b.file
        r["elapsed"] = round(time.monotonic() - t0, 2)
        return r
    except (ValueError, OSError, RuntimeError, scenes_mod.SceneError) as e:
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------- channels
@api.get("/api/v1/ch/{idx}")
async def ch_state(idx: int):
    p = app_state.player(idx)
    snap = p.snapshot()
    snap["osd_state"] = app_state.osd.state(p)
    snap["sdi_preview"] = app_state.sdi.state(p)
    return {"player": snap, "playlist": p.pl.view(), "logs": list(p.logs)}


class ChCmd(BaseModel):
    file: str | None = None
    files: list[str] | None = None
    frame: int | None = None
    delta: int | None = None
    fin: int | None = None
    fout: int | None = None
    on: bool | None = None
    mode: str | None = None
    id: str | None = None
    ids: list[str] | None = None
    at: int | None = None
    slot: str | None = None


CH_ACTIONS = {
    "load": lambda p, b: p.load(b.file, b.fin, b.fout),
    "cue": lambda p, b: p.cue(b.id, play=bool(b.on)),
    "play": lambda p, b: p.play(),
    "pause": lambda p, b: p.pause(),
    "toggle": lambda p, b: p.toggle(),
    "seek": lambda p, b: p.seek(b.frame or 0),
    "step": lambda p, b: p.step(b.delta or 0),
    "top": lambda p, b: p.top(),
    "next": lambda p, b: p.load_next(1),
    "prev": lambda p, b: p.load_next(-1),
    "mark_in": lambda p, b: p.mark_in(b.frame),
    "mark_out": lambda p, b: p.mark_out(b.frame),
    "marks": lambda p, b: p.set_marks(b.fin, b.fout),
    "clear_marks": lambda p, b: p.clear_marks(),
    "loop": lambda p, b: p.set_loop_mode(b.mode or "none"),
    "eject": lambda p, b: p.eject(),
}


class SdiCmd(BaseModel):
    on: bool
    source: str | None = None   # clean | osd (default: osd when the channel has one)


@api.post("/api/v1/ch/{idx}/sdi_preview")
async def ch_sdi_preview(idx: int, b: SdiCmd):
    p = app_state.player(idx)
    try:
        await app_state.sdi.set(p, b.on, b.source)
    except AmcpError as e:
        raise HTTPException(502, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "sdi_preview": app_state.sdi.state(p)}


@api.post("/api/v1/ch/{idx}/{action}")
async def ch_action(idx: int, action: str, body: ChCmd | None = None):
    p = app_state.player(idx)
    fn = CH_ACTIONS.get(action)
    if fn is None:
        raise HTTPException(404, f"unknown action {action}")
    body = body or ChCmd()
    if action == "load" and not body.file:
        raise HTTPException(400, "file required")
    try:
        await fn(p, body)
    except AmcpError as e:
        raise HTTPException(502, str(e))
    except (ValueError, OSError, RuntimeError) as e:
        p.logmsg(f"{action} failed: {e}", "error")
        raise HTTPException(400, str(e))
    return {"ok": True, "player": p.snapshot()}


@api.post("/api/v1/ch/{idx}/playlist/{op}")
async def ch_playlist(idx: int, op: str, body: ChCmd | None = None):
    p = app_state.player(idx)
    try:
        return await p.pl_cmd(op, body or ChCmd())
    except AmcpError as e:
        raise HTTPException(502, str(e))
    except (ValueError, OSError, RuntimeError, KeyError) as e:
        p.logmsg(f"playlist {op} failed: {e}", "error")
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------- file browser
def _fs_guard(fn):
    try:
        return fn()
    except Conflict as e:
        raise HTTPException(409, {"message": str(e), "conflicts": e.names})
    except (FsError, ValueError) as e:
        raise HTTPException(400, str(e))
    except OSError as e:
        raise HTTPException(400, f"{e.strerror or e}: {e.filename or ''}")


@api.get("/api/v1/fs/list")
async def fs_list(root: str, dir: str = ""):
    items = await asyncio.to_thread(_fs_guard, lambda: app_state.roots.list(root, dir))
    return {"root": root, "dir": dir, "base": str(app_state.roots.base(root)), "items": items}


class FsCmd(BaseModel):
    root: str
    dir: str = ""
    name: str | None = None
    path: str | None = None
    paths: list[str] = []
    dst_root: str | None = None
    dst_dir: str = ""
    overwrite: bool = False


async def _fs_changed(root: str, dir: str):
    await app_state.hub.broadcast({"type": "fs", "root": root, "dir": dir})


@api.post("/api/v1/fs/mkdir")
async def fs_mkdir(b: FsCmd):
    r = _fs_guard(lambda: app_state.roots.mkdir(b.root, b.dir, b.name or ""))
    await _fs_changed(b.root, b.dir)
    return {"ok": True, "path": r}


@api.post("/api/v1/fs/rename")
async def fs_rename(b: FsCmd):
    r = _fs_guard(lambda: app_state.roots.rename(b.root, b.path or "", b.name or ""))
    await _fs_changed(b.root, b.dir)
    return {"ok": True, "path": r}


@api.post("/api/v1/fs/copy")
async def fs_copy(b: FsCmd):
    return _fs_guard(lambda: app_state.jobs.transfer(False, b.root, b.paths, b.dst_root or b.root, b.dst_dir, b.overwrite))


@api.post("/api/v1/fs/move")
async def fs_move(b: FsCmd):
    return _fs_guard(lambda: app_state.jobs.transfer(True, b.root, b.paths, b.dst_root or b.root, b.dst_dir, b.overwrite))


@api.post("/api/v1/fs/delete")
async def fs_delete(b: FsCmd):
    return _fs_guard(lambda: app_state.jobs.delete(b.root, b.paths))


@api.get("/api/v1/fs/jobs")
async def fs_jobs():
    return {"jobs": app_state.jobs.list()}


@api.post("/api/v1/fs/jobs/{jid}/cancel")
async def fs_job_cancel(jid: int):
    app_state.jobs.cancel(jid)
    return {"ok": True}


@api.put("/api/v1/fs/upload")
async def fs_upload(request: Request, root: str, dir: str = "", name: str = "", overwrite: bool = False):
    """Raw-body streaming upload (client: XHR PUT with the File as body)."""
    def target():
        from .fsops import _check_name
        _check_name(name)
        d = app_state.roots.abs(root, dir)
        if not d.is_dir():
            raise FsError("destination is not a directory")
        t = d / name
        if t.exists() and not overwrite:
            raise Conflict([name])
        return t
    t = _fs_guard(target)
    tmp = t.with_name(f".{t.name}.upload")
    size = 0
    try:
        with open(tmp, "wb") as f:
            async for chunk in request.stream():
                await asyncio.to_thread(f.write, chunk)
                size += len(chunk)
        tmp.replace(t)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    log.info("upload %s (%d bytes) from %s", t, size, client_ip(request))
    await _fs_changed(root, dir)
    return {"ok": True, "size": size}


@api.get("/api/v1/fs/favorites")
async def fav_get():
    return {"favorites": app_state.favorites.data}


class Favorites(BaseModel):
    favorites: list[dict]


@api.post("/api/v1/fs/favorites")
async def fav_set(b: Favorites):
    app_state.favorites.data = b.favorites
    app_state.favorites.save()
    await app_state.hub.broadcast({"type": "favorites", "favorites": b.favorites})
    return {"ok": True}


# ---------------------------------------------------------------- per-client-IP session (UI prefs)
@api.get("/api/v1/session")
async def session_get(request: Request):
    return {"ip": client_ip(request), "session": app_state.sessions.data.get(client_ip(request), {})}


@api.post("/api/v1/session")
async def session_set(request: Request):
    body = await request.json()
    ip = client_ip(request)
    s = app_state.sessions.data.setdefault(ip, {})
    s.update(body if isinstance(body, dict) else {})
    s["seen"] = int(time.time())
    app_state.sessions.save()
    return {"ok": True}


# ---------------------------------------------------------------- OSD overlay
def osd_payload(p: Player) -> dict:
    ld = p.loaded
    d = {"status": p.status(), "pos": p.position(), "age": p.pos_age()}
    if ld:
        i = ld["info"]
        d.update(name=ld["name"], file=ld["file"], kind=i["kind"], fps=i["fps"], drop=i["drop"],
                 tc_start=i["tc_start"], fin=ld["in"], fout=ld["out"], loop=p.loop_mode == "single")
    return d


@api.websocket("/ws/osd")
async def ws_osd(ws: WebSocket, ch: int = 0):
    """Light feed for the CasparCG HTML overlay: config once, then player position at 25 Hz."""
    if not ws_allowed(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    try:
        p = app_state.player(ch)
    except HTTPException:
        await ws.close()
        return
    try:
        await ws.send_json({"type": "cfg", "osd": app_state.cfg["osd"], "name": p.name})
        last = None
        while True:
            d = osd_payload(p)
            key = (d["status"], d["pos"], d.get("file"), d.get("fin"), d.get("fout"))
            if key != last:
                last = key
                await ws.send_json({"type": "pos", **d})
            await asyncio.sleep(0.04)
    except (WebSocketDisconnect, RuntimeError):
        pass


@api.post("/api/v1/osd/reload")
async def osd_reload():
    """Re-read the osd section of sendust_player.json and reload the overlay pages."""
    try:
        app_state.cfg["osd"] = config_mod.load()["osd"]
    except (OSError, ValueError) as e:
        raise HTTPException(400, str(e))
    await app_state.osd.reload_overlays()
    return {"ok": True, "osd": app_state.cfg["osd"]}


# ---------------------------------------------------------------- websocket
@api.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not ws_allowed(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    hub = app_state.hub
    hub.clients.add(ws)
    hello = app_state.tick_msg()
    hello.update(type="hello", info=app_state.info(),
                 logs={p.idx: list(p.logs)[-50:] for p in app_state.players},
                 playlists={p.idx: p.pl.view() for p in app_state.players},
                 jobs=app_state.jobs.list(), favorites=app_state.favorites.data)
    await hub.send(ws, hello)
    try:
        while True:
            await ws.receive_text()  # client->server traffic goes through REST; keep socket open
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


@api.get("/media/{path:path}")
async def media_file(path: str):
    """Original media with HTTP Range support (VGA preview reads MXF GOPs with Range requests)."""
    try:
        p = app_state.media.abs(path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not p.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(p, headers={"Cache-Control": "no-cache"})


@api.get("/")
async def root():
    return RedirectResponse("/browser.html")


api.mount("/", StaticFiles(directory=ROOT / "www", html=True), name="www")


def main():
    h = app_state.cfg["http"]
    uvicorn.run(api, host=h["host"], port=h["port"], log_level="warning", timeout_graceful_shutdown=2)


if __name__ == "__main__":
    main()
