"""Python artifact callbacks over the actual sidecar and controlled loopback provider."""
import asyncio
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'clients/python'))
import morrow_agent as client
from controlled_provider import ControlledProvider, call, text

TARGET = Path(os.environ.get('CARGO_TARGET_DIR', 'target'))
BINARY = Path(os.environ.get('MORROW_JSONL_TEST_BINARY', str(TARGET / 'debug' /
              ('morrow-agent-jsonl.exe' if os.name == 'nt' else 'morrow-agent-jsonl'))))
TOKEN = 'controlled-artifact-no-provider-grant'


def config(root, endpoint):
    return {'kind': 'start_task', 'version': 1, 'artifact_review': True,
            'task': {'task_id': 'artifact-task', 'criteria_revision': 'file-v1', 'authorization_revision': 'owned-v1',
                     'kind': 'Coding', 'evidence_dir': str(root / 'harness'), 'max_runs': 2, 'max_calls': 4,
                     'deadline_unix_ms': int(time.time() * 1000) + 30000},
            'run': {'run_id': 'run-1', 'objective': 'Write the answer file, then submit.',
                    'cwd': str(root), 'session_path': str(root / 'session.json'),
                    'environment_state': str(root / 'environment'), 'device_fp': 'artifact-fixture',
                    'session_key': 'artifact/session', 'mode': 'execute', 'endpoint': endpoint,
                    'model': 'jsonl-fixture', 'max_calls': 4, 'max_seconds': 25, 'max_output': 512,
                    'model_resolution': {'kind': 'catalog'},
                    'tools': [{'name': 'write_answer', 'description': 'Write one Host-owned answer file.',
                               'parameters': {'type': 'object', 'properties': {'content': {'type': 'string'}},
                                              'required': ['content'], 'additionalProperties': False}}]},
            'cancel_grace_ms': 1000, 'emit_events': False}


