# jarvOS

JarvOS is the opinionated personalization layer built on top of OpenClaw. It provides the component architecture, information flow design, governance templates, and operational scripts that turn OpenClaw into a personal AI operating system and second brain.

For v0.1, the core promise is simple: JarvOS makes OpenClaw usable as a professional-grade personal agent setup without making the user become an AI infrastructure hobbyist.

The important product surface is not a pile of tools. It is a shared brain that stays aligned as you and your agents work:

- The daily journal is the live hub: what happened today, what changed, what was decided, what needs attention.
- Notes are durable linked knowledge: decisions, architecture, research, references, and reusable context promoted out of the daily feed.
- Memory and ontology distill the durable signal: compact recall, preferences, lessons, project state, beliefs, goals, and identity.
- Paperclip, GBrain/graph memory, Obsidian, OpenClaw, and `lossless-claw` are infrastructure behind the workflow. They should make the system feel aligned, not force the user to manage plumbing.
- `@jarvos/skills` provides default experience packs. The default `obsidian-default` pack makes Obsidian the polished front door for Markdown notes, while keeping `jarvos-secondbrain` in charge of note and journal contracts.

**JarvOS is not OpenClaw.** OpenClaw is the AI agent runtime — session management, model routing, tool execution, and compaction. JarvOS is what you build on top of it for a specific person and purpose.

**New here?** Read [`docs/WHAT-IS-JARVOS.md`](docs/WHAT-IS-JARVOS.md) — the full explainer covering what JarvOS is, what each component does, and where JarvOS ends and native OpenClaw begins.

For the full technical architecture, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Local stack preview:** The announcement candidate for the local OpenClaw
profile is documented in [`docs/INSTALL.md`](docs/INSTALL.md),
[`RELEASE_NOTES.md`](RELEASE_NOTES.md), and [`CHANGELOG.md`](CHANGELOG.md). It
is a source-checkout preview until the approval gate is complete; do not cut a
tag or GitHub Release from these notes without that approval.

---

## v0.1 Secondbrain Flow

JarvOS v0.1 should be understandable through one loop:

1. Conversation and agent work create raw signal.
2. The daily journal captures the day-level feed.
3. Important items become linked notes.
4. Durable facts, preferences, decisions, lessons, project state, and beliefs are promoted into agent-readable memory and ontology.
5. Future agents load the right context automatically instead of asking the user to repeat it.

This is the shared-brain alignment model: ordinary work grows the system, and the system gives the right context back to both the human and the agents.

## v0.1 Release Requirements

The README-level release bar is:

- A fresh reader can explain the difference between OpenClaw runtime mechanics and the JarvOS personalization layer.
- A fresh user understands that the daily journal is the coordination hub, not a throwaway log.
- A fresh user understands when something belongs in notes: it is durable, linkable knowledge that should survive beyond one day.
- The docs explain that context injection is a JarvOS outcome built from journal, notes, memory, ontology, and runtime adapters.
- Internal component names are presented as infrastructure, not as the user-facing mental model.
- Paperclip remains the execution authority; JarvOS captures meaning around work instead of duplicating task state.

## Mandatory Flow: Kickoff Before Build

Use this sequence for every new project:

1. Copy and complete `templates/PROJECT-KICKOFF-PACK.template.md`
2. Define Objective + measurable KRs
3. Create board from `templates/OKR-TASK-BOARD.template.md`
4. Link each task to a KR
5. Start implementation only after kickoff gate is complete

If work is not linked to a KR, it should be paused, merged, or dropped.

## Runtime Onboarding Defaults (Core)

Runtime onboarding behavior is inherited from jarvOS core templates (`jarvos/templates/AGENTS-template.md` + `jarvos/templates/BOOTSTRAP-template.md`):
- activation-first onboarding finish (1-3 concrete activation tasks)
- brief-first setup (daily + weekly brief/review early)
- proactive next-work closeouts (1-3 concrete options, unless user explicitly ends)
- "search the last X days" interpreted as web-first lastXdays research, with local recall as support

## Default Obsidian Experience Pack

JarvOS v0.3 ships `@jarvos/skills` with the `obsidian-default` pack. It references
`kepano/obsidian-skills` at commit `553ef99` and enables:

- `obsidian-markdown` for wikilinks, properties, embeds, and callouts
- `obsidian-cli` when the `obsidian` command is available and Obsidian is open
- `defuddle` when the `defuddle` command is available for clean web extraction
- `json-canvas` for visual knowledge artifacts
- `obsidian-bases` for note review views

Setup stays portable: configure `jarvos-secondbrain` paths through
`JARVOS_NOTES_DIR` and `JARVOS_JOURNAL_DIR`, or through `paths.notes` and
`paths.journal` in `jarvos.config.json`. Then run:

```bash
node jarvos-skills/bin/jarvos-skills.js doctor
```

Missing `obsidian` or `defuddle` commands only disable the optional tool-backed
parts of the pack. Markdown, notes, journals, and secondbrain contracts still
work without Obsidian installed.

## Minimal Workspace Doctor

JarvOS also ships a minimal workspace doctor for validating a portable install:

```bash
jarvos doctor --profile minimal
jarvos doctor --profile minimal --workspace /path/to/workspace --json
```

The minimal profile checks the reusable JarvOS contract:

- required workspace files: `MEMORY.md`, `jarvos.config.json`, and
  `jarvos.config.schema.json`
- `jarvos.config.json` validates against `jarvos.config.schema.json`
- `paths.workspace`, `paths.vault`, `paths.notes`, `paths.journal`, and
  `paths.memory` point to existing directories
- `AGENTS.md` exists as the agent context entry point and `MEMORY.md` is
  present for agent-context hydration
- the native knowledge surfaces under `.jarvos/knowledge` are available after
  capture, or clearly marked `skipped` before any reusable context artifacts
  have been generated
- memory-wiki is available through an explicit `paths.memoryWiki` surface or
  generated `memory-wiki-queue.json`, or clearly marked `skipped` on fresh
  installs

Failure output names the exact component, such as `agent.context` or
`path.vault`, so an installer or assistant can repair the missing piece directly.

## Local OpenClaw Profile

For the supported local runtime path, initialize JarvOS as an OpenClaw adapter:

```bash
jarvos init --profile local-openclaw --workspace /path/to/workspace
jarvos doctor --profile local-openclaw --workspace /path/to/workspace
```

This creates missing portable workspace files, registers the local OpenClaw
adapter in `jarvos.config.json`, records installed JarvOS skills, and writes
workspace state under the OpenClaw state directory. Existing JarvOS JSON files
are backed up before merge writes, and `openclaw.json` is never created or
overwritten by JarvOS.

The doctor uses explicit dependency states: `ok` for healthy dependencies,
`fail` for missing required dependencies such as the `openclaw` command, and
`skipped` for optional tools or init artifacts that are not present yet. See
[`docs/local-openclaw-profile.md`](docs/local-openclaw-profile.md) for the full
operator path.

## v0.5.0 Autonomous Profile (Claude/Codex + Portable Coding)

For non-Clawd hosts that run JarvOS through Claude/Codex, initialize:

```bash
jarvos init --profile v0-5-0 --workspace /path/to/workspace
jarvos doctor --profile v0-5-0 --workspace /path/to/workspace
```

This profile installs the `v0-5-0` skill pack and wires the autonomy surface:

- `@jarvos/coding` (including `runTakeIssueToDone` orchestration)
- `@jarvos/agent-context` (shared-brain continuity via `jarvos_session_state`)

Smoke proof for the profile is available as:

```bash
node scripts/jarvos-v05-profile-smoke.js --workspace /path/to/workspace
```

## Local OpenClaw Stack Preview

The local profile turns an existing checkout into a JarvOS-aware OpenClaw
workspace. It registers OpenClaw as a runtime adapter, records the installed
JarvOS skill pack, and preserves any existing OpenClaw runtime configuration.

From the repository root:

```bash
npm install
node jarvos-skills/bin/jarvos-skills.js init --pack local-openclaw --workspace "$PWD"
node jarvos-skills/bin/jarvos-skills.js doctor --pack local-openclaw
npm run canary:jarvos-install
```

What this does:

- creates or updates `jarvos.config.json` with missing JarvOS defaults
- writes `.jarvos/installed-skills/local-openclaw.json`
- writes OpenClaw workspace state under the configured OpenClaw state directory
- preserves existing OpenClaw runtime config instead of rewriting it
- reports optional tools, such as `lossless-claw`, without making them required

