#!/usr/bin/env python3
"""okaychat code sandbox: runs model-written Python and Bash for the app over a small HTTP API.

One container serves every user. Isolation inside it comes from these rules (docs/implementation/code-sandbox.md):
- Every run starts inside bubblewrap with its own user, network, IPC, UTS, and mount namespaces. The
  network namespace has only its own loopback, so run code reaches nothing: not the internet, DNS, the app,
  this runner's port, or another run's listeners and abstract sockets. The mount namespace shows the read-only
  system, the run's own workspace, and private /tmp and /dev/shm, never other workspaces. A seccomp filter
  (inner.bpf) keeps run code from creating namespaces, mounting, or opening non-namespaced socket families.
- Each workspace (one per chat) is a 0700 directory owned by its own unprivileged uid, so runs cannot
  read each other's files, and RLIMIT_NPROC counts only that workspace's processes.
- Runs in a workspace are serialized. After each run every process of its uid is killed, so nothing
  survives into the next run or races a file download.
- Per-run limits: wall time, CPU, address space, file size, open files, processes, output size, and a
  workspace size watchdog that also counts the run's temporary files.
- The runner is the only root process. Children get a fixed environment without the API token.
- If the namespaces cannot be created, the runner refuses every run (fail closed) and /health says why.
"""

import errno
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import stat
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
# Scratch space only: a workspace idle past this grace period is wiped completely. The app copies
# produced files into its own storage right after each run, so nothing of value is lost.
IDLE_MINUTES = float(os.environ.get("SANDBOX_IDLE_MINUTES", "30"))
OUTPUT_HEAD = 48 * 1024
OUTPUT_TAIL = 16 * 1024
FUNCTION_STDOUT_LIMIT = 32 * 1024
FUNCTION_STDERR_LIMIT = 8 * 1024
FUNCTION_MAX_BODY = 128 * 1024
FUNCTION_SLOT_WAIT = 2
MAX_UPLOAD = 50 * 1024 * 1024
MAX_LISTED = 500
UID_MIN, UID_MAX = 20000, 29999
PROBE_UID = 19999  # Runs the startup isolation check; never a workspace user.
# How long a run may wait for an earlier run in the same chat, and for a free slot.
LOCK_WAIT = MAX_TIMEOUT + 30
SLOT_WAIT = 30
CONVERT_TIMEOUT = int(os.environ.get("SANDBOX_CONVERT_TIMEOUT", "120"))
CANCEL_TTL = 15 * 60
INNER_SECCOMP = os.environ.get("SANDBOX_SECCOMP", "/opt/sandbox/inner.bpf")
# Formats the app may hand to /convert. LibreOffice Impress turns them into a PDF for visual checks.
CONVERTIBLE = {".pptx", ".ppt", ".pps", ".ppsx", ".odp"}
PRIVATE = ".okaychat"  # Script, tmp, and caches. Counted toward the size limit, hidden from listings.
HIDDEN = {PRIVATE, ".cache"}
# Installed packages and build caches, not results: never listed as outputs, so they stay out of the chat and
# the Library. Directories starting with a dot (.local, .venv, .npm) are skipped too; dotfiles themselves are not.
DEPENDENCY_DIRS = {"node_modules", "__pycache__", "site-packages", "dist-packages", "venv"}
WS_RE = re.compile(r"^[a-f0-9]{16,64}$")

uid_lock = threading.Lock()
used_uids: set[int] = set()
ws_locks: dict[str, threading.Lock] = {}
ws_locks_guard = threading.Lock()
run_slots = threading.BoundedSemaphore(CONCURRENCY)
# Jobs are named by the app, so a cancel that arrives before its run (or while it queues) still applies.
jobs_guard = threading.Lock()
queued: dict[str, str] = {}  # job id -> workspace, from arrival until the job ends
running: dict[str, str] = {}  # workspace -> job id of the run holding its processes
cancelled_jobs: dict[str, float] = {}  # job id -> expiry
# A function workspace is used exactly once; a second call is rejected instead of re-running in it.
function_workspaces: set[str] = set()
# Set at startup when bubblewrap cannot build a run's namespaces. Every run is refused while it is set.
isolation_error: str | None = "isolation check has not run yet"


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
    home = os.path.join(private, "home")
    if not os.path.lexists(home):
        os.mkdir(home, 0o700)
        os.chown(home, uid, uid, follow_symlinks=False)
    return private


