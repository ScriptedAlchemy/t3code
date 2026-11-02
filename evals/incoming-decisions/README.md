# Local incoming decision integration

T3 can evaluate newly completed MCP tool results before its ACP stdio bridge
forwards them to the provider. The integration is disabled by default and
**shadow-only in production**. The main model receives the complete original
result even when the decision model proposes a deletion. There is no active
pruning environment flag.

## Connect a local runtime

Use an already running, trusted local GPU runtime that implements
[`POST /v1/systemone`](https://github.com/armbues/mlx-decision/blob/main/docs/SERVER.md).
Set the server process environment before starting a new ACP session:

```sh
export T3_INCOMING_DECISION='{"mode":"shadow","port":8009,"model":"your-loaded-model","device":"metal"}'
```

Select the exact identifier reported by the runtime. A response from a different
model is rejected. No model is the default or approved for pruning. Elephant,
Mammoth, H2O-Lightning, Liquid d1, and pplx are candidates through compatible
runtimes. Other candidates need the same wire protocol. General benchmark scores
do not establish pruning quality.

`device` accepts `metal`, `mps`, or `cuda`. It records an operator declaration,
not hardware attestation. Verify local weights and GPU placement before enabling.
Do not use a hosted-model proxy or CPU fallback. T3 contacts literal `127.0.0.1`,
refuses redirects, sends no credentials, and has no cloud fallback. The operator
owns the runtime lifecycle and its admission limit across provider sessions.
T3 does not start another GPU server or download weights. Unset the variable and
restart the server/session to disable observations.

## Supported boundary

| Path                                                                     | Coverage                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| T3 MCP through the ACP stdio bridge                                      | Matching completed `tools/call` responses before forwarding         |
| ACP native tools, HTTP MCP, ACP MCP transport, terminal fallback         | Not intercepted                                                     |
| Codex app-server native tools and MCP connections                        | Not intercepted                                                     |
| Claude, Cursor, OpenCode, Grok, Antigravity outside the ACP stdio bridge | Not intercepted                                                     |
| Web, desktop, mobile, remote clients                                     | The setting belongs to the server environment; no display filtering |

Only newly arrived typed text leaves are eligible. Error results, structured
results, annotated text, mixed media, small results and oversized results bypass
inference. Existing prompt history is neither accepted nor edited by the service.
Notifications, unrelated response IDs and protocol errors bypass selection.

Each result produces one batch with immutable block IDs. Choices are `keep`,
`drop`, and `abstain`. Missing or unknown IDs, malformed answers, model mismatch,
truncation, timeout and transport failure preserve the entire original result.
The model cannot supply replacement text. Raw probabilities are not calibrated
estimates of necessity. The request has no task context, which remains a promotion
blocker even when the response is structurally valid.

The input cap is 16 KiB and 32 blocks. The response cap is 16 KiB. These are byte
bounds, not proof that a candidate's token window is sufficient. Admission allows
one request per bridge, with no queue or retry. The one-second total deadline is
an engineering budget, not an observed latency result. A timeout disables further
observations until a new bridge session. HTTP cancellation cannot guarantee that
the runtime stops GPU work already in progress. Timed receipts include failures
and actual envelope serialization. Bridge stderr contains proposed typed choices,
raw probabilities, effective retention, and elapsed time without tool text.

Different models process the same batch differently. Shared-state computation
and question interaction must be tested for the deployed candidate. See the
runtime's [batch semantics](https://github.com/armbues/mlx-decision/blob/main/docs/MODELS.md#how-they-read-a-request).
One HTTP batch does not prove shared computation or stable decisions.

## Verification and remaining evidence

Run the deterministic transport and selection tests:

```sh
vp test run apps/server/src/mcp/IncomingDecisionShadow.test.ts apps/server/src/mcp/AcpMcpStdioBridge.test.ts
```

The fixtures contain synthetic text and local fake decisions. An internal test
policy exercises exact block deletion through the real bridge and checks earlier
provider-facing bytes. Production construction keeps shadow mode. The tests prove selected bytes at
the bridge's provider-facing output, not provider-internal prompt serialization
or prompt-cache hits. Active selection across retries or process restarts has no
persistence guarantee. That is another promotion blocker; shadow replay remains
unchanged because the original result is always delivered.

Promotion requires independently labeled historical cases at original arrival
cutoffs, session-separated calibration and held-out evaluation, required-evidence
and dependency preservation, paired continuation checks, and hardware-specific
latency. The research owner maintains that evaluation separately. This directory
contains no source transcripts, private cases, model-quality result, or M5 pass.
No paid inference is used by these checks.
