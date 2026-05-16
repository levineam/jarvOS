# jarvOS

**An open operating layer for your personal AI assistant.**

jarvOS turns AI agents like OpenClaw, Claude, Codex, and Hermes into your own
personal Jarvis. It packages and connects a complete set of free/open-source,
portable, local-first tools that unlock the useful capabilities of large
language models: memory, notes, projects, structured knowledge, daily alignment,
and context that follows you across agents.

Talk to your agent like normal. jarvOS routes the conversation into the right
systems automatically:

- notes and drafts into Obsidian-compatible markdown
- active work into Paperclip
- durable facts, lessons, decisions, and preferences into memory
- people, projects, concepts, meetings, and sources into structured knowledge
- daily activity into your journal
- relevant context back into whichever agent you are using next

The result is a shared brain for you and your agents: one context spine that can
support OpenClaw, Codex, Claude, Hermes, and whatever comes next.

## What jarvOS Does

Most AI assistants are powerful in a single chat and forgetful across real life.
jarvOS gives them an operating layer:

- **Daily journal as the control room.** Your journal shows what your agents did,
  what changed, what notes were created or touched, and what still needs
  attention. If you use Apple Reminders, reminders can be pulled into the daily
  journal automatically.
- **Notes as durable knowledge.** Human-readable content stays in your vault, not
  inside a proprietary assistant database. The same notes remain useful to you,
  Obsidian, search tools, and agents.
- **Paperclip as the work tracker.** Concrete work becomes tracked issues,
  assignments, status, blockers, and verification evidence instead of scattered
  chat promises.
- **Structured knowledge for recall.** Curated people, companies, projects,
  concepts, meetings, and source pages become organized context an agent can
  retrieve before it acts.
- **Memory as the durable agent state.** Stable facts, decisions, preferences,
  and lessons are promoted into compact memory files that can be loaded by
  different agents.
- **Runtime adapters instead of lock-in.** jarvOS can run on top of OpenClaw,
  Hermes, Codex, Claude Desktop, and future agent runtimes through small
  adapters.

jarvOS is not another chat app. It is the connective tissue between your agent,
your notes, your tasks, your knowledge, and your daily operating rhythm.

## How It Works

jarvOS is organized around a simple loop:

1. **Capture.** You talk to an agent, save a note, complete a task, or change a
   project.
2. **Route.** jarvOS decides where that information belongs: journal, note,
   memory, Paperclip, ontology, or structured knowledge.
3. **Promote.** Important information is turned into durable, reusable context
   instead of being stranded in chat history.
4. **Inject.** The next agent you use gets the critical context it needs before
   acting.
5. **Audit.** The daily journal and health checks show what changed and what
   still needs attention.

This is the core idea: your assistant should not just answer you. It should help
maintain the operating system around your work and life.

## What's in This Repo

```text
jarvOS/
├── core/              # Portable behavior layer: AGENTS, SOUL, IDENTITY, governance
├── modules/           # jarvOS-owned npm modules
│   ├── jarvos-secondbrain/   # Journal, notes, capture routing, Obsidian adapter
│   ├── jarvos-memory/        # Durable memory contract and audit tooling
│   ├── jarvos-ontology/      # Beliefs, goals, projects, predictions, worldview
│   ├── jarvos-gbrain/        # Optional structured-knowledge adapter
│   ├── jarvos-agent-context/ # Runtime-facing recall/action MCP adapter
│   └── jarvos-skills/        # Default operating-system skill bundle
├── templates/         # Blank USER, MEMORY, ONTOLOGY, TOOLS, BOOTSTRAP, HEARTBEAT
├── runtimes/          # Runtime-specific adapters for OpenClaw, Hermes, Codex
├── starter-kit/       # Governance and project-management scaffolding
├── docs/              # Architecture, release process, operations
└── scripts/           # Smoke tests and release checks
```

Everything jarvOS-owned is plain markdown plus a small amount of generic Node.js
code. There is no hosted service, no required database, and no proprietary
knowledge format.

## Architecture

jarvOS is a set of layers, not a monolith:

| Layer | Owner | Purpose |
| --- | --- | --- |
| Content | `@jarvos/secondbrain` | Journal entries, notes, raw capture |
| Recall | `@jarvos/memory` | Facts, preferences, lessons, decisions |
| Worldview | `@jarvos/ontology` | Beliefs, predictions, goals, projects |
| Structured knowledge | local knowledge tools | People, companies, projects, concepts, meetings, sources |
| Behavior | `core/` | Identity, tone, rules, governance |
| Execution | Paperclip | Issues, tasks, status, blockers, verification |
| Runtime | OpenClaw, Hermes, Codex, Claude, etc. | Tools, messaging, sessions, model calls |

Each layer has one job. Notes do not become project boards. Project tasks do not
become memory. Private beliefs do not leak into public templates. That discipline
is what lets jarvOS stay portable.

## Modules

The runnable pieces live in `modules/`:

