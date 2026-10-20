#!/usr/bin/env python3
"""okaychat code sandbox: runs model-written Python and Bash for the app over a small HTTP API.

One container serves every user. Isolation inside it comes from these rules (docs/research/code-sandbox.md):
- Each workspace (one per chat) is a 0700 directory owned by its own unprivileged uid, so runs cannot
  read each other's files, and RLIMIT_NPROC counts only that workspace's processes.
- Runs in a workspace are serialized. After each run every process of its uid is killed, so nothing
  survives into the next run or races a file download.
- Per-run limits: wall time, CPU, address space, file size, open files, processes, output size, and a
  workspace size watchdog.
- The runner is the only root process. Children get a fixed environment without the API token.
"""

import hmac
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

TOKEN = os.environ.pop("SANDBOX_TOKEN", "")
PORT = int(os.environ.get("SANDBOX_PORT", "8080"))
ROOT = os.environ.get("SANDBOX_ROOT", "/work")
MAX_TIMEOUT = int(os.environ.get("SANDBOX_MAX_TIMEOUT", "300"))
MEMORY_MB = int(os.environ.get("SANDBOX_MEMORY_MB", "2048"))
WORKSPACE_MB = int(os.environ.get("SANDBOX_WORKSPACE_MB", "1024"))
MAX_PROCS = int(os.environ.get("SANDBOX_MAX_PROCS", "64"))
CONCURRENCY = int(os.environ.get("SANDBOX_CONCURRENCY", "4"))
TTL_DAYS = float(os.environ.get("SANDBOX_TTL_DAYS", "14"))
OUTPUT_HEAD = 48 * 1024
OUTPUT_TAIL = 16 * 1024
MAX_UPLOAD = 50 * 1024 * 1024
MAX_LISTED = 500
UID_MIN, UID_MAX = 20000, 29999
PRIVATE = ".okaychat"  # Script, tmp, and caches. Counted toward the size limit, hidden from listings.
HIDDEN = {PRIVATE, ".cache"}
WS_RE = re.compile(r"^[a-f0-9]{16,64}$")

uid_lock = threading.Lock()
used_uids: set[int] = set()
ws_locks: dict[str, threading.Lock] = {}
ws_locks_guard = threading.Lock()
run_slots = threading.BoundedSemaphore(CONCURRENCY)
cancelled: set[str] = set()


class Failure(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def ws_lock(ws: str) -> threading.Lock:
    with ws_locks_guard:
        return ws_locks.setdefault(ws, threading.Lock())


def ws_path(ws: str) -> str:
    if not WS_RE.match(ws):
        raise Failure(400, "invalid workspace id")
    return os.path.join(ROOT, ws)


def ensure_workspace(ws: str) -> tuple[str, int]:
    path = ws_path(ws)
    try:
        return path, os.lstat(path).st_uid
    except FileNotFoundError:
        pass
    with uid_lock:
        uid = next((u for u in range(UID_MIN, UID_MAX + 1) if u not in used_uids), None)
        if uid is None:
            raise Failure(503, "no free sandbox users; delete old chats")
        used_uids.add(uid)
    os.mkdir(path, 0o700)
    os.chown(path, uid, uid)
    return path, uid


def private_dir(path: str, uid: int) -> str:
    """Recreate the runner's directory if workspace code replaced it, e.g. with a symlink elsewhere."""
    private = os.path.join(path, PRIVATE)
    try:
        st = os.lstat(private)
        if not (os.path.isdir(private) and not os.path.islink(private) and st.st_uid == uid):
            if os.path.isdir(private) and not os.path.islink(private):
                shutil.rmtree(private, ignore_errors=True)
            else:
                os.unlink(private)
            raise FileNotFoundError
    except FileNotFoundError:
        os.mkdir(private, 0o700)
        os.chown(private, uid, uid, follow_symlinks=False)
    tmp = os.path.join(private, "tmp")
    if not os.path.lexists(tmp):
        os.mkdir(tmp, 0o700)
        os.chown(tmp, uid, uid, follow_symlinks=False)
    return private


def write_owned(full: str, data: bytes, uid: int) -> None:
    """Root writes into a user's directory. Never follow a symlink the user planted."""
    if os.path.islink(full):
        os.unlink(full)
    fd = os.open(full, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(fd, uid, uid)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)


def uid_pids(uid: int) -> list[int]:
    # The real uid from status, not the /proc entry owner: a process that makes itself non-dumpable
    # shows up as root-owned there.
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/status", encoding="ascii", errors="replace") as f:
                for line in f:
                    if line.startswith("Uid:"):
                        if uid in (int(v) for v in line.split()[1:]):
                            pids.append(int(entry))
                        break
        except (FileNotFoundError, ProcessLookupError, ValueError):
            pass
    return pids


def kill_uid(uid: int) -> None:
    """Kill every process of a workspace user. Repeats because a process can fork while we scan."""
    for _ in range(50):
        pids = uid_pids(uid)
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.02)


