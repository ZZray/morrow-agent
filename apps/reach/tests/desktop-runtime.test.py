"""Copyright (c) Ray Zhang. Actual installed Reach patch, isolated file effects."""
import importlib.metadata
import tempfile
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from thefuzz import process
from windows_mcp.filesystem import service


class RuntimeContract(unittest.TestCase):
    def test_installed_version_and_dependency_graph(self):
        self.assertEqual(importlib.metadata.version('windows-mcp'), '0.8.8+reach.3')
        for name in ['fuzzywuzzy', 'python-Levenshtein', 'Levenshtein']:
            with self.assertRaises(importlib.metadata.PackageNotFoundError):
                importlib.metadata.version(name)

    def test_file_error_content_is_data_and_missing_file_is_error(self):
        with tempfile.TemporaryDirectory(prefix='reach-runtime-') as path:
            p = Path(path)/'content.txt'
            p.write_text('Error: ordinary document text\n中文正文', encoding='utf-8')
            self.assertIn('Error: ordinary document text', service.read_file(str(p)))
            with self.assertRaises(ValueError):
                service.read_file(str(Path(path)/'missing.txt'))

    def test_copy_type_mismatch_has_no_success_and_no_effect(self):
        with tempfile.TemporaryDirectory(prefix='reach-runtime-') as path:
            p = Path(path)/'content.txt'; p.write_text('preserve', encoding='utf-8')
            d = Path(path)/'destination'; d.mkdir()
            with self.assertRaises(ValueError):
                service.copy_path(str(p), str(d), overwrite=True)
            self.assertEqual(p.read_text(), 'preserve')
            self.assertEqual(list(d.iterdir()), [])

    def test_name_matching_at_the_actual_cutoff(self):
        choices = ['Reach Verification', 'Windows PowerShell', 'Microsoft Edge', '文件资源管理器']
        for query, expected in [('reach verification','Reach Verification'),('Reech Verification','Reach Verification'),
                                ('PowerShell','Windows PowerShell'),('Microsoft Edge','Microsoft Edge'),
                                ('文件资源管理器','文件资源管理器'),('xyz0123456789',None)]:
            match = process.extractOne(query, choices, score_cutoff=70)
            self.assertEqual(match[0] if match else None, expected)

    def test_caught_file_failures_stay_failures(self):
        with tempfile.TemporaryDirectory(prefix='reach-runtime-') as path:
            with self.assertRaises(RuntimeError):
                service.write_file(path, 'must not claim a directory was written')
            with self.assertRaises(RuntimeError):
                service.delete_path(str(Path(path)/'missing'))
            p = Path(path)/'keep'; p.write_text('keep')
            with self.assertRaises(RuntimeError):
                service.delete_path(path, recursive=False)
            self.assertEqual(p.read_text(), 'keep')

    def test_app_and_notification_failure_codes_propagate(self):
        from windows_mcp.desktop.service import Desktop
        from windows_mcp.notifications import service as notifications
        from windows_mcp.registry import service as registry
        desktop = object.__new__(Desktop)
        desktop.launch_app = Mock(return_value=('launch rejected', 1, 0))
        desktop.resize_app = Mock(return_value=('resize rejected', 1))
        with self.assertRaises(RuntimeError):
            desktop.app('launch', 'fixture')
        with self.assertRaises(RuntimeError):
            desktop.app('resize', 'fixture')
        with patch.object(notifications.PowerShellExecutor, 'execute_command', return_value=('injected failure',1)):
            with self.assertRaises(RuntimeError):
                notifications.send_notification('test', 'not actually sent', 'fixture')
            for fn,args in [(registry.get_value,('HKCU:\\fixture','key')),
                            (registry.set_value,('HKCU:\\fixture','key','value')),
                            (registry.delete_entry,('HKCU:\\fixture','key')),
                            (registry.delete_entry,('HKCU:\\fixture',)),
                            (registry.list_key,('HKCU:\\fixture',))]:
                with self.assertRaises(RuntimeError): fn(*args)

    def test_partial_process_termination_keeps_uncertainty(self):
        import psutil
        from windows_mcp.process.service import kill_process
        first=Mock(); first.info={'pid':111,'name':'fixture'}; first.pid=111
        denied=Mock(); denied.info={'pid':222,'name':'fixture'}; denied.pid=222
        denied.terminate.side_effect=psutil.AccessDenied(222)
        with patch.object(psutil,'process_iter',return_value=[first,denied]):
            with self.assertRaisesRegex(RuntimeError,'unsettled=\\[222\\]'):
                kill_process(name='fixture')
        first.terminate.assert_called_once(); first.wait.assert_called_once_with(timeout=3)


if __name__ == '__main__':
    unittest.main()
