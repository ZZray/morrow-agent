#!/usr/bin/env python3
"""Ray Zhang. Update only Reach code, retaining Ray login, keys and operation data."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    helpers = runpy.run_path(str(Path(__file__).with_name('switch-ray-path.py')))
    command, digest, link = helpers['command'], helpers['digest'], helpers['link_release']
    old = Path('/opt/reach/releases/20261102-sso-fdb8c2099cda')
    binary_hash = '3b21deba87a5df87b19942a7b9557ab842ff92147e5103125d1d4a2b45fe7bd9'
    archive = Path(args.archive).resolve()
    release = Path('/opt/reach/releases/20261102-sso-stable-' + args.sha256[:12])
    backup = Path('/root/reach-sso-stable-backup-20261102')
    if os.geteuid() != 0 or digest(archive) != args.sha256 or Path('/opt/reach/current').resolve() != old or digest(Path('/opt/ray-front/bin/ray-front')) != binary_hash:
        raise RuntimeError('service update precondition failed')
    if release.exists() or backup.exists():
        raise RuntimeError('update staging already exists')
    backup.mkdir(mode=0o700)
    receipt = {'status': 'prepared', 'old_release': str(old), 'release': str(release), 'archive_sha256': args.sha256, 'ray_binary_sha256': binary_hash, 'database_restored': False}
    stopped = changed = False
    def state():
        with closing(sqlite3.connect('file:/var/lib/reach/reach.sqlite?mode=ro', uri=True)) as db:
            counts = {table: db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in ('nodes', 'operations', 'operation_events')}
            active = db.execute("SELECT count(*) FROM operations WHERE execution IN ('received','running') OR (delivery IN ('queued','claimed') AND execution NOT IN ('succeeded','failed','cancelled','unknown'))").fetchone()[0]
            return counts, active
    try:
        extract = runpy.run_path(str(Path(__file__).with_name('install-first.py')))['extract_release']
        extract(archive, release)
        if digest(release / 'bin/ray-front') != binary_hash:
            raise RuntimeError('this update may not change Ray ingress')
        before, active = state()
        if active:
            raise RuntimeError('active work; service unchanged')
        stopped = True
        command('systemctl', 'stop', 'reach')
        before, active = state()
        receipt['state_before'] = before
        if active:
            raise RuntimeError('new active work; update refused')
        # Preserve native sessions. Invalidate only the old SSO tokens before
        # enabling deterministic first-page reuse; no Ray session is touched.
        command('runuser', '-u', 'reach', '--', '/usr/bin/python3', '-c',
                "import sqlite3; db=sqlite3.connect('/var/lib/reach/reach.sqlite'); db.execute(\"ATTACH DATABASE '/var/lib/reach/ray-auth.sqlite' AS ray\"); db.execute('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM ray.ray_sessions)'); db.commit(); db.close()")
        changed = True
        link(release)
        command('systemctl', 'start', 'reach')
        receipt['health'] = helpers['wait_health']('/reach/healthz')
        after, _ = state()
        if before != after:
            raise RuntimeError('operation ledger counts changed during maintenance')
        receipt['state_after'] = after
        receipt['status'] = 'updated-ray-session-keys-and-operation-ledger-preserved'
    except Exception as error:
        receipt['failure_type'] = type(error).__name__
        receipt['status'] = 'preparation-failed-services-unchanged'
        if stopped:
            try:
                command('systemctl', 'stop', 'reach')
                if changed:
                    link(old)
                command('systemctl', 'start', 'reach')
                helpers['wait_health']('/reach/healthz')
                receipt['status'] = 'old-service-restored-ledger-preserved'
            except Exception as rollback:
                receipt['status'] = 'restore-needs-attention'
                receipt['restore_failure_type'] = type(rollback).__name__
        raise
    finally:
        (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt))


if __name__ == '__main__':
    main()
