#!/usr/bin/env python3
"""Ray Zhang. Enable the reviewed Ray login bridge; preserve all operation data."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import pwd
import runpy
import shutil
import sqlite3
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--binary-sha256', required=True)
    args = parser.parse_args()
    helpers = runpy.run_path(str(Path(__file__).with_name('switch-ray-path.py')))
    command, atomic, link = helpers['command'], helpers['atomic_file'], helpers['link_release']
    request, wait_health, old_checks = helpers['request'], helpers['wait_health'], helpers['old_checks']
    clear_sessions, digest = helpers['clear_sessions'], helpers['digest']
    archive = Path(args.archive).resolve()
    binary = Path('/opt/ray-front/bin/ray-front')
    old_hash = '8f780bc73af968a184f99ed4314ba07053a66fb739aa3029b4ff9084ae8cbcc3'
    old_release = Path('/opt/reach/releases/20261102-path-227051b674a0')
    release = Path('/opt/reach/releases/20261102-sso-' + args.sha256[:12])
    env = Path('/etc/reach/service.env')
    dropin = Path('/etc/systemd/system/ray-front.service.d/reach.conf')
    keys = [(Path('/etc/reach/ray-sso.key'), 'reach'), (Path('/etc/ray-front/reach-sso.key'), 'ray-front')]
    backup = Path('/root/reach-sso-backup-20261102')
    if os.geteuid() != 0 or digest(archive) != args.sha256 or digest(binary) != old_hash or Path('/opt/reach/current').resolve() != old_release:
        raise RuntimeError('SSO deployment precondition failed')
    if backup.exists() or release.exists() or any(path.exists() for path, _ in keys) or 'REACH_RAY_' in env.read_text() or 'REACH_RAY_' in dropin.read_text():
        raise RuntimeError('existing SSO install or staging conflict')
    before = old_checks()
    backup.mkdir(mode=0o700)
    receipt = {'status': 'prepared', 'old_binary_sha256': old_hash, 'binary_sha256': args.binary_sha256, 'archive_sha256': args.sha256, 'old_release': str(old_release), 'release': str(release), 'original_routes_before': before, 'database_restored': False}
    changed = False
    stopped = False
    try:
        shutil.copy2(binary, backup / 'ray-front')
        shutil.copy2(env, backup / 'service.env')
        shutil.copy2(dropin, backup / 'reach.conf')
        extract = runpy.run_path(str(Path(__file__).with_name('install-first.py')))['extract_release']
        extract(archive, release)
        if digest(release / 'bin/ray-front') != args.binary_sha256 or digest(binary) != old_hash:
            raise RuntimeError('candidate/live hash changed')
        key = os.urandom(32)
        for path, owner in keys:
            with path.open('xb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(key)
            account = pwd.getpwnam(owner)
            os.chown(path, account.pw_uid, account.pw_gid)
        del key
        prepared_env = backup / 'service-new.env'
        prepared_env.write_text(env.read_text().rstrip() + '\nREACH_RAY_SSO_KEY_FILE=/etc/reach/ray-sso.key\nREACH_RAY_USERNAME=ray\n')
        prepared_env.chmod(0o600)
        prepared_dropin = backup / 'reach-new.conf'
        prepared_dropin.write_text(dropin.read_text().rstrip() + '\nEnvironment=REACH_RAY_SSO_KEY_FILE=/etc/ray-front/reach-sso.key\n')
        with closing(sqlite3.connect('file:/var/lib/reach/reach.sqlite?mode=ro', uri=True)) as db:
            active = db.execute("SELECT count(*) FROM operations WHERE execution IN ('received','running') OR (delivery IN ('queued','claimed') AND execution NOT IN ('succeeded','failed','cancelled','unknown'))").fetchone()[0]
        if active:
            raise RuntimeError('operation still executing; Reach was not stopped')
        stopped = True
        command('systemctl', 'stop', 'reach')
        with closing(sqlite3.connect('file:/var/lib/reach/reach.sqlite?mode=ro', uri=True)) as db:
            counts = {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in ('nodes', 'operations', 'operation_events')}
            unsettled = db.execute("SELECT count(*) FROM operations WHERE execution IN ('received','running') OR (delivery IN ('queued','claimed') AND execution NOT IN ('succeeded','failed','cancelled','unknown'))").fetchone()[0]
        receipt['state_before'] = counts
        if unsettled:
            raise RuntimeError('operation still executing; retry after its original settlement')
        changed = True
        clear_sessions()
        link(release)
        atomic(prepared_env, env, 0o600)
        atomic(prepared_dropin, dropin, 0o644)
        atomic(release / 'bin/ray-front', binary, 0o755)
        command('systemctl', 'daemon-reload')
        command('systemctl', 'start', 'reach')
        command('systemctl', 'restart', 'ray-front')
        receipt['health'] = wait_health('/reach/healthz')
        receipt['original_routes_after'] = old_checks()
        status, _, headers = request('/reach/')
        if status != 303 or not any(k.lower() == 'location' and v.startswith('/ray/login?next=') for k, v in headers):
            raise RuntimeError('anonymous browser did not enter Ray login')
        if request('/reach/api/v1/nodes')[0] != 401 or request('/reach/api/v1/auth/ray', 'POST', {})[0] != 403:
            raise RuntimeError('browser/exchange authentication boundary failed')
        for path in ('/reach/assets/admin.js', '/reach/assets/admin.css'):
            if request(path)[0] != 200:
                raise RuntimeError('public management asset unavailable')
        credentials = json.loads(Path('/root/reach-stage-20261102/credentials.json').read_text())
        status, body, _ = request('/reach/api/v1/auth/login', 'POST', {'username': credentials['username'], 'password': credentials['password']})
        if status != 200:
            raise RuntimeError('native login regressed')
        token = json.loads(body)['token']
        try:
            if request('/reach/api/v1/overview', token=token)[0] != 200:
                raise RuntimeError('native bearer regressed')
        finally:
            request('/reach/api/v1/auth/logout', 'POST', {}, token)
        with closing(sqlite3.connect('file:/var/lib/reach/reach.sqlite?mode=ro', uri=True)) as db:
            after = {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in counts}
        if counts != after:
            raise RuntimeError('existing operation data changed during deployment')
        receipt['state_after'] = after
        receipt['status'] = 'sso-enabled-native-and-anonymous-verified-browser-pending'
    except Exception as error:
        receipt['failure_type'] = type(error).__name__
        receipt['status'] = 'preparation-failed-services-unchanged'
        if stopped and not changed:
            restart = subprocess.run(['systemctl', 'start', 'reach'], capture_output=True)
            receipt['restore_reach_exit'] = restart.returncode
            receipt['status'] = 'migration-refused-original-sessions-preserved' if restart.returncode == 0 else 'restore-reach-needs-attention'
        if changed:
            try:
                command('systemctl', 'stop', 'reach')
                clear_sessions()  # old service must not accept former SSO tokens as native
                atomic(backup / 'ray-front', binary, 0o755)
                atomic(backup / 'service.env', env, 0o600)
                atomic(backup / 'reach.conf', dropin, 0o644)
                link(old_release)
                command('systemctl', 'daemon-reload')
                command('systemctl', 'start', 'reach')
                command('systemctl', 'restart', 'ray-front')
                wait_health('/reach/healthz')
                receipt['rollback_routes'] = old_checks()
                receipt['status'] = 'rolled-back-sessions-invalidated-ledger-preserved'
            except Exception as rollback:
                receipt['status'] = 'rollback-needs-attention'
                receipt['rollback_failure_type'] = type(rollback).__name__
        raise
    finally:
        (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt))


if __name__ == '__main__':
    main()
