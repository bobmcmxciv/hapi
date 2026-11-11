# Oh My Pi

HAPI can run the Oh My Pi (`omp`) terminal interface locally and control the same native session remotely from the Web/PWA.

## Install

Install Oh My Pi on the runner machine, then verify that HAPI can find the executable:

```bash
omp --version
```

The initial HAPI integration targets OMP 17.0.4.

## Start a session

Start in the native terminal interface:

```bash
hapi omp
```

Resume an OMP-native session or select launch configuration explicitly:

```bash
hapi omp --resume <native-session-id>
hapi omp --model <provider/model> --effort high
```

Sessions created from a HAPI runner start in remote mode automatically. Terminal-created sessions start locally and can switch between local terminal control and remote Web control without creating a new HAPI session.

On Windows, HAPI launches the OMP package entry with a native `bun.exe`, not
through npm's `omp.cmd` or `bun.cmd` shims. It resolves Bun's executable from
PATH or the npm package layout; unsupported installations fail explicitly.

Reopening an archived OMP session preserves its HAPI row and resumes the native
session recorded in `metadata.ompSession`. Reopen succeeds only after OMP reports
ready. A spawn RPC error or timeout, an unexpected returned HAPI ID, and a
readiness failure all require runner-side cleanup verification before archive
metadata can be restored. Unknown cleanup remains a visible error, not a
successful reopen or a confirmed exit. Runner-owned PID/start-marker tracking
and spawn deduplication prevent retries from launching over an unconfirmed child.
HAPI verifies the discovered native ID against the original journal before
publishing readiness. A missing persisted journal, conflicting live writer or
unexpected sibling identity is an explicit error, not permission to silently
replace the history. Only a proven never-persisted empty session may receive a
new native ID while keeping the original HAPI row.

OMP and PTY archived resumes also persist a Hub-owned archive checkpoint before
spawn. CLI bootstrap cannot erase it, including when an older CLI omits the field.
It is committed only after readiness succeeds, or rolled back after runner-owned
cleanup is confirmed. After a Hub restart, reopening a pending checkpoint first
verifies cleanup on its recorded target machine; an offline or still-live result
refuses another spawn. Restoring archive fields preserves unrelated concurrent
metadata changes, native session identity, and transport configuration.
The checkpoint and PTY attempt are created together. Completing or restoring an
archive removes both in the same versioned metadata write, so a failed write
leaves a retryable checkpoint. A native-ready child whose commit failed is not
stopped on retry. A mismatched OMP return ID is cleaned only when the newly
created row matches this spawn's namespace, machine, runner origin and native
resume token; its attributed ID stays in the checkpoint until both returned and
requested IDs have runner-confirmed exit. An existing or otherwise unattributable
row is never terminated, and the failed reopen reports unverified cleanup.
Automatic native-ID deduplication does not merge any row while that identity has
a pending reopen checkpoint. A newly attributed failed child row is removed only
after its exit is verified and before the original checkpoint is cleared; the
original HAPI ID, history, and native journal remain intact.
OMP persists an unresolved-response marker before sending spawn. If a crash
loses the response, or the returned row cannot be attributed to this spawn,
that same checkpoint quarantines reopening and explicit archiving. A returned
unowned ID is diagnostic only, never permission to kill that row. Repeated
clicks or a Hub restart do not clear this quarantine, even if stopping the
original requested ID reports `already_gone`: the unconfirmed child may still
exist. The visible error identifies the target Runner whose actual process
ownership must be inspected. A known local failure before spawn is invoked can
roll back its checkpoint; an indeterminate RPC boundary cannot.

Archiving a session is a verified exit: the hub awaits session-owned cleanup,
then asks the runner to verify session-owned resource cleanup before marking the
row inactive and archived. The detached shared OMP broker is not session-owned
and is never killed by this path. Unverified cleanup (including an offline
runner) is a visible error, never silent success. Repeated or concurrent
archive/reopen/restart clicks are serialized per session server-side.

