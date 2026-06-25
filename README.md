# jarvOS

**Your own personal Jarvis that just works.**

AI power users are already building personal
Artificial Superintelligences by stringing together a complicated set of open 
source solutions plus custom code to make eveything work together to unlock 
incredible capabilities. But these setups are completely inaccessible to 
non-developers or even developers who just dont have the time to spend endlessly
tinkering and debugging these inherently
fragile setups. 

jarvOS bundles those tools and patterns into a compounding, self-improving knowledge 
base which any AI agent can tap into to understand who you are, what you're working on,
and what you're trying to accomplish. 

## What jarvOS Does

jarvOS combines an autonomous journaling and note-taking system (powered by Obsidian) with a Project 
Management System (powered by Paperclip) as well as a number of other pieces
of open source software (e.g. GBrain by Garry Tan) to construct a "digital twin" that serves as a unifying "mind" 
for your AI agents. Not only does it enable your AI agent to understand you and what you're 
trying to accomplish, but you can seamlessly switch between agents without losing any 

You talk to your assistant like normal. jarvOS routes useful information into
the right place, then brings the right context back when your assistant needs
it.

## The Power-User Stack, Bundled

jarvOS is built around excellent tools that already exist.

**OpenClaw** is the local agent runtime. It handles tools, sessions, messaging,
scheduled work, model routing, and native knowledge features like memory-wiki.
jarvOS uses OpenClaw as the engine and adds the operating layer around it.

**lossless-claw** gives OpenClaw stronger continuity across long conversations
and context compaction. It helps your assistant keep track of what happened
instead of losing the thread when a session gets large.

**Obsidian-compatible Markdown** gives your knowledge a home you own. Notes,
journals, drafts, references, and decisions stay in plain files you can open,
edit, search, sync, and back up.

**GBrain** turns your knowledge into structured recall. People, projects,
companies, concepts, meetings, and source material can become a queryable
knowledge base your assistant can use before it acts.

**Paperclip** gives real work a real system. Agent tasks can become tracked
issues with owners, blockers, status, and verification evidence instead of
disappearing into chat.

**jarvOS skills and adapters** are the webbing. They connect the tools, install
sane defaults, route context, define workflows, and make the system feel like
one assistant instead of a pile of software.

## A Compounding Knowledge Base for Every Agent You Use

Most assistant memory is trapped inside one product. jarvOS takes a different
path: your knowledge base lives in local, readable files and structured indexes
that multiple agents can use.

OpenClaw can use it for daily operation. Codex can use it for coding context.
Claude can use it for writing, planning, and analysis. Hermes Agent can use it
as part of a broader local assistant setup. Future runtimes can plug into the
same context spine through adapters.

Every useful capture makes the system better. Notes become searchable
knowledge. Repeated preferences become memory. Important entities become
structured recall. Completed work becomes durable context.

The longer you use jarvOS, the more leverage your assistants have.

## Your Knowledge Base Builds Itself

This is the part that matters most: every useful interaction can make your
system better.

When you share an idea, jarvOS can put it in today's journal.

When something should last, jarvOS can turn it into a Markdown note.

When a fact, preference, decision, or lesson will matter later, jarvOS can
promote it into durable memory.

When a note describes a person, project, company, meeting, source, or concept,
jarvOS can prepare it for structured recall through GBrain.

When something becomes real work, jarvOS can move it into Paperclip.

Over time, your assistant is not just accumulating chat logs. It is helping
construct your personal knowledge base from the work you are already doing.

## How It Works

jarvOS is organized around a simple loop:

1. **Capture.** You talk to an agent like you would a personal assistant; tell 
it to save an idea, make a note, start a project.
2. **Route.** jarvOS automatically knows where and how to store that information
so that it cam both be put to use, and efficiently
retrieved in the future. 
3. **Promote.** Important information becomes durable context instead of being
   stranded in chat history.
