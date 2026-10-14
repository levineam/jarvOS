# jarvOS — Claude Code Runtime

This adapter focuses jarvOS on Claude Code through the shared
`@jarvos/agent-context` MCP server, bounded startup hydration, and the
`CLAUDE.md` behavioral baseline. Claude Desktop MCP compatibility is documented
below, but it is not part of the current AI-coding-tool determinism target.

## Setup

From the jarvOS repo root:

```bash
./runtimes/claude/setup.sh
```

The setup script:

- registers a user-scoped Claude Code MCP server named `jarvos`
- installs Claude Code `SessionStart` and `PreCompact` hooks in `~/.claude/settings.json`
- materializes `~/.claude/CLAUDE.md` from
  `runtimes/claude/templates/CLAUDE.md.template` (see
  [Claude Code CLAUDE.md bootstrap](#claude-code-claudemd-bootstrap) below)
- optionally adds the same MCP server to Claude Desktop's local MCP config on
  macOS for manual compatibility
- backs up existing config files before writing changes

Claude Code MCP registration uses:

```bash
claude mcp add --scope user jarvos -- node "$PWD/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
```

Optional Todo work-action host bindings are passed through when set, and never
required for setup to succeed:

```bash
JARVOS_WORK_ACTION_SERVICE_MODULE=/absolute/path/in/workspace/work-action-host-service.js \
JARVOS_PROJECTS_CONTEXT_CONFIG=/absolute/path/to/jarvos-project-context.json \
  ./runtimes/claude/setup.sh
```

Copy `examples/work-action-host-service.js` into the Projects `workspaceRoot`
as an owner-only file. The MCP server refuses any module outside that root.
Leave both variables unset on a public/minimal install.

## Claude Code Hydration

Target: `claude-code`.

Claude Code supports `SessionStart` hook `additionalContext`, so the adapter
uses `runtimes/claude/jarvos-session-start-hook.js` to emit the same jarvOS
Working Context Packet used by Codex. The hook matcher is `startup|resume|compact`
so a compaction or resume re-orients the session instead of dropping jarvOS
context. Compact and resume use a 4,000 character packet because the session
already carries a summary of its own history; startup keeps the 9,500 character
default. Both budgets are capped by `JARVOS_CLAUDE_HYDRATION_MAX_CHARS` when
set. Claude Code caps hook-injected context at 10,000 characters.

Before compaction, `runtimes/claude/jarvos-precompact-hook.js` appends a
mechanical session-thread checkpoint (cwd, git HEAD, dirty-path count, trigger).
It does not persist compaction summaries or other prompt-derived content.
PreCompact cannot inject `additionalContext`; re-orientation happens on the
following `SessionStart` with `source: compact`.

Hook failures are logged to `~/.claude/jarvos-hydration.log` and fail open with
an empty hook result so Claude startup and compaction are not blocked.

When the optional stewardship bridge is enabled by the managed launcher, Claude
hooks resolve a pending judgment from the hook's `session_id` and an owner-only,
hashed session map. The durable Claude hook environment retains only the bridge
command and a neutral map root—never the private context-file path.

## Claude Code CLAUDE.md bootstrap

Claude Code loads `~/.claude/CLAUDE.md` into every session as the user-scope
behavioral baseline. The setup script materializes that file from
`runtimes/claude/templates/CLAUDE.md.template`, which provides:

- jarvOS identity and governance pointers
- Runtime applicability table for `CRITICAL-RULES.md` (which CRs are
  OpenClaw-only and which apply to Claude Code)
- **jarvOS Release Targeting** — version policy (v0.1.x vs v0.2.0), prompt
  prefix convention, branch/label/CHANGELOG/PR-title routing, ambiguity rule
- **jarvOS Upstream Evaluation (Proactive)** — when and how to evaluate
  workspace changes as candidates for the public jarvOS repo, and how to
  surface candidates without acting unilaterally
- Working Context Hydration notes (lists the `jarvos_*` MCP tools)

### Idempotency and local extensions

The template ends with a `<!-- LOCAL-EXTENSIONS-BELOW -->` marker. Anything
you add to `~/.claude/CLAUDE.md` below that marker is preserved across
re-runs of `setup.sh`. Re-running setup is idempotent: if the resulting
content matches the existing file, no write happens; if it differs, the
existing file is backed up to `~/.claude/CLAUDE.md.bak-jarvos-<timestamp>`
before the new content is written.

If you already have a `~/.claude/CLAUDE.md` from normal Claude Code use
(no jarvOS marker), the first setup run adopts your existing content as
local extensions: the new file starts with the jarvOS template, then
includes an "adopted" notice followed by your prior content below the
`<!-- LOCAL-EXTENSIONS-BELOW -->` marker. Your prior Claude Code
instructions stay active. Review and trim as needed after setup.

To skip CLAUDE.md materialization (e.g., on shared workstations where
`~/.claude/CLAUDE.md` is managed by another tool):

```bash
JARVOS_SKIP_CLAUDE_MD=1 ./runtimes/claude/setup.sh
```

To target a custom path:

```bash
CLAUDE_MD_PATH=/custom/path/CLAUDE.md ./runtimes/claude/setup.sh
```

## Claude Desktop

Target: `claude-desktop`.

Claude Desktop uses local MCP server configuration. This v1 adapter configures
`mcpServers.jarvos` in:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Claude Desktop startup hydration is manual/unsupported in v1 because this pass
does not verify an official Desktop startup additional-context hook. Use the
`jarvos_hydrate` MCP tool manually when a Desktop session needs the current
working-context packet.

### Boot jarvOS in Claude Desktop

For a new Claude Desktop chat, use this short starter phrase:

```text
boot jarvOS
```

Claude should route that request to the `jarvos_hydrate` MCP tool with a bounded
Desktop budget, then confirm the Working Context Packet and Hydration Report
were loaded. The jarvOS MCP server also exposes a `boot_jarvos` prompt with the
same instructions for clients that surface MCP prompts directly.

This is still manual hydration. It makes one-step Desktop boot reliable, but it
does not imply automatic startup context injection for Claude Desktop.

## Available Tools

- `jarvos_current_work` — diagnostic compatibility-only Paperclip work summary.
- `jarvos_recall` — GBrain/QMD/graph recall.
- `jarvos_create_note` — Obsidian note creation, journal wikilink, and verification.
- `jarvos_startup_brief` — bounded startup context.
- `jarvos_hydrate` — bounded working-context packet with a host-issued Projects
  orientation packet (or explicit unavailable/partial state), today's journal,
  linked notes, jarvOS ontology spine, redaction, and a hydration report.
- `jarvos_todo_*` — claim-based Beads Todo tools through the host work-action
  service. Requires `JARVOS_WORK_ACTION_SERVICE_MODULE` and
  `JARVOS_PROJECTS_CONTEXT_CONFIG` on the MCP process; without those host
  bindings the tools are present but unavailable.

## Secondbrain Capture Rule

For intentional capture requests in Claude Code, such as `note:`,
`make a note`, `idea:`, or `save this`, call the jarvOS universal capture
contract with source `claude-code`. Do not raw-write Obsidian notes or journals,
and do not create guessed daily journal files under `Notes/`.
- `boot_jarvos` prompt — user-facing "Boot jarvOS" starter prompt for Claude
  Desktop manual hydration.

## Verification

```bash
claude mcp get jarvos
node runtimes/claude/jarvos-session-start-hook.js
node runtimes/claude/jarvos-precompact-hook.js
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check claude
```