A failed starter can remain quarantined without losing its history. Quarantine
blocks message, metadata and readiness publication, but an authenticated cleanup
route may still request native disposal. The Runner must verify the wrapper's
own generation-bound cleanup receipt before terminating it. A rejected shutdown
metadata acknowledgment is not itself proof that disposal failed or succeeded:
only a positive verified Runner stop can complete that recovery. Verified cleanup
retires old publication identities before clearing the attempt, so a delayed old
connection cannot overwrite the archive or become the next session's publisher.

With native OMP 18.16.0, remote exit aborts the active turn and closes RPC input;
OMP disposes its session-owned resources and flushes its journal before HAPI
accepts an observed native exit code of zero. Local terminal shutdown uses a
per-launch private, nonce-bound request consumed by HAPI's managed OMP extension;
the extension invokes native abort/shutdown, rather than injecting keystrokes or
terminating a Windows process tree. Both paths wait up to 30 seconds for native
exit. Missing extension control, timeouts, nonzero exits, and unconfirmed metadata
flushes are visible failures; they never authorize a blanket broker/subtree kill.
The kill RPC acknowledges only after native disposal and hub metadata flushing,
then schedules wrapper/socket exit so the acknowledgment can reach its caller.

Archiving an idle-hibernated remote session reuses its already-confirmed native
disposal receipt rather than treating the absent subprocess as unknown cleanup.
Shutdown waits for an in-flight hibernation or wake-up before collecting that
receipt. An EOF disposal timeout keeps the native client available for a retry;
a failed shutdown preparation keeps the wrapper available until cleanup can be
confirmed and the successful kill-RPC acknowledgement can reach its caller.
These retries do not relax cleanup verification: abnormal exits and unconfirmed
resources still block a successful archive.

Closing a session tab, backgrounding the browser, or temporary network/SSE
disconnection only changes navigation/connectivity; none exits the native runtime.
The composer's Stop button aborts the current turn, not the session. Use Archive
for an explicit exit; use Reopen in the session list to resume its history.

## Native provider and model authority

For an OMP session, HAPI uses the selected Runner's native OMP login state,
workspace-specific model catalog, provider-qualified model IDs and thinking
capabilities. Selecting `anthropic/<model>` still starts OMP; it does not switch
the session to the separate Claude Code agent or its cc-switch configuration.
Choosing Default leaves model resolution to OMP. An explicit selection is kept
while discovery is loading and must be confirmed by the target workspace's
catalog before launch; an unavailable selection is not silently changed to auto.

Signing in and enabling a model are separate native operations. If Claude Pro
is authenticated but absent from the HAPI picker, compare the native catalog and
enabled scope on the same machine, OS account, profile and working directory:

```bash
omp models ls anthropic --json
omp config get enabledModels --json
omp config get enabledProviders --json
```

Use OMP's own model/config controls to include the intended provider, preserving
existing selections and defaults. Do not replace the entire enabled-model list
with a single provider or copy OAuth credentials into HAPI. Refresh the native
models in HAPI after signing in outside the web app or changing the native scope.
The refresh covers both machine discovery and current-session model queries.

## Native subscription usage

OMP already exposes machine-readable subscription reports:

```bash
omp usage --json --redact
```

The HAPI usage page defaults to OMP-native reports from one selected online
Runner. It calls the installed native CLI on page access or explicit refresh,
with single-flight requests and a short cache, not a second provider polling
service. The Hub endpoint `/api/subscription/omp/:machineId` remains admin-only
and rechecks credentials after the Runner responds. Credentials, raw provider
payloads, metadata and stderr are not sent to the browser; account references
are opaque. Report `fetchedAt`, not envelope generation time, controls freshness.
Expired reports/windows are hidden, real zero remains zero, and routing copies
of the same account's shared quota pool are not summed.

Built-in coverage includes Anthropic Claude Pro/Max, ChatGPT through
`openai-codex` OAuth, Google Antigravity, Devin and `zai` Coding Plan. Coverage
depends on the installed OMP and its extensions and credentials. No returned
report means no report for this query, not zero quota or proof of no subscription.
The current built-ins do not supply DeepSeek balance, arbitrary GPT proxy-pool
balances or every GLM billing product. The explicit External monitors source
retains those integrations and the formal stale-snapshot rules. Selecting native
reports does not stop or reconfigure an existing collector. Session token/cost
accounting below the quota panel is separate and remains unchanged.