def save(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def candidate(basis):
    return {'version': 1, 'artifact_id': 'artifact-1',
            **{key: basis[key] for key in ('task_id', 'session_id', 'run_id')},
            'native_call_id': 'write-1', 'tool': 'write_answer', 'input_sha256': 'a' * 64,
            'output_sha256': 'b' * 64, 'artifact_ref': 'journal/1/result-2', 'status': 'candidate', 'created_at': '1'}


def verified(artifact):
    artifact = copy.deepcopy(artifact)
    artifact['status'] = 'verified'
    artifact['host_receipt'] = {
        **{key: artifact[key] for key in ('artifact_id', 'task_id', 'session_id', 'run_id', 'native_call_id',
                                        'input_sha256', 'output_sha256')},
        'receipt_id': 'receipt-' + artifact['run_id'], 'verifier': 'python-file-host', 'verifier_version': '1',
        'verified_at': '2026-11-11T00:00:00Z', 'committed': True, 'settled': True}
    return artifact


class FileHost:
    """Legacy Host callbacks use actual files and fsynced operation evidence."""
    def __init__(self, root):
        self.root = root
        self.writes = 0

    async def tool_call(self, request, cancelled):
        self.writes += 1
        answer = self.root / 'answer.txt'
        answer.write_text(request['arguments']['content'], encoding='utf-8')
        receipt = self.root / f'write-{self.writes}.json'
        save(receipt, {'request': request, 'answer_sha256': hashlib.sha256(answer.read_bytes()).hexdigest()})
        return {'value': {'written': True}, 'is_error': False, 'settlement': 'Settled',
                'operation_receipt': str(receipt)}

    async def verify(self, subject, cancelled):
        passed = (self.root / 'answer.txt').read_text(encoding='utf-8') == 'correct'
        proof = self.root / f"review-{subject['basis']['run_number']}.json"
        save(proof, {'basis': subject['basis'], 'passed': passed})
        return {'basis': subject['basis'], 'committed': True, 'settlement': 'Settled',
                'verdict': 'Verified' if passed else {'NeedsChanges': {'feedback': 'Write correct to the answer file.'}},
                'evidence': [str(proof)]}

    async def prepare(self, continuation, cancelled):
        return {'run_id_next': f"run-{continuation['next_run_number']}", 'objective': 'Repair the answer file.'}


class ArtifactHost(FileHost):
    def __init__(self, root, fault=None):
        super().__init__(root)
        self.fault = fault
        self.artifact_reviews = []
        self.started = asyncio.Event()
        self.joined = False

    async def review_artifacts(self, review, cancelled):
        self.artifact_reviews.append(copy.deepcopy(review))
        self.started.set()
        number = review['basis']['run_number']
        evidence = self.root / 'harness'
        assert any((evidence / f'run-{number}-{suffix}.json').is_file()
                   for suffix in ('review', 'budget-review', 'stop-review'))
        assert not (evidence / f'run-{number}-artifacts.json').exists()
        if self.fault == 'exception':
            raise RuntimeError('private Host diagnostic must stay local')
        if self.fault == 'cancel':
            await asyncio.wait_for(cancelled.wait(), timeout=5)
            await asyncio.sleep(.03)
            self.joined = True
        artifacts = [verified(artifact) for artifact in review['artifacts']]
        assert artifacts
        if self.fault == 'cross-run':
            artifacts[0]['run_id'] = 'unrelated-run'
        if self.fault == 'bad-reference':
            artifacts[0]['artifact_ref'] = '../outside'
        proof = self.root / f'artifact-host-receipts-{number}.json'
        save(proof, {'artifacts': artifacts, 'actual_answer': (self.root / 'answer.txt').read_text(encoding='utf-8')})
        return artifacts

    async def verify_budget_snapshot(self, snapshot, cancelled):
        return await self.verify(snapshot, cancelled)

    async def prepare_budget_stop_continuation(self, continuation, cancelled):
        return await self.prepare(continuation, cancelled)

    async def verify_stop_snapshot(self, snapshot, cancelled):
        return await self.verify(snapshot, cancelled)

    async def prepare_stop_continuation(self, continuation, cancelled):
        return await self.prepare(continuation, cancelled)


class ArtifactContractTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = config(self.root, 'http://127.0.0.1:1/v1')
        self.basis = {**{key: self.config['task'][key] for key in ('task_id', 'criteria_revision', 'authorization_revision')},
                      'session_id': self.config['run']['session_key'], 'session_path': self.config['run']['session_path'],
                      'run_id': 'run-1', 'run_number': 1}
        Path(self.basis['session_path']).write_text('{}')
        self.evidence = self.root / 'harness'
        self.evidence.mkdir()
        self.review = {'basis': self.basis, 'artifacts': [candidate(self.basis)]}
        self.path = self.evidence / 'jsonl-artifact-review-1.json'
        save(self.path, self.review)
        self.frame = {'kind': 'review_artifacts_request', 'version': 1, 'task_id': 'artifact-task',
                      'run_id': 'run-1', 'rpc_id': 'rpc-1', 'review': self.review}

    def test_inline_and_reference_requests_check_fixed_original(self):
        reference = client._checked_artifact_review(self.review, self.frame, self.config, self.evidence)
        frame = {key: value for key, value in self.frame.items() if key != 'review'}
        frame['review_ref'] = reference
        review = client.read_reference(reference, self.evidence)
        self.assertEqual(client._checked_artifact_review(review, frame, self.config, self.evidence), reference)
        client.validate_tool_artifacts([verified(review['artifacts'][0])], self.basis)
        for path in (self.evidence / 'other.json', self.root / 'outside.json'):
            save(path, self.review)
            changed_ref = {'path': str(path), 'sha256': reference['sha256']}
            with self.subTest(path=path), self.assertRaises(client.ReconciliationRequired):
                changed = client.read_reference(changed_ref, self.evidence)
                client._checked_artifact_review(changed, {**frame, 'review_ref': changed_ref}, self.config, self.evidence)
        self.path.write_text('{}')
        with self.assertRaises(client.ReconciliationRequired):
            client.read_reference(reference, self.evidence)

    def test_request_identity_and_record_bindings_are_checked(self):
        for field in ('task_id', 'criteria_revision', 'authorization_revision', 'run_id', 'session_id', 'session_path'):
            changed = copy.deepcopy(self.review)
            changed['basis'][field] = 'other'
            with self.subTest(field=field), self.assertRaises((client.ReconciliationRequired, OSError)):
                client._checked_artifact_review(changed, self.frame, self.config, self.evidence)
        changed = copy.deepcopy(self.review)
        changed['artifacts'][0]['run_id'] = 'other'
        with self.assertRaises(client.ReconciliationRequired):
            client._checked_artifact_review(changed, self.frame, self.config, self.evidence)

    def test_reference_views_accept_above_eight_mib_through_the_sixteen_mib_boundary(self):
        self.assertEqual(client.REFERENCE_BYTES, 16 * 1024 * 1024)
        payload = json.dumps(self.review).encode('utf-8')
        for size in (8 * 1024 * 1024 + 1, 16 * 1024 * 1024):
            with self.subTest(size=size):
                # JSON whitespace preserves a valid review while exercising the
                # physical reference byte limit independently of artifact counts.
                raw = payload + b' ' * (size - len(payload))
                self.path.write_bytes(raw)
                reference = {'path': str(self.path.resolve()), 'sha256': hashlib.sha256(raw).hexdigest()}
                actual = client.read_reference(reference, self.evidence)
                self.assertEqual(actual, self.review)
                frame = {key: value for key, value in self.frame.items() if key != 'review'}
                frame['review_ref'] = reference
                self.assertEqual(client._checked_artifact_review(actual, frame, self.config, self.evidence), reference)

    def test_reference_views_reject_above_sixteen_mib_before_reading(self):
        raw = json.dumps(self.review).encode('utf-8')
        raw += b' ' * (16 * 1024 * 1024 + 1 - len(raw))
        self.path.write_bytes(raw)
        reference = {'path': str(self.path.resolve()), 'sha256': hashlib.sha256(raw).hexdigest()}
        with patch.object(Path, 'open', side_effect=AssertionError('oversized file must not be read')):
            with self.assertRaises(client.ReconciliationRequired):
                client.read_reference(reference, self.evidence)
            with self.assertRaises(client.ReconciliationRequired):
                client._budget_file(self.review, self.evidence, self.path.name, reference)

    def test_reference_views_bound_the_read_if_the_file_grows_after_stat(self):
        reference = {'path': str(self.path.resolve()), 'sha256': hashlib.sha256(self.path.read_bytes()).hexdigest()}
        for load in (
                lambda: client.read_reference(reference, self.evidence),
                lambda: client._budget_file(self.review, self.evidence, self.path.name, reference)):
            stream = io.BytesIO(b' ' * (client.REFERENCE_BYTES + 2))
            with patch.object(stream, 'read', wraps=stream.read) as read:
                with patch.object(Path, 'open', return_value=stream):
                    with self.assertRaisesRegex(client.ReconciliationRequired, 'grew beyond byte bound'):
                        load()
                read.assert_called_once_with(client.REFERENCE_BYTES + 1)

    def test_reply_schema_status_hash_and_receipt_binding_are_checked(self):
        valid = verified(candidate(self.basis))
        for field, value in [('version', True), ('status', 'done'), ('input_sha256', 'A' * 64),
                             ('output_sha256', '0' * 63), ('artifact_ref', '../file'), ('artifact_ref', '/file'),
                             ('artifact_ref', 'C:/file'), ('artifact_ref', 'https://host/file'),
                             ('run_id', 'other'), ('session_id', 'other'), ('host_receipt', None)]:
            invalid = copy.deepcopy(valid)
            invalid[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(client.ReconciliationRequired):
                client.validate_tool_artifacts([invalid], self.basis)
        for field, value in [('committed', False), ('settled', False), ('committed', 1),
                             ('artifact_id', 'other'), ('input_sha256', 'c' * 64), ('verifier', '')]:
            invalid = copy.deepcopy(valid)
            invalid['host_receipt'][field] = value
            with self.subTest(receipt_field=field), self.assertRaises(client.ReconciliationRequired):
                client.validate_tool_artifacts([invalid], self.basis)
        for invalid in ([valid, valid], {'artifacts': [valid]}, [{**valid, 'extra': True}]):
            with self.assertRaises(client.ReconciliationRequired):
                client.validate_tool_artifacts(invalid, self.basis)
        client.validate_tool_artifacts([], self.basis)

    def test_artifact_reply_uses_existing_frame_bound(self):
        records = []
        for number in range(65):
            artifact = candidate(self.basis)
            artifact['artifact_id'] = f'artifact-{number}'
            records.append(verified(artifact))
        client.validate_tool_artifacts(records, self.basis)
        reply = {'kind': 'review_artifacts_reply', 'version': 1, 'rpc_id': 'rpc-1',
                 'task_id': 'artifact-task', 'run_id': 'run-1', 'artifacts': records}
        self.assertLess(len(client.encoded(reply)), client.FRAME_BYTES)
        with self.assertRaises(client.ReconciliationRequired):
            client.encoded({**reply, 'artifacts': records * 10})


class ArtifactAdmissionTest(unittest.IsolatedAsyncioTestCase):
    async def test_optin_requires_async_callback_and_boolean_before_process_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = config(root, 'http://127.0.0.1:1/v1')
            host = FileHost(root)
            with patch.object(client.asyncio, 'create_subprocess_exec', new_callable=AsyncMock) as spawn:
                for value in (None, 'true', 1, True):
                    with self.subTest(value=value), self.assertRaises(ValueError):
                        await client.run_task(__file__, {**settings, 'artifact_review': value}, host,
                                              token=TOKEN, operation_directory=root / 'operations')
                host.review_artifacts = lambda review, cancelled: []
                with self.assertRaises(ValueError):
                    await client.run_task(__file__, settings, host, token=TOKEN,
                                          operation_directory=root / 'operations')
                spawn.assert_not_called()
                self.assertFalse((root / 'operations').exists())


class ArtifactProcessTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.assertTrue(BINARY.is_file(), f'build the current sidecar and set MORROW_JSONL_TEST_BINARY: {BINARY}')
        evidence = os.environ.get('MORROW_JSONL_ARTIFACT_EVIDENCE')
        if evidence:
            self.root = Path(evidence) / (self._testMethodName + '-' + str(time.time_ns()))
            self.root.mkdir(parents=True)
        else:
            temporary = tempfile.TemporaryDirectory()
            self.addCleanup(temporary.cleanup)
            self.root = Path(temporary.name)
        save(self.root / 'identity.json', {'binary': str(BINARY.resolve()),
                                         'binary_sha256': hashlib.sha256(BINARY.read_bytes()).hexdigest()})

    async def invoke(self, settings, host, **kwargs):
        save(self.root / 'start.json', settings)
        return await client.run_task(BINARY, settings, host, token=TOKEN,
                                     operation_directory=self.root / 'operations', **kwargs)

    async def test_actual_artifact_receipts_are_persisted_by_rust_and_returned_in_outcome(self):
        with ControlledProvider([call('write-1', 'write_answer', {'content': 'correct'}), text('Submitted.')]) as provider:
            host = ArtifactHost(self.root)
            result = await self.invoke(config(self.root, provider.endpoint), host)
            self.assertEqual(result['stop'], 'AwaitingHostAcceptance')
            self.assertFalse(result['task_accepted'])
            self.assertEqual((host.writes, len(host.artifact_reviews), len(provider.requests)), (1, 1, 2))
            self.assertEqual(result['artifacts'][0]['status'], 'verified')
            accepted = json.loads((self.root / 'harness/run-1-artifacts.json').read_bytes())
            self.assertEqual(result['artifacts'], accepted['artifacts'])
            rows = [json.loads(line) for line in (self.root / 'harness/tool-artifacts.jsonl').read_bytes().splitlines()]
            self.assertEqual(rows[-1]['host_receipt']['verifier'], 'python-file-host')
            self.assertEqual((self.root / 'answer.txt').read_text(), 'correct')

    async def test_needs_changes_keeps_history_and_returns_latest_run_artifact(self):
        with ControlledProvider([call('first', 'write_answer', {'content': 'wrong'}), text('First.'),
                                 call('fixed', 'write_answer', {'content': 'correct'}), text('Fixed.')]) as provider:
            host = ArtifactHost(self.root)
            result = await self.invoke(config(self.root, provider.endpoint), host)
            self.assertEqual(result['stop'], 'AwaitingHostAcceptance')
            self.assertEqual((result['runs'], len(host.artifact_reviews)), (2, 2))
            self.assertEqual([item['run_id'] for item in result['artifacts']], ['run-2'])
            self.assertTrue((self.root / 'harness/run-1-artifacts.json').is_file())
            self.assertTrue((self.root / 'harness/run-2-artifacts.json').is_file())

    async def test_actual_sidecar_uses_review_ref_for_large_host_seeded_candidate_ledger(self):
        class LargeReviewHost(FileHost):
            seeded_count = 800

            async def tool_call(self, request, cancelled):
                result = await super().tool_call(request, cancelled)
                scope = {'task_id': request['task_id'], 'run_id': request['run_id'],
                         'session_id': 'artifact/session'}
                # These are explicitly artificial Host fixture candidates, not
                # additional native tool calls or automatically derived receipts.
                ledger = self.root / 'harness/tool-artifacts.jsonl'
                with ledger.open('x', encoding='utf-8') as stream:
                    for number in range(self.seeded_count):
                        record = candidate(scope)
                        record.update(artifact_id=f'host-fixture-{number}',
                                      native_call_id=f'host-fixture-call-{number}',
                                      artifact_ref=f'host-fixture/result-{number}')
                        stream.write(json.dumps(record, separators=(',', ':')) + '\n')
                    stream.flush()
                    os.fsync(stream.fileno())
                return result

            async def review_artifacts(self, review, cancelled):
                native = [item for item in review['artifacts'] if item['artifact_id'].startswith('journal-')]
                seeded = [item for item in review['artifacts'] if item['artifact_id'].startswith('host-fixture-')]
                assert len(native) == 1 and len(seeded) == self.seeded_count
                assert native[0]['native_call_id'] == 'write-1'
                assert all(item['status'] == 'candidate' for item in seeded)
                assert (self.root / 'answer.txt').read_text() == 'correct'
                returned = [verified(native[0])]
                save(self.root / 'large-review-host-receipt.json',
                     {'manual_fixture_candidates': len(seeded), 'native_tool_candidates': len(native),
                      'returned_artifacts': returned})
                return returned

        with ControlledProvider([call('write-1', 'write_answer', {'content': 'correct'}), text('Submitted.')]) as provider:
            host = LargeReviewHost(self.root)
            result = await self.invoke(config(self.root, provider.endpoint), host)
            self.assertEqual(result['stop'], 'AwaitingHostAcceptance')
            self.assertFalse(result['task_accepted'])
            self.assertEqual((host.writes, len(provider.requests)), (1, 2))
            evidence = self.root / 'harness'
            payload_path = evidence / 'jsonl-artifact-review-1.json'
            payload_bytes = payload_path.read_bytes()
            self.assertGreater(len(payload_bytes), client.FRAME_BYTES)
            requests = [json.loads(path.read_bytes()) for path in evidence.glob('jsonl-rpc-*-request.json')]
            artifact_requests = [item for item in requests if item['kind'] == 'review_artifacts_request']
            self.assertEqual(len(artifact_requests), 1)
            frame = artifact_requests[0]
            self.assertNotIn('review', frame)
            self.assertTrue(Path(frame['review_ref']['path']).samefile(payload_path))
            self.assertEqual(frame['review_ref']['sha256'], hashlib.sha256(payload_bytes).hexdigest())
            payload = client.read_reference(frame['review_ref'], evidence)
            self.assertEqual(len(payload['artifacts']), host.seeded_count + 1)
            self.assertEqual(len(result['artifacts']), 1)
            self.assertTrue(result['artifacts'][0]['artifact_id'].startswith('journal-'))
            self.assertEqual(result['artifacts'][0]['native_call_id'], 'write-1')
            manifest = json.loads((evidence / 'run-1-artifacts.json').read_bytes())
            self.assertEqual(manifest['artifacts'], result['artifacts'])
            rows = [json.loads(line) for line in (evidence / 'tool-artifacts.jsonl').read_bytes().splitlines()]
            self.assertEqual(len(rows), host.seeded_count + 2, 'manual fixture ledger plus native candidate/verified')
            self.assertEqual(sum(item['status'] == 'verified' for item in rows), 1)

    async def test_closed_budget_review_returns_artifacts_without_final_model_stop(self):
        with ControlledProvider([call('write-1', 'write_answer', {'content': 'correct'})]) as provider:
            settings = config(self.root, provider.endpoint)
            settings['budget_stop_review'] = 'review_closed_tool_round'
            settings['run']['max_calls'] = settings['task']['max_calls'] = 1
            host = ArtifactHost(self.root)
            result = await self.invoke(settings, host)
            self.assertEqual(result['stop'], 'AwaitingHostAcceptance')
            self.assertEqual(len(result['artifacts']), 1)
            self.assertEqual(len(provider.requests), 1)
            self.assertTrue((self.root / 'harness/run-1-budget-review-index.json').is_file())

    async def test_closed_length_review_returns_artifacts(self):
        with ControlledProvider([call('write-1', 'write_answer', {'content': 'correct'}),
                                 {'delta': {'content': 'unfinished'}, 'finish': 'length'}]) as provider:
            settings = config(self.root, provider.endpoint)
            settings['length_stop_review'] = 'review_closed_length'
            result = await self.invoke(settings, ArtifactHost(self.root))
            self.assertEqual(result['stop'], 'AwaitingHostAcceptance')
            self.assertEqual(len(result['artifacts']), 1)
            self.assertTrue((self.root / 'harness/run-1-stop-review-index.json').is_file())

    async def test_old_host_without_callback_uses_legacy_default(self):
        with ControlledProvider([call('write-1', 'write_answer', {'content': 'correct'}), text('Submitted.')]) as provider:
            settings = config(self.root, provider.endpoint)
            settings.pop('artifact_review')
            result = await self.invoke(settings, FileHost(self.root))
            self.assertEqual(result['stop'], 'AwaitingHostAcceptance')
            self.assertEqual(result.get('artifacts', []), [])
            self.assertFalse((self.root / 'harness/jsonl-artifact-review-1.json').exists())

    async def test_cross_run_reply_is_rejected_and_leaves_fence(self):
        await self.rejected_callback('cross-run')

    async def test_invalid_artifact_reference_is_rejected_and_leaves_fence(self):
        await self.rejected_callback('bad-reference')

    async def test_callback_exception_leaves_host_failure_receipt_and_fence(self):
        await self.rejected_callback('exception')

    async def rejected_callback(self, fault):
        with ControlledProvider([call('write-1', 'write_answer', {'content': 'correct'}), text('Submitted.')]) as provider:
            with self.assertRaises(client.ReconciliationRequired) as error:
                await self.invoke(config(self.root, provider.endpoint), ArtifactHost(self.root, fault))
            self.assertNotIn('private Host diagnostic', str(error.exception))
            result = json.loads((self.root / 'harness/outcome.json').read_bytes())
            self.assertEqual(result['fence_presence'], 'Present')
            self.assertEqual(result.get('artifacts', []), [])
            self.assertFalse((self.root / 'harness/run-1-artifacts.json').exists())
            self.assertTrue(list((self.root / 'operations').glob('*-failed-or-unknown.json')))
            self.assertEqual(len(provider.requests), 2)

    async def test_cancel_waits_for_artifact_callback_and_keeps_original_fence(self):
        with ControlledProvider([call('write-1', 'write_answer', {'content': 'correct'}), text('Submitted.')]) as provider:
            host, cancel = ArtifactHost(self.root, 'cancel'), asyncio.Event()
            running = asyncio.create_task(self.invoke(config(self.root, provider.endpoint), host, cancellation=cancel))
            await asyncio.wait_for(host.started.wait(), timeout=10)
            cancel.set()
            result = await asyncio.wait_for(running, timeout=10)
            self.assertTrue(host.joined)
            self.assertEqual(result['stop'], 'Cancelled')
            self.assertEqual(result['fence_presence'], 'Present')
            self.assertEqual(result.get('artifacts', []), [])
            self.assertFalse((self.root / 'harness/run-1-artifacts.json').exists())

    async def test_unsolicited_callback_is_refused_before_calling_host(self):
        with ControlledProvider([call('write-1', 'write_answer', {'content': 'correct'}), text('Submitted.')]) as provider:
            host = ArtifactHost(self.root)
            settings = config(self.root, provider.endpoint)
            settings.pop('artifact_review')
            original = client.encoded

            def server_optin(value):
                # Inject a server/client policy mismatch on the actual subprocess transport.
                if value.get('kind') == 'start_task':
                    value = {**value, 'artifact_review': True}
                return original(value)

            with patch.object(client, 'encoded', side_effect=server_optin):
                with self.assertRaises(client.ReconciliationRequired):
                    await self.invoke(settings, host)
            self.assertEqual(host.artifact_reviews, [])
            self.assertFalse((self.root / 'harness/run-1-artifacts.json').exists())


if __name__ == '__main__':
    unittest.main()
