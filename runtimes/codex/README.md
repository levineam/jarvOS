# jarvOS — Codex Runtime

This adapter connects local Codex CLI and Codex app sessions to jarvOS through
the shared `@jarvos/agent-context` MCP server and a Codex `SessionStart` hook.

## Setup

From the jarvOS repo root:

```bash
./runtimes/codex/setup.sh
```

The script registers a local stdio MCP server named `jarvos`, enables a Codex
`SessionStart` hook in `~/.codex/config.toml`, backs up the config before any
write, and persists the hook's current trusted hash through Codex's app-server
config path so the hook is runnable in Codex app Local sessions.

On a public or minimal install with no private host configured, that command is
enough: setup registers the shared MCP server without control-plane host
bindings. `jarvos_control_plane` remains declared on the tool surface; live
authenticated host operations require the optional bindings below.

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

The repo also includes an equivalent hook manifest template for review/reference:

```text
runtimes/codex/hooks.json
```

It runs `runtimes/codex/jarvos-session-start-hook.js`, which emits
`hookSpecificOutput.additionalContext` for `SessionStart`. Hook failures are
logged to `~/.codex/jarvos-hydration.log` and fail open with an empty hook
result so Codex startup is not blocked.

## Available Tools

- `jarvos_current_work` — current Paperclip work summary.
- `jarvos_recall` — GBrain/QMD/graph recall.
- `jarvos_create_note` — Obsidian note creation, journal wikilink, and verification.
- `jarvos_startup_brief` — bounded startup context for future Codex hooks/wrappers.
- `jarvos_hydrate` — bounded Codex startup packet with Paperclip current work,
  today's journal, linked notes, the jarvOS ontology context packet, redaction, and a
  hydration report.
- `jarvos_control_plane` — authenticated request, inspection, evidence, and
  approval access through the installed host application service. Requires
  `JARVOS_CONTROL_PLANE_SERVICE_MODULE` (and a credential binding) on the MCP
  process; without those host bindings the tool is present but not ready for
  live host operations.

## Hydration Scope

Default budget is 12,000 characters, configurable with
`JARVOS_HYDRATION_MAX_CHARS`. The packet includes:

- Paperclip issues in `in_progress` and PR-backed `in_review`.
- Today's journal entry.
- Notes wikilinked from today's journal entry.
- A compact `@jarvos/ontology` provider packet for hierarchy-of-meaning context.
- A report with sources, omissions, budget use, stale/missing data, and handles.

The standalone `jarvos_current_work` tool keeps its broader default status
filter of `in_progress`, `todo`, and `blocked`; hydration narrows the execution
packet to active work plus review-backed PRs.

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
