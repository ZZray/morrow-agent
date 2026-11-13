#!/usr/bin/env python3
"""Ray Zhang: migrate the unused first Reach install to the existing Ray TLS path.

Keeps Ray identity/config and the Reach operation database in place. This is a
one-time migration, guarded by exact live versions and zero existing Nodes.
"""
import argparse
from contextlib import closing
import hashlib
import http.client
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import sqlite3
import ssl
import subprocess
import tempfile
import time
import uuid

IP = '118.25.103.226'
ORIGINAL = '72c4eff9bd3f747ff9c111dbdbb53803816683634e4818ab4df453c4ef61a188'
OLD_RELEASE = Path('/opt/reach/releases/20261102-f5bf3af0f024')
BINARY = Path('/opt/ray-front/bin/ray-front')
CURRENT = Path('/opt/reach/current')
ENV = Path('/etc/reach/service.env')
DROPIN = Path('/etc/systemd/system/ray-front.service.d/reach.conf')
DATABASE = Path('/var/lib/reach/reach.sqlite')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def atomic_file(source, target, mode):
    descriptor, name = tempfile.mkstemp(prefix=target.name + '.reach-', dir=target.parent)
    temp = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


def link_release(release):
    temp = CURRENT.with_name('current.reach-' + uuid.uuid4().hex)
    try:
        temp.symlink_to(release, target_is_directory=True)
        os.replace(temp, CURRENT)
    finally:
        temp.unlink(missing_ok=True)


