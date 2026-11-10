# Business Host examples

Author — Ray Zhang

These examples launch `morrow-agent-jsonl` through the existing Python SDK.
Each Host owns its business target, verifies the result and writes a final
`business-acceptance.json`. The same CLI supports `start`, `inspect` and
`resume` through SDK reconciliation.

| Entry point | Business operation | Verification |
| --- | --- | --- |
| `local_file.py` | Write `result.txt` under the chosen Task root | Read the file and check its content and SHA-256 |
| `object_store.py` | Put one uniquely named object under an authorized S3 prefix | Get the object and check its content and SHA-256 |
| `model_only.py` | Ask the configured model for a fixed text result | Independently check the returned text |

## Runtime and model configuration

Use Python 3.11 or later and a built `morrow-agent-jsonl` executable. The file
and model examples use the standard library. Install `boto3` in a dedicated
Python environment for the object-storage example.

Supply these variables in the process environment before starting or resuming.

| Variable | Value |
| --- | --- |
| `MORROW_MODEL_BASE_URL` | OpenAI-compatible model API base URL |
| `MORROW_MODEL_API_KEY` | Model credential |
| `MORROW_MODEL` | Model ID accepted by that route |

The aliases `MORROW_HOST_MODEL_ENDPOINT`, `MORROW_HOST_MODEL_TOKEN` and
`MORROW_HOST_MODEL_ID` are also supported. Credentials are read from the process
environment. The manifest stores the endpoint, model and Task authority.

From the repository root, run a file Host with a fresh absolute Task directory
under an existing parent.

```powershell
python crates/morrow-agent-jsonl/examples/business_hosts/local_file.py start `
  --root C:/Temp/morrow-file-1 `
  --binary C:/Tools/morrow-agent-jsonl.exe --seconds 900
```

Use `model_only.py` with a different fresh root for the model Host. The default
expected result is `MORROW_HOST_OK`. `--expected` selects another text value.
Verification compares trimmed UTF-8 text. Each Run has at most four model calls,
60 seconds and 512 output tokens. The Task permits at most four Runs and sixteen
calls. `--seconds` sets the Task deadline within 10–900 seconds, with a default
of 180 seconds. Choose enough time for any intended manual reconciliation.

## S3-compatible storage

Provide an existing authorized bucket and a nonempty object prefix.

| Variable | Value |
| --- | --- |
| `MORROW_HOST_S3_ENDPOINT` | S3-compatible HTTP(S) endpoint |
| `MORROW_HOST_S3_BUCKET` | Existing bucket |
| `MORROW_HOST_S3_PREFIX` | Authorized key prefix |
| `AWS_DEFAULT_REGION` | Region, default `us-east-1` |
| `AWS_ACCESS_KEY_ID` | Access key from the process environment |
| `AWS_SECRET_ACCESS_KEY` | Secret key from the process environment |
| `AWS_SESSION_TOKEN` | Optional session credential |

```powershell
python crates/morrow-agent-jsonl/examples/business_hosts/object_store.py start `
  --root C:/Temp/morrow-object-1 `
  --binary C:/Tools/morrow-agent-jsonl.exe --seconds 900
```

The Host chooses `<prefix>/<uuid>/result.txt` and uses SigV4 with path-style
addressing. The tool accepts only a `content` string of at most 64 KiB. The
Host configures one SDK attempt, a three-second connect timeout and a four-second
read timeout. Its operation receipt records the returned ETag, version ID and
request ID when the server supplies them. The operator owns bucket provisioning
and retention of the generated objects.

## Inspect and resume

Inspect the original Task root after interruption or an exit status of 2.

```powershell
python crates/morrow-agent-jsonl/examples/business_hosts/local_file.py inspect `
  --root C:/Temp/morrow-file-1
```

Inspection reports the original Task, fence content and SHA-256, operation
receipts and outcome paths. Read those records and the actual external target
before settling effects. Preserve the original files. Prepare a separate
reconciliation JSON file binding the Task and current original fence.

```json
{
  "task_id": "original-task-id",
  "fence_sha256": "sha256-of-the-original-fence",
  "committed": true,
  "settlement": "Settled",
  "tool_calls": [
    {
      "call_id": "original-open-call-id",
      "settlement": {
        "kind": "completed",
        "output": "Host checked the original external effect"
      }
    }
  ],
  "evidence": [
    {
      "path": "C:/Temp/morrow-file-1/operator-business-receipt.json",
      "sha256": "sha256-of-that-evidence-file"
    }
  ]
}
```

Match the original open tool call IDs in their original order. Use
`"tool_calls": []` when the interrupted Run has no open calls. The existing SDK
also supports `not_executed` and `failed` settlements. Record `not_executed` only
when the external evidence establishes that result. A completed dispatched
operation requires its original Host intent and matching current target bytes.
Every declaration requires external evidence files with matching hashes.

```powershell
python crates/morrow-agent-jsonl/examples/business_hosts/local_file.py resume `
  --root C:/Temp/morrow-file-1 --binary C:/Tools/morrow-agent-jsonl.exe `
  --reconciliation C:/Temp/file-reconciliation.json
```

Use the corresponding script for the object-storage or model Host. Resume keeps
the original Task, Session, cumulative budgets and deadline, then creates a fresh
Run and evidence directory. Expired Tasks retain their original terminal result.
An unresolved operation requires settlement before continuation. Original
operation receipts remain available alongside the separate reconciliation record.

## Evidence and acceptance

The root contains the manifest, attempt configuration, SDK callback operation
records and Task outcome. `receipts/` contains business intents and results,
readback proofs, artifact receipts and explicit reconciliation records.

The Host verifies its own `submit_result` ToolArtifacts against settled operation
receipts and current target bytes. Other Core tool candidates retain their
existing status. The Harness persists accepted artifact records in
`tool-artifacts.jsonl` and references them from the outcome.

Final business acceptance checks the released outcome, its original
`run-N-review.json`, Host proof and current business result. The resulting
`business-acceptance.json` records the Task, criteria, outcome and review hashes,
business evidence and accepted result. Core reports `AwaitingHostAcceptance`
with `task_accepted: false` under its existing contract. The business Host's
acceptance is recorded in its own file. CLI exit status 0 requires successful
business acceptance, while status 2 means acceptance or reconciliation remains
incomplete.

## Focused regression tests

Set `MORROW_HOST_TEST_BINARY` to the executable under test. Optionally set
`MORROW_HOST_TEST_EVIDENCE` to preserve every test root. Run from the repository
root using the Python environment containing any optional S3 dependency.

```powershell
python -m unittest discover `
  -s crates/morrow-agent-jsonl/examples/business_hosts -p test_hosts.py -v
```

The callback tests cover fixed tool authority, duplicate receipts, explicit
reconciliation and mixed Core/Host artifacts. Sidecar tests exercise the actual
JSONL executable with a controlled model provider, including same-Task resume
and final business acceptance. The S3 test uses a real configured S3 endpoint
and is skipped when `MORROW_HOST_S3_ENDPOINT` is absent. Real-model trials use
the normal CLI and require a separately configured authorized model route.