4. **Inject.** The next agent gets the critical context it needs before acting.
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
│   ├── jarvos-gbrain/        # Structured-knowledge adapter
│   ├── jarvos-coding/        # Issue-to-PR coding orchestrator, review gates, host adapters
│   ├── jarvos-agent-context/ # Runtime-facing recall/action MCP adapter
│   └── jarvos-skills/        # Default operating-system skill bundle
├── templates/         # Blank USER, MEMORY, ONTOLOGY, TOOLS, BOOTSTRAP, HEARTBEAT
├── runtimes/          # Runtime-specific adapters for OpenClaw, Hermes, Codex
├── starter-kit/       # Governance and project-management scaffolding
├── docs/              # Architecture, release process, operations
└── scripts/           # Smoke tests and release checks
```

Everything jarvOS-owned is plain Markdown plus a small amount of generic Node.js
code. There is no hosted service, no required database, and no proprietary
knowledge format.

## Architecture

jarvOS is a set of layers, not a monolith:

| Layer | Owner | Purpose |
| --- | --- | --- |
| Content | `@jarvos/secondbrain` | Journal entries, notes, raw capture |
| Recall | `@jarvos/memory` | Facts, preferences, lessons, decisions |
| Worldview | `@jarvos/ontology` | Beliefs, predictions, goals, projects |
| Structured knowledge | `@jarvos/gbrain` and local knowledge tools | People, companies, projects, concepts, meetings, sources |
| Runtime context | `@jarvos/agent-context` | Current work, recall bundles, startup briefs, note creation |
| Behavior | `core/` | Identity, tone, rules, governance |
| Execution | Paperclip | Issues, tasks, status, blockers, verification |
| Runtime | OpenClaw, Hermes, Codex, Claude, etc. | Tools, messaging, sessions, model calls |

Each layer has one job. Notes do not become project boards. Project tasks do not
become memory. Private beliefs do not leak into public templates. That
discipline is what lets jarvOS stay portable.

## Modules

The runnable pieces live in `modules/`:

- **[`@jarvos/secondbrain`](./modules/jarvos-secondbrain/)** keeps the content
  layer organized: journal maintenance, notes management, capture routing, and
  Obsidian-compatible storage adapters.
- **[`@jarvos/memory`](./modules/jarvos-memory/)** defines how durable agent
  memory is represented, promoted, and audited.
- **[`@jarvos/ontology`](./modules/jarvos-ontology/)** models goals, beliefs,
  predictions, projects, and operating context.
- **[`@jarvos/gbrain`](./modules/jarvos-gbrain/)** prepares curated vault content
  for a local knowledge base and exposes sync, recall, health-check, and
  retrieval-eval workflows.
- **[`@jarvos/coding`](./modules/jarvos-coding/)** orchestrates coding work from
  tracked issue to pull request: the portable `runTakeIssueToDone` loop, review
  gates with documented host equivalents, live tracker/git/PR adapters, and thin
  Claude Code/Codex host adapters.
- **[`@jarvos/agent-context`](./modules/jarvos-agent-context/)** exposes current
  work, recall bundles, startup briefs, and verified note creation to agent
  runtimes through a local MCP adapter.
- **[`@jarvos/skills`](./modules/jarvos-skills/)** packages default operating
  skills plus the `obsidian-default` experience pack: workflow execution, rule
  creation, context management, cron hygiene, Obsidian Markdown, Obsidian CLI,
  Defuddle, JSON Canvas, and Obsidian Bases.

Each module has its own README and can be used independently.

## Runtime Adapters

jarvOS deliberately separates portable behavior from runtime-specific glue.

- **OpenClaw** provides scheduling, tools, messaging, workspace context loading,
  cron jobs, workflow gates, and native knowledge surfaces like memory-wiki.
  jarvOS supplies the behavior, memory, project, note, and recall patterns that
  OpenClaw runs.
- **Hermes Agent** provides its own model configuration, tool calling, learning,
  session search, and user modeling. jarvOS adds the portable behavior layer and
  avoids duplicating Hermes-native systems.
- **Codex and Claude** can use jarvOS context through local adapters and
  hydration flows.

jarvOS is not the runtime. It is the user-owned context and governance layer that
runtimes hydrate from and write back to. The same core files and knowledge base
can move across runtimes because the source of truth is Markdown and local
tooling, not a single vendor's memory system.

For the product-category boundary, see
[`docs/architecture/product-category-and-boundaries.md`](./docs/architecture/product-category-and-boundaries.md).

## Quick Start

Clone the repo and run the smoke test:

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
npm test
```

Expected result:

```text
PASS - All checks passed. The repo is ready to use.
```

### Public CLI

The public command router is `jarvos`. It keeps the old bootstrap aliases
working while making new profile-aware commands discoverable:

```bash
jarvos init --profile minimal --yes
jarvos doctor --profile minimal --workspace /path/to/jarvos-workspace
```

`jarvos doctor` uses the checked-in profile manifest and reports portable health
checks for the starter workspace, `jarvos.config.json`, vault folders, Node.js,
and the public agent-context package. It also verifies your journal stays safe:
`vault-path-stale` catches a configured vault root that has moved or gone away,
and `journal-conflict` catches a second journaling tool (Obsidian's `journals`
plugin or core Daily notes) writing into the same `Journal/` folder jarvOS owns.
Run it after install and whenever you change vault or Obsidian settings. See the
[Journal Install Contract](./docs/journal-install-contract.md) for the
single-writer rule these checks enforce. Local-only Paperclip, GBrain, and full
profile checks are intentionally out of the minimal public profile.

### OpenClaw

OpenClaw is the recommended first runtime for the full jarvOS experience.

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

### Codex

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

`v0.6.2` is the current public preview release. It is a patch on the focused
v0.6.0 secondbrain cut for AI coding-tool capture determinism, intentional note
and idea capture, canonical Obsidian routing, source-backed provenance,
generated knowledge surfaces, and retrieval status.

Useful release files:

- [`CHANGELOG.md`](./CHANGELOG.md)
- [`docs/release-process.md`](./docs/release-process.md)
- [`PUBLIC_BASELINE.md`](./PUBLIC_BASELINE.md)

Run the release readiness check locally:

```bash
npm run release:check
```

## Philosophy

- **Bundle the best tools, do not hide them.** jarvOS is strongest when it makes
  excellent local tools work together.
- **Local-first over hosted lock-in.** Your operating layer should outlive any
  one model, runtime, or chat product.
- **Human-readable first.** Important context should be inspectable in normal
  files, especially notes and journals.
- **Context compounds.** Every useful capture should make future assistant work
  better.
- **Tracked work beats chat promises.** If an agent is doing real work, the work
  should be visible in a project system with status and evidence.
- **Power-user workflows should be usable by most people.** The goal is to give
  more people the personal artificial Superintelligence stack that power users
  are already building for themselves.

## Follow Along

The creator shares how he uses and develops jarvOS on X:
[@andrarchy](https://x.com/andrarchy).

If you build something on top of jarvOS, open an issue or find him there.