def write_owned(full: str, data: bytes, uid: int) -> None:
    """Root writes into a user's directory. Never follow a symlink the user planted."""
    try:
        # A planted FIFO or device would block or misdirect the write, so only regular files stay.
        if not stat.S_ISREG(os.lstat(full).st_mode):
            os.unlink(full)
    except FileNotFoundError:
        pass
    fd = os.open(full, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Failure(400, "refusing to write over a special file")
        os.ftruncate(fd, 0)
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
    dirs = rel.split("/")[:-1]
    return rel.split("/", 1)[0] not in HIDDEN and not any(d.startswith(".") or d in DEPENDENCY_DIRS for d in dirs)


def snapshot(path: str) -> dict[str, tuple[int, int]]:
    files = {rel: (size, mtime) for rel, size, mtime in walk(path) if visible(rel)}
    # A virtualenv can have any name; its pyvenv.cfg marks it.
    envs = [rel[: -len("pyvenv.cfg")] for rel in files if rel.endswith("/pyvenv.cfg")]
    return {rel: v for rel, v in files.items() if not any(rel.startswith(env) for env in envs)}


class StrictCapture:
    """Exact bounded capture for the function protocol: no splicing, and an overflow is a hard stop.

    A truncated head is never valid JSON, so head/tail splicing is deliberately not reused here.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.data = bytearray()
        self.overflow = False

    def feed(self, chunk: bytes) -> None:
        if self.overflow:
            return
        room = self.limit - len(self.data)
        if len(chunk) > room:
            self.data += chunk[: max(room, 0)]
            self.overflow = True
            return
        self.data += chunk

    def text(self) -> str:
        return self.data.decode("utf-8", "replace")


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
        # Tools installed with pip or uv land in ~/.local/bin.
        "PATH": f"{os.path.join(private, 'home', '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin",
        # Not the workspace: pip --user, uv, and npm install under HOME, and those files are not results.
        "HOME": os.path.join(private, "home"),
        # /tmp and /dev/shm are the run's own directories, deleted when it ends. The soffice wrapper keeps each
        # LibreOffice profile there too.
        "TMPDIR": "/tmp",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "dumb",
        "MPLBACKEND": "Agg",
        "MPLCONFIGDIR": os.path.join(private, "matplotlib"),
        "XDG_CACHE_HOME": os.path.join(private, "cache"),
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PYTHONUNBUFFERED": "1",
        # Numeric libraries and Tesseract otherwise start one thread per host core and hit the process limit.
        "OMP_NUM_THREADS": "2",
        "OMP_THREAD_LIMIT": "2",
        "OPENBLAS_NUM_THREADS": "2",
        "MKL_NUM_THREADS": "2",
        "NUMEXPR_MAX_THREADS": "2",
        # Each glibc arena reserves address space, which counts against the per-process limit.
        "MALLOC_ARENA_MAX": "2",
    }


def feed(stream, data: bytes) -> None:
    try:
        stream.write(data)
    except (BrokenPipeError, OSError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


def run_dir(path: str, uid: int) -> str:
    """A fresh per-run directory under the private area: the run's /tmp and /dev/shm. It counts toward the
    workspace size limit and is deleted when the run ends, however it ends."""
    base = os.path.join(private_dir(path, uid), "run")
    shutil.rmtree(base, ignore_errors=True)
    if os.path.lexists(base):
        os.unlink(base)
    for sub in ("", "tmp", "shm"):
        full = os.path.join(base, sub)
        os.mkdir(full, 0o700)
        os.chown(full, uid, uid, follow_symlinks=False)
    return base


def data_fd(text: str) -> int:
    fd = os.memfd_create("okaychat", 0)
    os.write(fd, text.encode())
    os.lseek(fd, 0, os.SEEK_SET)
    return fd


def jail(path: str, base: str, uid: int, command: list[str], fds: list[int]) -> list[str]:
    """Wraps a command in bubblewrap. Appends the descriptors it hands over to `fds`; bubblewrap reads and closes
    them before the command starts, so the command inherits only stdin, stdout, and stderr."""
    seccomp = os.open(INNER_SECCOMP, os.O_RDONLY)
    with open("/etc/passwd", encoding="utf-8") as f:
        passwd = f.read() + f"sandbox:x:{uid}:{uid}:sandbox:{os.path.join(path, PRIVATE, 'home')}:/bin/bash\n"
    with open("/etc/group", encoding="utf-8") as f:
        group = f.read() + f"sandbox:x:{uid}:\n"
    passwd_fd, group_fd = data_fd(passwd), data_fd(group)
    args = [
        "--unshare-user", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
        "--die-with-parent", "--new-session", "--cap-drop", "ALL",
        "--ro-bind", "/usr", "/usr",
        # Host AppArmor profiles attach by executable path (Ubuntu confines /usr/bin/gs and /usr/bin/qpdf to home
        # directories). The run sees /usr/bin and /usr/sbin as symlinks into a second mount of the same files, so
        # every executable runs from /usr/lib/okaychat-exec and no such profile matches. See exec-view.py.
        "--ro-bind", "/usr/bin", "/usr/lib/okaychat-exec/bin", "--ro-bind", "/usr/sbin", "/usr/lib/okaychat-exec/sbin",
        "--ro-bind", "/opt/sandbox/exec-view/bin", "/usr/bin", "--ro-bind", "/opt/sandbox/exec-view/sbin", "/usr/sbin",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
        "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
        "--ro-bind", "/etc", "/etc",
        "--ro-bind-data", str(passwd_fd), "/etc/passwd", "--ro-bind-data", str(group_fd), "/etc/group",
        "--ro-bind", "/var/cache/fontconfig", "/var/cache/fontconfig",
        "--ro-bind", "/opt/sandbox", "/opt/sandbox",
        # A fresh procfs needs a fully visible /proc, which Docker's masked paths rule out. The container's /proc
        # shows other runs' pids and command lines, never their environment, memory, or files. For the same reason
        # there is no pid namespace: its pids would not match this /proc, and it would hide nothing.
        "--ro-bind", "/proc", "/proc",
        "--dev", "/dev",
        "--bind", os.path.join(base, "tmp"), "/tmp", "--symlink", "/tmp", "/var/tmp",
        "--bind", os.path.join(base, "shm"), "/dev/shm",
        "--bind", path, path,
        # The jail's own root is a tmpfs; nothing outside the workspace, /tmp, and /dev/shm may be written.
        "--remount-ro", "/",
        "--chdir", path,
        "--seccomp", str(seccomp),
    ]
    # Every process's command line is visible to other runs (the shared /proc), so bubblewrap reads its options,
    # which name this workspace, from a descriptor. The command itself carries no paths or user data.
    args_fd = data_fd("".join(f"{arg}\0" for arg in args))
    fds += [seccomp, passwd_fd, group_fd, args_fd]
    return ["bwrap", "--args", str(args_fd), "--", *command]


def limits(timeout: int, fsize: int) -> list[str]:
    # prlimit runs as the workspace user and lowers its own limits before exec; bubblewrap and the run inherit them.
    return [
        "prlimit",
        f"--as={MEMORY_MB * 1024 * 1024}",
        f"--cpu={timeout + 5}",
        f"--nproc={MAX_PROCS}",
        f"--fsize={fsize}",
        "--nofile=256",
        "--core=0",
        "--",
    ]


def cancelled(job: str) -> bool:
    with jobs_guard:
        return job in cancelled_jobs


def cancel(ws: str, job: str | None) -> None:
    """Marks the job (or every job of the workspace) cancelled and kills it if it is running. A marked job that
    has not started yet never starts."""
    with jobs_guard:
        now = time.monotonic()
        for name, expiry in list(cancelled_jobs.items()):
            if expiry < now:
                del cancelled_jobs[name]
        targets = [job] if job else [name for name, owner in queued.items() if owner == ws]
        for name in targets:
            cancelled_jobs[name] = now + CANCEL_TTL
    # The running job's monitor sees the mark within 50 ms and kills its uid while it still owns the
    # workspace; killing here could hit a successor that already took the same uid.


def wait_for(acquire, job: str, seconds: float, busy: str, status: int = 503) -> None:
    """Waits for a lock or slot in short steps, so a cancelled job stops queueing at once."""
    deadline = time.monotonic() + seconds
    while not acquire(timeout=0.25):
        if cancelled(job):
            raise Cancelled()
        if time.monotonic() >= deadline:
            raise Failure(status, busy)


class Cancelled(Exception):
    pass


def execute(ws: str, path: str, uid: int, job: str, command: list[str], timeout: int, watch_limit: int, stdin: bytes | None = None, env: dict[str, str] | None = None, strict: bool = False) -> dict:
    """Runs one command in a fresh jail as the workspace user. The caller holds the workspace lock and a slot.

    `strict` is the function protocol: exact bounded captures and a hard kill on overflow.
    """
    if isolation_error and ws != "probe":
        raise Failure(503, f"run isolation is unavailable, so no code runs: {isolation_error}")
    base = run_dir(path, uid)
    # A workspace already over the limit may still run, so code can delete files; it only may not grow.
    allowed = max(watch_limit, workspace_bytes(path))
    fds: list[int] = []
    out = StrictCapture(FUNCTION_STDOUT_LIMIT) if strict else Capture()
    err = StrictCapture(FUNCTION_STDERR_LIMIT) if strict else Capture()
    started = time.monotonic()
    with jobs_guard:
        running[ws] = job
    try:
        argv = limits(timeout, watch_limit) + jail(path, base, uid, command, fds)
        proc = subprocess.Popen(
            argv,
            cwd=path,
            env={**child_env(path), **(env or {})},
            user=uid,
            group=uid,
            extra_groups=[],
            start_new_session=True,
            stdin=subprocess.DEVNULL if stdin is None else subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
            pass_fds=fds,
        )
        for fd in fds:
            os.close(fd)
        fds.clear()
        readers = [threading.Thread(target=pump, args=(proc.stdout, out), daemon=True), threading.Thread(target=pump, args=(proc.stderr, err), daemon=True)]
        if stdin is not None:
            readers.append(threading.Thread(target=feed, args=(proc.stdin, stdin), daemon=True))
        for r in readers:
            r.start()
        reason = None
        deadline = started + timeout
        next_size_check = started + 2
        while proc.poll() is None:
            now = time.monotonic()
            if cancelled(job):
                reason = "cancelled"
                break
            if now >= deadline:
                reason = f"timed out after {timeout} s"
                break
            if out.overflow or err.overflow:
                reason = "output limit exceeded"
                break
            if now >= next_size_check:
                next_size_check = now + 2
                if workspace_bytes(path) > allowed:
                    reason = f"stopped: workspace exceeded {WORKSPACE_MB} MB"
                    break
            time.sleep(0.05)
        # Everything the run started dies with it, including background processes.
        kill_uid(uid)
        proc.wait()
        for r in readers:
            r.join(timeout=5)
    finally:
        for fd in fds:
            os.close(fd)
        with jobs_guard:
            running.pop(ws, None)
        kill_uid(uid)
        clean_shared_tmp(uid)
    code_ = proc.returncode
    if reason is None and cancelled(job):
        reason = "cancelled"
    elif reason is None and code_ is not None and (code_ < 0 or code_ - 128 in LIMIT_SIGNALS):
        # bubblewrap passes a child's death by signal on as exit status 128 + signal, like a shell.
        sig = -code_ if code_ < 0 else code_ - 128
        reason = LIMIT_SIGNALS.get(sig, f"signal {sig}")
    stderr = err.text()
    # bubblewrap reports its own setup failures before the command starts; nothing of the run executed.
    if code_ == 1 and stderr.startswith("bwrap: ") and not getattr(out, "data", getattr(out, "head", b"")):
        raise Failure(503, f"run isolation failed, so the code did not run: {stderr.strip()}")
    result = {"exitCode": code_, "stdout": out.text(), "stderr": stderr, "stopped": reason, "durationMs": round((time.monotonic() - started) * 1000), "base": base}
    if strict:
        result["stdoutOverflow"] = out.overflow
        result["stderrOverflow"] = err.overflow
    return result


LIMIT_SIGNALS = {signal.SIGXCPU: "CPU time limit", signal.SIGXFSZ: "file size limit", signal.SIGKILL: "killed (likely out of memory)"}


def admitted(ws: str, job: str | None, work, slot_wait: float = SLOT_WAIT, busy_status: int = 503) -> dict:
    """Queues a job for its workspace and a slot, then runs `work(path, uid, job)` with both held."""
    job = job or secrets.token_hex(12)
    with jobs_guard:
        queued[job] = ws
    lock = ws_lock(ws)
    try:
        wait_for(lock.acquire, job, LOCK_WAIT, "another run in this chat is still going; try again")
        try:
            wait_for(run_slots.acquire, job, slot_wait, "busy" if busy_status == 429 else "the sandbox is busy; try again", busy_status)
            try:
                if cancelled(job):
                    raise Cancelled()
                path, uid = ensure_workspace(ws)
                return work(path, uid, job)
            finally:
                run_slots.release()
        finally:
            lock.release()
    finally:
        with jobs_guard:
            queued.pop(job, None)


def run(ws: str, language: str, code: str, timeout: int, job: str | None = None) -> dict:
    if ws in function_workspaces:
        raise Failure(409, "function workspaces accept only one function call")
    if language not in ("python", "bash"):
        raise Failure(400, "language must be python or bash")
    timeout = max(1, min(int(timeout), MAX_TIMEOUT))

    def work(path: str, uid: int, job: str) -> dict:
        limit = WORKSPACE_MB * 1024 * 1024
        os.utime(path)
        before = snapshot(path)
        script = os.path.join(private_dir(path, uid), "main.py" if language == "python" else "main.sh")
        write_owned(script, code.encode("utf-8"), uid)
        # Relative to the working directory, so the command line other runs can see does not name the workspace.
        relative = os.path.join(PRIVATE, os.path.basename(script))
        interpreter = ["python3", relative] if language == "python" else ["bash", relative]
        try:
            result = execute(ws, path, uid, job, interpreter, timeout, limit)
        finally:
            shutil.rmtree(os.path.join(path, PRIVATE, "run"), ignore_errors=True)
            os.utime(path)  # Idle retention starts when a run finishes, even after long runs.
        result.pop("base")
        after = snapshot(path)
        result["files"] = [
            {"path": rel, "size": size}
            for rel, (size, mtime) in sorted(after.items())
            if before.get(rel) != (size, mtime)
        ][:MAX_LISTED]
        result["deleted"] = sorted(set(before) - set(after))[:MAX_LISTED]
        return result

    try:
        return admitted(ws, job, work)
    except Cancelled:
        return {"exitCode": None, "stdout": "", "stderr": "", "stopped": "cancelled before it started", "durationMs": 0, "files": [], "deleted": []}


def convert(ws: str, name: str, data: bytes, job: str | None = None) -> bytes:
    """Turns a presentation into a PDF with LibreOffice, inside the same jail as a run. Input and output live in
    the run's private /tmp, so nothing appears among the chat's files."""
    if ws in function_workspaces:
        raise Failure(409, "function workspaces accept only one function call")
    ext = os.path.splitext(os.path.basename(name))[1]
    if ext.lower() not in CONVERTIBLE:
        raise Failure(400, f"only {', '.join(sorted(CONVERTIBLE))} files can be converted")

    def work(path: str, uid: int, job: str) -> bytes:
        limit = WORKSPACE_MB * 1024 * 1024
        if workspace_bytes(path) + len(data) > limit:
            raise Failure(409, f"the chat's sandbox workspace is over {WORKSPACE_MB} MB; delete files with run_code first")
        os.utime(path)
        try:
            # The input arrives on stdin: execute() creates the run directory, so nothing can be staged before it.
            # A fixed file name: other runs can see this command line, and the user's file name is not theirs to see.
            source = "input" + ext.lower()
            command = ["sh", "-c", 'mkdir -p /tmp/out && cat > "/tmp/$SOURCE" && exec soffice --headless --norestore --nolockcheck --convert-to pdf --outdir /tmp/out "/tmp/$SOURCE"']
            result = execute(ws, path, uid, job, command, CONVERT_TIMEOUT, limit, data, env={"SOURCE": source})
            if result["stopped"]:
                raise Failure(422, f"conversion {result['stopped']}")
            out = os.path.join(result["base"], "tmp", "out", "input.pdf")
            try:
                fd = os.open(out, os.O_RDONLY | os.O_NOFOLLOW)
            except OSError:
                detail = (result["stderr"] or result["stdout"]).strip()[-500:]
                raise Failure(422, f"LibreOffice could not convert the file{': ' + detail if detail else ''}")
            with os.fdopen(fd, "rb") as f:
                if os.fstat(f.fileno()).st_size > MAX_UPLOAD:
                    raise Failure(413, "the converted PDF is over 50 MB")
                return f.read()
        finally:
            shutil.rmtree(os.path.join(path, PRIVATE, "run"), ignore_errors=True)
            os.utime(path)

    try:
        return admitted(ws, job, work)
    except Cancelled:
        raise Failure(409, "the conversion was cancelled")


FUNCTION_WRAPPER = r"""
import contextlib
import importlib.util
import inspect
import json
import sys

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

def check(value):
    # Semantic walk before dumps: tuples, bytes, sets, non-string keys and unsafe numbers are rejected.
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return
    if isinstance(value, int):
        if not (-9007199254740991 <= value <= 9007199254740991):
            raise TypeError("integer outside the safe range")
        return
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise TypeError("non-finite number")
        return
    if isinstance(value, list):
        for item in value:
            check(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("mapping keys must be strings")
            check(item)
        return
    raise TypeError("result is not JSON data")

try:
    data = json.loads(sys.stdin.read())
except Exception:
    fail("invalid input")

try:
    spec = importlib.util.spec_from_file_location("okaychat_custom_tool", sys.argv[1])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
except Exception:
    fail("the code could not be loaded")

main = getattr(module, "main", None)
if not callable(main):
    fail("main is not callable")
if inspect.iscoroutinefunction(main) or inspect.isgeneratorfunction(main):
    fail("main must be a synchronous function")

try:
    with contextlib.redirect_stdout(sys.stderr):
        result = main(data)
    check(result)
    text = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
except SystemExit:
    raise
except Exception:
    fail("main raised an error")

# stdout carries exactly one JSON value; any earlier direct fd1 write makes the app reject it.
sys.stdout.write(text)
"""


def run_function(ws: str, code: str, input_text: str, timeout: int, job: str | None = None) -> dict:
    """One isolated Python function execution in a fresh one-use workspace."""
    if not isinstance(code, str) or not code or len(code.encode("utf-8")) > 64 * 1024 or "\0" in code:
        raise Failure(400, "invalid code")
    if not isinstance(input_text, str) or len(input_text.encode("utf-8")) > 16 * 1024:
        raise Failure(400, "invalid input")
    timeout = max(1, min(int(timeout), 30))
    with jobs_guard:
        if ws in function_workspaces:
            raise Failure(409, "function workspace already used")
        function_workspaces.add(ws)

    def work(path: str, uid: int, job: str) -> dict:
        limit = WORKSPACE_MB * 1024 * 1024
        os.utime(path)
        private = private_dir(path, uid)
        wrapper = os.path.join(private, "function_wrapper.py")
        module_path = os.path.join(private, "function_code.py")
        write_owned(wrapper, FUNCTION_WRAPPER.encode("utf-8"), uid)
        write_owned(module_path, code.encode("utf-8"), uid)
        command = ["python3", "-I", os.path.join(PRIVATE, "function_wrapper.py"), os.path.join(PRIVATE, "function_code.py")]
        try:
            result = execute(ws, path, uid, job, command, timeout, limit, input_text.encode("utf-8"), strict=True)
        finally:
            shutil.rmtree(os.path.join(path, PRIVATE, "run"), ignore_errors=True)
            # The whole workspace is deleted below; touching it keeps an idle sweep from racing.
            os.utime(path)
        result.pop("base", None)
        return {
            "exitCode": result.get("exitCode"),
            "stopped": result.get("stopped"),
            "durationMs": result.get("durationMs", 0),
            "stdout": result.get("stdout", ""),
            "stderr": result.get("stderr", ""),
            "stdoutOverflow": result.get("stdoutOverflow", False),
            "stderrOverflow": result.get("stderrOverflow", False),
        }

    try:
        return admitted(ws, job, work, slot_wait=FUNCTION_SLOT_WAIT, busy_status=429)
    except Cancelled:
        return {"exitCode": None, "stdout": "", "stderr": "", "stopped": "cancelled before it started", "durationMs": 0, "stdoutOverflow": False, "stderrOverflow": False}
    finally:
        delete_workspace(ws)


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


def delete_workspace(ws: str, idle_before: float | None = None) -> None:
    path = ws_path(ws)
    with ws_lock(ws):
        try:
            info = os.stat(path)
            if idle_before is not None and info.st_mtime >= idle_before:
                return
            uid = info.st_uid
        except FileNotFoundError:
            return
        kill_uid(uid)
        clean_shared_tmp(uid)
        shutil.rmtree(path, ignore_errors=True)
        function_workspaces.discard(ws)
        with uid_lock:
            used_uids.discard(uid)


def idle_loop() -> None:
    """Wipes workspaces idle past the grace period, along with their uid processes.

    Each run touches the workspace's mtime, so inactivity is measured from the last run. A workspace
    swept between two runs is simply recreated by the next one; produced files are already safe in
    the app's database.
    """
    while True:
        cutoff = time.time() - IDLE_MINUTES * 60
        try:
            names = os.listdir(ROOT)
        except OSError:
            names = []
        for name in names:
            try:
                if WS_RE.match(name) and os.stat(os.path.join(ROOT, name)).st_mtime < cutoff:
                    delete_workspace(name, idle_before=cutoff)
            except OSError:
                pass
        # Sweep at least four times within one grace period, but never busier than every 15 s.
        time.sleep(max(15.0, min(IDLE_MINUTES * 60 / 4, 300)))


def job_id(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", value):
        raise Failure(400, "invalid job id")
    return value


PROBE = r"""
import errno, json, os, socket
r = {"ifaces": sorted(l.split(":")[0].strip() for l in open("/proc/self/net/dev").readlines()[2:])}
status = dict(l.split(":", 1) for l in open("/proc/self/status") if ":" in l)
for key in ("CapEff", "CapPrm", "CapAmb", "NoNewPrivs", "Seccomp"):
    r[key] = status[key].strip()
def attempt(name, fn):
    try:
        fn()
        r[name] = "allowed"
    except OSError as e:
        r[name] = errno.errorcode.get(e.errno, str(e.errno))
attempt("inet", lambda: socket.create_connection(("192.0.2.1", 80), timeout=2))
attempt("runner", lambda: socket.create_connection(("127.0.0.1", int(os.environ["PROBE_PORT"])), timeout=2))
attempt("userns", lambda: os.unshare(os.CLONE_NEWUSER))
attempt("packet", lambda: socket.socket(socket.AF_PACKET, socket.SOCK_RAW))
attempt("vsock", lambda: socket.socket(40, socket.SOCK_STREAM))
r["fds"] = sorted(int(fd) for fd in os.listdir("/proc/self/fd"))
print(json.dumps(r))
"""
# What the probe must see. Anything else means the jail is not what the runner thinks it is.
PROBE_EXPECT = {"ifaces": ["lo"], "CapEff": "0000000000000000", "CapPrm": "0000000000000000", "CapAmb": "0000000000000000",
                "NoNewPrivs": "1", "Seccomp": "2", "inet": "ENETUNREACH", "runner": "ECONNREFUSED", "userns": "EPERM",
                "packet": "EAFNOSUPPORT", "vsock": "EAFNOSUPPORT"}


def check_isolation() -> str | None:
    """Starts one jailed process and checks from inside that it has no network, no capabilities, and the inner
    seccomp filter. Returns why isolation is unavailable, or None."""
    for name in ("bin", "sbin"):
        # Files Docker mounts in at run time (docker-init with `init: true`) are not part of the image's view.
        real = {e for e in os.listdir(f"/usr/{name}") if not os.path.ismount(f"/usr/{name}/{e}")}
        if not real <= set(os.listdir(f"/opt/sandbox/exec-view/{name}")):
            return f"/opt/sandbox/exec-view/{name} does not match /usr/{name}; rebuild the image (exec-view.py must run after every package install)"
    path = os.path.join(ROOT, ".isolation-probe")
    shutil.rmtree(path, ignore_errors=True)
    os.mkdir(path, 0o700)
    os.chown(path, PROBE_UID, PROBE_UID)
    os.chdir("/")
    try:
        result = execute("probe", path, PROBE_UID, secrets.token_hex(8), ["python3", "-I", "-c", PROBE], 30, WORKSPACE_MB * 1024 * 1024, env={"PROBE_PORT": str(PORT)})
    except Failure as e:
        return str(e)
    except OSError as e:
        return f"{type(e).__name__}: {e}"
    finally:
        kill_uid(PROBE_UID)
        shutil.rmtree(path, ignore_errors=True)
    if result["exitCode"] != 0:
        return f"the probe exited with {result['exitCode']}: {(result['stderr'] or result['stdout']).strip()[-400:]}"
    try:
        seen = json.loads(result["stdout"])
    except ValueError:
        return "the probe printed no result"
    wrong = {k: seen.get(k) for k, v in PROBE_EXPECT.items() if seen.get(k) != v}
    if seen.get("fds") != [0, 1, 2, 3]:  # 3 is the probe's own listing of /proc/self/fd.
        wrong["fds"] = seen.get("fds")
    return f"unexpected result inside the jail: {json.dumps(wrong)}" if wrong else None


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
                if isolation_error:
                    return self.json(503, {"ok": False, "error": f"run isolation is unavailable: {isolation_error}"})
                return self.json(200, {"ok": True, "isolation": "bubblewrap"})
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
                return self.json(200, run(ws, req.get("language", ""), str(req.get("code", "")), req.get("timeout", 60), job_id(req.get("job"))))
            if method == "POST" and action == "function":
                raw = self.body(FUNCTION_MAX_BODY)
                try:
                    req = json.loads(raw)
                except ValueError:
                    raise Failure(400, "invalid body")
                if not isinstance(req, dict) or not isinstance(req.get("code"), str) or not isinstance(req.get("input"), str):
                    raise Failure(400, "invalid body")
                timeout_ms = req.get("timeoutMs", 10000)
                if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 1000 <= timeout_ms <= 30000:
                    raise Failure(400, "invalid timeout")
                return self.json(200, run_function(ws, req["code"], req["input"], (timeout_ms + 999) // 1000, job_id(req.get("job"))) )
            if method == "POST" and action == "cancel":
                # No lock: the run holding it sees its process exit and finishes normally.
                req = json.loads(self.body(4096) or b"{}")
                cancel(ws, job_id(req.get("job")))
                return self.json(200, {"ok": True})
            if method == "POST" and action == "convert" and "name" in query:
                pdf = convert(ws, query["name"], self.body(MAX_UPLOAD), job_id(query.get("job")))
                return self.reply(200, pdf, "application/pdf")
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
    # Nothing survives a restart: the container holds only scratch space. Wipe every workspace left
    # over from the previous container life before serving.
    for name in os.listdir(ROOT):
        if WS_RE.match(name):
            shutil.rmtree(os.path.join(ROOT, name), ignore_errors=True)
    for name in os.listdir(ROOT):
        try:
            if WS_RE.match(name):
                used_uids.add(os.stat(os.path.join(ROOT, name)).st_uid)
        except OSError:
            pass
    # The server answers before the check finishes, but refuses runs until it passes. A failed check never
    # falls back to running code without the jail.
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    global isolation_error
    isolation_error = check_isolation()
    if isolation_error:
        print(f"okaychat sandbox: run isolation is unavailable, refusing all runs: {isolation_error}. See docs/implementation/code-sandbox.md (seccomp profile sandbox/seccomp.json, apparmor=unconfined).", flush=True)
    threading.Thread(target=idle_loop, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
