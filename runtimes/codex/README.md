# jarvOS — Codex Runtime

This adapter connects local Codex CLI and Codex app sessions to jarvOS through
the shared `@jarvos/agent-context` MCP server and a Codex `SessionStart` hook.

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
- `jarvos_create_note` — Obsidian note creation, journal wikilink, and verification.
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

## Secondbrain Capture Rule

For intentional capture requests such as `note:`, `make a note`, `idea:`, or
`save this`, Codex should call the jarvOS universal capture entrypoint instead
of raw-writing Markdown:

```bash
node modules/jarvos-secondbrain/scripts/jarvos-capture.js
```

The capture event source is `codex`. Successful note captures must end up under
the configured `Notes/` directory, link exactly once from
`Journal/YYYY-MM-DD.md`, record source-backed provenance, and leave QMD/search
freshness as `pending-refresh`. Codex must not create guessed daily journal
files under `Notes/`.
