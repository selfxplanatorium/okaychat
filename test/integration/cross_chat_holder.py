# Executed after cross_chat_common.py, inside Chat A's real run_code job.
import secrets
import stat
import sys
import threading

# exec gives /proc/self/environ a harmless, known positive-control entry.
if os.environ.get('OKAYCHAT_ISOLATION_FIXTURE') != 'harmless':
    os.execve(sys.executable, [sys.executable, '.okaychat/main.py'],
              dict(os.environ, OKAYCHAT_ISOLATION_FIXTURE='harmless'))

private = FIXTURE.resolve()
canary = private / 'canary.bin'
secret = secrets.token_bytes(32)
fd = os.open(canary, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
os.write(fd, secret)
memory = ctypes.create_string_buffer(secret)
address = ctypes.addressof(memory)
socket_path = private / 'listener.sock'
listener = socket.socket(socket.AF_UNIX)
listener.bind(str(socket_path))
listener.listen(4)
signals = 0


def signalled(_number, _frame):
    global signals
    signals += 1


def serve():
    while True:
        client, _ = listener.accept()
        with client:
            client.settimeout(1)
            if client.recv(4) == b'ping':
                client.sendall(b'pong')


signal.signal(signal.SIGUSR1, signalled)
threading.Thread(target=serve, daemon=True).start()
os.kill(os.getpid(), signal.SIGUSR1)
assert signals == 1
target = dict(identity(os.getpid()), uid=os.getuid(), workspace=str(Path.cwd()),
              canary=str(canary), socket=str(socket_path), fd=fd, address=address)


def checkpoint(nonce):
    pid = os.getpid()
    os.kill(pid, 0)
    directory_fd = os.open(Path.cwd(), os.O_RDONLY | os.O_DIRECTORY)
    os.close(directory_fd)
    checks = {
        'workspace_open': True,
        'workspace_list': '.okaychat' in os.listdir(Path.cwd()),
        'private_mode': stat.S_IMODE(private.stat().st_mode) == 0o700,
        'workspace_mode': stat.S_IMODE(Path.cwd().stat().st_mode) == 0o700,
        'canary_mode': stat.S_IMODE(canary.stat().st_mode) == 0o600,
        'canary_read': read_bytes(canary) == secret,
        'proc_root_canary': read_bytes(f'/proc/{pid}/root{canary}') == secret,
        'unix_socket': stat.S_ISSOCK(socket_path.stat().st_mode) and connect(socket_path),
        'proc_root_socket': connect(f'/proc/{pid}/root{socket_path}'),
        'environment': b'OKAYCHAT_ISOLATION_FIXTURE=harmless\0' in Path(f'/proc/{pid}/environ').read_bytes(),
        'memory': read_memory(pid, address) == secret,
        'process_vm_readv': vm_read(pid, address) == secret,
        'fd_list': str(fd) in os.listdir(f'/proc/{pid}/fd'),
        'fd_readlink': os.readlink(f'/proc/{pid}/fd/{fd}') == str(canary),
        'fd_read': read_bytes(f'/proc/{pid}/fd/{fd}') == secret,
        'signal_zero': True,
        'signal_usr1': signals == 1,
    }
    publish(dict(nonce=nonce, target=target, checks=checks, signals=signals,
                 identity=identity(pid)))


try:
    nonce = 'ready'
    checkpoint(nonce)
    while True:
        request = command(nonce)
        nonce = request['nonce']
        if request['op'] == 'stop':
            break
        checkpoint(nonce)
finally:
    listener.close()
    os.close(fd)
    socket_path.unlink(missing_ok=True)
    canary.unlink(missing_ok=True)
