"""Ring buffer of all backend log records for the log viewer (www/log.html), pushed live over /ws."""
import asyncio
import logging
import re
import time
from collections import deque

SIZE = 2000
_CH = re.compile(r"^\[([^\]]+)\] ")


class LogHub(logging.Handler):
    def __init__(self, emit):
        super().__init__(logging.INFO)
        self.emit_ws = emit           # async callable(msg)
        self.buf: deque = deque(maxlen=SIZE)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.seq = 0

    def emit(self, record: logging.LogRecord):
        try:
            msg = record.getMessage()
        except Exception:
            msg = str(record.msg)
        src = record.name
        m = _CH.match(msg)
        if m and record.name == "player":     # "[PLAY 1] ..." -> source PLAY 1
            src, msg = m.group(1), msg[m.end():]
        if record.exc_info:
            msg += " | " + self.format(record).splitlines()[-1]
        self.seq += 1
        e = {"id": self.seq, "t": record.created, "level": record.levelname, "src": src, "msg": msg}
        self.buf.append(e)
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.emit_ws({"type": "syslog", "entry": e})))

    def recent(self, n: int = 500) -> list[dict]:
        return list(self.buf)[-n:]
