"""Ray Zhang. Linux filesystem rollback test; no live systemd or network calls."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest


class RollbackTest(unittest.TestCase):
    def test_failed_ray_restart_restores_files_but_never_restores_sessions_or_ledger(self):
        self.exercise(False)

    def test_node_appearing_during_preparation_refuses_migration_without_session_or_state_loss(self):
        self.exercise(True)

    def exercise(self, pairing_race):
        spec = importlib.util.spec_from_file_location('switch_path', sys.argv[1])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='reach-deploy-path-') as directory:
            root = Path(directory)
            # All production paths and external effects are explicitly replaced.
            module.BINARY = root / 'ray-front'
            module.BINARY.write_bytes(b'original-binary')
            module.ORIGINAL = module.digest(module.BINARY)
            module.OLD_RELEASE = root / 'old-release'
            module.OLD_RELEASE.mkdir()
            module.CURRENT = root / 'current'
            module.CURRENT.symlink_to(module.OLD_RELEASE)
            module.ENV = root / 'service.env'
            original_env = 'REACH_PUBLIC_ORIGIN=https://118.25.103.226:8443\nREACH_DATA_DIR=/var/lib/reach\n'
            module.ENV.write_text(original_env)
            module.DROPIN = root / 'reach.conf'
            module.DATABASE = root / 'reach.sqlite'
            with sqlite3.connect(module.DATABASE) as db:
                for table in ('nodes', 'operations', 'sessions'):
                    db.execute('CREATE TABLE ' + table + '(id TEXT)')
                db.execute("INSERT INTO sessions VALUES('expired-fixture')")
                db.execute('PRAGMA application_id=124578')
            archive = root / 'candidate.tar.gz'
            archive.write_bytes(b'archive-fixture')
            credentials = root / 'credentials.json'
            credentials.write_text('{}')
            commands = []
            restarts = 0

            def command(*args):
                nonlocal restarts
                commands.append(args)
                if pairing_race and args == ('systemctl', 'stop', 'reach-ingress', 'reach') and not any(c == ('systemctl', 'restart', 'ray-front') for c in commands):
                    with sqlite3.connect(module.DATABASE) as db:
                        if not db.execute('SELECT count(*) FROM nodes').fetchone()[0]:
                            db.execute("INSERT INTO nodes VALUES('late-node')")
                if args == ('systemctl', 'restart', 'ray-front'):
                    restarts += 1
                    if restarts == 1 and not pairing_race:
                        self.assertEqual(module.BINARY.read_bytes(), b'candidate-binary')
                        self.assertTrue(module.DROPIN.exists())
                        # Simulate a newly appended durable record at the failure.
                        with sqlite3.connect(module.DATABASE) as db:
                            db.execute("INSERT INTO operations VALUES('must-survive')")
                        raise RuntimeError('injected failed restart')
                return 'active'

            def clear_sessions():
                with sqlite3.connect(module.DATABASE) as db:
                    db.execute('DELETE FROM sessions')

            # Replace only the candidate path constructor, leaving pathlib's
            # real file operations and atomic replacement code active.
            real_path = Path
            def path(value):
                if str(value).startswith('/opt/reach/releases/20261102-path-'):
                    return root / 'candidate-release'
                return real_path(value)

            def extract(_archive, release):
                (release / 'bin').mkdir(parents=True)
                (release / 'deploy').mkdir()
                (release / 'bin/ray-front').write_bytes(b'candidate-binary')
                (release / 'deploy/ray-front-reach.conf').write_text('[Service]\nEnvironment=REACH_PORTAL_ORIGIN=https://118.25.103.226/reach\n')

            module.Path = path
            module.command = command
            module.old_checks = lambda: {'fixture': 200}
            module.wait_health = lambda _path: {'fixture': True}
            module.clear_sessions = clear_sessions
            module.runpy.run_path = lambda _path: {'extract_release': extract}
            saved = sys.argv
            sys.argv = ['switch', '--archive', str(archive), '--sha256', module.digest(archive), '--binary-sha256', hashlib.sha256(b'candidate-binary').hexdigest(), '--credentials', str(credentials), '--backup', str(root / 'backup')]
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(RuntimeError, 'appeared during preparation' if pairing_race else 'injected failed restart'):
                        module.main()
            finally:
                sys.argv = saved
            self.assertEqual(module.BINARY.read_bytes(), b'original-binary')
            self.assertEqual(module.ENV.read_text(), original_env)
            self.assertEqual(module.CURRENT.resolve(), module.OLD_RELEASE)
            self.assertFalse(module.DROPIN.exists())
            self.assertEqual(restarts, 1 if pairing_race else 2)
            with sqlite3.connect(module.DATABASE) as db:
                self.assertEqual(db.execute('SELECT id FROM operations').fetchall(), [] if pairing_race else [('must-survive',)])
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 1 if pairing_race else 0)
                self.assertEqual(db.execute('SELECT id FROM nodes').fetchall(), [('late-node',)] if pairing_race else [])
                self.assertEqual(db.execute('PRAGMA application_id').fetchone()[0], 124578)
            receipt = json.loads((root / 'backup/receipt.json').read_text())
            self.assertEqual(receipt['status'], 'rolled-back-original-ledger-preserved')
            self.assertFalse(receipt['database_restored'])
            self.assertFalse(list(root.glob('*.reach-*')))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])
