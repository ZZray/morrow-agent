"""Ray Zhang. Regression checks for deterministic, offline source preparation."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import source


class SourceTests(unittest.TestCase):
    def cache(self, root):
        target = root / 'work/shared-source'
        target.mkdir(parents=True)
        data = b'module ara\n'
        (target / 'go.mod').write_bytes(data)
        (root / 'work/shared-source-manifest.json').write_text(json.dumps({
            'commit': source.REV, 'files': {'go.mod': hashlib.sha256(data).hexdigest()}
        }), encoding='utf-8')
        return target

    def test_complete_cache_never_resolves_repository(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(source, 'source_repository', side_effect=AssertionError('network requested')):
            root = Path(temp)
            self.cache(root)
            with patch.object(source, 'ROOT', root):
                source.prepare(None)

    def test_changed_or_extra_cache_files_are_rejected(self):
        for changed in ('go.mod', 'extra.go'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (self.cache(root) / changed).write_bytes(b'changed')
                with patch.object(source, 'ROOT', root), patch.object(source, 'source_repository', side_effect=AssertionError('network requested')):
                    with self.assertRaisesRegex(RuntimeError, 'cache changed'):
                        source.prepare(None)

    def test_incomplete_cache_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'work/shared-source').mkdir(parents=True)
            with patch.object(source, 'ROOT', root):
                with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                    source.prepare(None)

    def test_archive_ignores_host_autocrlf(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            (repo / 'LICENSE').write_bytes(b'copyright\nlicense\n')
            source.git(repo, '-c', 'core.autocrlf=false', 'add', 'LICENSE')
            source.git(repo, '-c', 'user.name=Source Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
            rev = source.git(repo, 'rev-parse', 'HEAD').decode().strip()
            source.git(repo, 'config', 'core.autocrlf', 'true')
            with patch.object(source, 'REV', rev):
                self.assertEqual(source.archive(repo, ['LICENSE'])['LICENSE'], source.git(repo, 'show', rev + ':LICENSE'))


if __name__ == '__main__':
    unittest.main()
