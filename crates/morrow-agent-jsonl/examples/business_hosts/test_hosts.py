"""Host callback regressions and real-sidecar integration. Author: Ray Zhang."""
import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'tests')]
from common import client, digest, load, save
from local_file import LocalFileHost
from controlled_provider import ControlledProvider, call, text

BINARY = os.environ.get('MORROW_HOST_TEST_BINARY')
EXPECTED = 'MORROW_HOST_OK'


def frame():
    return {'task_id': 'task-1', 'run_id': 'run-1', 'native_call_id': 'call-1',
            'args_sha256': 'a' * 64, 'tool_name': 'submit_result', 'arguments': {'content': EXPECTED}}


class CallbackTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.manifest = {'target': LocalFileHost.target(self.root), 'expected': EXPECTED}

    async def test_fixed_grant_and_duplicate_operation_preserve_original_receipt(self):
        host = LocalFileHost(self.root, self.manifest)
        request = frame()
        invalid = copy.deepcopy(request)
        invalid['arguments']['path'] = '../outside'
        with self.assertRaises(ValueError):
            await host.tool_call(invalid, asyncio.Event())
        first = await host.tool_call(request, asyncio.Event())
        original = (self.root / 'result.txt').stat().st_mtime_ns
        second = await host.tool_call(request, asyncio.Event())
        self.assertEqual(first, second)
        self.assertEqual((self.root / 'result.txt').stat().st_mtime_ns, original)
        self.assertEqual(first['settlement'], 'Settled')

    async def test_unknown_write_is_retained_until_explicit_reconciliation(self):
        class LostReply(LocalFileHost):
            def write_payload(self, content):
                super().write_payload(content)
                raise TimeoutError('controlled lost reply after effect')
        host = LostReply(self.root, self.manifest)
        reply = await host.tool_call(frame(), asyncio.Event())
        self.assertEqual(reply['settlement'], 'Unknown')
        original = Path(reply['operation_receipt']).read_bytes()
        evidence = self.root / 'operator.json'
        save(evidence, {'actual_sha256': digest((self.root / 'result.txt').read_bytes()), 'settled_by': 'test-host'})
        declaration = {'task_id': 'task-1', 'committed': True, 'settlement': 'Settled',
                       'tool_calls': [{'call_id': 'call-1', 'settlement': {'kind': 'completed', 'output': 'effect verified'}}],
                       'evidence': [{'path': str(evidence), 'sha256': digest(evidence.read_bytes())}]}
        host = LocalFileHost(self.root, self.manifest, declaration)
        review = {'task_id': 'task-1', 'interrupted_run': {'run_id': 'run-1',
                  'open_tool_calls': [{'id': 'call-1', 'name': 'submit_result', 'arguments': {'content': EXPECTED}}]}}
        receipt = await host.reconcile_resume(review, asyncio.Event())
        self.assertTrue(client.valid_resume_receipt(receipt))
        self.assertEqual(Path(reply['operation_receipt']).read_bytes(), original)
        self.assertEqual((await host.tool_call(frame(), asyncio.Event()))['settlement'], 'Settled')
        evidence.write_text('changed', encoding='utf-8')
        with self.assertRaises(client.ReconciliationRequired):
            await host.reconcile_resume(review, asyncio.Event())

    async def test_mixed_core_and_host_candidates_only_verify_owned_artifacts(self):
        host = LocalFileHost(self.root, self.manifest)
        await host.tool_call(frame(), asyncio.Event())
        candidate = {'version': 1, 'artifact_id': 'owned', 'task_id': 'task-1', 'session_id': 'session-1',
                     'run_id': 'run-1', 'native_call_id': 'call-1', 'tool': 'submit_result',
                     'input_sha256': 'a' * 64, 'output_sha256': 'b' * 64,
                     'artifact_ref': 'journal/1/result-2', 'status': 'candidate', 'created_at': '1'}
        core_candidate = {**candidate, 'artifact_id': 'core', 'tool': 'reference_read', 'native_call_id': 'core-1'}
        result = await host.review_artifacts({'artifacts': [core_candidate, candidate]}, asyncio.Event())
        self.assertEqual([artifact['artifact_id'] for artifact in result], ['owned'])
        self.assertEqual(result[0]['status'], 'verified')
        self.assertEqual(core_candidate['status'], 'candidate')


