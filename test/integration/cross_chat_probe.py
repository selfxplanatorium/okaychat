# Executed after cross_chat_common.py and the controller-supplied TARGET, inside Chat B.
pid = TARGET['pid']
proc = f'/proc/{pid}'


def open_directory():
    fd = os.open(TARGET['workspace'], os.O_RDONLY | os.O_DIRECTORY)
    os.close(fd)


attempts = {
    'workspace_open': open_directory,
    'workspace_list': lambda: os.listdir(TARGET['workspace']),
    'canary_read': lambda: read_bytes(TARGET['canary']),
    'proc_root_canary': lambda: read_bytes(proc + '/root' + TARGET['canary']),
    'unix_socket': lambda: connect(TARGET['socket']),
    'proc_root_socket': lambda: connect(proc + '/root' + TARGET['socket']),
    'environment': lambda: read_bytes(proc + '/environ'),
    'memory': lambda: read_memory(pid, TARGET['address']),
    'process_vm_readv': lambda: vm_read(pid, TARGET['address']),
    'fd_list': lambda: os.listdir(proc + '/fd'),
    'fd_readlink': lambda: os.readlink(proc + f"/fd/{TARGET['fd']}"),
    'fd_read': lambda: read_bytes(proc + f"/fd/{TARGET['fd']}"),
    'signal_zero': lambda: os.kill(pid, 0),
    # A installed and locally checked a harmless handler; never use a destructive signal.
    'signal_usr1': lambda: os.kill(pid, signal.SIGUSR1),
}
nonce = 'ready'
publish(dict(nonce=nonce, identity=identity(os.getpid()), uid=os.getuid(), workspace=str(Path.cwd())))
while True:
    request = command(nonce)
    nonce = request['nonce']
    if request['op'] == 'stop':
        break
    before = identity(pid)
    try:
        attempts[request['op']]()
        result = 'ALLOWED'
    except OSError as error:
        result = errno.errorcode.get(error.errno, f'errno={error.errno}')
    publish(dict(nonce=nonce, result=result, before=before, after=identity(pid)))
