#!/usr/bin/env python3
"""Runs inside the browser worker container as root (docker exec), started by test/integration/run.sh. Every check
runs as the worker user it concerns, through setpriv, so it shows what code executing as that user (for example a
compromised Chromium) can do. Prints PASS/FAIL lines and exits non-zero on any failure.

Usage: python3 - <fixture ip> <app ip> <own ip> < worker_boundaries.py
"""

import json
import os
import re
import subprocess
import sys

FIXTURE, APP, OWN = sys.argv[1:4]
JOBS, SCRAPE, EGRESS, SLOT1, SLOT2 = 10001, 10002, 10003, 10011, 10012
failed = 0


def check(ok: bool, what: str) -> None:
    global failed
    print(("PASS " if ok else "FAIL ") + what, flush=True)
    failed += 0 if ok else 1


def as_user(uid: int, code: str, *args: str, timeout=20) -> str:
    out = subprocess.run(["setpriv", f"--reuid={uid}", f"--regid={uid}", "--clear-groups", "python3", "-c", code, *args],
                         capture_output=True, text=True, timeout=timeout)
    return (out.stdout or out.stderr).strip()


CONNECT = r"""
import socket, sys, errno
host, port = sys.argv[1], int(sys.argv[2])
try:
    s = socket.create_connection((host, port), timeout=3); s.close(); print("connected")
except OSError as e:
    print(errno.errorcode.get(e.errno, type(e).__name__) if e.errno else type(e).__name__)
"""


def connect(uid: int, host: str, port: int) -> str:
    return as_user(uid, CONNECT, host, str(port))


# ---- TCP matrix: who may open which connection ---------------------------------------------------------------
targets = {
    "fixture": (FIXTURE, 9000), "app": (APP, 8787), "public": ("1.1.1.1", 443), "job api": ("127.0.0.1", 8080),
    "own ip job api": (OWN, 8080), "fetch server": ("127.0.0.1", 8093), "slot 1": ("127.0.0.1", 8101),
    "slot 2": ("127.0.0.1", 8102), "proxy": ("127.0.0.1", 3128), "old scrapling mcp port": ("127.0.0.1", 8092),
    "ipv6 loopback": ("::1", 8080), "ipv6 public": ("2606:4700:4700::1111", 443),
}
allowed = {
    JOBS: {"fetch server", "slot 1", "slot 2"},
    SLOT1: {"proxy"}, SLOT2: {"proxy"}, SCRAPE: {"proxy"},
    EGRESS: {"public"},
    0: {"job api"},
}
for uid, may in allowed.items():
    for name, (host, port) in targets.items():
        got = connect(uid, host, port)
        if name in may:
            check(got == "connected", f"uid {uid} -> {name} ({host}:{port}) connected: {got}")
        else:
            # Refused at once by the firewall (or unreachable for IPv6); never connected, never a silent hang.
            check(got in ("ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM"), f"uid {uid} -> {name} ({host}:{port}) blocked: {got}")

# ---- UDP and DNS ---------------------------------------------------------------------------------------------
UDP = r"""
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    for _ in range(3): s.sendto(b"x", (sys.argv[1], 9999))
    print("sent")
except OSError as e:
    print(type(e).__name__)
"""
for uid in (JOBS, SLOT1, SCRAPE, EGRESS, 0):
    as_user(uid, UDP, FIXTURE)
DNS = r"""
import socket
try:
    socket.getaddrinfo("example.com", 443); print("resolved")
except OSError as e:
    print(type(e).__name__)
"""
for uid in (JOBS, SLOT1, SLOT2, SCRAPE, 0):
    got = as_user(uid, DNS)
    check(got != "resolved", f"uid {uid} cannot resolve names: {got}")
check(as_user(EGRESS, DNS) == "resolved", "uid 10003 (proxy) resolves names (positive control)")

# ---- the token and other users' processes ---------------------------------------------------------------------
READ = r"""
import sys
try:
    open(sys.argv[1], "rb").read(64); print("read")
except OSError as e:
    print(type(e).__name__)
"""
TOKEN = "/run/okaychat-browser/token"
check(as_user(JOBS, READ, TOKEN) == "read", "the job API user reads the worker token")
for uid in (SLOT1, SLOT2, SCRAPE, EGRESS):
    got = as_user(uid, READ, TOKEN)
    check(got == "PermissionError", f"uid {uid} cannot read the worker token: {got}")


def processes():
    rows = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            status = dict(line.split(":", 1) for line in open(f"/proc/{pid}/status") if ":" in line)
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace").strip()
        except OSError:
            continue
        rows.append({"pid": int(pid), "uid": int(status["Uid"].split()[0]), "cmd": cmd,
                     **{k: status[k].strip() for k in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs")}})
    return [r for r in rows if r["pid"] != os.getpid() and "worker_boundaries" not in r["cmd"] and "python3 -" not in r["cmd"]]


procs = processes()
by_uid = lambda uid: [p for p in procs if p["uid"] == uid]
dispatcher = next(p for p in by_uid(JOBS) if "index.js" in p["cmd"])
slot2 = next(p for p in by_uid(SLOT2) if "index.js" in p["cmd"])
for uid, victims in ((SLOT1, [dispatcher, slot2]), (SCRAPE, [dispatcher, slot2]), (SLOT2, [dispatcher])):
    for victim in victims:
        for part in ("environ", "mem", "fd"):
            target = f"/proc/{victim['pid']}/{part}"
            code = READ if part != "fd" else "import os,sys\ntry:\n    os.listdir(sys.argv[1]); print('read')\nexcept OSError as e:\n    print(type(e).__name__)"
            got = as_user(uid, code, target)
            check(got == "PermissionError", f"uid {uid} cannot read {part} of uid {victim['uid']} ({victim['cmd'][:40]}): {got}")

# ---- capabilities of every long-lived process ------------------------------------------------------------------
NET_ADMIN, CHOWN = 1 << 12, 1 << 0
for p in procs:
    caps = {k: int(p[k], 16) for k in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")}
    if p["uid"] == 0:
        ok = not any(c & (NET_ADMIN | CHOWN) for c in caps.values())
        check(ok, f"root process {p['pid']} ({p['cmd'][:50]}) has neither NET_ADMIN nor CHOWN: {p['CapEff']}/{p['CapBnd']}")
    else:
        ok = not any(caps.values()) and p["NoNewPrivs"] == "1"
        check(ok, f"uid {p['uid']} process {p['pid']} ({p['cmd'][:50]}) has no capabilities and no_new_privs")
uids = {p["uid"] for p in procs}
check({JOBS, SCRAPE, EGRESS, SLOT1, SLOT2} <= uids, f"every worker user runs a process: {sorted(uids)}")
check(not any(re.search(r"chrom|headless", p["cmd"]) for p in by_uid(JOBS)), "the job API user runs no browser")
listening = open("/proc/net/tcp").read()
check(":1F9C " not in listening, "nothing listens on the former Scrapling MCP port 8092")
print(json.dumps({"processes": [{k: p[k] for k in ("pid", "uid", "cmd")} for p in procs]}), file=sys.stderr)
sys.exit(1 if failed else 0)