def clean_shared_tmp(uid: int) -> None:
    for base in ("/tmp", "/dev/shm"):
        try:
            entries = os.listdir(base)
        except OSError:
            continue
        for name in entries:
            full = os.path.join(base, name)
            try:
                if os.lstat(full).st_uid != uid:
                    continue
                if os.path.isdir(full) and not os.path.islink(full):
                    shutil.rmtree(full, ignore_errors=True)
                else:
                    os.unlink(full)
            except OSError:
                pass


def walk(path: str):
    """Yield (relative path, size, mtime) for regular files without following symlinks."""
    stack = [""]
    while stack:
        rel = stack.pop()
        try:
            entries = list(os.scandir(os.path.join(path, rel)))
        except OSError:
            continue
        for entry in entries:
            child = f"{rel}/{entry.name}" if rel else entry.name
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(child)
                elif entry.is_file(follow_symlinks=False):
                    st = entry.stat(follow_symlinks=False)
                    yield child, st.st_size, st.st_mtime_ns
            except OSError:
                pass


def workspace_bytes(path: str) -> int:
    return sum(size for _, size, _ in walk(path))


def visible(rel: str) -> bool:
    return rel.split("/", 1)[0] not in HIDDEN


def snapshot(path: str) -> dict[str, tuple[int, int]]:
    return {rel: (size, mtime) for rel, size, mtime in walk(path) if visible(rel)}


class Capture:
    """Keeps the head and tail of a stream and counts what was dropped in between."""

    def __init__(self) -> None:
        self.head = bytearray()
        self.tail = bytearray()
        self.dropped = 0

    def feed(self, chunk: bytes) -> None:
        room = OUTPUT_HEAD - len(self.head)
        if room > 0:
            self.head += chunk[:room]
            chunk = chunk[room:]
        if chunk:
            self.tail += chunk
            if len(self.tail) > OUTPUT_TAIL:
                self.dropped += len(self.tail) - OUTPUT_TAIL
                del self.tail[: len(self.tail) - OUTPUT_TAIL]

    def text(self) -> str:
        head = self.head.decode("utf-8", "replace")
        if not self.tail:
            return head
        gap = f"\n[... {self.dropped} bytes omitted ...]\n" if self.dropped else ""
        return head + gap + self.tail.decode("utf-8", "replace")


def pump(stream, capture: Capture) -> None:
    while chunk := stream.read(65536):
        capture.feed(chunk)
    stream.close()


def child_env(path: str) -> dict[str, str]:
    private = os.path.join(path, PRIVATE)
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": path,
        "TMPDIR": os.path.join(private, "tmp"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "dumb",
        "MPLBACKEND": "Agg",
        "MPLCONFIGDIR": os.path.join(private, "matplotlib"),
        "XDG_CACHE_HOME": os.path.join(private, "cache"),
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PYTHONUNBUFFERED": "1",
        # Numeric libraries otherwise start one thread per host core and hit the process limit.
        "OMP_NUM_THREADS": "2",
        "OPENBLAS_NUM_THREADS": "2",
        "MKL_NUM_THREADS": "2",
    }


