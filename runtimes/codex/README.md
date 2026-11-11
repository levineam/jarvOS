# jarvOS — Codex Runtime

This adapter connects local Codex CLI and Codex app sessions to jarvOS through
the shared `@jarvos/agent-context` MCP server and a Codex `SessionStart` hook.

## Optional native GBrain plugin

The [native plugin integration](gbrain-plugin.md) provides explicit install,
doctor, update and removal using a compatible Codex executable. It preserves
managed launch authority and documents binding an existing descriptor-managed
brain through the upstream launcher. Choose one connection owner: the native
plugin or the manual provider below. Registration does not prove live tools.

## Private GBrain continuity

Portable setup keeps GBrain optional. A private continuity profile registers a
second MCP server named `gbrain` through
`modules/jarvos-gbrain/scripts/jarvos-gbrain-provider.js`, with
`JARVOS_GBRAIN_RUNTIME_DESCRIPTOR` pointing at the same owner-only descriptor
used by Hermes and OpenClaw. The launcher revalidates the pinned GBrain source
and Bun interpreter before handing stdio directly to GBrain. It does not proxy
tools or persist database credentials in Codex configuration.

Codex discovers Skillify through GBrain's `list_skills` and `get_skill` tools.
Do not copy Skillify into `~/.codex/skills`: that would bypass GBrain's resolver
and sever update provenance. Registration presence is only configuration
evidence; continuity requires a native recall turn plus Skillify discovery
against the shared runtime/brain/store tuple.

Register and inspect the provider with Codex's native stdio surface:

```bash
codex mcp add gbrain \
  --env JARVOS_GBRAIN_RUNTIME_DESCRIPTOR=<owner-only-descriptor> \
  -- node <provider-launcher>
codex mcp get gbrain
```

## Compound Engineering provider

`compound-engineering-capability.json` declares the approved Compound Engineering
source revision. The runtime manifest also declares the managed provider, its
`CODEX_HOME` profile boundary, and the checked-in
`compound-engineering-conformance.json` evidence. A disposable authenticated
profile proved the immutable marketplace install, fresh-process discovery,
bounded `plan` and `work` receipts, capability isolation, and exact-owned-state
rollback.

An installed plugin is healthy only when it matches the approved pin and the
reviewed conformance receipt. Doctor reports the discovered version and health;
ordinary jarvOS `plan`, `work`, and `complete` requests use the CE route when
healthy and the native fallback in the same durable work run when absent,
modified, disabled, or otherwise unavailable.

Discovery commands are read-only. `codex plugin marketplace add` and
`codex plugin add` are the exact pinned activation commands; they are scoped to
the selected `CODEX_HOME`, and rollback removes only the provider marketplace
and plugin state owned by jarvOS. Capability discovery and doctor never mutate a
profile.

The durable evidence contract is:

- approved pin: `3.21.4` at the reviewed immutable revision and digest
- observed installation: Codex `0.146.0`, marketplace and plugin version found
- invocation: strict `plan` and `work` receipts validated against the jarvOS
  provider contract
- denied capabilities: credentials, network, profile state, and privileged
  tools are not available to the provider operation
- recovery: continue through native jarvOS coding whenever the provider is not
  healthy; rerun doctor after profile repair or an approved update

## Setup

From the jarvOS repo root:

```bash
./runtimes/codex/setup.sh
```

The script registers a local stdio MCP server named `jarvos`, enables a Codex
`SessionStart` hook in `~/.codex/config.toml` for both fresh and resumed
sessions, backs up the config before any
write, and persists the hook's current trusted hash through Codex's app-server
config path so the hook is runnable in Codex app Local sessions.

On a public or minimal install with no private host configured, that command is
enough: setup registers the shared MCP server without control-plane host
bindings. `jarvos_control_plane` remains declared on the tool surface; live
authenticated host operations require the optional bindings below.

### Managed Compound Engineering activation

The setup script preserves an existing Codex profile unless activation is
explicitly requested. A new managed coding profile enables the reviewed pin by
running:

```bash
JARVOS_CODEX_PROVIDER_MODE=new-managed ./runtimes/codex/setup.sh
```

An existing profile can opt in with `JARVOS_CODEX_PROVIDER_MODE=opt-in`. The
activation path reads the shipped capability and conformance records, applies
only their exact pinned marketplace/plugin argv, verifies the fresh profile
state, and records the provider-owned additions under the selected
`CODEX_HOME`. It refuses to replace a stale, disabled, locally changed, or
unverifiable installation. `existing` (the default) and `disabled` modes leave
the profile untouched and jarvOS uses native fallback when CE is unavailable.

