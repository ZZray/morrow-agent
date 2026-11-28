# Copyright (c) Ray Zhang. Verify portable archive permissions and publication.
import hashlib
import importlib.util
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / 'packaging/portable/build.py'
SPEC = importlib.util.spec_from_file_location('reach_portable_build', SCRIPT)
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class PortablePublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reach-portable-test-')
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name)
        self.staging = self.output / 'temporary'
        self.staging.mkdir()
        self.stem = 'Reach-Worker-0.1.9-linux-x64-preview'
        self.stage = self.staging / self.stem
        self.stage.mkdir()
        self.archive = self.output / f'{self.stem}.tar.gz'
        self.checksum = self.output / f'{self.stem}.tar.gz.sha256'
        (self.stage / 'notices' / 'dependency').mkdir(parents=True)
        for name, content in [('ryreach', b'worker'), ('README.md', b'readme'),
                              ('LICENSE', b'license'), ('notices/dependency/NOTICE', b'notice')]:
            path = self.stage / name
            path.write_bytes(content)
            path.chmod(0o777)
        for directory in (self.stage, self.stage / 'notices', self.stage / 'notices' / 'dependency'):
            directory.chmod(0o777)

    def test_archive_normalizes_777_input_modes_and_checksum_matches(self):
        original = tarfile.TarFile.gettarinfo

        def world_writable(tar, *args, **kwargs):
            member = original(tar, *args, **kwargs)
            if member:
                # Windows cannot report a regular file as 0777. Exercise the
                # same incoming TarInfo modes on both Windows and Unix.
                member.mode = 0o777
            return member

        with mock.patch.object(tarfile.TarFile, 'gettarinfo', world_writable):
            build.publish(self.stage, self.staging, self.archive)
        with tarfile.open(self.archive, 'r:gz') as package:
            members = package.getmembers()
        modes = {member.name: member.mode for member in members}
        for member in members:
            expected = 0o755 if member.isdir() or member.name == f'{self.stem}/ryreach' else 0o644
            self.assertEqual(member.mode, expected, member.name)
        self.assertEqual(modes[f'{self.stem}/ryreach'], 0o755)
        self.assertEqual(modes[f'{self.stem}/notices/dependency/NOTICE'], 0o644)
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.assertEqual(self.checksum.read_text(encoding='ascii'), f'{digest}  {self.archive.name}\n')

    def test_existing_archive_or_checksum_is_not_overwritten(self):
        for archive_exists, checksum_exists in [(True, False), (False, True), (True, True)]:
            with self.subTest(archive_exists=archive_exists, checksum_exists=checksum_exists):
                if archive_exists:
                    self.archive.write_bytes(b'old archive')
                if checksum_exists:
                    self.checksum.write_bytes(b'old checksum')
                with self.assertRaises(FileExistsError):
                    build.publish(self.stage, self.staging, self.archive)
                self.assertEqual(self.archive.read_bytes() if self.archive.exists() else None,
                                 b'old archive' if archive_exists else None)
                self.assertEqual(self.checksum.read_bytes() if self.checksum.exists() else None,
                                 b'old checksum' if checksum_exists else None)
                self.archive.unlink(missing_ok=True)
                self.checksum.unlink(missing_ok=True)

    def test_dangling_symlinks_are_existing_targets(self):
        for target in (self.archive, self.checksum):
            with self.subTest(target=target.name):
                try:
                    os.symlink(self.output / 'missing', target)
                except OSError as error:
                    self.skipTest(f'Creating symlinks is unavailable: {error}')
                self.assertFalse(target.exists())
                self.assertTrue(os.path.lexists(target))
                with self.assertRaises(FileExistsError):
                    build.publish(self.stage, self.staging, self.archive)
                self.assertTrue(target.is_symlink())
                target.unlink()

    def test_lexists_blocks_a_dangling_target_without_following_it(self):
        original = os.path.lexists
        for target in (self.archive, self.checksum):
            with self.subTest(target=target.name):
                with mock.patch.object(build.os.path, 'lexists', side_effect=lambda path: path == target or original(path)):
                    with self.assertRaises(FileExistsError):
                        build.publish(self.stage, self.staging, self.archive)
                self.assertFalse(self.archive.exists())
                self.assertFalse(self.checksum.exists())

    def test_second_link_failure_removes_only_our_archive(self):
        real_link = os.link

        def conflicting_checksum(source, target):
            if target == self.checksum:
                self.checksum.write_bytes(b'other checksum')
            return real_link(source, target)

        with mock.patch.object(build.os, 'link', side_effect=conflicting_checksum):
            with self.assertRaises(FileExistsError):
                build.publish(self.stage, self.staging, self.archive)
        self.assertFalse(os.path.lexists(self.archive))
        self.assertEqual(self.checksum.read_bytes(), b'other checksum')

    def test_second_link_failure_preserves_a_replaced_archive(self):
        real_link = os.link

        def replaced_archive(source, target):
            if target == self.checksum:
                self.archive.unlink()
                self.archive.write_bytes(b'another publisher')
                raise OSError('simulated checksum publication failure')
            return real_link(source, target)

        with mock.patch.object(build.os, 'link', side_effect=replaced_archive):
            with self.assertRaisesRegex(OSError, 'simulated checksum'):
                build.publish(self.stage, self.staging, self.archive)
        self.assertEqual(self.archive.read_bytes(), b'another publisher')
        self.assertFalse(os.path.lexists(self.checksum))

    def test_interruption_between_links_leaves_only_an_archive(self):
        real_link = os.link

        def interrupted(source, target):
            if target == self.checksum:
                raise KeyboardInterrupt()
            return real_link(source, target)

        with mock.patch.object(build.os, 'link', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                build.publish(self.stage, self.staging, self.archive)
        self.assertTrue(self.archive.is_file())
        self.assertFalse(os.path.lexists(self.checksum))
        with tarfile.open(self.archive, 'r:gz') as package:
            self.assertIn(f'{self.stem}/ryreach', package.getnames())

    def test_racing_archive_creation_is_not_overwritten(self):
        real_link = os.link

        def racing_archive(source, target):
            if target == self.archive:
                self.archive.write_bytes(b'other archive')
            return real_link(source, target)

        with mock.patch.object(build.os, 'link', side_effect=racing_archive):
            with self.assertRaises(FileExistsError):
                build.publish(self.stage, self.staging, self.archive)
        self.assertEqual(self.archive.read_bytes(), b'other archive')
        self.assertFalse(os.path.lexists(self.checksum))


if __name__ == '__main__':
    unittest.main()
