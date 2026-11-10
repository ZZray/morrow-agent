"""Business Host callbacks over the existing Morrow JSONL SDK.

Author: Ray Zhang
"""
from __future__ import annotations

import argparse
import asyncio
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import uuid
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'clients/python'))
import morrow_agent as client


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save(path: Path, value: dict) -> None:
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def load(path: Path) -> dict:
    with path.open('rb') as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('Host record exceeds one MiB')
    return json.loads(raw)


def service_endpoint(value: str) -> str:
    url = urlsplit(value)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('service endpoint needs an HTTP(S) origin/path with credentials supplied separately')
    return value


class Host:
    """Subclasses implement one fixed business target and independent readback."""
    kind = ''
    tools = True

    def __init__(self, root: Path, manifest: dict, reconciliation: dict | None = None):
        self.root = root
        self.manifest = manifest
        self.reconciliation = reconciliation
        self.receipts = root / 'receipts'
        self.receipts.mkdir(exist_ok=True)

    def write_payload(self, content: bytes) -> dict:
        raise NotImplementedError

    def read_payload(self) -> bytes:
        raise NotImplementedError

    async def tool_call(self, request: dict, cancelled: asyncio.Event) -> dict:
        arguments = request['arguments']
        if (not self.tools or request['tool_name'] != 'submit_result'
                or not isinstance(arguments, dict) or set(arguments) != {'content'}
                or not isinstance(arguments['content'], str)
                or len(arguments['content'].encode('utf-8')) > 64 * 1024):
            raise ValueError('tool arguments exceed the fixed Host grant')
        identity = {key: request[key] for key in ('task_id', 'run_id', 'native_call_id', 'args_sha256')}
        operation = digest(json.dumps(identity, sort_keys=True).encode())
        intent = self.receipts / f'{operation}-intent.json'
        receipt = self.receipts / f'{operation}-result.json'
        reconciled = self.receipts / f'{operation}-reconciled.json'
        if reconciled.is_file() or receipt.is_file():
            prior = load(reconciled if reconciled.is_file() else receipt)
            if prior['identity'] != identity:
                raise ValueError('operation identity changed')
            return prior['reply']
        if intent.exists():
            raise client.ReconciliationRequired('original operation has no result receipt; inspect before resume')
        if cancelled.is_set():
            raise client.ReconciliationRequired('operation cancelled before dispatch')
        content = arguments['content'].encode('utf-8')
        save(intent, {'identity': identity, 'content_sha256': digest(content), 'target': self.manifest['target']})
        try:
            metadata = await asyncio.to_thread(self.write_payload, content)
            actual = await asyncio.to_thread(self.read_payload)
            if actual != content:
                raise ValueError('business readback differs from submitted content')
            reply = {'value': {'sha256': digest(actual), **metadata}, 'is_error': False,
                     'settlement': 'Settled', 'operation_receipt': str(receipt)}
        except Exception as error:
            reply = {'value': {'error_type': type(error).__name__, 'effects': 'unknown'},
                     'is_error': True, 'settlement': 'Unknown', 'operation_receipt': str(receipt)}
        save(receipt, {'identity': identity, 'reply': reply})
        return reply

    async def verify(self, candidate: dict, cancelled: asyncio.Event) -> dict:
        actual = await asyncio.to_thread(self.read_payload) if self.tools else candidate['output'].encode('utf-8')
        passed = actual.decode('utf-8').strip() == self.manifest['expected']
        proof = self.receipts / f"review-{candidate['basis']['run_id']}-{uuid.uuid4().hex}.json"
        save(proof, {'basis': candidate['basis'], 'passed': passed, 'actual_sha256': digest(actual)})
        return {'basis': candidate['basis'], 'committed': True, 'settlement': 'Settled',
                'verdict': 'Verified' if passed else {'NeedsChanges': {'feedback': self.objective()}},
                'evidence': [str(proof)]}

    def objective(self) -> str:
        expected = json.dumps(self.manifest['expected'], ensure_ascii=False)
        if self.tools:
            return f'Call submit_result with content exactly {expected}, then report completion.'
        return f'Return exactly {expected} as plain text, with no surrounding explanation.'

    async def prepare(self, continuation: dict, cancelled: asyncio.Event) -> dict:
        return {'run_id_next': f"run-{uuid.uuid4().hex}", 'objective': self.objective()}

    async def review_artifacts(self, review: dict, cancelled: asyncio.Event) -> list[dict]:
        verified = []
        operations = {}
        for pattern in ('*-result.json', '*-reconciled.json'):
            for path in self.receipts.glob(pattern):
                item = load(path)
                key = tuple(item['identity'][field] for field in ('task_id', 'run_id', 'native_call_id'))
                operations[key] = item
        for candidate in review['artifacts']:
            if candidate['tool'] != 'submit_result':
                continue
            key = tuple(candidate[field] for field in ('task_id', 'run_id', 'native_call_id'))
            operation = operations.get(key)
            if operation is None or operation['reply']['settlement'] != 'Settled' or operation['reply']['is_error']:
                continue
            actual = await asyncio.to_thread(self.read_payload)
            if digest(actual) != operation['reply']['value']['sha256']:
                raise client.ReconciliationRequired('business output changed before artifact review')
            item = copy.deepcopy(candidate)
            item['status'] = 'verified'
            item['host_receipt'] = {
                **{key: item[key] for key in ('artifact_id', 'task_id', 'session_id', 'run_id',
                                            'native_call_id', 'input_sha256', 'output_sha256')},
                'receipt_id': uuid.uuid4().hex, 'verifier': f'{self.kind}-example-host', 'verifier_version': '1',
                'verified_at': datetime.now(timezone.utc).isoformat(), 'committed': True, 'settled': True,
            }
            save(self.receipts / f"artifact-{item['host_receipt']['receipt_id']}.json", item)
            verified.append(item)
        return verified

    async def reconcile_resume(self, review: dict, cancelled: asyncio.Event) -> dict:
        declaration = self.reconciliation
        if not declaration or declaration.get('task_id') != review['task_id']:
            raise client.ReconciliationRequired('explicit Host reconciliation for the original Task is required')
        if declaration.get('committed') is not True or declaration.get('settlement') != 'Settled':
            raise client.ReconciliationRequired('Host effects remain unknown')
        evidence = []
        for reference in declaration['evidence']:
            path = Path(reference['path']).resolve(strict=True)
            if digest(path.read_bytes()) != reference['sha256']:
                raise client.ReconciliationRequired('external reconciliation evidence changed')
            evidence.append(str(path))
        if not evidence:
            raise client.ReconciliationRequired('external reconciliation evidence is required')
        calls = (review.get('interrupted_run') or {}).get('open_tool_calls', [])
        settlements = declaration['tool_calls']
        if [call['id'] for call in calls] != [item['call_id'] for item in settlements]:
            raise client.ReconciliationRequired('settlement does not match original open calls')
        for call, settled in zip(calls, settlements):
            if call['name'] != 'submit_result' or not self.tools:
                raise client.ReconciliationRequired('unexpected original business tool')
            matching_intents = [load(path) for path in self.receipts.glob('*-intent.json')]
            matching_intents = [item for item in matching_intents
                               if item['identity']['task_id'] == review['task_id']
                               and item['identity']['run_id'] == review['interrupted_run']['run_id']
                               and item['identity']['native_call_id'] == call['id']]
            if not matching_intents and settled['settlement']['kind'] == 'not_executed':
                continue
            if len(matching_intents) != 1:
                raise client.ReconciliationRequired('original operation intent is required for a dispatched operation')
            intent = matching_intents[0]
            expected = call['arguments']['content'].encode('utf-8')
            if intent['content_sha256'] != digest(expected):
                raise client.ReconciliationRequired('original operation arguments changed')
            value = {'reconciled': settled['settlement']['kind']}
            if settled['settlement']['kind'] == 'completed':
                actual = await asyncio.to_thread(self.read_payload)
                if actual != expected:
                    raise client.ReconciliationRequired('completed effect fails current business readback')
                value['sha256'] = digest(actual)
            operation = digest(json.dumps(intent['identity'], sort_keys=True).encode())
            result_path = self.receipts / f'{operation}-reconciled.json'
            if not result_path.exists():
                save(result_path, {'identity': intent['identity'], 'reconciliation_evidence': evidence,
                                  'reply': {'value': value, 'is_error': settled['settlement']['kind'] != 'completed',
                                            'settlement': 'Settled', 'operation_receipt': str(result_path)}})
        receipt = {'committed': True, 'settlement': 'Settled', 'tool_calls': settlements, 'evidence': evidence}
        if not client.valid_resume_receipt(receipt):
            raise ValueError('invalid reconciliation receipt')
        save(self.receipts / f'reconciled-{uuid.uuid4().hex}.json', {'review': review, 'receipt': receipt})
        return receipt

    def accept(self, outcome: dict, evidence: Path) -> bool:
        outcome_path = evidence / 'released.json'
        released = load(outcome_path)
        if released != outcome:
            raise client.ReconciliationRequired('SDK outcome differs from the original released file')
        outcome_ref = {'path': str(outcome_path), 'sha256': digest(outcome_path.read_bytes())}
        receipt = released['last_receipt']
        if (released['task_id'] != self.manifest['config']['task']['task_id']
                or released['stop'] != 'AwaitingHostAcceptance' or released['fence_presence'] != 'Released'
                or receipt['committed'] is not True or receipt['settlement'] != 'Settled'
                or receipt['verdict'] != 'Verified'):
            raise client.ReconciliationRequired('final Task outcome has no settled successful Host review')
        review_path = evidence / f"run-{receipt['basis']['run_number']}-review.json"
        if load(review_path) != receipt:
            raise client.ReconciliationRequired('final ReviewReceipt differs from its durable source')
        proofs = []
        for source in receipt['evidence']:
            path = Path(source)
            proof = load(path)
            if proof['basis'] != receipt['basis'] or proof['passed'] is not True:
                raise client.ReconciliationRequired('business verification proof changed')
            proofs.append({'path': str(path), 'sha256': digest(path.read_bytes()),
                           'artifact_sha256': proof['actual_sha256']})
        actual = self.read_payload() if self.tools else released['last_candidate']['output'].encode('utf-8')
        actual_sha256 = digest(actual)
        accepted = (actual.decode('utf-8').strip() == self.manifest['expected']
                    and all(proof['artifact_sha256'] == actual_sha256 for proof in proofs))
        save(self.root / 'business-acceptance.json', {
            'version': 1, 'task_id': released['task_id'], 'accepted': accepted,
            'criteria_revision': receipt['basis']['criteria_revision'],
            'condition': {'kind': 'trimmed_utf8_equals', 'expected': self.manifest['expected']},
            'artifact': {'target': self.manifest['target'], 'sha256': actual_sha256},
            'outcome': outcome_ref,
            'review': {'path': str(review_path), 'sha256': digest(review_path.read_bytes())},
            'business_evidence': proofs, 'verifier': f'{self.kind}-example-host',
            'accepted_at': datetime.now(timezone.utc).isoformat(),
        })
        return accepted


