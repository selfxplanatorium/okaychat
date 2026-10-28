"""Shared fixture protocol. Only booleans/metadata leave a job; never the canary bytes."""
import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import socket
import time

FIXTURE = Path('.okaychat/cross-chat')
FIXTURE.mkdir(mode=0o700, exist_ok=True)


def publish(value):
    temporary = FIXTURE / 'status.tmp'
    temporary.write_text(json.dumps(value))
    temporary.replace(FIXTURE / 'status.json')


def command(previous):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            value = json.loads((FIXTURE / 'control.json').read_text())
            if value['nonce'] != previous:
                return value
        except FileNotFoundError:
            pass
        time.sleep(0.025)
    raise RuntimeError('fixture controller stopped responding')


def identity(pid):
    # Only the explicitly supplied fixture pid, never a process scan. Handle spaces in comm.
    text = Path(f'/proc/{pid}/stat').read_text()
    return {'pid': pid, 'start': text[text.rfind(')') + 2:].split()[19]}


def read_bytes(path):
    with open(path, 'rb') as source:
        return source.read(32)


def read_memory(pid, address):
    fd = os.open(f'/proc/{pid}/mem', os.O_RDONLY)
    try:
        return os.pread(fd, 32, address)
    finally:
        os.close(fd)


class IOVec(ctypes.Structure):
    _fields_ = [('base', ctypes.c_void_p), ('length', ctypes.c_size_t)]


def vm_read(pid, address):
    target = ctypes.create_string_buffer(32)
    local = IOVec(ctypes.addressof(target), 32)
    remote = IOVec(address, 32)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.process_vm_readv.restype = ctypes.c_ssize_t
    size = libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
    if size < 0:
        raise OSError(ctypes.get_errno(), 'fixture memory read refused')
    return target.raw[:size]


def connect(path):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(1)
        client.connect(str(path))
        client.sendall(b'ping')
        return client.recv(4) == b'pong'