@unittest.skipUnless(BINARY, 'set MORROW_HOST_TEST_BINARY to an actual JSONL executable')
class SidecarTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        parent = os.environ.get('MORROW_HOST_TEST_EVIDENCE')
        if parent:
            Path(parent).mkdir(parents=True, exist_ok=True)
            self.root = Path(tempfile.mkdtemp(prefix='host-', dir=parent)).resolve()
        else:
            directory = tempfile.TemporaryDirectory()
            self.addCleanup(directory.cleanup)
            self.root = Path(directory.name).resolve()

    async def invoke(self, script, action, root, provider, extra=(), driver=None):
        env = dict(os.environ, MORROW_MODEL_BASE_URL=provider.endpoint,
                   MORROW_MODEL_API_KEY='controlled-host-fixture-token', MORROW_MODEL='jsonl-fixture')
        entry = [str(HERE / script)] if driver is None else ['-c', driver]
        command = [sys.executable, *entry, action, '--root', str(root), '--binary', BINARY, *extra]
        process = await asyncio.create_subprocess_exec(*command, env=env,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=90)
        (self.root / f'{action}-{script}-{len(list(self.root.glob("*.log")))}.log').write_bytes(stdout + stderr)
        return process.returncode, stdout, stderr

    def check_artifacts(self, root, outcome, expected_tools):
        evidence = Path(load(next(root.glob('attempt-*.json')))['task']['evidence_dir'])
        released = load(evidence / 'released.json')
        self.assertEqual(outcome['stop'], 'AwaitingHostAcceptance')
        self.assertFalse(outcome['task_accepted'])
        acceptance = load(root / 'business-acceptance.json')
        self.assertTrue(acceptance['accepted'])
        self.assertEqual(acceptance['task_id'], outcome['task_id'])
        self.assertEqual(acceptance['outcome']['sha256'], digest(Path(acceptance['outcome']['path']).read_bytes()))
        self.assertEqual(acceptance['review']['sha256'], digest(Path(acceptance['review']['path']).read_bytes()))
        self.assertTrue(released['last_receipt']['committed'])
        for path in released['last_receipt']['evidence']:
            self.assertTrue(load(Path(path))['passed'])
        artifacts = released.get('artifacts', [])
        self.assertEqual(len(artifacts), expected_tools)
        if expected_tools:
            ledger = [json.loads(line) for line in (evidence / 'tool-artifacts.jsonl').read_text(encoding='utf-8').splitlines()]
            for artifact in artifacts:
                verified = [item for item in ledger if item['artifact_id'] == artifact['artifact_id'] and item['status'] == 'verified']
                self.assertTrue(verified)
                self.assertEqual(verified[-1]['host_receipt']['native_call_id'], artifact['native_call_id'])
                self.assertTrue(verified[-1]['host_receipt']['committed'])
            self.assertEqual(len(list((root / 'receipts').glob('*-result.json'))), expected_tools)

    async def test_local_file_with_actual_sidecar(self):
        with ControlledProvider([call('write-1', 'submit_result', {'content': EXPECTED}), text('Submitted.')]) as provider:
            root = self.root / 'local'
            code, stdout, stderr = await self.invoke('local_file.py', 'start', root, provider)
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual((root / 'result.txt').read_text(), EXPECTED)
        self.check_artifacts(root, json.loads(stdout), 1)

    async def test_model_only_with_actual_sidecar(self):
        with ControlledProvider([text(EXPECTED)]) as provider:
            root = self.root / 'model'
            code, stdout, stderr = await self.invoke('model_only.py', 'start', root, provider)
        self.assertEqual(code, 0, stderr.decode())
        self.check_artifacts(root, json.loads(stdout), 0)

    async def test_mixed_core_and_business_tools_with_actual_sidecar(self):
        with ControlledProvider([
                call('reference-1', 'reference_read', {'id': 'missing-reference'}),
                call('write-1', 'submit_result', {'content': EXPECTED}), text('Submitted.')]) as provider:
            root = self.root / 'mixed'
            code, stdout, stderr = await self.invoke('local_file.py', 'start', root, provider)
        self.assertEqual(code, 0, stderr.decode())
        outcome = json.loads(stdout)
        self.assertTrue(load(root / 'business-acceptance.json')['accepted'])
        self.assertEqual([(item['native_call_id'], item['status']) for item in outcome['artifacts']],
                         [('write-1', 'verified')])
        ledger = [json.loads(line) for line in (root / 'evidence-first/tool-artifacts.jsonl').read_text().splitlines()]
        core_records = [item for item in ledger if item['tool'] == 'reference_read']
        self.assertTrue(core_records)
        self.assertTrue(all(item['status'] == 'candidate' for item in core_records))
        code, stdout, stderr = await self.invoke('local_file.py', 'inspect', root, provider)
        self.assertEqual(code, 0, stderr.decode())
        self.assertEqual(json.loads(stdout)['fences'], [])

    @unittest.skipUnless(os.environ.get('MORROW_HOST_S3_ENDPOINT'), 'configure an authorized real S3 service')
    async def test_object_store_over_real_s3_protocol(self):
        with ControlledProvider([call('put-1', 'submit_result', {'content': EXPECTED}), text('Submitted.')]) as provider:
            root = self.root / 'object'
            code, stdout, stderr = await self.invoke('object_store.py', 'start', root, provider)
        self.assertEqual(code, 0, stderr.decode())
        self.check_artifacts(root, json.loads(stdout), 1)
        receipt = load(next((root / 'receipts').glob('*-result.json')))
        self.assertTrue(receipt['reply']['value']['etag'])

    async def test_resume_uses_original_task_and_operator_receipt_without_repeating_write(self):
        driver = f'''import sys
sys.path.insert(0, {str(HERE)!r})
from local_file import LocalFileHost
from common import cli
class LostSettlement(LocalFileHost):
    async def tool_call(self, request, cancelled):
        reply = await super().tool_call(request, cancelled)
        return {{**reply, 'settlement': 'Unknown'}}
cli(LostSettlement)
'''
        with ControlledProvider([call('write-1', 'submit_result', {'content': EXPECTED}), text('Interrupted.'), text('Recovered.')]) as provider:
            root = self.root / 'resume'
            code, _, _ = await self.invoke('local_file.py', 'start', root, provider, driver=driver)
            self.assertEqual(code, 2)
            manifest = load(root / 'manifest.json')
            fence = next((root / 'state').glob('*.fence.json'))
            operation = next((root / 'receipts').glob('*-result.json'))
            original_bytes = operation.read_bytes()
            declaration = self.root / 'reconciliation.json'
            save(declaration, {'task_id': manifest['config']['task']['task_id'],
                 'fence_sha256': digest(fence.read_bytes()), 'committed': True, 'settlement': 'Settled', 'tool_calls': [],
                 'evidence': [{'path': str(operation), 'sha256': digest(original_bytes)}]})
            code, stdout, stderr = await self.invoke('local_file.py', 'resume', root, provider,
                                                    extra=['--reconciliation', str(declaration)])
        self.assertEqual(code, 0, stderr.decode())
        outcome = json.loads(stdout)
        self.assertEqual(outcome['task_id'], manifest['config']['task']['task_id'])
        self.assertEqual(outcome['runs'], 2)
        self.assertEqual(outcome['stop'], 'AwaitingHostAcceptance')
        self.assertTrue(load(root / 'business-acceptance.json')['accepted'])
        self.assertEqual(len(list((root / 'receipts').glob('*-result.json'))), 1)
        self.assertEqual(operation.read_bytes(), original_bytes)


if __name__ == '__main__':
    unittest.main()
