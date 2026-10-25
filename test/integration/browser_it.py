#!/usr/bin/env python3
"""Integration tests for the real browser worker container and the app wiring, run from the tester container
(on the browser and default networks, like the app). Started by test/integration/run.sh; see
docs/implementation/browser-worker.md. The fixture at 10.231.1.50 counts every request that reaches it: blocked
destinations must leave its counters at zero, while the tester's own requests (positive control) arrive.

Usage: python3 browser_it.py [test-name-substring ...]
"""

import base64
import concurrent.futures
import http.cookiejar
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request

WORKER = os.environ.get("BROWSER_URL", "http://browser:8080")
APP = os.environ.get("APP_URL", "http://okaychat:8787")
FIXTURE = "10.231.1.50"
SHARE = os.environ.get("IT_SHARE", "/share")
TOKEN = open("/run/okaychat-browser/token").read().strip()
results: list[dict] = []


def job(route: str, body: dict, timeout=200, token=TOKEN):
    req = urllib.request.Request(WORKER + route, data=json.dumps(body).encode(), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def hits() -> dict:
    with urllib.request.urlopen(f"http://{FIXTURE}:8000/hits", timeout=5) as res:
        return json.loads(res.read())


def reset():
    urllib.request.urlopen(urllib.request.Request(f"http://{FIXTURE}:8000/reset", data=b"", method="POST"), timeout=5).read()


def control():
    """The tester reaches the fixture, so a zero count afterwards means the worker's request was stopped."""
    before = hits()["http"]
    urllib.request.urlopen(f"http://{FIXTURE}:8000/control", timeout=5).read()
    assert hits()["http"] == before + 1


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


@test
def health_reports_the_firewall():
    with urllib.request.urlopen(WORKER + "/health", timeout=5) as res:
        health = json.loads(res.read())
    assert health["ok"] and health["chromium"] and health["scrapling"] and health["egressEnforced"], health
    status, _ = job("/v1/render", {"kind": "pdf", "html": "x"}, token="wrong" * 8)
    assert status == 401


@test
def offline_pdf_and_document_pages():
    status, out = job("/v1/render", {"kind": "pdf", "html": "<h1>Invoice</h1><div style='break-before:page'>Second</div>"})
    assert status == 200, out
    pdf = base64.b64decode(out["pdf"])
    assert pdf[:5] == b"%PDF-"
    status, shot = job("/v1/render", {"kind": "pdf-page", "file": out["pdf"], "page": 2})
    assert status == 200 and shot["label"] == "page 2 of 2" and base64.b64decode(shot["png"])[:4] == b"\x89PNG", shot.get("label")
    status, err = job("/v1/render", {"kind": "pdf-page", "file": out["pdf"], "page": 3})
    assert status == 422 and err == {"error": "This PDF has 2 pages.", "model": True}, err


ATTEMPTS = f"""<p>probe</p><img src="http://{FIXTURE}:8000/img"><iframe src="http://{FIXTURE}:8000/frame"></iframe>
<link rel="stylesheet" href="http://{FIXTURE}:8000/css"><link rel="prefetch" href="http://{FIXTURE}:8000/prefetch">
<script>
(async () => {{
  const out = {{}};
  const urls = {{ fixture: "http://{FIXTURE}:8000/fetch", rebind: "http://rebind.okaychat.test:8000/fetch", job: "http://127.0.0.1:8080/health",
    proxy: "http://127.0.0.1:3128/", scrapling: "http://127.0.0.1:8092/mcp", file: "file:///etc/passwd", token: "file:///run/okaychat-browser/token",
    hex: "http://0x0a.0xe7.0x01.0x32:8000/fetch", decimal: "http://182911282:8000/fetch", ipv6: "http://[::ffff:10.231.1.50]:8000/fetch" }};
  for (const [k, u] of Object.entries(urls)) {{ try {{ const r = await fetch(u, {{ mode: "no-cors" }}); out[k] = "reached:" + r.type; }} catch (e) {{ out[k] = "blocked"; }} }}
  try {{ navigator.sendBeacon("http://{FIXTURE}:8000/beacon", "x"); }} catch {{}}
  try {{ new WebSocket("ws://{FIXTURE}:8000/ws"); }} catch {{}}
  try {{ const w = new Worker(URL.createObjectURL(new Blob(["fetch('http://{FIXTURE}:8000/worker')"]))); }} catch {{}}
  await new Promise((r) => setTimeout(r, 1500));
  console.error("RESULT " + JSON.stringify(out));
}})();
</script>"""


@test
def rendered_pages_reach_no_private_destination():
    for network in ("offline", "cdn"):
        reset()
        status, out = job("/v1/render", {"kind": "screenshot", "html": ATTEMPTS, "network": network})
        assert status == 200, out
        # The fixture's counter is the evidence; the notes show each attempt was stopped and reported.
        assert hits()["http"] == 0 and hits()["tcp"] == 0, (network, hits())
        errors = "\n".join(out["errors"])
        for target in ("10.231.1.50:8000/img", "10.231.1.50:8000/fetch", "rebind.okaychat.test:8000", "127.0.0.1:8080/health", "127.0.0.1:3128/", "127.0.0.1:8092/mcp"):
            assert f"Blocked request to http://{target}" in errors, (network, target, errors)
        assert "Not allowed to load local resource: file:///etc/passwd" in errors and "Blocked WebSocket to ws://10.231.1.50" in errors, errors
        # The page's own summary, when it finished before the screenshot.
        summary = next((e for e in out["errors"] if e.startswith("RESULT ")), None)
        if summary:
            result = json.loads(summary[7:])
            assert all(v == "blocked" for v in result.values()), (network, result)
        control()
        results.append({"name": f"render attempts {network}", "detail": out["errors"]})


@test
def cdn_previews_load_only_from_the_allowlist():
    page = """<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script>addEventListener("load", () => console.error("CDN " + (typeof confetti) + " " + (typeof jQuery)))</script><p>hi</p>"""
    status, cdn = job("/v1/render", {"kind": "screenshot", "html": page, "network": "cdn"})
    assert status == 200 and "CDN function undefined" in cdn["errors"], cdn["errors"]
    assert any("Blocked request to https://code.jquery.com/jquery-3.7.1.min.js: previews can load only from" in e for e in cdn["errors"]), cdn["errors"]
    status, offline = job("/v1/render", {"kind": "screenshot", "html": page, "network": "offline"})
    assert status == 200 and "CDN undefined undefined" in offline["errors"], offline["errors"]
    assert any("this render is offline" in e and "cdn.jsdelivr.net" in e for e in offline["errors"]), offline["errors"]


@test
def scrapling_fetches_public_pages_only():
    status, page = job("/v1/fetch", {"url": "https://example.com/"})
    assert status == 200 and page.get("content") and "documentation" in page["content"], page
    reset()
    for url in (f"http://{FIXTURE}:8000/scrape", "http://rebind.okaychat.test:8000/scrape", "http://127.0.0.1:8080/health", "http://localhost:3128/",
                "http://[::1]:8080/", "http://0x7f000001:8080/", "http://okaychat:8787/api/health", "http://browser:8080/health"):
        status, page = job("/v1/fetch", {"url": url})
        assert status == 200 and page.get("title") is None, (url, page)
    assert hits()["http"] == 0, hits()
    control()


@test
def concurrent_jobs_queue_and_all_finish():
    t = time.time()
    with concurrent.futures.ThreadPoolExecutor(5) as pool:
        futures = [pool.submit(job, "/v1/render", {"kind": "screenshot", "html": f"<h1>Job {n}</h1>" + "<p>x</p>" * 200, "network": "offline"}) for n in range(5)]
        statuses = [f.result()[0] for f in futures]
    assert statuses == [200] * 5, statuses
    results.append({"name": "five concurrent screenshots", "seconds": round(time.time() - t, 1)})


@test
def app_uses_the_worker_and_sandbox_in_compose():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    origin = {"Origin": APP, "Content-Type": "application/json"}

    def request(method, path, body=None):
        req = urllib.request.Request(APP + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=origin)
        with opener.open(req, timeout=120) as res:
            return res.status, res.headers.get("Content-Type", ""), res.read()

    try:
        request("POST", "/api/auth/signup", {"email": "it@example.test", "password": "integration-test-pass"})
    except urllib.error.HTTPError as e:
        assert e.code == 409, e.read()
        request("POST", "/api/auth/login", {"email": "it@example.test", "password": "integration-test-pass"})
    _, _, body = request("GET", "/api/sandbox")
    assert json.loads(body) == {"configured": True, "reachable": True}, body
    request("POST", "/api/threads", {"id": "thr_it_export"})
    status, kind, pdf = request("GET", "/api/threads/thr_it_export/export?format=pdf")
    assert status == 200 and kind == "application/pdf" and pdf[:5] == b"%PDF-", (status, kind, pdf[:20])


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
    with open(f"{SHARE}/browser-results.json", "w") as f:
        json.dump(results, f, indent=1)
    print(f"{failures} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
