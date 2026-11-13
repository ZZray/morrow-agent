"""Ray Zhang. Exercise the ordinary Desk binary using fresh local state only."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=ROOT / 'dist/reach-desk.exe')
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve()
    checks = []
    env = dict(os.environ)
    for key in ('REACH_DESK_STATE_DIR', 'HW_DEV'):
        env.pop(key, None)
    with tempfile.TemporaryDirectory(prefix='reach-desk-smoke-') as temporary:
        root = Path(temporary)
        legacy = root / 'legacy'
        legacy.mkdir()
        marker = b'token=legacy-sentinel\n'
        (legacy / 'hub.conf').write_bytes(marker)
        env['HW_CONF'] = str(legacy)

        def command(name, argv, code, needle, state=None):
            child_env = dict(env)
            if state is not None:
                child_env['REACH_DESK_STATE_DIR'] = str(state)
            result = subprocess.run([str(binary), *argv], cwd=root, env=child_env, capture_output=True, text=True, encoding='utf-8', timeout=15)
            output = result.stdout + result.stderr
            assert result.returncode == code and needle in output, (name, result.returncode, output)
            checks.append({'name': name, 'passed': True, 'exit_code': code})

        command('no arguments show help', [], 0, 'Reach Desk')
        command('version has confirmed product name', ['version'], 0, 'Reach Desk compatibility')
        for old_command in ('node', 'pair', 'approve', 'deny'):
            command('reject legacy ' + old_command, [old_command], 2, 'device operations use Reach Node')
        command('missing state rejects inherited HW_CONF', ['serve'], 2, 'explicit absolute directory')
        command('relative state rejected', ['serve'], 2, 'explicit absolute directory', 'relative')
        blocked = root / 'occupied'
        blocked.write_text('file', encoding='utf-8')
        command('file state rejected', ['serve'], 2, 'create Reach Desk state directory', blocked)
        command('uncreatable child state rejected', ['serve'], 2, 'create Reach Desk state directory', blocked / 'child')
        assert (legacy / 'hub.conf').read_bytes() == marker and len(list(legacy.iterdir())) == 1
        checks.append({'name': 'legacy sentinel remains untouched', 'passed': True})

        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            port = reserved.getsockname()[1]
        state = root / 'desk'
        state.mkdir()
        (state / 'hub.conf').write_text('token=' + secrets.token_hex(32) + '\n', encoding='utf-8')
        env['REACH_DESK_STATE_DIR'] = str(state)
        with (root / 'process.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen([str(binary), 'serve', '-listen', f'127.0.0.1:{port}'], cwd=root, env=env, stdout=log, stderr=log)
            try:
                def request(path):
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                    try:
                        connection.request('GET', path)
                        response = connection.getresponse()
                        return response.status, response.read().decode('utf-8'), response.getheader('Location')
                    finally:
                        connection.close()
                deadline = time.monotonic() + 30
                while True:
                    assert process.poll() is None, 'Desk exited before readiness'
                    try:
                        status, body, _ = request('/healthz')
                        if status == 200 and 'ok' in body.lower():
                            break
                    except OSError:
                        pass
                    if time.monotonic() > deadline:
                        raise RuntimeError('Desk readiness timed out')
                    time.sleep(0.1)
                checks.append({'name': 'ordinary binary health response', 'passed': True, 'status': status, 'body': body})
                status, body, _ = request('/login')
                assert status == 200 and '<title>Reach Desk' in body and '<h1>Reach Desk' in body
                checks.append({'name': 'embedded login has Reach Desk brand', 'passed': True})
                status, body, location = request('/api/sessions')
                assert status in (401, 403) or (status in (302, 303, 307) and location and location.startswith('/login'))
                checks.append({'name': 'anonymous API access denied', 'passed': True, 'status': status})
                assert (legacy / 'hub.conf').read_bytes() == marker and len(list(legacy.iterdir())) == 1
                checks.append({'name': 'live server uses isolated state', 'passed': True})
            finally:
                process.terminate()
                process.wait(timeout=15)
        assert process.poll() is not None
        checks.append({'name': 'temporary server stopped', 'passed': True})
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps({
        'author': 'Ray Zhang', 'binary': binary.name,
        'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
        'checks': checks, 'scope': 'local compatibility binary; no model, Reach identity, device integration or deployment'
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{len(checks)} ordinary-binary checks passed; temporary server stopped')


if __name__ == '__main__':
    main()