def cli(host_type: type[Host]) -> None:
    parser = argparse.ArgumentParser(description=f'Morrow {host_type.kind} business Host')
    parser.add_argument('action', choices=['start', 'inspect', 'resume'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--expected', default='MORROW_HOST_OK')
    parser.add_argument('--seconds', type=int, default=180)
    parser.add_argument('--reconciliation', type=Path)
    args = parser.parse_args()
    if args.action != 'inspect' and not args.binary:
        parser.error('--binary is required for start and resume')
    root = args.root.absolute()
    if args.action == 'start':
        if not root.parent.is_dir() or root.exists() or not 10 <= args.seconds <= 900:
            parser.error('start needs a fresh root under an existing parent and 10..900 seconds')
        endpoint = service_endpoint(os.environ.get('MORROW_MODEL_BASE_URL') or os.environ['MORROW_HOST_MODEL_ENDPOINT'])
        model = os.environ.get('MORROW_MODEL') or os.environ['MORROW_HOST_MODEL_ID']
        root.mkdir()
        (root / 'state').mkdir()
        target = host_type.target(root)
        task_id = uuid.uuid4().hex
        manifest = {'kind': host_type.kind, 'expected': args.expected, 'target': target,
                    'config': {'kind': 'start_task', 'version': 1, 'artifact_review': True,
                        'task': {'task_id': task_id, 'criteria_revision': 'exact-content-v1',
                                 'authorization_revision': 'fixed-target-v1', 'kind': 'Coding',
                                 'evidence_dir': str(root / 'evidence-first'), 'max_runs': 4, 'max_calls': 16,
                                 'deadline_unix_ms': int(time.time() * 1000) + args.seconds * 1000},
                        'run': {'run_id': f'run-{uuid.uuid4().hex}', 'objective': '', 'cwd': str(root),
                                'session_path': str(root / 'state/session.json'),
                                'environment_state': str(root / 'state/environment'), 'device_fp': 'RY-host-example',
                                'session_key': f'{host_type.kind}/{task_id}', 'mode': 'execute',
                                'endpoint': endpoint, 'model': model, 'max_calls': 4, 'max_seconds': min(60, args.seconds),
                                'max_output': 512, 'model_resolution': {'kind': 'catalog'},
                                'tools': [{'name': 'submit_result', 'description': 'Submit text to the fixed Host-owned target.',
                                           'parameters': {'type': 'object', 'properties': {'content': {'type': 'string'}},
                                                          'required': ['content'], 'additionalProperties': False},
                                           'allow_in_plan': False}] if host_type.tools else []},
                        'cancel_grace_ms': 15000, 'emit_events': False}}
        save(root / 'manifest.json', manifest)
    else:
        root = root.resolve(strict=True)
        manifest = load(root / 'manifest.json')
        if manifest['kind'] != host_type.kind:
            parser.error('Host kind differs from the original manifest')
    fences = list((root / 'state').glob('.ara-lite-harness-*.fence.json'))
    if args.action == 'inspect':
        print(json.dumps({'task': manifest['config']['task'],
                          'fences': [{'path': str(path), 'sha256': digest(path.read_bytes()), 'record': load(path)} for path in fences],
                          'receipts': [str(path) for path in (root / 'receipts').glob('*.json')],
                          'outcomes': [str(path) for path in root.glob('evidence-*/outcome.json')]}, indent=2))
        return
    reconciliation = None
    config = copy.deepcopy(manifest['config'])
    if args.action == 'resume':
        if len(fences) != 1 or not args.reconciliation:
            parser.error('resume needs one original fence and --reconciliation')
        reconciliation = load(args.reconciliation)
        if (reconciliation.get('fence_sha256') != digest(fences[0].read_bytes())
                or load(fences[0])['task_id'] != config['task']['task_id']):
            parser.error('reconciliation must bind the current original fence')
        config['resume'] = {'version': 1, 'fence_sha256': reconciliation['fence_sha256']}
        config['task']['evidence_dir'] = str(root / f'evidence-{uuid.uuid4().hex}')
        config['run']['run_id'] = f'run-{uuid.uuid4().hex}'
    host = host_type(root, manifest, reconciliation)
    config['run']['objective'] = host.objective()
    attempt = uuid.uuid4().hex
    save(root / f'attempt-{attempt}.json', config)
    try:
        outcome = asyncio.run(client.run_task(args.binary, config, host,
            token=os.environ.get('MORROW_MODEL_API_KEY') or os.environ['MORROW_HOST_MODEL_TOKEN'],
            operation_directory=root / f'operations-{attempt}'))
        save(root / f'result-{attempt}.json', outcome)
        print(json.dumps(outcome, ensure_ascii=False, indent=2))
        if outcome['stop'] != 'AwaitingHostAcceptance':
            raise SystemExit(2)
        if not host.accept(outcome, Path(config['task']['evidence_dir'])):
            raise SystemExit(2)
    except client.ReconciliationRequired:
        print('Original Task requires reconciliation. Use inspect and retain its evidence.', file=sys.stderr)
        raise SystemExit(2) from None