### cx2cc proxy quotas

HAPI maintains a separate `hapi-cx2cc-usage.ts` OMP extension for configured cx2cc
providers. It registers only a native usage fetcher; existing model definitions,
API routing, credential references and other extensions remain unchanged.
The adapter reads the same configured origin's `/api/usage` with the resolved
provider key. It does not request `/api/accounts` or require account-pool access.

Native reports include the returned quota windows, reset times and credit
balance. Credits stay in credit units, not USD; missing values are not invented,
real zero remains zero and shared quotas are not summed. HAPI applies the same
freshness and identity-redaction boundary as for other OMP-native reports.
The external monitor source remains available for pool-wide views and providers
without native reports.

Updated Runners install the managed extension before on-demand quota queries and
session startup. Installing the extension alone also enables the next standalone
`omp usage --json --provider cx2cc-ecs` or HAPI native-usage query without restarting
existing Runner/Agent processes. A foreign file at the reserved extension path is
never overwritten.

From a HAPI source checkout, install it on the Runner's OMP profile with:

```bash
bun -e "import { ensureCx2ccUsageExtension } from './fork-features/omp-host-integration/cx2ccUsageExtension'; console.log(await ensureCx2ccUsageExtension())"
```


## Native remote protocol

Remote control starts OMP in native headless RPC mode (`omp --mode rpc`). The process exchanges typed JSONL commands, responses, and events with HAPI; OMP is not routed through ACP.

The native RPC path provides:

- text and image prompts, steer, follow-up, queued input cancellation, abort, and abort-and-prompt;
- provider-qualified model selection plus `off` / `auto` and model-supported thinking levels;
- native session resume, rename, clear, branch, local/remote handoff, and history continuity;
- tool, thinking, usage, retry, subagent, media, file, and extension UI events;
- host tools for `display_image`, `display_video`, and `send_file`;
- runner-scoped provider sign-in under **Settings → HAPI Extensions → Oh My Pi providers**, without copying credentials into chat.

### Durable input delivery and compatibility

Token-aware remote input requires native OMP advertising both
`get_state.capabilities.inputReceipts` and `capabilities.nativeOrder`; the version
string alone is not proof. Deploy this native build on each Runner host before
deploying the dependent HAPI CLI. HAPI forwards the original Hub message `localId`
as the generic native `clientToken`, and validates committed delivery identity,
timestamp and journal order before consumed acknowledgment.
Old native builds fail this input path explicitly instead of silently accepting
an ignored idempotency field.

On reconnect, HAPI resumes the original journal and initializes host tools and
subscriptions before invoking native `recover_inputs`. Recovery readiness does
not wait for a model generation. Journal admission keeps payload ownership in
native OMP but leaves the Hub message queued: only a committed native delivery
receipt with the original `sessionId`, conversation `entryId`, delivery timestamp
and journal ordinal emits a consumed acknowledgement. Display order follows the
native journal, not an acknowledgment's arrival time or a Runner's wall clock.
A previous assistant finishing, enqueue success, or equal text is never evidence
of delivery.

Native local/builtin handling and cancellation are durable non-invocation
outcomes. HAPI persists their complete receipts and sends separate terminal
resolutions, including on wrapper reconnect, without marking the message consumed.
Wrapper-owned session commands such as `/rename` persist their acknowledged
host handling separately; they resolve as handled, never as native user turns.
Cancelling an admitted native input uses exact `clientToken`, not a text match;
the asynchronous cancellation acknowledgement waits for native journal proof.
Not-found or unavailable cancellation remains unconfirmed, not executed.

HAPI does not replay admitted payloads. Legacy dispatched **or accepted** sidecars
without native proof remain quarantined rather than guessed or blindly retried.
Native journal payload ownership and receipt identity survive wrapper restart;
HAPI sidecars preserve identity and native evidence, not a replacement transcript.
This prevents duplicate native user invocation, not exactly-once tool effects.


### Attachments

