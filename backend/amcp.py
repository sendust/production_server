"""Async AMCP client: one persistent TCP connection, commands serialized, auto-reconnect.

CasparCG also sends OSC to every connected AMCP client's IP (UDP default-port 6250),
so keeping this connection open is what feeds the OSC receiver.
"""
import asyncio
import logging
import time

log = logging.getLogger("amcp")
IO_TIMEOUT = 8.0   # whole command/response exchange
RESPONSIVE_SEC = 6.0   # keepalive PINGs every 2 s: no answer for this long = not responsive


class AmcpError(Exception):
    def __init__(self, code: int, text: str):
        super().__init__(f"{code} {text}")
        self.code = code
        self.text = text


def quote(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


class Amcp:
    def __init__(self, host: str, port: int, on_state=None):
        self.host, self.port = host, port
        self.on_state = on_state or (lambda connected: None)
        self._reader = self._writer = None
        self._lock = asyncio.Lock()
        self.connected = False
        self.last_ok = 0.0   # monotonic time of the last answered command
        self._task = None

    @property
    def responsive(self) -> bool:
        """Connected AND answering. A crashed CasparCG that is still writing its core dump keeps
        port 5250 open (TCP connects fine) but never answers -- that must not count as ON."""
        return self.connected and time.monotonic() - self.last_ok < RESPONSIVE_SEC

    def start(self):
        self._task = asyncio.create_task(self._keepalive())

    async def stop(self):
        if self._task:
            self._task.cancel()
        await self._close()

    async def _close(self):
        if self._writer:
            self._writer.close()
        self._reader = self._writer = None
        if self.connected:
            self.connected = False
            self.on_state(False)

    async def _connect(self):
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.port), 3)
        self.connected = True
        log.info("connected %s:%s", self.host, self.port)
        self.on_state(True)

    async def _keepalive(self):
        while True:
            try:
                if not self.connected:
                    async with self._lock:
                        await self._connect()
                else:
                    await self.send("PING")
            except asyncio.CancelledError:
                raise
            except Exception as e:   # never let the keepalive die: it is what reconnects after a CasparCG restart
                log.warning("keepalive: %s", e)
                await self._close()
            await asyncio.sleep(2)

    async def _readline(self) -> str:
        line = await asyncio.wait_for(self._reader.readline(), 5)
        if not line:
            raise ConnectionError("AMCP connection closed")
        return line.decode("utf-8", "replace").rstrip("\r\n")

    async def send(self, cmd: str) -> list[str]:
        """Send one command; return data lines. Raises AmcpError on 4xx/5xx."""
        async with self._lock:
            if not self.connected:
                try:
                    await self._connect()
                except (OSError, asyncio.TimeoutError) as e:
                    raise AmcpError(0, f"not connected: {e}")
            try:
                # one deadline for the whole exchange: a peer that stops reading (CasparCG hung or
                # writing a core dump) must not hold the lock -- and so every command -- forever
                head, data = await asyncio.wait_for(self._exchange(cmd), IO_TIMEOUT)
                self.last_ok = time.monotonic()
            except (OSError, asyncio.TimeoutError, ConnectionError) as e:
                await self._close()
                raise AmcpError(0, f"io error: {e!r}")
            if cmd != "PING":
                log.info("%s -> %s", cmd, head)
            return data

    async def _exchange(self, cmd: str) -> tuple[str, list[str]]:
        self._writer.write((cmd + "\r\n").encode("utf-8"))
        await self._writer.drain()
        head = await self._readline()
        if head == "PONG":  # CasparCG answers PING without a status code
            return head, []
        code = int(head[:3]) if head[:3].isdigit() else 0
        data: list[str] = []
        if code == 200:
            while (ln := await self._readline()) != "":
                data.append(ln)
        elif code == 201:
            data.append(await self._readline())
        elif code >= 400 or code == 0:
            raise AmcpError(code, f"{head} <- {cmd}")
        return head, data
