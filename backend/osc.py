"""Minimal OSC 1.0 UDP receiver (no dependency). Calls handler(address, args) per message."""
import asyncio
import struct


def _str(b: bytes, i: int):
    j = b.index(b"\0", i)
    return b[i:j].decode("utf-8", "replace"), (j + 4) & ~3


def parse(b: bytes):
    if b.startswith(b"#bundle\0"):
        i = 16
        while i + 4 <= len(b):
            n = struct.unpack_from(">i", b, i)[0]
            yield from parse(b[i + 4:i + 4 + n])
            i += 4 + n
        return
    addr, i = _str(b, 0)
    if i >= len(b):
        yield addr, []
        return
    tags, i = _str(b, i)
    args = []
    for c in tags[1:]:
        if c == "i":
            args.append(struct.unpack_from(">i", b, i)[0]); i += 4
        elif c == "f":
            args.append(struct.unpack_from(">f", b, i)[0]); i += 4
        elif c == "h":
            args.append(struct.unpack_from(">q", b, i)[0]); i += 8
        elif c == "d":
            args.append(struct.unpack_from(">d", b, i)[0]); i += 8
        elif c == "s":
            s, i = _str(b, i); args.append(s)
        elif c == "T":
            args.append(True)
        elif c == "F":
            args.append(False)
        elif c == "N":
            args.append(None)
        elif c == "b":
            n = struct.unpack_from(">i", b, i)[0]
            args.append(b[i + 4:i + 4 + n]); i += (4 + n + 3) & ~3
    yield addr, args


class _Proto(asyncio.DatagramProtocol):
    def __init__(self, handler):
        self.handler = handler

    def datagram_received(self, data, addr):
        try:
            for a, args in parse(data):
                self.handler(a, args, addr)
        except (ValueError, struct.error):
            pass


async def listen(port: int, handler, host: str = "0.0.0.0"):
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(lambda: _Proto(handler), local_addr=(host, port))
    return transport
