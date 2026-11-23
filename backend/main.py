"""sendust playlist backend.  Run: .venv/bin/python -m backend.main"""
import asyncio
import json
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config as config_mod
from . import osc
from .amcp import Amcp, AmcpError
from .config import ROOT
from .engine import Engine
from .media import Media
from .player import Player
from .version import commit_stamp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("main")

TICK_HZ = 20


class Hub:
    """WebSocket fan-out. Every client gets a full 'hello' then 'engine' ticks."""

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


class App:
    def __init__(self):
        self.cfg = config_mod.load()
        self.stamp = commit_stamp()
        self.engine = Engine()
        self.hub = Hub()
        c = self.cfg["casparcg"]
        self.amcp = Amcp(c["host"], c["amcp_port"], on_state=self._amcp_state)
        self.media = Media(c["media_path"])
        self.players = [Player(ch, c["video_layer"], self.amcp, self.engine, self.media, self.hub.broadcast)
                        for ch in self.cfg["channels"]]
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
            "title": self.cfg["title"], "stamp": self.stamp,
            "channels": self.cfg["channels"], "osd": self.cfg["osd"],
            "zoom_timeline": self.cfg["zoom_timeline"],
            "media_path": self.cfg["casparcg"]["media_path"],
            "video_layer": self.cfg["casparcg"]["video_layer"],
        }

    async def start(self):
        self.osc_transport = await osc.listen(self.cfg["casparcg"]["osc_port"], self.engine.on_osc)
        self.amcp.start()
        self._ticker = asyncio.create_task(self._tick())

    async def stop(self):
        self._ticker.cancel()
        await self.amcp.stop()
        if self.osc_transport:
            self.osc_transport.close()

    async def _tick(self):
        last = -1
        while True:
            await asyncio.sleep(1 / TICK_HZ)
            if self.engine.version != last or not self.engine.osc_last:
                last = self.engine.version
                for p in self.players:
                    asyncio.create_task(p.sync_with_engine())
                await self.hub.broadcast(self.tick_msg())

    def tick_msg(self) -> dict:
        peaks = self.engine.take_peaks()
        players = []
        for p in self.players:
            s = p.snapshot()
            s["volume"] = peaks.get(p.clean, [])
            players.append(s)
        return {"type": "tick", "engine": self.engine.snapshot(), "amcp": self.amcp.connected, "players": players}


app_state = App()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await app_state.start()
    yield
    await app_state.stop()


api = FastAPI(title="sendust playlist", lifespan=lifespan)


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


@api.get("/api/v1/ch/{idx}")
async def ch_state(idx: int):
    p = app_state.player(idx)
    return {"player": p.snapshot(), "logs": list(p.logs)}


class ChCmd(BaseModel):
    file: str | None = None
    frame: int | None = None
    delta: int | None = None
    fin: int | None = None
    fout: int | None = None
    on: bool | None = None
    mode: str | None = None


CH_ACTIONS = {
    "load": lambda p, b: p.load(b.file, b.fin, b.fout),
    "play": lambda p, b: p.play(),
    "pause": lambda p, b: p.pause(),
    "toggle": lambda p, b: p.toggle(),
    "seek": lambda p, b: p.seek(b.frame or 0),
    "step": lambda p, b: p.step(b.delta or 0),
    "top": lambda p, b: p.top(),
    "mark_in": lambda p, b: p.mark_in(b.frame),
    "mark_out": lambda p, b: p.mark_out(b.frame),
    "marks": lambda p, b: p.set_marks(b.fin, b.fout),
    "clear_marks": lambda p, b: p.clear_marks(),
    "loop": lambda p, b: p.set_loop_mode(b.mode or "none"),
    "eject": lambda p, b: p.eject(),
}


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


@api.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub = app_state.hub
    hub.clients.add(ws)
    hello = app_state.tick_msg()
    hello.update(type="hello", info=app_state.info(),
                 logs={p.idx: list(p.logs)[-50:] for p in app_state.players})
    await hub.send(ws, hello)
    try:
        while True:
            await ws.receive_text()  # client->server traffic goes through REST; keep socket open
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


@api.get("/")
async def root():
    return RedirectResponse("/player.html?ch=0")


api.mount("/", StaticFiles(directory=ROOT / "www", html=True), name="www")


def main():
    h = app_state.cfg["http"]
    uvicorn.run(api, host=h["host"], port=h["port"], log_level="warning")


if __name__ == "__main__":
    main()