def run(ws: str, language: str, code: str, timeout: int) -> dict:
    if language not in ("python", "bash"):
        raise Failure(400, "language must be python or bash")
    timeout = max(1, min(int(timeout), MAX_TIMEOUT))
    if not run_slots.acquire(timeout=30):
        raise Failure(503, "the sandbox is busy; try again")
    try:
        with ws_lock(ws):
            path, uid = ensure_workspace(ws)
            limit = WORKSPACE_MB * 1024 * 1024
            if workspace_bytes(path) > limit:
                raise Failure(409, f"workspace is over {WORKSPACE_MB} MB; delete files before running more code")
            cancelled.discard(ws)
            os.utime(path)
            before = snapshot(path)
            script = os.path.join(private_dir(path, uid), "main.py" if language == "python" else "main.sh")
            write_owned(script, code.encode("utf-8"), uid)
            interpreter = ["python3", script] if language == "python" else ["bash", script]
            # prlimit runs as the workspace user and lowers its own limits before exec.
            command = [
                "prlimit",
                f"--as={MEMORY_MB * 1024 * 1024}",
                f"--cpu={timeout + 5}",
                f"--nproc={MAX_PROCS}",
                f"--fsize={limit}",
                "--nofile=256",
                "--core=0",
                "--",
                *interpreter,
            ]
            started = time.monotonic()
            proc = subprocess.Popen(
                command,
                cwd=path,
                env=child_env(path),
                user=uid,
                group=uid,
                extra_groups=[],
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                close_fds=True,
            )
            out, err = Capture(), Capture()
            readers = [threading.Thread(target=pump, args=(proc.stdout, out), daemon=True), threading.Thread(target=pump, args=(proc.stderr, err), daemon=True)]
            for r in readers:
                r.start()
            reason = None
            deadline = started + timeout
            next_size_check = started + 2
            while proc.poll() is None:
                now = time.monotonic()
                if now >= deadline:
                    reason = f"timed out after {timeout} s"
                    break
                if now >= next_size_check:
                    next_size_check = now + 2
                    if workspace_bytes(path) > limit:
                        reason = f"stopped: workspace exceeded {WORKSPACE_MB} MB"
                        break
                time.sleep(0.05)
            # Everything the run started dies with it, including background processes.
            kill_uid(uid)
            proc.wait()
            for r in readers:
                r.join(timeout=5)
            clean_shared_tmp(uid)
            after = snapshot(path)
            changed = [
                {"path": rel, "size": size}
                for rel, (size, mtime) in sorted(after.items())
                if before.get(rel) != (size, mtime)
            ]
            deleted = sorted(set(before) - set(after))
            code_ = proc.returncode
            if reason is None and ws in cancelled:
                reason = "cancelled"
            elif reason is None and code_ is not None and code_ < 0:
                sig = -code_
                reason = {signal.SIGXCPU: "CPU time limit", signal.SIGXFSZ: "file size limit", signal.SIGKILL: "killed (likely out of memory)"}.get(sig, f"signal {sig}")
            return {
                "exitCode": code_,
                "stdout": out.text(),
                "stderr": err.text(),
                "stopped": reason,
                "durationMs": round((time.monotonic() - started) * 1000),
                "files": changed[:MAX_LISTED],
                "deleted": deleted[:MAX_LISTED],
            }
    finally:
        run_slots.release()


def split_path(rel: str) -> list[str]:
    parts = rel.strip().lstrip("/").split("/")
    if not rel.strip() or "\0" in rel or any(part in ("", ".", "..") for part in parts) or parts[0] in HIDDEN:
        raise Failure(400, "invalid path")
    return parts


def read_file(ws: str, rel: str) -> bytes:
    with ws_lock(ws):
        path, _ = ensure_workspace(ws)
        # Workspace code can plant symlinks. The real path must stay inside the workspace. No process of the
        # workspace user is alive while we hold its lock, so the check cannot be raced.
        real = os.path.realpath(os.path.join(path, *split_path(rel)))
        if not real.startswith(path + os.sep):
            raise Failure(403, "path leaves the workspace")
        if not os.path.isfile(real):
            raise Failure(404, "no such file")
        if os.path.getsize(real) > MAX_UPLOAD:
            raise Failure(413, "file is too large to download")
        with open(real, "rb") as f:
            return f.read()


