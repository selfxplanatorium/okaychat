#!/usr/bin/env python3
"""Integration tests for the real sandbox container (run_code's runner), driven over its HTTP API from the tester
container on the sandbox network, exactly like the app. Started by test/integration/run.sh; see
docs/research/code-sandbox.md. Every network check has a positive control: the tester itself (and run.sh, from
the sandbox container's own namespace) reaches the same fixture, so a refusal cannot come from a dead target.

Usage: python3 sandbox_it.py [test-name-substring ...]
"""

import base64
import binascii
import concurrent.futures
import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request

URL = os.environ.get("SANDBOX_URL", "http://sandbox:8080")
TOKEN = os.environ["SANDBOX_TOKEN"]
FIXTURE = os.environ.get("FIXTURE_IP", "10.231.2.50")
SHARE = os.environ.get("IT_SHARE", "/share")
results: list[dict] = []


def call(method: str, path: str, body=None, raw: bytes | None = None, timeout=420):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(URL + path, data=data, method=method, headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def run(ws: str, code: str, language="bash", timeout=60, job=None) -> dict:
    body = {"language": language, "code": code, "timeout": timeout}
    if job:
        body["job"] = job
    status, out = call("POST", f"/workspaces/{ws}/run", body)
    result = json.loads(out)
    result["_status"] = status
    return result


def py(ws: str, code: str, timeout=60) -> dict:
    return run(ws, code, "python", timeout)


def ok(result: dict, what="run") -> dict:
    assert result["_status"] == 200, f"{what}: HTTP {result['_status']} {result}"
    assert result["exitCode"] == 0, f"{what}: exit {result['exitCode']} stopped={result.get('stopped')}\nstdout={result['stdout'][-1500:]}\nstderr={result['stderr'][-2500:]}"
    return result


def fixture_hits() -> dict:
    with urllib.request.urlopen(f"http://{FIXTURE}:8000/hits", timeout=5) as res:
        return json.loads(res.read())


def reset_fixture():
    urllib.request.urlopen(urllib.request.Request(f"http://{FIXTURE}:8000/reset", data=b"", method="POST"), timeout=5).read()


def ws(name: str) -> str:
    return (name.encode().hex() + "0" * 32)[:32]


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


# ---- contract ----------------------------------------------------------------------------------------------


@test
def contract_python_and_bash():
    w = ws("contract")
    r = ok(py(w, "import sys\nprint('out'); print('err', file=sys.stderr)"))
    assert r["stdout"] == "out\n" and r["stderr"] == "err\n", r
    r = run(w, "echo bad >&2; exit 3")
    assert r["exitCode"] == 3 and r["stderr"] == "bad\n" and r["stopped"] is None, r
    r = py(w, "raise SystemExit('boom')")
    assert r["exitCode"] == 1 and "boom" in r["stderr"], r
    assert call("POST", f"/workspaces/{w}/run", {"language": "ruby", "code": "x"})[0] == 400
    assert urllib.request.urlopen(urllib.request.Request(URL + "/health"), timeout=5).status == 200
    req = urllib.request.Request(URL + f"/workspaces/{w}/files", headers={"Authorization": "Bearer wrong"})
    try:
        urllib.request.urlopen(req, timeout=5)
        raise AssertionError("a wrong token was accepted")
    except urllib.error.HTTPError as e:
        assert e.code == 401


@test
def output_truncation_keeps_head_and_tail():
    r = ok(py(ws("trunc"), "import sys\nsys.stdout.write('A' * 100_000 + 'END')"))
    assert r["stdout"].startswith("A" * 1000) and r["stdout"].endswith("END"), r["stdout"][-50:]
    assert "bytes omitted" in r["stdout"] and len(r["stdout"]) < 70_000, len(r["stdout"])


@test
def files_listing_download_upload_and_hidden_dirs():
    w = ws("files")
    r = ok(run(w, "mkdir -p out .hidden node_modules/x && echo hi > out/a.txt && echo no > .hidden/b && echo no > node_modules/x/c && echo dot > .env"))
    paths = sorted(f["path"] for f in r["files"])
    assert paths == [".env", "out/a.txt"], paths
    status, body = call("GET", f"/workspaces/{w}/files?path=out/a.txt")
    assert status == 200 and body == b"hi\n", (status, body)
    status, _ = call("PUT", f"/workspaces/{w}/files?path=in/data.bin", raw=b"\x00\x01payload")
    assert status == 200
    r = ok(run(w, "cat in/data.bin | tail -c 7; ln -s /etc/passwd leak; ln -s ../../ other"))
    assert r["stdout"] == "payload", r
    assert call("GET", f"/workspaces/{w}/files?path=leak")[0] == 403
    assert call("GET", f"/workspaces/{w}/files?path=../x")[0] == 400
    assert call("PUT", f"/workspaces/{w}/files?path=.okaychat/main.py", raw=b"x")[0] == 400


# ---- identity, capabilities, filesystem ---------------------------------------------------------------------


@test
def identity_capabilities_seccomp_and_limits():
    r = ok(py(ws("ident"), r"""
import os, json
status = dict(l.split(':', 1) for l in open('/proc/self/status') if ':' in l)
limits = {l[:26].strip(): l[26:].split()[0] for l in open('/proc/self/limits').readlines()[1:]}
print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'groups': os.getgroups(),
  'status': {k: status[k].strip() for k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs','Seccomp','Seccomp_filters')},
  'limits': limits, 'fds': sorted(os.listdir('/proc/self/fd')), 'cwd': os.getcwd(),
  'env': sorted(os.environ)}))
""", timeout=30))
    info = json.loads(r["stdout"])
    assert 20000 <= info["uid"] <= 29999 and info["gid"] == info["uid"] and info["groups"] in ([info["uid"]], []), info
    s = info["status"]
    for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
        assert s[key] == "0000000000000000", (key, s)
    assert s["NoNewPrivs"] == "1" and s["Seccomp"] == "2" and int(s["Seccomp_filters"]) >= 2, s
    lim = info["limits"]
    assert lim["Max cpu time"] == "35", lim  # timeout 30 + 5
    assert lim["Max address space"] == str(2048 * 1024 * 1024), lim
    assert lim["Max processes"] == "64" and lim["Max open files"] == "256" and lim["Max core file size"] == "0", lim
    assert lim["Max file size"] == str(1024 * 1024 * 1024), lim
    assert info["fds"] == ["0", "1", "2", "3"], info["fds"]  # 3 is the listing itself
    assert "SANDBOX_TOKEN" not in info["env"], info["env"]
    status, out = call("GET", "/health")
    assert json.loads(out)["isolation"] == "bubblewrap"


@test
def filesystem_is_read_only_and_private():
    w = ws("fs")
    r = ok(run(w, r"""
for p in /usr/x /etc/x /opt/sandbox/x /x /var/x; do (echo > $p) 2>/dev/null && echo WROTE $p; done
ls -a /work; ls /; test -e /work/.isolation-probe && echo PROBE
for pid in 1 $(pgrep -f runner.py); do cat /proc/$pid/environ >/dev/null 2>&1 && echo ENVIRON $pid; done
ls /proc/1/root/ 2>/dev/null && echo ROOT
grep -c . /etc/passwd >/dev/null; whoami
"""))
    out = r["stdout"]
    assert "WROTE" not in out and "ENVIRON" not in out and "ROOT" not in out and "PROBE" not in out, out
    entries = out.split("\n")
    assert entries[0:3] == [".", "..", w], entries[:4]  # only this chat's workspace is mounted
    assert "sandbox" in out.splitlines()[-1]


# ---- network ------------------------------------------------------------------------------------------------

NET_PROBE = r"""
import errno, json, os, socket, subprocess, sys, urllib.request
F = sys.argv[1]; targets = json.loads(sys.argv[2])
res = {}
def attempt(name, fn):
    try:
        fn(); res[name] = 'ALLOWED'
    except Exception as e:
        res[name] = errno.errorcode.get(getattr(e, 'errno', None) or 0, type(e).__name__)
def tcp(host, port, fam=socket.AF_INET):
    s = socket.socket(fam, socket.SOCK_STREAM); s.settimeout(3); s.connect((host, port)); s.close()
def udp(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b'x', (host, port))
for name, (host, port) in targets.items():
    attempt('tcp ' + name, lambda h=host, p=port: tcp(h, p))
attempt('udp fixture', lambda: udp(F, 9999))
attempt('http fixture', lambda: urllib.request.urlopen(f'http://{F}:8000/from-sandbox', timeout=3))
attempt('dns fixture name', lambda: socket.getaddrinfo('fixture', 8000))
attempt('dns public name', lambda: socket.getaddrinfo('example.com', 443))
def dns_reply():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    s.sendto(bytes.fromhex('abcd01000001000000000000076578616d706c6503636f6d0000010001'), ('127.0.0.11', 53))
    s.recv(512)  # Only an answer counts as reaching Docker's DNS.
attempt('dns server reply', dns_reply)
attempt('ipv6 public', lambda: tcp('2606:4700:4700::1111', 443, socket.AF_INET6))
attempt('ipv6 loopback runner', lambda: tcp('::1', 8080, socket.AF_INET6))
attempt('raw inet', lambda: socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP))
attempt('packet', lambda: socket.socket(socket.AF_PACKET, socket.SOCK_RAW))
attempt('vsock', lambda: socket.socket(40, socket.SOCK_STREAM))
attempt('netlink route', lambda: socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0))
attempt('new userns', lambda: os.unshare(os.CLONE_NEWUSER))
attempt('new netns', lambda: os.unshare(os.CLONE_NEWNET))
res['interfaces'] = sorted(l.split(':')[0].strip() for l in open('/proc/self/net/dev').readlines()[2:])
res['routes'] = open('/proc/self/net/route').read().count('\n') - 1
print(json.dumps(res))
"""


@test
def no_network_from_run_code_descendants():
    targets = json.loads(os.environ["NET_TARGETS"])
    # Positive control: the tester reaches the fixture and the runner on the same network.
    reset_fixture()
    socket.create_connection((FIXTURE, 9000), timeout=3).close()
    urllib.request.urlopen(f"http://{FIXTURE}:8000/control", timeout=3).read()
    assert fixture_hits()["tcp"] == 1
    reset_fixture()
    w = ws("net")
    payload = json.dumps(targets)
    # The probe runs as a grandchild of bash, in the background, and as a setsid'd process: none may get out.
    code = f"""cat > probe.py <<'PY'
{NET_PROBE}
PY
python3 probe.py {FIXTURE} '{payload}' > direct.json
(python3 probe.py {FIXTURE} '{payload}' > child.json) &
setsid python3 probe.py {FIXTURE} '{payload}' > setsid.json &
wait; sleep 1
cat direct.json child.json setsid.json"""
    r = ok(run(w, code, timeout=120))
    lines = [json.loads(line) for line in r["stdout"].splitlines() if line.startswith("{")]
    assert len(lines) == 3, r
    for res in lines:
        allowed = [k for k, v in res.items() if v == "ALLOWED" and k != "netlink route"]
        assert not allowed, f"allowed from run code: {allowed} in {res}"
        assert res["interfaces"] == ["lo"] and res["routes"] == 0, res
        assert res["packet"] == "EAFNOSUPPORT" and res["vsock"] == "EAFNOSUPPORT", res
        assert res["raw inet"] in ("EPERM", "EACCES"), res
        assert res["new userns"] == "EPERM" and res["new netns"] == "EPERM", res
        assert res["tcp runner loopback"] == "ECONNREFUSED", res
    hits = fixture_hits()
    assert hits["tcp"] == 0 and hits["udp"] == 0 and hits["http"] == 0, f"the fixture saw traffic from run code: {hits}"
    socket.create_connection((FIXTURE, 9000), timeout=3).close()
    assert fixture_hits()["tcp"] == 1, "positive control after the run failed"
    results.append({"name": "network probe detail", "detail": lines[0]})


@test
def runs_cannot_reach_each_other():
    a, b = ws("crossA"), ws("crossB")
    listener = r"""
import os, socket, time
t = socket.create_server(('127.0.0.1', 45678)); u = socket.socket(socket.AF_UNIX); u.bind('\0okaychat-it-abstract'); u.listen()
f = socket.socket(socket.AF_UNIX); f.bind('/tmp/okc.sock'); f.listen(); os.chmod('/tmp/okc.sock', 0o777)
open('/dev/shm/okc-shm', 'w').write('secret'); open('/tmp/okc-tmp', 'w').write('secret')
print('listening', flush=True); time.sleep(8)
"""
    probe = r"""
import errno, json, os, socket, time
time.sleep(2)
res = {}
def attempt(name, fn):
    try: fn(); res[name] = 'ALLOWED'
    except OSError as e: res[name] = errno.errorcode.get(e.errno, str(e))
def unix(addr):
    s = socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(addr)
attempt('tcp loopback', lambda: socket.create_connection(('127.0.0.1', 45678), timeout=2))
attempt('abstract', lambda: unix('\0okaychat-it-abstract'))
attempt('fs socket', lambda: unix('/tmp/okc.sock'))
attempt('shm', lambda: open('/dev/shm/okc-shm').read())
attempt('tmp', lambda: open('/tmp/okc-tmp').read())
attempt('other workspace', lambda: os.listdir('/work/' + os.environ['OTHER']))
procs = [p for p in os.listdir('/proc') if p.isdigit()]
others = []
for p in procs:
    try:
        st = dict(l.split(':', 1) for l in open(f'/proc/{p}/status') if ':' in l)
        if int(st['Uid'].split()[0]) != os.getuid():
            try: open(f'/proc/{p}/environ').read(); others.append(('environ', p))
            except OSError: pass
            try: os.kill(int(p), 0); others.append(('signal', p))
            except OSError: pass
            try: os.listdir(f'/proc/{p}/fd'); others.append(('fds', p))
            except OSError: pass
    except (OSError, KeyError, ValueError): pass
res['foreign process access'] = others
print(json.dumps(res))
"""
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        first = pool.submit(py, a, listener, 30)
        time.sleep(1)
        second = pool.submit(py, b, f"import os; os.environ['OTHER'] = '{a}'\n" + probe, 30)
        ra, rb = ok(first.result(), "listener"), ok(second.result(), "probe")
    assert "listening" in ra["stdout"], ra
    res = json.loads(rb["stdout"])
    assert res["tcp loopback"] == "ECONNREFUSED" and res["abstract"] == "ECONNREFUSED", res
    assert res["fs socket"] == "ENOENT" and res["shm"] == "ENOENT" and res["tmp"] == "ENOENT", res
    assert res["other workspace"] == "ENOENT" and res["foreign process access"] == [], res


@test
def what_a_run_sees_of_another_run():
    a, b = ws("visA"), ws("visB")
    holder = "# secret-in-the-script-body\nsleep 17.5 &\nsleep 6"
    probe = r"""
import json, os, sys
other = sys.argv[1]
cmdlines = []
for pid in filter(str.isdigit, os.listdir('/proc')):
    try: cmdlines.append(open(f'/proc/{pid}/cmdline', 'rb').read().replace(b'\0', b' ').decode())
    except OSError: pass
joined = '\n'.join(cmdlines)
print(json.dumps({'workspace id visible': other in joined, 'script body visible': 'secret-in-the-script-body' in joined,
                  'subprocess argv visible': 'sleep 17.5' in joined, 'cmdlines': [c for c in cmdlines if 'bwrap' in c or 'sleep' in c][:6]}))
"""
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        first = pool.submit(run, a, holder, "bash", 20)
        time.sleep(1.5)
        seen = json.loads(ok(py(b, "import sys; sys.argv = ['x', %r]\n" % a + probe, 20))["stdout"])
        first.result()
    assert not seen["workspace id visible"] and not seen["script body visible"], seen
    # Known limit (docs/research/code-sandbox.md): arguments that run code passes to its own subprocesses are visible.
    results.append({"name": "cross-run process visibility", "detail": seen})


# ---- lifecycle ----------------------------------------------------------------------------------------------


@test
def temporary_files_and_processes_end_with_the_run():
    w = ws("cleanup")
    ok(run(w, "echo x > /tmp/left; echo y > /dev/shm/left; mkdir -p keep; echo z > keep/partial.txt; sleep 600 & setsid sleep 601 & nohup sleep 602 >/dev/null 2>&1 & (trap '' TERM HUP; exec -a sneaky sleep 603) & disown -a; echo started"))
    r = ok(run(w, "ls -A /tmp /dev/shm; ps -eo user:20,args | grep -E 'sleep 60[0-3]|sneaky' | grep -v grep || true; cat keep/partial.txt; echo RUNDIR $(ls -A .okaychat/run)"))
    out = r["stdout"]
    assert "left" not in out and "sleep 60" not in out and "sneaky" not in out, out
    # The run directory holds only the current run's fresh /tmp and /dev/shm.
    assert "z" in out and "RUNDIR shm tmp" in out, out


@test
def timeout_cpu_and_partial_outputs():
    w = ws("timeout")
    t = time.time()
    r = run(w, "echo partial > partial.txt; echo before; sleep 30; echo after", timeout=2)
    elapsed = time.time() - t
    assert r["stopped"] == "timed out after 2 s" and "before" in r["stdout"] and "after" not in r["stdout"], r
    assert elapsed < 8, elapsed
    assert any(f["path"] == "partial.txt" for f in r["files"]), r["files"]
    r = py(w, "while True: pass", timeout=1)
    assert r["stopped"] == "timed out after 1 s", r
    # The CPU limit, not the wall clock, stops a busy child whose parent would otherwise wait: two busy
    # processes with timeout 3 hit RLIMIT_CPU (8 s of CPU) only after the wall limit, so wall time wins here.
    r = run(w, "python3 -c 'while True: pass' & python3 -c 'while True: pass' & wait", timeout=3)
    assert r["stopped"] == "timed out after 3 s", r


@test
def default_timeout_is_60_seconds_and_long_runs_finish():
    w = ws("longrun")
    t = time.time()
    r = run(w, "sleep 65; echo done", timeout=70)
    assert r["exitCode"] == 0 and r["stdout"] == "done\n", r
    status, out = call("POST", f"/workspaces/{w}/run", {"language": "bash", "code": "sleep 75"})
    r = json.loads(out)
    assert r["stopped"] == "timed out after 60 s", r
    assert time.time() - t < 160


@test
def queued_and_running_jobs_cancel():
    w = ws("cancel")
    # Cancelled before it ever arrives: it must never start.
    call("POST", f"/workspaces/{w}/cancel", {"job": "job_precancelled1"})
    r = run(w, "echo started > never.txt", job="job_precancelled1")
    assert r["stopped"] == "cancelled before it started" and r["files"] == [], r
    r = ok(run(w, "test -e never.txt && echo exists || echo absent"))
    assert r["stdout"] == "absent\n", r
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        first = pool.submit(run, w, "sleep 1000 & sleep 20; echo finished", "bash", 60, "job_running_one1")
        time.sleep(1.5)
        queued = pool.submit(run, w, "echo ran > queued.txt", "bash", 60, "job_queued_two22")
        time.sleep(1.5)
        call("POST", f"/workspaces/{w}/cancel", {"job": "job_queued_two22"})
        rq = queued.result(timeout=10)
        assert rq["stopped"] == "cancelled before it started", rq
        t = time.time()
        call("POST", f"/workspaces/{w}/cancel", {"job": "job_running_one1"})
        r1 = first.result(timeout=15)
        assert r1["stopped"] == "cancelled" and "finished" not in r1["stdout"] and time.time() - t < 5, r1
    r = ok(run(w, "test -e queued.txt && echo exists || echo absent; pgrep -x sleep || true"))
    assert r["stdout"] == "absent\n", r
    # A cancel for another job of the workspace leaves a running job alone.
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        f = pool.submit(run, w, "sleep 3; echo survived", "bash", 30, "job_survivor_33")
        time.sleep(1)
        call("POST", f"/workspaces/{w}/cancel", {"job": "job_unrelated_44"})
        assert f.result()["stdout"] == "survived\n"


@test
def workspace_size_watchdog_and_file_size_limit():
    w = ws("bigfile")
    r = run(w, "head -c 1100M /dev/zero > big.bin; echo exit=$?", timeout=120)
    assert r["stopped"] == "stopped: workspace exceeded 1024 MB" or "exit=153" in r["stdout"], r
    # Over the limit, a run may still delete files.
    r = ok(run(w, "rm -f big.bin; echo cleaned"))
    assert r["stdout"] == "cleaned\n", r
    r = run(w, "head -c 600M /dev/zero > /tmp/a; head -c 600M /dev/zero > /tmp/b; sleep 10", timeout=60)
    assert r["stopped"] == "stopped: workspace exceeded 1024 MB", "temporary files count toward the workspace limit: " + str(r)
    r = ok(run(w, "ls -A /tmp | wc -l; du -sk . | cut -f1"))
    left, kilobytes = r["stdout"].split()
    assert left == "0" and int(kilobytes) < 1024, r


@test
def fork_bomb_and_memory_are_bounded():
    w = ws("bounds")
    r = run(w, ":(){ :|:& };: ; sleep 2; echo alive", timeout=10)
    assert r["_status"] == 200, r
    r = py(w, "x = bytearray(3 * 1024**3)", timeout=20)
    assert r["exitCode"] != 0 and "MemoryError" in r["stderr"], r
    r = run(w, "head -c 2000M /dev/zero > /tmp/x", timeout=60)
    assert r["stopped"] in ("file size limit", "stopped: workspace exceeded 1024 MB"), r
    r = ok(run(w, "echo recovered"))


# ---- tools --------------------------------------------------------------------------------------------------

CLIS = ["ffmpeg", "ffprobe", "pdftotext", "pdfinfo", "pdftoppm", "qpdf", "gs", "pandoc", "soffice", "libreoffice", "tesseract", "ocrmypdf",
        "rsvg-convert", "dot", "zip", "unzip", "xz", "zstd", "7z", "7zz", "bsdtar", "exiftool", "jq", "rg", "sqlite3", "git", "curl",
        "file", "tree", "fd", "fdfind", "bc", "fc-list", "csvlook", "in2csv", "img2pdf", "gzip", "bzip2"]
IMPORTS = ["numpy", "pandas", "scipy", "sklearn", "matplotlib", "sympy", "PIL", "pillow_heif", "openpyxl", "docx", "pptx", "reportlab",
           "pypdf", "pikepdf", "pdfplumber", "pdfminer", "ocrmypdf", "csvkit", "requests", "bs4", "lxml", "yaml", "tabulate", "xlsxwriter"]


@test
def every_cli_and_python_import():
    w = ws("tools")
    r = ok(run(w, "for c in " + " ".join(CLIS) + "; do command -v $c >/dev/null || echo MISSING $c; done; tesseract --list-langs 2>&1 | tail -n +2 | tr '\\n' ' '; cat /opt/sandbox/TOOLS.md | head -1"))
    assert "MISSING" not in r["stdout"], r["stdout"]
    assert all(lang in r["stdout"] for lang in ("eng", "ita", "osd")), r["stdout"]
    r = ok(py(w, "import importlib\nfor m in " + repr(IMPORTS) + ": importlib.import_module(m)\nprint('ok')", timeout=120))
    assert r["stdout"] == "ok\n"


@test
def media_ffmpeg_bounded_threads():
    w = ws("media")
    r = ok(run(w, """set -e
ffmpeg -v error -f lavfi -i testsrc=duration=3:size=640x360:rate=25 -f lavfi -i sine=frequency=440:duration=3 -threads 2 -c:v libx264 -preset veryfast -c:a aac -shortest clip.mp4
ffmpeg -v error -i clip.mp4 -threads 2 -c:v libvpx-vp9 -b:v 300k -deadline realtime -c:a libopus small.webm
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height:format=duration -of json small.webm""", timeout=180))
    info = json.loads(r["stdout"])
    codecs = sorted(s["codec_name"] for s in info["streams"])
    assert codecs == ["opus", "vp9"], info
    assert 2.5 < float(info["format"]["duration"]) < 3.5, info
    assert {"clip.mp4", "small.webm"} <= {f["path"] for f in r["files"]}


@test
def images_heic_svg_graphviz_fonts_matplotlib():
    w = ws("images")
    r = ok(py(w, r"""
import subprocess, PIL.Image as Image, pillow_heif
pillow_heif.register_heif_opener()
Image.new('RGB', (64, 48), (200, 30, 30)).save('fixture.heic', quality=80)
im = Image.open('fixture.heic'); im.load(); print('heic', im.size, im.mode, im.getpixel((10, 10)))
open('pic.svg', 'w').write('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#0a0"/><text x="5" y="25" font-family="DejaVu Sans">Hi ✓</text></svg>')
subprocess.run(['rsvg-convert', '-o', 'pic.png', 'pic.svg'], check=True)
print('svg', Image.open('pic.png').size)
open('g.dot', 'w').write('digraph { a -> b -> c; a -> c }')
subprocess.run(['dot', '-Tpng', '-o', 'g.png', 'g.dot'], check=True); subprocess.run(['dot', '-Tsvg', '-o', 'g.svg', 'g.dot'], check=True)
print('dot', Image.open('g.png').size, '<svg' in open('g.svg').read())
for family in ('DejaVu Sans', 'Liberation Sans', 'Liberation Serif', 'Noto Sans', 'Noto Color Emoji'):
    print('font', family, '->', subprocess.run(['fc-match', family, 'family'], capture_output=True, text=True).stdout.strip())
print('cjk', subprocess.run(['fc-list', ':lang=ja', 'family'], capture_output=True, text=True).stdout.strip() or 'none')
import matplotlib.pyplot as plt
plt.plot([1, 2, 3], [3, 1, 2]); plt.title('Chart ✓'); plt.savefig('chart.png', dpi=80)
data = open('chart.png', 'rb').read(); print('png', data[:8] == b'\x89PNG\r\n\x1a\n', Image.open('chart.png').size)
""", timeout=120))
    out = r["stdout"]
    assert "heic (64, 48) RGB" in out and "svg (80, 40)" in out and "dot (" in out and "True" in out, out
    for family in ("DejaVu Sans", "Liberation Sans", "Liberation Serif", "Noto Sans", "Noto Color Emoji"):
        assert f"font {family} -> {family}" in out, out
    assert "cjk none" in out and "png True" in out, out


@test
def office_create_and_convert_with_libreoffice():
    w = ws("office")
    r = ok(py(w, r"""
import subprocess, docx, openpyxl, pptx
d = docx.Document(); d.add_heading('Quarterly report', 1); d.add_paragraph('Revenue grew.'); d.add_page_break(); d.add_paragraph('Page two'); d.save('report.docx')
wb = openpyxl.Workbook(); ws = wb.active; ws.append(['Item', 'Cost']); ws.append(['Hosting', 120]); ws['B3'] = '=SUM(B2:B2)'; wb.save('costs.xlsx')
p = pptx.Presentation(); s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = 'Deck title'; s.placeholders[1].text = 'First point'
s2 = p.slides.add_slide(p.slide_layouts[5]); s2.shapes.title.text = 'Second slide'; p.save('deck.pptx')
procs = [subprocess.Popen(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', 'pdf', f], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) for f in ('report.docx', 'costs.xlsx', 'deck.pptx')]
for proc in procs: assert proc.wait() == 0, proc.stderr.read()
for f, want in (('report', 'Revenue grew'), ('costs', 'Hosting'), ('deck', 'Deck title')):
    pages = [l for l in subprocess.run(['pdfinfo', f'pdf/{f}.pdf'], capture_output=True, text=True).stdout.splitlines() if l.startswith('Pages')]
    text = subprocess.run(['pdftotext', f'pdf/{f}.pdf', '-'], capture_output=True, text=True).stdout
    print(f, pages, want in text)
subprocess.run(['pandoc', 'report.docx', '-o', 'report.md'], check=True); print('pandoc', 'Quarterly report' in open('report.md').read())
import os; print('profiles left', [n for n in os.listdir('/tmp') if 'libreoffice' in n])
""", timeout=240))
    out = r["stdout"]
    assert "report ['Pages:           2'] True" in out and "costs ['Pages:           1'] True" in out and "deck ['Pages:           2'] True" in out, out
    assert "pandoc True" in out and "profiles left []" in out, out
    with open(f"{SHARE}/office-fileids.json", "w") as f:
        json.dump({"ws": w, "files": [x["path"] for x in r["files"]]}, f)


@test
def pdf_extraction_ocr_and_ocrmypdf():
    w = ws("ocr")
    r = ok(py(w, r"""
import subprocess
from PIL import Image, ImageDraw, ImageFont
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 48)
im = Image.new('L', (1400, 300), 255); d = ImageDraw.Draw(im)
d.text((40, 40), 'Invoice number 4521', font=font, fill=0); d.text((40, 150), 'La città è bellissima perché', font=font, fill=0)
im.save('scan.png', dpi=(300, 300))
print('eng', subprocess.run(['tesseract', 'scan.png', '-', '-l', 'eng'], capture_output=True, text=True).stdout.strip().splitlines()[0])
print('ita', subprocess.run(['tesseract', 'scan.png', '-', '-l', 'ita'], capture_output=True, text=True).stdout.strip().splitlines()[-1])
subprocess.run(['img2pdf', 'scan.png', '-o', 'scan.pdf'], check=True)
r = subprocess.run(['ocrmypdf', '--jobs', '2', '-l', 'eng+ita', '--output-type', 'pdf', 'scan.pdf', 'searchable.pdf'], capture_output=True, text=True)
print('ocrmypdf', r.returncode, r.stderr.strip().splitlines()[-1:] )
print('text', ' '.join(subprocess.run(['pdftotext', 'searchable.pdf', '-'], capture_output=True, text=True).stdout.split()))
import pdfplumber, pypdf
with pdfplumber.open('searchable.pdf') as pdf: print('plumber', 'Invoice' in (pdf.pages[0].extract_text() or ''))
print('pypdf', len(pypdf.PdfReader('searchable.pdf').pages))
print('qpdf', subprocess.run(['qpdf', '--check', 'searchable.pdf'], capture_output=True, text=True).returncode)
subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', '-r50', '-sOutputFile=page.png', 'searchable.pdf'], check=True)
subprocess.run(['pdftoppm', '-png', '-r', '50', 'searchable.pdf', 'pp'], check=True)
print('raster', Image.open('page.png').size, Image.open('pp-1.png').size)
""", timeout=240))
    out = r["stdout"]
    assert "eng Invoice number 4521" in out, out
    assert "città" in out.split("ita", 1)[1].splitlines()[0] and "perché" in out, out
    assert "ocrmypdf 0" in out and "Invoice number 4521" in out.split("text", 1)[1] and "plumber True" in out and "pypdf 1" in out and "qpdf 0" in out, out


@test
def archives_and_metadata():
    w = ws("archives")
    for name in ("rar4.rar", "rar5.rar"):
        path = f"{SHARE}/{name}"
        if os.path.exists(path):
            assert call("PUT", f"/workspaces/{w}/files?path={name}", raw=open(path, "rb").read())[0] == 200
    r = ok(run(w, r"""set -e
mkdir -p src && echo alpha > src/a.txt && echo beta > src/b.txt
zip -qr z.zip src && unzip -qo z.zip -d unz && cat unz/src/a.txt
7z a -bd -y s.7z src >/dev/null && 7z x -bd -y -os7 s.7z >/dev/null && cat s7/src/b.txt
tar -cf t.tar src && xz -k t.tar && zstd -q -k t.tar && xz -dc t.tar.xz | tar -t | sort | tr '\n' ' ' && echo
bsdtar -xf t.tar.zst -C . --strip-components 0 -O src/a.txt
for f in rar4.rar rar5.rar; do [ -e $f ] || continue; echo "$f bsdtar: $(bsdtar -tf $f 2>&1 | head -3 | tr '\n' ' ')"; echo "$f 7z: $(7z l -ba $f 2>&1 | head -2 | tr '\n' ' ')"; done
python3 - <<'PY'
from PIL import Image
im = Image.new('RGB', (20, 20)); exif = im.getexif(); exif[0x010F] = 'okaychat-cam'; im.save('photo.jpg', exif=exif)
PY
exiftool -s -s -s -Make photo.jpg
exiftool -q -overwrite_original -Artist='Tester' photo.jpg && exiftool -s -s -s -Artist photo.jpg
file -b photo.jpg | cut -d, -f1
"""))
    out = r["stdout"]
    assert "alpha" in out and "beta" in out and "src/a.txt src/b.txt" in out, out
    assert "okaychat-cam" in out and "Tester" in out and "JPEG image data" in out, out
    rar = [l for l in out.splitlines() if l.startswith("rar")]
    results.append({"name": "rar support", "detail": rar})
    if os.path.exists(f"{SHARE}/rar4.rar"):
        assert any(l.startswith("rar4.rar bsdtar: test.txt") for l in rar) and any(l.startswith("rar5.rar bsdtar: helloworld.txt") for l in rar), rar


MACRO_DOC = r"""
import sys, zipfile
content = '''<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:ooo="http://openoffice.org/2004/office" office:version="1.3">
<office:scripts><office:event-listeners>
<script:event-listener script:language="ooo:script" script:event-name="dom:load" xlink:href="vnd.sun.star.script:Standard.Module1.Run?language=Basic&amp;location=document" xlink:type="simple"/>
</office:event-listeners></office:scripts>
<office:body><office:text><text:p>Document with an autorun macro</text:p></office:text></office:body></office:document-content>'''
module = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">Sub Run
  Dim n As Integer
  n = FreeFile
  Open "MARKER_PATH" For Output As #n
  Print #n, "macro ran"
  Close #n
End Sub
</script:module>'''
lib = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false"><library:element library:name="Module1"/></library:library>'''
libs = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd">
<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink"><library:library library:name="Standard" library:link="false"/></library:libraries>'''
manifest = '''<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="Basic/" manifest:media-type=""/>
<manifest:file-entry manifest:full-path="Basic/script-lc.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="Basic/Standard/script-lb.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="Basic/Standard/Module1.xml" manifest:media-type="text/xml"/>
</manifest:manifest>'''
with zipfile.ZipFile('macro.odt', 'w') as z:
    z.writestr(zipfile.ZipInfo('mimetype'), 'application/vnd.oasis.opendocument.text')
    z.writestr('content.xml', content); z.writestr('Basic/script-lc.xml', libs)
    z.writestr('Basic/Standard/script-lb.xml', lib); z.writestr('Basic/Standard/Module1.xml', module)
    z.writestr('META-INF/manifest.xml', manifest)
"""


def macro_doc(marker: str) -> str:
    return MACRO_DOC.replace("MARKER_PATH", marker)

# A profile that tries to switch macros back on. The image's finalized defaults must win over it.
WEAK_PROFILE = r"""mkdir -p /tmp/weak/user && cat > /tmp/weak/user/registrymodifications.xcu <<'XCU'
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
XCU
"""


@test
def libreoffice_never_runs_document_macros():
    # The image ships no macro engine at all: no StarBasic interpreter, Python-UNO, or Java. A document with an
    # autorun macro, and a profile that tries to switch macros on, therefore stay inert. (A positive control is
    # impossible for the same reason; okaychat.xcd additionally finalizes the macro and link settings.)
    w = ws("macro")
    code = "python3 - <<'PY'\n" + macro_doc(f"/work/{w}/MARKER") + "PY\n" + WEAK_PROFILE + """
ls /usr/lib/libreoffice/program/ | grep -E '^(libbasiclo|libpyuno|pyuno)' || echo no-engines
command -v java || ls /usr/lib/jvm 2>/dev/null || echo no-java
soffice --headless --convert-to pdf --outdir out macro.odt >/dev/null 2>&1
soffice -env:UserInstallation=file:///tmp/weak --headless --convert-to pdf --outdir out2 macro.odt >/dev/null 2>&1
ls out out2; test -e MARKER && echo MACRO_RAN || echo no-macro
"""
    r = ok(run(w, code, timeout=120))
    out = r["stdout"]
    assert "no-engines" in out and "no-java" in out, out
    assert out.count("macro.pdf") == 2 and "no-macro" in out and "MACRO_RAN" not in out, r


@test
def concurrent_heavy_load_under_the_memory_limit():
    jobs = {
        "ocr": ("python", r"""
import subprocess
from PIL import Image, ImageDraw, ImageFont
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 36)
pages = []
for n in range(4):
    im = Image.new('L', (2480, 3508), 255); d = ImageDraw.Draw(im)
    for line in range(40): d.text((150, 150 + line * 80), f'Page {n} line {line} lorem ipsum dolor sit amet', font=font, fill=0)
    im.save(f'p{n}.png', dpi=(300, 300)); pages.append(f'p{n}.png')
subprocess.run(['img2pdf', *pages, '-o', 'scan.pdf'], check=True)
r = subprocess.run(['ocrmypdf', '--jobs', '2', 'scan.pdf', 'out.pdf'], capture_output=True, text=True); print('ocr', r.returncode, r.stderr[-300:])
"""),
        "office": ("python", r"""
import subprocess, docx
d = docx.Document()
for i in range(300): d.add_paragraph(f'Paragraph {i} ' + 'text ' * 60)
d.save('long.docx')
r = subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', 'long.docx'], capture_output=True, text=True); print('office', r.returncode)
print(subprocess.run(['pdfinfo', 'long.pdf'], capture_output=True, text=True).stdout.split('Pages:')[1].split()[0])
"""),
        "media": ("bash", "ffmpeg -v error -f lavfi -i testsrc2=duration=15:size=1280x720:rate=30 -threads 2 -c:v libx264 -preset fast out.mp4 && echo media 0 && ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4"),
        "numpy": ("python", "import numpy as np\na = np.random.rand(6000, 6000)\nb = a @ a.T\nprint('numpy', round(float(b.trace()), 1) > 0)"),
    }
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        futures = {name: pool.submit(run, ws("load" + name), code, lang, 300) for name, (lang, code) in jobs.items()}
        out = {name: f.result() for name, f in futures.items()}
    summary = {name: {"exit": r["exitCode"], "stopped": r["stopped"], "seconds": round(r["durationMs"] / 1000, 1), "stdout": r["stdout"][-200:], "stderr": r["stderr"][-300:]} for name, r in out.items()}
    results.append({"name": "load detail", "detail": summary, "wall": round(time.time() - t0, 1)})
    failed = {k: v for k, v in summary.items() if v["exit"] != 0}
    assert not failed, json.dumps(failed, indent=1)


def main():
    wanted = sys.argv[1:]
    failures = 0
    for fn in TESTS:
        if wanted and not any(w in fn.__name__ for w in wanted):
            continue
        t = time.time()
        try:
            fn()
            results.append({"name": fn.__name__, "ok": True, "seconds": round(time.time() - t, 1)})
            print(f"PASS {fn.__name__} ({time.time() - t:.1f} s)", flush=True)
        except Exception:
            failures += 1
            results.append({"name": fn.__name__, "ok": False, "error": traceback.format_exc()[-3000:]})
            print(f"FAIL {fn.__name__}\n{traceback.format_exc()[-3000:]}", flush=True)
    with open(f"{SHARE}/sandbox-results.json", "w") as f:
        json.dump(results, f, indent=1)
    print(f"{failures} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
