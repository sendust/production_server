"""File browser backend: two roots ('media' = CasparCG media path, 'host' = /mnt),
listing, mkdir/rename, and copy/move/delete as background jobs with progress."""
import asyncio
import errno
import itertools
import logging
import os
import shutil
import threading
import time
from pathlib import Path

from .media import kind_of

log = logging.getLogger("fs")

CHUNK = 8 * 1024 * 1024


class FsError(Exception):
    pass


class Conflict(FsError):
    def __init__(self, names: list[str]):
        super().__init__(f"{len(names)} item(s) already exist")
        self.names = names


class Roots:
    def __init__(self, media: str, host: str):
        self.roots = {"media": Path(media).resolve(), "host": Path(host).resolve()}

    def base(self, root: str) -> Path:
        if root not in self.roots:
            raise FsError(f"unknown root {root}")
        return self.roots[root]

    def abs(self, root: str, rel: str) -> Path:
        base = self.base(root)
        p = (base / (rel or "").lstrip("/")).resolve()
        if p != base and base not in p.parents:
            raise FsError("path outside root")
        return p

    def rel(self, root: str, p: Path) -> str:
        return str(p.relative_to(self.base(root)))

    def list(self, root: str, rel: str) -> list[dict]:
        base = self.abs(root, rel)
        if not base.is_dir():
            raise FsError(f"not a directory: {rel}")
        out = []
        with os.scandir(base) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    st = e.stat()
                    isdir = e.is_dir()
                except OSError:
                    continue
                out.append({"name": e.name, "dir": isdir, "kind": None if isdir else kind_of(e.name),
                            "size": 0 if isdir else st.st_size, "mtime": int(st.st_mtime),
                            "path": self.rel(root, Path(e.path))})
        return out

    def mkdir(self, root: str, rel_dir: str, name: str) -> str:
        _check_name(name)
        p = self.abs(root, rel_dir) / name
        p.mkdir()
        return self.rel(root, p)

    def rename(self, root: str, rel: str, name: str) -> str:
        _check_name(name)
        src = self.abs(root, rel)
        if src == self.base(root):
            raise FsError("cannot rename root")
        dst = src.with_name(name)
        if dst.exists():
            raise Conflict([name])
        src.rename(dst)
        return self.rel(root, dst)


def _check_name(name: str):
    if not name or name in (".", "..") or "/" in name or "\0" in name:
        raise FsError(f"invalid name: {name!r}")


def _tree_size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    total = 0
    for dp, _, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dp, f))
            except OSError:
                pass
    return total


class Job:
    _ids = itertools.count(1)

    def __init__(self, kind: str, desc: str, src: str = "", dst: str = ""):
        self.id = next(self._ids)
        self.kind, self.desc = kind, desc
        self.src, self.dst = src, dst
        self.status = "running"   # running | done | error | cancelled
        self.total = 0
        self.done = 0
        self.current = ""
        self.error = ""
        self.started = time.time()
        self.cancel = threading.Event()

    def view(self) -> dict:
        return {"id": self.id, "kind": self.kind, "desc": self.desc, "src": self.src, "dst": self.dst,
                "status": self.status, "total": self.total,
                "done": self.done, "current": self.current, "error": self.error, "started": self.started}