- **[`@jarvos/secondbrain`](./modules/jarvos-secondbrain/)** keeps the content
  layer organized: journal maintenance, notes management, capture routing, and
  Obsidian-compatible storage adapters.
- **[`@jarvos/memory`](./modules/jarvos-memory/)** defines how durable agent
  memory is represented, promoted, and audited.
- **[`@jarvos/ontology`](./modules/jarvos-ontology/)** models goals, beliefs,
  predictions, projects, and operating context.
- **[`@jarvos/gbrain`](./modules/jarvos-gbrain/)** is the included structured
  knowledge adapter. It prepares curated vault content for a local knowledge
  base and exposes sync, recall, health-check, and retrieval-eval workflows.
- **[`@jarvos/agent-context`](./modules/jarvos-agent-context/)** exposes current
  work, recall bundles, startup briefs, and verified note creation to agent
  runtimes through a local MCP adapter.
- **[`@jarvos/skills`](./modules/jarvos-skills/)** packages default operating
  skills: workflow execution, rule creation, context management, and cron
  hygiene.

Each module has its own README and can be used independently.

## Runtime Adapters

jarvOS deliberately separates portable behavior from runtime-specific glue.

- **OpenClaw** provides scheduling, tools, messaging, workspace context loading,
  cron jobs, and workflow gates. jarvOS supplies the behavior, memory, project,
  note, and recall patterns that OpenClaw runs.
- **Hermes Agent** provides its own model configuration, tool calling, learning,
  session search, and user modeling. jarvOS adds the portable behavior layer and
  avoids duplicating Hermes-native systems.
- **Codex CLI and Claude Desktop** can use jarvOS context through local adapters
  and manual hydration flows.

The same core files can move across runtimes because the source of truth is
markdown and local tooling, not a single vendor's memory system.

## Quick Start

Clone the repo and run the smoke test:

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
npm test
```

Expected result:

```text
PASS — All checks passed. The repo is ready to use.
```

### OpenClaw

```bash
cp core/AGENTS.md    /path/to/openclaw-workspace/AGENTS.md
cp core/SOUL.md      /path/to/openclaw-workspace/SOUL.md
cp core/IDENTITY.md  /path/to/openclaw-workspace/IDENTITY.md
cp templates/BOOTSTRAP-template.md /path/to/openclaw-workspace/BOOTSTRAP.md
cp templates/HEARTBEAT-template.md /path/to/openclaw-workspace/HEARTBEAT.md
node modules/jarvos-skills/scripts/install-skills.js --dest /path/to/openclaw-workspace/skills
```

Then create `USER.md`, `MEMORY.md`, and `ONTOLOGY.md` from the templates and
fill them in for your own workspace.

See [`runtimes/openclaw/README.md`](./runtimes/openclaw/README.md) for the full
adapter checklist.

### Hermes

```bash
hermes setup
./runtimes/hermes/setup.sh
```

See [`runtimes/hermes/README.md`](./runtimes/hermes/README.md) for the Hermes
setup path and the systems jarvOS intentionally does not duplicate.

### Codex CLI

```bash
./runtimes/codex/setup.sh
```

This registers the local jarvOS MCP server so Codex can call jarvOS recall,
current-work, and note-capture tools.

### Install Modules

Install modules from a local clone:

```bash
npm install ./modules/jarvos-memory ./modules/jarvos-ontology ./modules/jarvos-secondbrain ./modules/jarvos-gbrain ./modules/jarvos-agent-context ./modules/jarvos-skills
```

## Public vs. Private

This repo is the public, reusable baseline. It includes templates, adapters,
schemas, smoke tests, and generic operating patterns.

It does **not** include anyone's private workspace:

- personal notes
- journal entries
- reminders
- memories
- goals
- beliefs
- private structured-knowledge pages
- private Paperclip projects
- local API keys or runtime configuration

The design principle is simple: **code and patterns are public; personal context
is private.**

## Release Status

`v0.1.0` is the first public preview release.

Useful release files:

- [`CHANGELOG.md`](./CHANGELOG.md)
- [`docs/releases/v0.1.0.md`](./docs/releases/v0.1.0.md)
- [`docs/release-process.md`](./docs/release-process.md)
- [`PUBLIC_BASELINE.md`](./PUBLIC_BASELINE.md)

Run the release readiness check locally:

```bash
npm run release:check
```

## Philosophy

- **Generic over specific.** Prefer portable markdown and assistant patterns over
  setup-specific hacks.
- **Portable over proprietary.** Your operating layer should outlive any one
  model, runtime, or chat product.
- **Human-readable first.** Important context should be inspectable in normal
  files, especially notes and journals.
- **Tracked work beats chat promises.** If an agent is doing real work, the work
  should be visible in a project system with status and evidence.
- **Context is an asset.** The point is not to save everything. The point is to
  promote the right things into the right layer so future agents can act well.

## Follow Along

The creator shares how he uses and develops jarvOS on X:
[@andrarchy](https://x.com/andrarchy).

If you build something on top of jarvOS, open an issue or find him there.