This is intentionally not a secret one-machine setup. The reusable pattern is:
describe the workspace contract in Markdown and JSON, register runtime adapters
explicitly, then test the packaged artifact with a clean install canary.

## Project Governance Policy v1 (Default)

All project work should follow this baseline:
- link projects to Portfolio + Program by default
- if no fit exists, set `Program: Incubator` with reason + review date
- keep `Project Board.md` + `Project Brief.md` as a required pair
- maintain 3-6 milestones/decision gates per project
- hotfixes can start fast, but governance backfill is required in the same session

## Autonomous Work Loop (Optional)

For always-on autonomous execution, copy `templates/WORKFLOW_AUTO-template.md` to your workspace root as `WORKFLOW_AUTO.md` and customize:

1. Replace placeholder paths (`{{CLAWD_PATH}}`, `{{VAULT_PATH}}`, `{{NOTES_DIR}}`)
2. Set your timezone (`{{TIMEZONE}}`)
3. Copy required scripts (`autopilot-work.js`, `lib/autopilot-utils.js`, `lib/governance-utils.js`)
4. Update script paths to match your setup
5. Configure cron to run `autopilot-work.js` twice per hour

The autonomous loop enables:
- Progress on tasks while you sleep (configurable quiet hours)
- Governance-first task selection (board + brief required)
- Artifact creation (outlines, schema stubs) as concrete progress markers

## Context Management

Your AI assistant loads files into its context window every turn. If those files grow unchecked, quality degrades — from subtle attention loss to full timeouts. Context management gives you the tools to monitor and control this.

**What's included:**
- [`scripts/context-watchdog.js`](scripts/context-watchdog.js) — Instant health check. Prints `NO_REPLY` when healthy, one-line alert on threshold breach.
- [`scripts/context-budget-trend-capture.js`](scripts/context-budget-trend-capture.js) — Daily snapshot to JSONL. Tracks file sizes, utilization, and drift over time.
- [`config/context-watchdog.json`](config/context-watchdog.json) — Configurable thresholds per file and total.
- [`templates/CONTEXT-MANAGEMENT.template.md`](templates/CONTEXT-MANAGEMENT.template.md) — Project kickoff template with metric model, KR dashboard, change checklist, and weekly review.

**Quick start:**
```bash
# Check context health right now
node scripts/context-watchdog.js

# Take a snapshot (preview)
node scripts/context-budget-trend-capture.js --dry-run --json

# Set up daily cron capture — see templates/CRON-MAINTENANCE.template.md
```

**Full guide:** [`docs/context-management.md`](docs/context-management.md) — covers the stability-first approach, 4-week stabilization pattern, and lessons from production.

## Maintenance & Hygiene

Your OpenClaw deployment needs basic upkeep or it'll eat credits, slow itself down, or leak too much local machine context into shared status surfaces. See [`docs/maintenance-hygiene.md`](docs/maintenance-hygiene.md), [`templates/CRON-MAINTENANCE.template.md`](templates/CRON-MAINTENANCE.template.md), and [`docs/context-management.md`](docs/context-management.md) for the essential patterns:

1. **Session Pruning** — automated cleanup of accumulated cron/subagent sessions ([script](scripts/prune-cron-sessions.sh) + [cron template](templates/CRON-MAINTENANCE.template.md))
2. **Cron Model Tiering** — stop running monitoring jobs on your most expensive model
3. **On-demand exposure scanning** — optional local-openclaw security checks that keep raw scan output local and share only redacted summaries

Set these up on day one. Your wallet will thank you.

## Included Reusable Templates

- `templates/PROJECT-KICKOFF-PACK.template.md` — New project setup
- `templates/OKR-TASK-BOARD.template.md` — Objective/Key Result task tracking
- `templates/WORKFLOW_AUTO-template.md` — Autonomous work loop documentation
- `templates/AGENTS-template.md` — AI assistant behavior configuration
- `templates/BOOTSTRAP-template.md` — First-run onboarding
- `templates/HEARTBEAT-template.md` — Proactive check-in system
- `templates/TASK-BREAKDOWN.template.md` — Phase-level task decomposition
- `templates/CRON-MAINTENANCE.template.md` — Session pruning, context monitoring, and model tiering cron configs
- `templates/CONTEXT-MANAGEMENT.template.md` — Context budget governance kickoff (metric model, KR dashboard, checklists)

These templates are generic markdown and portable across repos/tools.