class Jobs:
    """Runs copy/move/delete in worker threads; emit(msg) pushes progress to WebSocket clients."""

    def __init__(self, roots: Roots, emit):
        self.roots = roots
        self.emit = emit
        self.jobs: dict[int, Job] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    def list(self) -> list[dict]:
        return [j.view() for j in self.jobs.values()]

    def _push(self, job: Job, final: bool = False):
        msg = {"type": "job", "job": job.view()}
        if final:
            msg["refresh"] = True
        self.loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.emit(msg)))

    def _start(self, job: Job, fn):
        self.loop = asyncio.get_running_loop()
        self.jobs[job.id] = job
        # forget finished jobs after a while
        for jid in [k for k, j in self.jobs.items() if j.status != "running" and time.time() - j.started > 3600]:
            self.jobs.pop(jid, None)

        def run():
            try:
                fn(job)
                job.status = "cancelled" if job.cancel.is_set() else "done"
            except Exception as e:  # report every failure to the UI
                job.status, job.error = "error", str(e)
                log.warning("job %s failed: %s", job.id, e)
            job.current = ""
            self._push(job, final=True)

        threading.Thread(target=run, daemon=True, name=f"job-{job.id}").start()
        self._push(job)
        return job.view()

    def cancel(self, jid: int):
        j = self.jobs.get(jid)
        if j:
            j.cancel.set()

    # ---- copy / move -------------------------------------------------------
    def transfer(self, move: bool, src_root: str, paths: list[str], dst_root: str, dst_dir: str, overwrite: bool):
        srcs = [self.roots.abs(src_root, p) for p in paths]
        dst = self.roots.abs(dst_root, dst_dir)
        if not dst.is_dir():
            raise FsError("destination is not a directory")
        for s in srcs:
            if s == self.roots.base(src_root):
                raise FsError("cannot copy/move a root")
            if s == dst or s in dst.parents:
                raise FsError(f"cannot {('move' if move else 'copy')} {s.name} into itself")
            if s.parent == dst:
                raise FsError(f"{s.name} is already in the destination")
        conflicts = [s.name for s in srcs if (dst / s.name).exists()]
        if conflicts and not overwrite:
            raise Conflict(conflicts)
        names = ", ".join(s.name for s in srcs[:3]) + (f" +{len(srcs) - 3}" if len(srcs) > 3 else "")
        job = Job("move" if move else "copy", f"{names} → {dst_root}:/{dst_dir}",
                  src=", ".join(str(x) for x in srcs[:3]) + (f" +{len(srcs) - 3}" if len(srcs) > 3 else ""), dst=str(dst))

        def run(job: Job):
            job.total = sum(_tree_size(s) for s in srcs)
            last = [0.0]

            def progress(n):
                job.done += n
                if time.monotonic() - last[0] > 0.3:
                    last[0] = time.monotonic()
                    self._push(job)

            for s in srcs:
                if job.cancel.is_set():
                    return
                target = dst / s.name
                if move:
                    try:
                        if target.exists():
                            _remove(target)
                        os.rename(s, target)   # same filesystem: instant
                        job.done += _tree_size(target)
                        continue
                    except OSError as e:
                        if e.errno != errno.EXDEV:
                            raise
                _copy_tree(s, target, job, progress)
                if move and not job.cancel.is_set():
                    _remove(s)

        return self._start(job, run)

    def delete(self, root: str, paths: list[str]):
        targets = [self.roots.abs(root, p) for p in paths]
        for t in targets:
            if t == self.roots.base(root):
                raise FsError("cannot delete root")
        job = Job("delete", ", ".join(t.name for t in targets[:3]) + (f" +{len(targets) - 3}" if len(targets) > 3 else ""))

        def run(job: Job):
            job.total = len(targets)
            errors = []
            for t in targets:
                if job.cancel.is_set():
                    return
                job.current = t.name
                try:
                    if t.exists() or t.is_symlink():
                        _remove(t)
                except OSError as e:
                    errors.append(f"{t.name}: {e.strerror or e}")
                job.done += 1
            if errors:
                raise FsError("; ".join(errors[:5]))

        return self._start(job, run)


def _remove(p: Path):
    if p.is_dir() and not p.is_symlink():
        shutil.rmtree(p)
    else:
        p.unlink()


def _copy_file(src: Path, dst: Path, job: Job, progress):
    job.current = src.name
    tmp = dst.with_name(f".{dst.name}.part")
    try:
        with open(src, "rb") as fi, open(tmp, "wb") as fo:
            while not job.cancel.is_set():
                b = fi.read(CHUNK)
                if not b:
                    break
                fo.write(b)
                progress(len(b))
        if job.cancel.is_set():
            tmp.unlink(missing_ok=True)
            return
        shutil.copystat(src, tmp)
        tmp.replace(dst)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _copy_tree(src: Path, dst: Path, job: Job, progress):
    if src.is_dir():
        dst.mkdir(exist_ok=True)
        for child in sorted(src.iterdir()):
            if job.cancel.is_set():
                return
            _copy_tree(child, dst / child.name, job, progress)
    else:
        _copy_file(src, dst, job, progress)