Images are sent as native OMP image content. Other attachments, including PDFs,
text files, Office documents, and archives, are passed as local `@path` file
references so OMP can read them with its tools. Files are not discarded based on
their MIME type. Messages containing only file attachments are supported.

Files remain on the runner machine; their contents are read on demand rather
than embedded as binary prompt text. Extraction depends on OMP's support for the
file format. After upgrading HAPI, reopen an existing remote session to load the
updated attachment handling.

## Message formatting

OMP chat messages render `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` formulas
with KaTeX, including color, bold text, and subscripts. Single-dollar delimiters
must touch the formula and must not be followed by a digit at the closing end;
ordinary dollar amounts remain prose. Bare `<br>`, `<br/>`, and `<br />` tags
produce line breaks, including inside tables. Other raw HTML stays inert, and
code spans and fenced code blocks keep their literal contents.

## Model usage accounting

HAPI reads OMP's persisted native journals for the main session and recursively
owned subagents. Each assistant response and auxiliary `model_usage` entry is
counted once by its native session ID and entry ID, independently of RPC timeline
selection. Reported token usage from failed or aborted requests is included.
Provider-qualified actual model names are retained, including Devin models;
`upstreamModel` takes precedence when the native entry supplies it. Cache-read,
cache-write, input, and output counts remain separate.

After the complete initial primary subtree has been read, its native accounting
replaces legacy OMP chat/trace accounting for that HAPI session. Replay and cache
rebuilds do not duplicate requests. Older trace records without a response identity
cannot be deduplicated exactly; identical token counts are not evidence that two
requests are the same.

For OMP invoked inside Antigravity, HAPI installs a managed `hapi-usage.ts` global
OMP extension. It records the native journal path and inherited `HAPI_SESSION_ID`
in OMP's `hapi-usage-bindings` directory. Only exact bindings are followed; matching
a workspace, model, or time window is not sufficient. Antigravity's own generation
usage remains separate and is also read for native child conversations. The usage
page groups by model; native OMP accounting events retain agent and purpose metadata
but do not add a per-agent usage UI.

Accounting requires persisted usage and model metadata. Calls not written by the
native agent cannot be reconstructed. External OMP processes started with extension
discovery disabled, without `HAPI_SESSION_ID`, or before the managed extension was
installed have no automatic binding. Existing HAPI session processes keep their
old accounting code until resumed with the upgraded CLI. OMP journal timestamps
are preserved; Antigravity generation-only records without a transcript timestamp
use their discovery time. New sessions and resumes use the new accounting path.

The global extension lifecycle was verified with OMP **18.16.0**.

## RPC event timeline allowlist

Choose which OMP events produce persisted chat messages, status rows, and cards
in HAPI. This is a CLI/runner-host setting, not an OMP-native setting or a Web
settings control. In `$HAPI_HOME/settings.json` (default `~/.hapi/settings.json`),
edit only `ompEventAllowlist`, preserving the other settings:

```json
{
  "ompEventAllowlist": ["message_end", "notice", "todo_reminder"]
}
```

An environment variable takes precedence over the file:

```bash
HAPI_OMP_EVENT_ALLOWLIST_JSON='["message_end","notice"]' hapi omp --hapi-starting-mode remote
```

Precedence is environment variable, then file field, then the defaults below.
Each configured array **completely replaces** the defaults; it is not merged.
Every event in the 43-name catalog below can be selected, including state-only
events that otherwise have no timeline projection. Selecting those events adds
an identifiable event record; existing message and card projections retain their
formats.

`[]` is valid and suppresses all RPC-event-derived timeline output, including
tool/subagent replay and host result presentation. It does not remove user input
records or historical messages, disable tool execution, interrupt session/config
or command-catalog synchronization, or suppress required interactive requests and
responses. Unknown future events remain diagnostic-only, not warning chat rows.

Configuration is read on the next remote launcher start: a new remote session or
re-entry into remote mode. Already-running sessions do not hot-reload it. Invalid
JSON, a non-object settings file, a non-array allowlist, non-string entries,
unknown names, duplicate names, and unreadable settings files fail explicitly
instead of silently restoring defaults. Missing files or an absent field use
defaults. A supplied environment variable replaces the file without reading it;
an empty environment string is invalid JSON, not an instruction to use defaults.

