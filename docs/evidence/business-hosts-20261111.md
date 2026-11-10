# Business Host verification — 2026-11-11

Author — Ray Zhang

## Delivered scope

The Python JSONL SDK examples implement local-file, S3-compatible object-storage
and model-only Hosts. Each exposes `start`, `inspect` and explicit-reconciliation
`resume`, retains operation evidence and performs final business acceptance.
The model-only Host has zero business tools. Core tools can still produce
candidate records in its journal and artifact ledger.

The examples and invocation instructions are in
[business_hosts](../../crates/morrow-agent-jsonl/examples/business_hosts/README.md).

## Executable and source identity

The exercised executable was
`C:/Users/loveu/AppData/Local/Temp/morrow-host-acceptance-20261111/morrow-agent-jsonl.exe`.
It was built from recovery commit `3b9b8ef` plus the orchestration module being
reviewed concurrently. The executable SHA-256 is
`a716e1400dab3ef9caa50c518d4859e87c528af387da6b833d21c7923e87364e`.

The production example files remained at these hashes during final controlled
and real-model trials.

| File under `examples/business_hosts/` | SHA-256 |
| --- | --- |
| `common.py` | `859360c25fe4c5de1e1573fd50a0e7e9a765c06c2371e7face0bdf84a4db5eac` |
| `local_file.py` | `47b91f934503786545a6a4b5747d81ab9fb9181867b8b7a708a8392dd4f6437b` |
| `object_store.py` | `d27ada180c65936d35923d1de7fe955c4284421509b0eb24d0cfe16e6474c852` |
| `model_only.py` | `c768eb28f28a269fc2eb763c8c3f160d07f30a8e69c6158f138a7964a191a885` |
| Final `test_hosts.py` | `0e3453e4ab5cebf27ac5533ac3af0ddb490fef7c73eda190cc93667425f4636d` |

The Python environment was `D:/workspace/env/python/morrow-hosts`, with Python
3.14.6, boto3 1.43.127 and botocore 1.43.127. Optional S3 packages were installed
in that environment. Model and storage credentials were injected through the
process environment.

## Controlled-provider regression

The final suite passed 8/8 in 5.136 seconds. It exercised the actual sidecar and
a controlled model provider. The S3 case used a real SeaweedFS 4.53 service with
SigV4 PutObject/GetObject requests.

| Case | Result |
| --- | --- |
| Fixed business grant and duplicate operation receipt | Passed |
| Write with lost reply, explicit reconciliation and retained original receipt | Passed |
| Mixed Core/Host artifact callback ownership | Passed |
| Actual sidecar local-file write and final acceptance | Passed |
| Actual sidecar mixed `reference_read` and `submit_result`, followed by inspect | Passed |
| Actual sidecar model result and final acceptance | Passed |
| Actual sidecar and real S3 write/readback | Passed |
| Actual SDK resume preserving Task, cumulative Runs and original single write | Passed |

An earlier seven-case run passed 7/7 in 4.181 seconds. The eighth case adds a
real-sidecar regression for the mixed-artifact failure observed with the live
model. Its ledger retains the Core candidate and verifies the owned business
artifact. Both sets of evidence remain under the local evidence root.

## Real-model business results

The final trials used the authorized CAS route at `https://cas.ciqtek.com/v1`
with model `deepseek-v4.1-flash`. Each fresh Task had a 900-second deadline and
a 60-second per-Run limit. The longer Task budget allowed time for potential
manual reconciliation.

| Host and local evidence directory | Task ID | Elapsed | Business acceptance |
| --- | --- | --- | --- |
| Local file, `live-local-2` | `601a8926ca8642d88051903f8bc2ceea` | 4.431 s | Passed |
| Model only, `live-model-2` | `a8e381fed93d424085da4a09e4c3ca25` | 3.447 s | Passed |
| Object storage, `live-object-2` | `3b6d952eb50f4508afae97512d9e6c75` | 3.870 s | Passed |

All three used the expected business content `Morrow business integration verified`
(36 UTF-8 bytes). Its SHA-256
was `3d68a83fa34825a277833cccef818d36853d68803eff946bb5b9ae2354772dbe`.
The local-file Host verified `live-local-2/result.txt`. The S3 Host verified
`host-live/c874f109828644d394a807622c1c8003/result.txt` in the authorized local
test bucket `morrow-acceptance-1e0a75e04712` at `http://127.0.0.1:27969`.

Each `business-acceptance.json` has `accepted: true` and references the original
released outcome, review receipt and Host proof with matching hashes. The Core
outcome retains `AwaitingHostAcceptance` and `task_accepted: false`. Local-file
and S3 outcomes each reference one verified business artifact. The model-only
outcome has zero verified business artifacts. Its Core `reference_read` call
left a candidate in the ledger. The local-file ledger contains three records,
and the S3 ledger contains two.

The main agent independently checked these records and saved
`live-receipt-audit.json`. The example author also re-read all three acceptance
files and verified outcome/review hashes, Task identities and per-Run limits.
An additional S3 GetObject read returned the same 36 bytes as the local file.
`independent-business-readback.json` records that comparison and its SHA-256.

## Preserved failures and corrections

The first live local-file trial, `live-local-1`, wrote the expected file and
received a Verified business review. Artifact review then rejected a Core
`reference_read` candidate because the initial example assumed every candidate
belonged to `submit_result`. The correction filters ownership before reviewing
business artifacts. The initial Task's 180-second deadline expired. Its fence
and original failed evidence remain available, and that Task was left
unrecovered. The final trials use separate fresh Task roots.

During controlled implementation, a 30000 ms cancel grace exceeded the protocol
limit. The example now uses 15000 ms. A model-only test initially expected an
empty `artifacts` property that serde omits. Another acceptance implementation
expected an `outcome_ref` envelope after the SDK had already loaded and returned
the full outcome. The final implementation reads and compares the original
`released.json` and hashes that file. The added mixed-sidecar test initially
read `tool` from an `ArtifactReceiptRef`. Its final assertion uses
`native_call_id` and verifies the complete record in the ledger. The original
failed logs remain beside the passing logs.

## Evidence locations and coverage

The local evidence root is
`C:/Users/loveu/AppData/Local/Temp/morrow-host-acceptance-20261111`.

- `controlled-final-tests.txt` and `controlled-final/` contain the 7/7 run.
- `controlled-complete-tests.txt` and `controlled-complete/` contain the 8/8 run.
- `controlled-mixed-tests.txt` retains the intermediate test-assertion failure.
- `controlled-acceptance-tests.txt` retains the initial SDK-envelope failure.
- `live-results-2.json`, `live-source-hashes-2.json` and `live-receipt-audit.json`
  record the final real-model trials and independent receipt audit.
- Each `live-*-2` root retains its manifest, SDK operations, business receipts,
  journal, artifact ledger, released outcome and business acceptance.
- `live-local-1` retains the first failed real-model trial.

Same-Task resume was exercised through the actual SDK with a controlled model.
The three final real-model trials exercised ordinary successful starts. The S3
service was a local persistent SeaweedFS instance. Remote production storage,
other S3 implementations and live-model interruption recovery remain outside
this verification record. The main agent independently reviewed the production
callbacks, CLI, receipts, reconciliation and artifact paths and found no
blocking implementation issue. It identified a README Python-version mismatch
with the SDK's `asyncio.timeout` requirement. The README now requires Python
3.11 or later. The main agent owns the final scoped commit.