To remove only additions made by jarvOS, use the same profile and explicit
rollback flag:

```bash
JARVOS_MANAGED_HARNESS_ROLLBACK=1 ./runtimes/codex/setup.sh
```

Rollback preserves the marketplace when another plugin now uses it and refuses
to remove provider state that changed after jarvOS installed it. Restart Codex
after activation or rollback before relying on the new profile state.

### Optional authenticated control-plane host

Private installs that supply an authenticated host service and credential file
can pass both together. Setup verifies the pair, then registers two non-secret
environment bindings for the stdio MCP process:

```bash
# Credential file must be absolute, owner-only (mode 0600/0400), and under a
# trusted non-writable ancestry (same fail-closed bar as CLI/MCP).
# Setup registers the *path* only — never the secret value.
umask 077
printf '%s' "$HOST_CREDENTIAL" > /absolute/path/to/control-plane.credential
chmod 600 /absolute/path/to/control-plane.credential

JARVOS_CONTROL_PLANE_SERVICE_MODULE=/absolute/path/to/authenticated-host-service.js \
JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=/absolute/path/to/control-plane.credential \
  ./runtimes/codex/setup.sh
```

- `JARVOS_CONTROL_PLANE_SERVICE_MODULE` — absolute path of the host service module
- `JARVOS_CONTROL_PLANE_CREDENTIAL_FILE` — absolute path of the owner-only credential file

If either variable is set, both must be present, absolute, and usable. Relative
paths are rejected. Setup never puts the credential value on `codex mcp add`
argv and never persists it in `~/.codex/config.toml`. The MCP server (and human
CLI `--credential-file`) read the credential file at runtime with the same
strict permission, ownership, and ancestry checks and fail closed if the binding
is missing, empty, world-readable, untrusted, or under an unsafe writable
parent. Errors never echo the path or secret. Ambient
`JARVOS_CONTROL_PLANE_CREDENTIAL` remains valid for non-persisted host sessions
(for example tests), but setup must not register that variable. The host service
enforces authorization.

### Optional shared-skills owner binding

To resolve shared-skill decisions without enabling the broader control plane,
provide only a dedicated owner credential file:

```bash
JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE=/absolute/path/to/shared-skills.credential \
  ./runtimes/codex/setup.sh
```

The file uses the same owner-only and trusted-ancestry checks above. Setup
registers its path, not its value, and configures `jarvos_shared_skills` for
explicit Codex approval on every call. Without this binding, owner operations
use an existing control-plane credential binding if present, and otherwise fail
closed. Owner-bound setup requires `CODEX_CONFIG` to be the same
`$CODEX_HOME/config.toml` that `codex mcp add` updates.

Optional Todo work-action host bindings follow the same optional `--env`
pattern and are never required for setup to succeed:

```bash
JARVOS_WORK_ACTION_SERVICE_MODULE=/absolute/path/in/workspace/work-action-host-service.js \
JARVOS_PROJECTS_CONTEXT_CONFIG=/absolute/path/to/jarvos-project-context.json \
  ./runtimes/codex/setup.sh
```

Copy `examples/work-action-host-service.js` into the Projects `workspaceRoot`
as an owner-only file. The MCP server refuses any module outside that root.

The repo also includes an equivalent hook manifest template for review/reference:

```text
runtimes/codex/hooks.json
```

It runs `runtimes/codex/jarvos-session-start-hook.js`, which emits
`hookSpecificOutput.additionalContext` for `SessionStart`. Hook failures are
logged to `~/.codex/jarvos-hydration.log` and fail open with an empty hook
result so Codex startup is not blocked.

When managed stewardship supplies both
`JARVOS_STEWARDSHIP_BRIDGE_COMMAND` and
`JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT`, setup persists those
session-neutral inputs in
Codex's shell environment policy. This lets the session hook display a
validated, bounded pending judgment and lets the in-session agent run the
listed bridge answer command without locating private runtime state. The
private bridge resolves its context by the current `CODEX_THREAD_ID`; setup
never persists a session-specific context path. Setup does not print either
value, and rollback removes only these two entries.

## Available Tools

- `jarvos_current_work` — diagnostic compatibility-only Paperclip work summary.
- `jarvos_recall` — GBrain/QMD/graph recall.
- `jarvos_capture` — save requested Ideas, Journal entries, or linked notes with declared provenance.
- `jarvos_create_note` (deprecated; use jarvos_capture with kind note).
- `jarvos_startup_brief` — bounded startup context for future Codex hooks/wrappers.
- `jarvos_hydrate` — bounded Codex startup packet with a host-issued Projects
  orientation packet (or explicit unavailable/partial state), today's journal,
  linked notes, the jarvOS ontology context packet, redaction, and a hydration report.
