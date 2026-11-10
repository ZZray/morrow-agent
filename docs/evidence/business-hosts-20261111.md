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

The initial same-Task resume test used the actual SDK with a controlled model.
The three final real-model start trials exercised ordinary successful starts.
The S3 service was a local persistent SeaweedFS instance. Remote production
storage and other S3 implementations remain outside this verification record.
The real-model recovery trials below extend the initial coverage.
The main agent independently reviewed the production
callbacks, CLI, receipts, reconciliation and artifact paths and found no
blocking implementation issue. It identified a README Python-version mismatch
with the SDK's `asyncio.timeout` requirement. The README now requires Python
3.11 or later. The main agent owns the final scoped commit.

## Real-model cancellation and timeout recovery

Two further trials used the delivered examples at commit `547f2e4`, the same
executable SHA-256 recorded above, CAS `deepseek-v4.1-flash` and the original
business criterion `Morrow business integration verified`. Each fresh Task
started with a 900-second deadline, four Runs, sixteen total calls and the
existing four-call/60-second per-Run authority. Temporary Python drivers under
the local evidence root supplied the fault and post-reconciliation Host
feedback. Production source hashes matched the final start trials.

| Trial | Original Task | Initial process result | Fresh-process resume |
| --- | --- | --- | --- |
| `live-recovery-local-1` | `05202730c98842feb3103ef922e8c962` | Exit 2, Cancelled, 3.541 s | Exit 0, accepted, 3.526 s |
| `live-recovery-object-timeout-1` | `dbb0219760c34b0e9ab85ed4473fd67a` | Exit 2, Cancelled, 7.480 s | Exit 0, accepted, 3.123 s |

### File write followed by an unknown settlement

The temporary file driver performed the production write, `flush` and `fsync`,
then appended and synced a write-count record. The business operation's original
Settled receipt was already durable when the driver changed the callback's
settlement to Unknown. The runtime retained a fence and recorded one unknown
effect. Its first outcome was Cancelled, with one consumed Run and three
observed calls.

The explicit Host reconciliation read the actual file, compared its 36 bytes
with the unchanged business criterion and checked the original operation
receipt. The proof retained the original outcome, fence, Task identity and
receipt SHA-256. The original Run had already closed with `pending_run: null`,
so the declaration used `tool_calls: []` and supplied the external proof and
original receipt as evidence.

Fresh Host process PID 36648 resumed the Task after PID 16132 performed the
original write. Final cumulative counts were two Runs and four calls. The
audit found exactly one native `submit_result` call and one external write.
The original write log and receipt hashes matched their pre-resume values.
The file SHA-256 remained
`3d68a83fa34825a277833cccef818d36853d68803eff946bb5b9ae2354772dbe`.

### Real S3 read timeout after a successful PUT

A temporary HTTP proxy ran in PID 46500 at `http://127.0.0.1:52111` and forwarded
requests to the existing SeaweedFS endpoint `http://127.0.0.1:27969`. It preserved
the original request headers for SigV4 verification and recorded request
methods, object paths, hashes and response metadata. Credential headers were
excluded from the evidence logs.

The proxy forwarded the actual PUT and saved the backend's HTTP 200 receipt
before delaying its response by six seconds. The production boto3 client used
its configured four-second read timeout and one attempt. It raised an actual
`ReadTimeoutError`; the production Host persisted an Unknown operation receipt,
and the runtime retained a Cancelled outcome and reconciliation fence. The
proxy later recorded that the client had disconnected after the successful
backend response.

The backend object was
`host-live-timeout/0bc2f92e54954efaaa027e8528f6c10f/result.txt` in bucket
`morrow-acceptance-1e0a75e04712`. A direct backend GET, outside the proxy, verified
the original 36 bytes and their SHA-256 before the explicit reconciliation
declaration was created. The recorded PUT ETag was
`07803c839df39760adca73d4cb7ff5e2` and request ID was
`18E6C310D7C2B014E1D7EA51`. SeaweedFS supplied no version ID for this write.

Host PID 68872 resumed the original Task after PID 64584 handled the timed-out
write. Counts advanced from one Run/three calls to two Runs/four calls. The
proxy recorded exactly one forwarded PUT across both processes. Direct backend
readback after resume still matched the original content and hash. The original
Unknown receipt retained SHA-256
`05bf91e2f6cafe1766297d3006cf784c222f5ecc568639ebc01f9d11e10ae461`.
The proxy closed in `finally`, its server thread joined, and a subsequent
listener query found zero listeners on port 52111.

### Shared recovery checks and boundaries

Both audits checked the original Task and Session, unchanged deadline, criteria,
authorization revision, tool declaration and per-Run limits. Each resume record
retained `consumed_runs: 1` and `consumed_calls: 3`. Original receipts, external
readback, final outcome, review and business-proof hashes were checked. The
final outcome was `AwaitingHostAcceptance` with `task_accepted: false`, and the
separate `business-acceptance.json` recorded `accepted: true`.

After checking the original business effect and receipt hash, each temporary
Host supplied resume-specific feedback stating that the effect had completed
and requesting a completion report without another submission. That feedback
was saved in `resume-host-feedback.json`. These trials exercise a Host-directed
continuation through the production SDK. The production example CLI continues
to use its existing objective generation.

The original ledgers retain `reference_read` as candidate and `submit_result`
as unknown. Each recovery record has `artifact_recovery: []`. The resumed Runs
made no business tool calls, and their final outcomes contain zero verified
artifact references. The explicit business reconciliation and acceptance
receipts provide the new settlement evidence. Historical unknown artifact
records remain available for inspection.

The file trial covers injected lost settlement after a durable write and its
runtime cancellation path. The S3 trial covers an actual socket read timeout
after a durable external effect, followed by explicit reconciliation. User
cancellation, hard process termination and Task-deadline expiry recovery were
outside these two trials. The older expired `live-local-1` Task retains its
original failed evidence and deadline.

### Recovery evidence

Under the local evidence root, each recovery Task contains
`operator-business-check.json`, `operator-reconciliation.json`, original
operation receipts, `resume-host-feedback.json`, the resumed evidence directory,
`business-acceptance.json` and `recovery-audit.json`. The file Task also retains
`external-writes.jsonl` and `injected-unknown.json`.

`live-recovery-object-timeout-proxy-1/` contains `proxy-start.json`,
`requests.jsonl`, both subprocess outputs and exit records, and
`proxy-stop.json`. `listener-check.json` records the subsequent zero-listener
check. Local temporary scripts retain the fault and audit mechanics.

| Temporary script | SHA-256 |
| --- | --- |
| `live-recovery-driver.py` | `4a9c686725e88ca3db769e895e6438a20ff097b8fd7650e0daa13a49aa287406` |
| `live-recovery-launch.py` | `d638172755976906e0282ff60592948b4bb5a01a58704b18d02dcb7a0539f865` |
| `live-recovery-reconcile.py` | `9b713021469927fa383113e5485d3f110375b44b32d283a5c8ec0e54be03f1a9` |
| `live-recovery-audit.py` | `602dd9c6a1ccf66a5d61fe7270c723810feb46db9f8480aa08ea775a7f3c2563` |
| `live-recovery-object-driver.py` | `8821c852fdf19e37b977e0a9dcb77c4937e077e82b33c5d46d7f44903e8b072f` |
| `live-recovery-object-trial.py` | `2f71a7b7901b7f2287916c33822bc86d8cd27d171a243db9180ac87d866302b0` |
