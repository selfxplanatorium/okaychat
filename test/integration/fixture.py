#!/usr/bin/env python3
"""Controlled destination for the isolation tests. Listens on HTTP 8000, raw TCP 9000, and UDP 9999 and counts
every connection or datagram, so a test can prove nothing arrived (and, as a positive control, that something
does arrive from a peer that is allowed to connect). GET /hits returns the counters, POST /reset clears them.
Runs only inside the integration-test compose project."""

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

hits = {"http": 0, "tcp": 0, "udp": 0, "paths": []}
lock = threading.Lock()


def count(kind: str, path: str | None = None) -> None:
    with lock:
        hits[kind] += 1
        if path and len(hits["paths"]) < 200:
            hits["paths"].append(path)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self, body: bytes, kind="text/plain"):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/hits":
            with lock:
                return self.answer(json.dumps(hits).encode(), "application/json")
        count("http", self.path)
        self.answer(b"fixture says hello")

    def do_POST(self):
        if self.path == "/reset":
            with lock:
                hits.update(http=0, tcp=0, udp=0, paths=[])
            return self.answer(b"ok")
        count("http", self.path)
        self.answer(b"ok")

    do_CONNECT = do_GET


def tcp():
    server = socket.create_server(("0.0.0.0", 9000))
    while True:
        conn, _ = server.accept()
        count("tcp")
        conn.close()


def udp():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 9999))
    while True:
        sock.recvfrom(65536)
        count("udp")


threading.Thread(target=tcp, daemon=True).start()
threading.Thread(target=udp, daemon=True).start()
ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