- `jarvos_todo_*` — claim-based Beads Todo tools through the host work-action
  service. Requires `JARVOS_WORK_ACTION_SERVICE_MODULE` and
  `JARVOS_PROJECTS_CONTEXT_CONFIG` on the MCP process; without those host
  bindings the tools are present but unavailable.
- `jarvos_control_plane` — authenticated request, inspection, evidence, and
  approval access through the installed host application service. Requires
  `JARVOS_CONTROL_PLANE_SERVICE_MODULE` (and a credential binding) on the MCP
  process; without those host bindings the tool is present but not ready for
  live host operations.

## Hydration Scope

Default budget is 12,000 characters, configurable with
`JARVOS_HYDRATION_MAX_CHARS`. The packet includes:

- A bounded host-issued Projects `orientation` packet, or an explicit
  unavailable/partial Projects result without raw task-board fallback.
- Today's journal entry.
- Notes wikilinked from today's journal entry.
- A compact `@jarvos/ontology` provider packet for hierarchy-of-meaning context.
- A report with sources, omissions, budget use, stale/missing data, and handles.

The standalone `jarvos_current_work` tool keeps its broader default status
filter of `in_progress`, `todo`, and `blocked`, but is diagnostic compatibility
only and never supplies startup project orientation.

## Operating Rule

Codex should treat jarvOS as the source of truth for memory and capture
semantics. Do not reimplement note writing or memory persistence in Codex
instructions; call the jarvOS tools.

## Ontology Context Rule

Codex should load ontology through `jarvos_hydrate` or the shared
`@jarvos/ontology` provider. The ontology packet is hierarchy-of-meaning
context, not task state and not raw memory. Codex must not directly mutate
ontology source files or rewrite `ONTOLOGY.md`; secondbrain evidence can only
create source-backed ontology candidates or inquiry items for review.

## Capture

Save requested Ideas, Journal entries and notes with `jarvos_capture` (or `jarvos capture` when no jarvOS tool is available). Follow the single [capture guideline](../../modules/jarvos-instruction-projection/content/capture-guideline.md); provenance and safety are handled inside the tool.

The Codex adapter writes no instruction file; the guideline arrives through `jarvos_capture`’s description and the session-start packet.

Native stewardship hooks require `JARVOS_STEWARDSHIP_BRIDGE_COMMAND` to name a
canonical absolute executable with trusted ownership, safe ancestor permissions
and no symlinks. They use system Git and constrain bridge helper/interpreter PATH
to `/usr/bin:/bin`; bridge scripts must bind any other interpreter explicitly.
Claude setup still accepts a bounded command name plus an approved bridge bin,
then persists the resulting absolute identity. Session environment persistence
does not extend PATH. Unconfigured or unsafe commands remain unavailable without
probing workspace commands. Platforms without POSIX ownership verification fail
closed. Protected selected-runtime adoption remains a separate operation.

## Assignment context across compaction

This source route preserves an attributed peer assignment through automatic or
manual root-session compaction. It is opt-in: the existing setup owner supplies
`JARVOS_CODEX_NATIVE_COMMAND`, a trusted absolute path to the qualified native
Codex executable, rather than a managed launcher wrapper. Managed setup also
requires the selected dispatcher's `assignmentContinuity` capability receipt.
An older dispatcher does not qualify merely because it advertises a generic
pre-compaction action. No installed configuration is changed by source tests.

PreCompact supplies the exact native session and turn identities. The reader uses
only `initialize`, `thread/turns/list` and `thread/items/list`; it never starts or
resumes a thread, reads raw transcripts, calls a model or executes a task. The
reader searches at most eight pages of 25 metadata records for the supplied turn
identity, with item bodies excluded. Only that exact turn's items are requested;
absence or invalid metadata fails closed. Stored status is never interpreted as
live ownership, cancellation or goal completion. The native
original start accompanies the unchanged assignment constraints and deadlines.

A derived profile-local projection uses an owner-only directory and mode-0600
files, a source/selected-owner generation, a separate invalidation fence and a
one-use pending capture. Every new capture invalidates its predecessor before
reading input. Captures expire after 120 seconds. The reader has a 2.5-second
deadline, eight item pages of 100 records, 32 MiB total transport and 256 KiB retained projection;
delivered context is bounded to 64 KiB. Native item listing supports exact
turn filtering but no field projection. Streaming parsing therefore discards
irrelevant bodies before retaining a frame, bounds candidate fields, nesting and
token count, and fingerprints each complete original item. Native effect receipts
label that fingerprint `sourceWireDigest`; it is not a canonical object hash.
Attributed input bodies remain intact or fail closed. Oversize or unavailable evidence is visible degradation, not silent
truncation or a renewed budget. Setup disables hook context previewing only for
the opted-in handler, whose own context limit remains enforced.