### Default selection

The complete low-noise default is:

```json
[
  "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "auto_compaction_start", "auto_compaction_end",
  "auto_retry_start", "auto_retry_end",
  "retry_fallback_applied", "retry_fallback_succeeded",
  "notice", "command_output", "extension_error", "rpc_frame_error",
  "subagent_lifecycle", "subagent_progress", "subagent_event",
  "host_tool_call", "host_uri_request"
]
```

Lifecycle, incremental assistant stream events, `tool_stream_update`, state/config
and advisor invalidations, cancellations, and other bookkeeping are off by
default. Add their exact names to your replacement array to expose them.

`extension_ui_request` is also opt-in as one complete 11-method family. Native
title updates can carry rapidly changing spinner/status text, so its optional
titles, widgets, status rows, and notifications are hidden by default. Required
input and permission controls still work when this event is excluded. Add
`extension_ui_request` to the replacement array to show its optional output;
individual methods are not separate selectors.

### Complete top-level catalog

Baseline: OMP **18.1.10**, cross-checked against both installed source unions and
stdout producers. Paths below are relative to the named `@oh-my-pi` package.
`RpcOutput` admits an open `object`, so its declaration alone is not an exhaustive
catalog.

| Source | Logical events |
| --- | --- |
| `pi-agent-core/src/types.ts`, `AgentEvent` (11); forwarded by `pi-coding-agent/src/modes/rpc/rpc-mode.ts` session subscription | `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_stream_update`, `tool_execution_end` |
| `pi-coding-agent/src/session/agent-session-events.ts`, session additions (17); same session subscription | `auto_compaction_start`, `auto_compaction_end`, `auto_retry_start`, `auto_retry_end`, `retry_fallback_applied`, `retry_fallback_succeeded`, `model_changed`, `config_warnings_changed`, `advisor_cost_changed`, `advisor_yielded`, `ttsr_triggered`, `todo_reminder`, `todo_auto_clear`, `irc_message`, `notice`, `thinking_level_changed`, `goal_updated` |
| `pi-coding-agent/src/modes/rpc/rpc-types.ts`, subagent envelopes (3); emitted through `rpc-subagents.ts` | `subagent_lifecycle`, `subagent_progress`, `subagent_event` |
| `pi-coding-agent/src/modes/rpc/rpc-types.ts`, extension/host requests (5) | `extension_ui_request`, `host_tool_call`, `host_tool_cancel`, `host_uri_request`, `host_uri_cancel` |
| `pi-coding-agent/src/modes/rpc/rpc-types.ts` and `rpc-mode.ts`, additional stdout producers (6) | `available_commands_update`, `prompt_result`, `command_output`, `session_info_update`, `config_update`, `extension_error` |
| `pi-coding-agent/src/modes/rpc/rpc-frame.ts`, framing error producer (1) | `rpc_frame_error` |

### Nested variants and control frames

Configuration always selects a **top-level** name. These nested variants are not
additional allowlist names, and there is no nested selector syntax:

