"""Drive the installed CLI through a real PTY; no mocked isTTY or renderer."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

cli, home = sys.argv[1:]
env = {**os.environ, 'COMMON_MEMORY_HOME': home, 'HOME': home,
       'CODEX_HOME': home + '/codex', 'PI_CODING_AGENT_DIR': home + '/pi',
       'TERM': 'xterm-256color', 'NODE_OPTIONS': '', 'NODE_NO_WARNINGS': ''}
env.pop('NO_COLOR', None)

def drive(steps):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    child = subprocess.Popen([cli], stdin=slave, stdout=slave, stderr=slave,
                             env=env, start_new_session=True)
    os.close(slave)
    output, frame, step = b'', b'', 0
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                output += chunk
                frame += chunk
                if step < len(steps) and steps[step][0].encode() in re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', frame):
                    os.write(master, steps[step][1])
                    step += 1
                    frame = b''
            elif child.poll() is not None:
                break
        assert step == len(steps), output.decode(errors='replace')
        assert child.wait(timeout=3) == 0, output.decode(errors='replace')
        assert b'ExperimentalWarning' not in output, output.decode(errors='replace')
        return output
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        os.close(master)

# First launch enters model setup; cancelling must create no config or database.
drive([('Model Configuration', b'\x1b')])
assert not os.path.exists(home + '/config.json')
# A synthetic existing config exercises normal startup without any provider calls.
with open(home + '/fixture.json', encoding='utf8') as file:
    config = json.load(file)
with open(home + '/config.json', 'w', encoding='utf8') as file:
    json.dump(config, file)
for _ in range(2):
    output = drive([('Enter: confirm', b'\x1b[B'),
                   ('查找、查看与自然语言调整', b'\x1b[B'),
                   ('查看配置与更换模型', b'\x1b[A'),
                   ('查找、查看与自然语言调整', b'\x1b[A'),
                   ('选择需要接入的 Agent', b'\x1b')])
    assert b'Model Configuration' not in output
    assert b'Done' in output
assert not os.path.exists(config['dataRoot']), 'Viewing TUI must not open runtime SQLite'
print('PASS: installed CLI in a real WSL PTY: first-run cancel, repeated startup, arrows and Esc.')