SessionStart with source `compact` consumes only a fresh matching capture and
rereads that exact turn for late input. It does not call ordinary start/resume,
SessionWait binding, Projects refresh, journal or hydration operations. Original
peer deliveries and native user-input records retain their attribution; native
user-role text is not itself proof of human authorization. Recent assistant
checkpoints are context, and effect IDs/statuses/digests are receipts to reconcile,
never an action replay plan. Cancellation, supersession, completed work and
ambiguous effects must be reconciled under the original authority before acting.
The hook contains no semantic task classifier, controller, scheduler or Stop loop.

Focused tests exercise both stale-question shapes through the owning hooks,
late peer/human changes, capture invalidation, repeat compaction, provenance,
resource bounds, corrupt state, setup coexistence and rollback. They prove source
and input behavior only. The installation owner still must verify the selected
runtime, native immediate post-compaction delivery, and a correct current-task
final or genuine stop in a separately bounded synthetic live test. They must not
promote these fixture results into real continuation proof.

Rollback uses the existing setup rollback transaction to remove only the owned
PreCompact/start/turn entries and native-reader binding. Profile-local derived
captures are not a canonical work ledger; they cannot grant execution authority.

## Canonical Plan task continuity

The project files remain the progress authority. An eligible Codex session can
explicitly select one current Plan task using `plan-task-continuity.js`; the
startup/resume, compact and turn hooks then reread that task, its owner, inputs and next
action. Task changes are noticed even when the project stays active.

The CLI uses JSON on stdin and the host's `JARVOS_PROJECTS_DIR` and
`CODEX_THREAD_ID`. `read` returns the current selection and `stateRevision`.
`select` accepts `project` (the canonical project ID), `task` (the exact Plan
checkbox text), and the returned `expectedState`; an optional `expectedRevision`
checks the current project bytes. A first selection expects `"none"`.

This exact-text selector is a guarded lookup, not a permanent task ID. Renamed,
removed or duplicated tasks require deliberate reconciliation. The reader never
chooses the first open checkbox or claims a task. A task's `Owner:` detail must
identify one retained session unambiguously; a missing/other owner, unavailable
input, uncommitted file or stale selection is explicit. All project content is
data, never execution authority. Read the actual inputs before continuing.
Task lookup validates the complete canonical file up to 1 MiB, with the same
guarded file identity/parser and full-source revision check, so long project
history cannot hide a task or duplicate behind the display projection. The
40,000-character project display and selected-context budgets are unchanged;
oversize, unsafe or concurrently changed source requires reconciliation.

Writeback stays with the authorized local file edit and scoped Git commit under
the project's README. After meaningful progress, call `checkpoint` with the same
`project`, `task`, current `expectedState` and freshly read `expectedRevision`.
It verifies that this session still owns the selected task and that its current
file is committed and read back before advancing the pointer. Failed commits,
stale revisions and unrelated staged files never become successful writeback.
The command does not edit project files, approve effects or transfer ownership.

Pointers reuse `jarvos-session-state/v1` and its file store, one private file per
Codex session under the XDG state directory's `jarvos/session-state/codex`.
They retain only the existing authority/item/operation/revision and artifact
pointer shape; they are not a second progress store. An existing work handoff
still requires workspace, HEAD, dirty-state and authority resolution.

For a profile whose managed runtime is pinned, the CLI's `hook` action can be
registered alongside existing `SessionStart` (`startup|resume|compact`) and
`UserPromptSubmit` commands. It consumes the native event/session input and emits
only the selected-task context. Preserve existing dispatchers, configuration and
trust boundaries; use a reviewed, versioned local installation and the supported
hook trust path. Rollback removes only these owned additions and retains newer
profile edits and saved pointers. This requires no selected-package mutation,
service, AgentMail operation or provider call. On compact, the full hook adds the
selected task beside the existing assignment-continuity output, preserving its
receipts or unavailable warning without ordinary startup/hydration operations.
If the combined compact block exceeds 64 KiB, preserve the original assignment
context intact and report the explicit task-read fallback; never truncate data.
Unselected sessions gain no task or authority. Compacted or externally launched
sessions without the qualified hook remain unqualified until the explicit read
fallback is used; hook output alone is not proof of model consumption.