def write_file(ws: str, rel: str, data: bytes) -> dict:
    with ws_lock(ws):
        path, uid = ensure_workspace(ws)
        parts = split_path(rel)
        current = path
        for part in parts[:-1]:
            current = os.path.join(current, part)
            if os.path.islink(current) or (os.path.lexists(current) and not os.path.isdir(current)):
                raise Failure(409, f"{part} is not a directory")
            if not os.path.lexists(current):
                os.mkdir(current, 0o700)
                os.chown(current, uid, uid, follow_symlinks=False)
        write_owned(os.path.join(current, parts[-1]), data, uid)
        return {"path": "/".join(parts), "size": len(data)}


def list_files(ws: str) -> dict:
    with ws_lock(ws):
        path, _ = ensure_workspace(ws)
        files = [{"path": rel, "size": size} for rel, (size, _) in sorted(snapshot(path).items())]
        return {"files": files[:MAX_LISTED], "total": len(files), "bytes": workspace_bytes(path)}


def delete_workspace(ws: str) -> None:
    path = ws_path(ws)
    with ws_lock(ws):
        try:
            uid = os.stat(path).st_uid
        except FileNotFoundError:
            return
        kill_uid(uid)
        clean_shared_tmp(uid)
        shutil.rmtree(path, ignore_errors=True)
        with uid_lock:
            used_uids.discard(uid)


def expire_loop() -> None:
    while True:
        cutoff = time.time() - TTL_DAYS * 86400
        for name in os.listdir(ROOT):
            try:
                if WS_RE.match(name) and os.stat(os.path.join(ROOT, name)).st_mtime < cutoff:
                    delete_workspace(name)
            except OSError:
                pass
        time.sleep(3600)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # Paths contain workspace ids only, never code. Keep logs quiet anyway.
        pass

    def reply(self, status: int, body: bytes, kind: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json(self, status: int, value) -> None:
        self.reply(status, json.dumps(value).encode())

    def body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise Failure(413, "request body is too large")
        return self.rfile.read(length)

    def handle_any(self, method: str) -> None:
        url = urlsplit(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        parts = [p for p in url.path.split("/") if p]
        try:
            if method == "GET" and parts == ["health"]:
                return self.json(200, {"ok": True})
            supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if not TOKEN or not hmac.compare_digest(supplied.encode(), TOKEN.encode()):
                raise Failure(401, "unauthorized")
            if len(parts) < 2 or parts[0] != "workspaces":
                raise Failure(404, "not found")
            ws = parts[1]
            ws_path(ws)
            action = parts[2] if len(parts) > 2 else None
            if method == "POST" and action == "run":
                req = json.loads(self.body(2 * 1024 * 1024) or b"{}")
                return self.json(200, run(ws, req.get("language", ""), str(req.get("code", "")), req.get("timeout", 60)))
            if method == "POST" and action == "cancel":
                # No lock: the run holding it sees its process exit and finishes normally.
                if os.path.isdir(ws_path(ws)):
                    cancelled.add(ws)
                    kill_uid(os.lstat(ws_path(ws)).st_uid)
                return self.json(200, {"ok": True})
            if method == "GET" and action == "files" and "path" in query:
                return self.reply(200, read_file(ws, query["path"]), "application/octet-stream")
            if method == "GET" and action == "files":
                return self.json(200, list_files(ws))
            if method == "PUT" and action == "files" and "path" in query:
                return self.json(200, write_file(ws, query["path"], self.body(MAX_UPLOAD)))
            if method == "DELETE" and action is None:
                delete_workspace(ws)
                return self.json(200, {"ok": True})
            raise Failure(404, "not found")
        except Failure as e:
            self.json(e.status, {"error": str(e)})
        except Exception as e:  # The app shows this to the model. It never contains the token.
            self.json(500, {"error": f"sandbox error: {type(e).__name__}"})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_DELETE(self):
        self.handle_any("DELETE")


def main() -> None:
    if len(TOKEN) < 32:
        raise SystemExit("SANDBOX_TOKEN must be at least 32 characters")
    os.makedirs(ROOT, exist_ok=True)
    os.chmod(ROOT, 0o711)  # Users can enter their own workspace but not list the others.
    for name in os.listdir(ROOT):
        try:
            if WS_RE.match(name):
                used_uids.add(os.stat(os.path.join(ROOT, name)).st_uid)
        except OSError:
            pass
    threading.Thread(target=expire_loop, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