class LocalTLS(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        self.sock = self._context.wrap_socket(raw, server_hostname=IP)


def request(path, method='GET', data=None, token='', port=443):
    connection = LocalTLS(IP, port=port, timeout=10, context=ssl.create_default_context())
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    try:
        connection.request(method, path, None if data is None else json.dumps(data), headers)
        response = connection.getresponse()
        body = response.read(2_097_153)
        return response.status, body, response.getheaders()
    finally:
        connection.close()


def wait_health(path):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        try:
            status, body, _ = request(path)
            if status == 200:
                return json.loads(body)
        except (OSError, ValueError):
            pass
        time.sleep(0.4)
    raise RuntimeError('health check did not settle')


def old_checks():
    observed = {}
    for path, expected in [('/', 303), ('/ray/login', 200), ('/healthz', 200), ('/handwave/healthz', 200), ('/arena/health', 200)]:
        status, _, _ = request(path)
        if status != expected:
            raise RuntimeError('original route status changed: ' + path)
        observed[path] = status
    status, _, _ = request('/api/health', port=8000)
    if status != 200:
        raise RuntimeError('RainFlow health changed')
    observed[':8000/api/health'] = status
    return observed


def clear_sessions():
    # Run as the state owner, including any SQLite WAL/SHM creation.
    command('runuser', '-u', 'reach', '--', '/usr/bin/python3', '-c',
            "import sqlite3; db=sqlite3.connect('/var/lib/reach/reach.sqlite'); db.execute('DELETE FROM sessions'); db.commit(); db.close()")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--binary-sha256', required=True)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--backup', required=True)
    args = parser.parse_args()
    archive = Path(args.archive).resolve()
    backup = Path(args.backup).resolve()
    if os.geteuid() != 0 or digest(archive) != args.sha256 or digest(BINARY) != ORIGINAL:
        raise RuntimeError('deployment identity/hash precondition failed')
    if CURRENT.resolve() != OLD_RELEASE or DROPIN.exists() or DROPIN.is_symlink() or backup.exists():
        raise RuntimeError('live layout changed or backup already exists')
    with closing(sqlite3.connect('file:' + str(DATABASE) + '?mode=ro', uri=True)) as db:
        counts = {name: db.execute('SELECT count(*) FROM ' + name).fetchone()[0] for name in ('nodes', 'operations', 'sessions')}
    if counts['nodes'] or counts['operations']:
        raise RuntimeError('existing Node/operation requires explicit endpoint migration; state preserved')
    before = old_checks()
    for unit in ('reach', 'reach-ingress', 'ray-front'):
        if command('systemctl', 'is-active', unit) != 'active':
            raise RuntimeError('expected active service missing')
    release = Path('/opt/reach/releases/20261102-path-' + args.sha256[:12])
    if release.exists():
        raise RuntimeError('candidate release already exists')
    backup.mkdir(mode=0o700)
    shutil.copy2(BINARY, backup / 'ray-front')
    shutil.copy2(ENV, backup / 'service.env')
    (backup / 'service.env').chmod(0o600)
    with closing(sqlite3.connect('file:' + str(DATABASE) + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(backup / 'reach-before.sqlite')) as target:
            source.backup(target)
    (backup / 'reach-before.sqlite').chmod(0o600)
    receipt = {'status': 'prepared', 'old_binary_sha256': ORIGINAL, 'old_release': str(OLD_RELEASE), 'release': str(release), 'archive_sha256': args.sha256, 'binary_sha256': args.binary_sha256, 'state_before': counts, 'original_routes_before': before, 'database_restored': False}
    changed = False
    migration_started = False
    try:
        extract = runpy.run_path(str(Path(__file__).with_name('install-first.py')))['extract_release']
        extract(archive, release)
        if digest(release / 'bin/ray-front') != args.binary_sha256 or digest(BINARY) != ORIGINAL:
            raise RuntimeError('candidate/live binary changed')
        lines = ENV.read_text().splitlines()
        if 'REACH_PUBLIC_ORIGIN=https://' + IP + ':8443' not in lines or any(line.startswith(('REACH_COOKIE_PATH=', 'REACH_BOOTSTRAP_')) for line in lines):
            raise RuntimeError('environment precondition changed')
        new_env = '\n'.join(('REACH_PUBLIC_ORIGIN=https://' + IP if line.startswith('REACH_PUBLIC_ORIGIN=') else line) for line in lines) + '\nREACH_COOKIE_PATH=/reach/\n'
        prepared = backup / 'service-new.env'
        prepared.write_text(new_env)
        prepared.chmod(0o600)
        # Every subsequent mutation has a rollback entry; never restore a ledger.
        changed = True
        command('systemctl', 'stop', 'reach-ingress', 'reach')
        with closing(sqlite3.connect('file:' + str(DATABASE) + '?mode=ro', uri=True)) as db:
            stopped_counts = {name: db.execute('SELECT count(*) FROM ' + name).fetchone()[0] for name in ('nodes', 'operations')}
        receipt['state_after_stop'] = stopped_counts
        if any(stopped_counts.values()):
            raise RuntimeError('Node/operation appeared during preparation; endpoint migration refused')
        migration_started = True
        clear_sessions()
        link_release(release)
        atomic_file(prepared, ENV, 0o600)
        command('systemctl', 'start', 'reach')
        atomic_file(release / 'bin/ray-front', BINARY, 0o755)
        atomic_file(release / 'deploy/ray-front-reach.conf', DROPIN, 0o644)
        command('systemctl', 'daemon-reload')
        command('systemctl', 'restart', 'ray-front')
        receipt['reach_health'] = wait_health('/reach/healthz')
        receipt['original_routes_after'] = old_checks()
        if request('/reach/api/v1/nodes')[0] != 401 or request('/reach/')[0] != 200:
            raise RuntimeError('Reach anonymous boundary failed')
        credentials = json.loads(Path(args.credentials).read_text())
        status, body, headers = request('/reach/api/v1/auth/login', 'POST', {'username': credentials['username'], 'password': credentials['password']})
        if status != 200:
            raise RuntimeError('persisted account login failed')
        token = json.loads(body)['token']
        try:
            cookies = [value for name, value in headers if name.lower() == 'set-cookie']
            if len(cookies) != 2 or 'Path=/reach/;' not in cookies[0] or 'Path=/;' not in cookies[1] or 'Max-Age=0' not in cookies[1]:
                raise RuntimeError('Cookie migration failed')
            if request('/reach/api/v1/overview', token=token)[0] != 200:
                raise RuntimeError('account overview failed')
        finally:
            logout = request('/reach/api/v1/auth/logout', 'POST', {}, token)[0]
        if logout != 200 or request('/reach/api/v1/nodes', token=token)[0] != 401:
            raise RuntimeError('logout persistence failed')
        command('systemctl', 'disable', 'reach-ingress')
        receipt['status'] = 'switched-local-tls-verified-public-browser-pending'
        receipt['account_login_after_bootstrap_removal'] = True
    except Exception as error:
        receipt['failure_type'] = type(error).__name__
        if changed:
            try:
                command('systemctl', 'stop', 'reach-ingress', 'reach')
                if migration_started:
                    clear_sessions()
                atomic_file(backup / 'ray-front', BINARY, 0o755)
                if DROPIN.exists():
                    DROPIN.unlink()
                link_release(OLD_RELEASE)
                atomic_file(backup / 'service.env', ENV, 0o600)
                command('systemctl', 'daemon-reload')
                command('systemctl', 'restart', 'ray-front')
                wait_health('/healthz')
                receipt['rollback_routes'] = old_checks()
                command('systemctl', 'enable', '--now', 'reach', 'reach-ingress')
                receipt['status'] = 'rolled-back-original-ledger-preserved'
            except Exception as rollback_error:
                receipt['status'] = 'rollback-needs-attention'
                receipt['rollback_failure_type'] = type(rollback_error).__name__
        raise
    finally:
        (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt))


if __name__ == '__main__':
    main()