- `message_update.assistantMessageEvent.type` owns 13 variants from
  `pi-ai/src/types.ts` (`AssistantMessageEvent`): `start`, `text_start`,
  `text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`,
  `image_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, `done`, `error`.
- `extension_ui_request.method` owns 11 methods from
  `pi-coding-agent/src/modes/rpc/rpc-types.ts`: `select`, `confirm`, `input`,
  `editor`, `cancel`, `notify`, `setStatus`, `setWidget`, `setTitle`,
  `set_editor_text`, `open_url`. Required bidirectional UI continues even when
  its optional timeline presentation is excluded.
- `subagent_event.payload.event.type` owns all 28 `AgentSessionEvent` variants:
  the 11 core events and 17 session additions in the first two catalog rows.
  This ownership comes from `pi-coding-agent/src/task/types.ts`; nested child
  output is selected by `subagent_event`, not by a second child-event allowlist.
  Snapshot lifecycle, snapshot progress, and transcript replay follow
  `subagent_lifecycle`, `subagent_progress`, and `subagent_event`, respectively.
  Selected progress or child traces may reconstruct their required card header
  even when lifecycle presentation is disabled.

`ready`, `response`, and `rpc_chunk` are transport/control frames, not selectable
logical events. `extension_ui_response`, `host_tool_update`, `host_tool_result`,
and `host_uri_result` travel **to** OMP and are likewise not output-event names.
The presentation policy never filters handshake, command responses, or framing.

## Permission labels

OMP 17.0.4 RPC does not expose a tool-permission or plan-mode protocol. HAPI therefore shows only `default` and `yolo` labels for OMP and starts both local and remote OMP processes with native Yolo execution. OMP tool calls do not create HAPI approval prompts.

Use OMP only in a workspace where direct tool execution is acceptable.

## Web controls

Provider sign-in is a runner setting, not a session action. Session chats never display sign-in controls. After a provider authenticates, the **New Session** model selector refreshes from OMP and lists that provider's qualified model IDs.

In a remote OMP session, the composer exposes the native model and thinking selectors plus the OMP permission label. The chat and session menus also provide queued-message cancellation, current-turn abort, per-message rewind/fork, archive/kill, media and file cards, subagent timelines, and local/remote switching.

The model and thinking values shown after reconnect come from the resumed native session. Subscription quotas are queried independently through the native usage command described above; they are not inferred from retry/fallback events in the chat timeline.

## Claude-only configuration

OMP 17.0.4 RPC has no equivalent mutation for these Claude configuration fields:

- fallback model selection before a turn;
- custom system prompt;
- appended system prompt;
- allowed/disallowed built-in tool filters.

HAPI identifies these fields as Claude-only instead of converting them into prompt text or host-tool registration.

## Event-driven Beta timeline

The optional `/beta/` UI reads a separate authenticated runtime stream from
`GET /api/sessions/:id/runtime/events`; `GET /api/sessions/:id/runtime`
returns the current snapshot and producer connectivity. These routes use
the same account, machine, directory and session grants as the existing API,
and revalidate credentials and grants during streaming. They do not send
high-frequency runtime frames to the legacy `/api/events` stream.

An upgraded CLI publishes one launch epoch with monotonically sequenced
entity changes. Reconnect starts with an authoritative snapshot. Text,
thinking and tool progress update only the corresponding Beta row; native
run completion flushes the pending tail before publishing terminal state.
`stop`, `length`, `toolUse`, `error` and `aborted` are preserved on durable
assistant envelopes. `toolUse` ends a message, not an agent run. Network
disconnection is not treated as successful completion or cancellation.

Canonical message UUIDs connect live rows to their durable history records;
the UI does not match responses by text or wall-clock proximity. Beta history
requests complete invoked-user turns, rather than fixed message-row pages.
An ordinary page returns fewer complete turns when their aggregate size reaches
the safety limit. A single turn exceeding 2,000 raw records is explicitly split
into continuations carrying the original user-turn ID and missing-side flags.
Queued and terminal non-invoked inputs do not create execution boundaries.

The viewport retains at most 8,000 execution rows and mounts only visible rows
and interaction pins. Whole-turn sharing independently collects the selected
turn through the authenticated API, including segments outside this viewport
window. Its cursor is fenced to a captured snapshot; cancellation or an incomplete
collection is an explicit failure, never a silently truncated image. These
coverage flags do not assert that a still-running model has finished its turn.

Runtime recovery state is bounded to 2,000 items and 3 MiB, with a 4 MiB
publication limit. Whole older entities are evicted with explicit changes;
canonical history is not removed. An individual oversized live preview is
explicitly marked deferred, and its complete canonical result is still
stored and rendered through history. The Hub also bounds aggregate runtime
state and subscriber queues; a slow or interrupted stream reconnects through
a fresh snapshot rather than accumulating an unbounded backlog.

The Beta keeps the existing composer, scheduling, queue controls, models,
thinking selectors, provider setup, attachments, file/media services, voice
controls and business pages. Its live runtime channel is independent of the
legacy timeline presentation allowlist. A pre-upgrade CLI is labeled
history-compatible instead of displaying a fabricated live connection.
