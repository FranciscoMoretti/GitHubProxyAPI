"""Isolated activation fixture. Owns a listener, never registers an OS service.
Passes the real listening FD, activates on demand, and reaps crashed children.
OS login/reboot and launch_activate_socket check-in require separate acceptance.
"""
import os
import select
import signal
import socket
import sys
import time

path = sys.argv[1]
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
assert listener.fileno() == 3
listener.bind(path)
os.chmod(path, 0o600)
listener.listen(128)
listener.set_inheritable(True)
child = None
starts = 0
print('ready', flush=True)
try:
    while True:
        if child is not None:
            exited, _ = os.waitpid(child, os.WNOHANG)
            if exited:
                child = None
        readable, _, _ = select.select([sys.stdin] + ([listener] if child is None else []), [], [], 0.02)
        if sys.stdin in readable:
            break
        if listener in readable:
            child = os.fork()
            if child == 0:
                try:
                    env = dict(os.environ)
                    if sys.platform == 'darwin':
                        env['GHPA_LAUNCH_FD'] = '3'
                    else:
                        env.update(LISTEN_FDS='1', LISTEN_PID=str(os.getpid()), LISTEN_FDNAMES='ghpa')
                    os.execve(sys.argv[2], sys.argv[2:], env)
                except BaseException as error:
                    print('exec failed: ' + str(error), file=sys.stderr, flush=True)
                finally:
                    os._exit(127)
            starts += 1
            print('started ' + str(child), flush=True)
finally:
    if child is not None:
        try:
            os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)
        except ProcessLookupError:
            pass
    listener.close()
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
