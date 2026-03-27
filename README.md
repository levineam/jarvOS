# jarvOS

**A personal AI operating system. Cross-platform. Portable. Yours.**

---

jarvOS is a behavioral layer that makes AI assistants actually useful out of the box — with persistent identity, governance, proactive behavior, and alignment to what you care about.

It runs on [OpenClaw](https://openclaw.ai) and [Hermes Agent](https://github.com/NousResearch/hermes-agent). Same core, different runtimes.

## What jarvOS does

Most AI assistants are reactive. You ask, they answer. Close the chat, and they forget everything.

jarvOS changes the default:
- **Identity & persona** — your assistant knows who it is and how to communicate
- **Behavioral rules** — when to act autonomously, when to ask permission, when to plan first
- **Governance** — structured project tracking, milestone gates, escalation ladders
- **Alignment** — every project traces back to your goals and values via ONTOLOGY.md
- **Proactive work** — briefings, task execution, email monitoring, calendar awareness

## Architecture: Core + Runtime + Modules

jarvOS separates **what the agent believes and how it behaves** (portable) from **how it executes** (runtime-specific), with **executable modules** that do the actual work.

```
jarvOS/
├── core/                  # Portable behavioral layer
│   ├── AGENTS.md          # Behavioral rules (works on any runtime)
│   ├── SOUL.md            # Personality and tone
│   └── IDENTITY.md        # Agent identity
├── templates/             # You fill these in
│   ├── USER.template.md   # About you
│   ├── MEMORY.template.md # Long-term memory seed
│   ├── ONTOLOGY.template.md # Your values and goals
│   └── TOOLS.template.md  # Local tool notes + guardrails
├── modules/               # Executable runtime modules (NEW — actual code)
│   ├── jarvos-memory/     # Agent-state memory contract and audit helpers
│   ├── jarvos-ontology/   # Ontology tooling (read/write/validate/render)
│   └── jarvos-secondbrain/ # Vault bridges, journal/notes, capture routing
├── runtimes/
│   ├── openclaw/          # OpenClaw-specific (scripts, workflows, heartbeat)
│   └── hermes/            # Hermes-specific (setup script, lean adapter)
└── docs/                  # Documentation and architecture
```

**Core** is the behavioral backbone — rules, principles, persona, governance philosophy. It's pure markdown with zero runtime assumptions. It works on any AI agent that loads project context files.

**Modules** are the executable layer — three Node.js packages that your agent uses to manage memory, ontology, and your second brain. Code is public; your personal data stays local.

**Runtimes** wire those principles into specific platforms:
- **OpenClaw** adds scripts, Lobster workflow gates, heartbeat automation, and custom memory management (because OpenClaw doesn't have built-in learning loops)
- **Hermes** is deliberately lean — Hermes has native skill creation, memory nudges, session search, and user modeling, so jarvOS just provides the behavioral layer and lets Hermes handle the mechanism

## Modules

The `modules/` directory contains three executable Node.js packages that power the runtime behavior of your jarvOS agent.

| Module | Purpose |
|--------|---------|
| [`modules/jarvos-memory`](./modules/jarvos-memory/) | Durable agent-state memory — schema, audit helpers, promotion rules |
| [`modules/jarvos-ontology`](./modules/jarvos-ontology/) | Ontology tooling — read, write, validate, and render your belief/goal graph |
| [`modules/jarvos-secondbrain`](./modules/jarvos-secondbrain/) | Content layer — vault bridges (Obsidian/OpenClaw), journal, notes, capture routing |

These are the same modules used in production. They ship with the repo so a `git clone` gives you working software, not just documentation.

**Privacy model:** the modules contain generic, configurable code only. Your personal ontology data, memories, and vault content stay local. See [`PUBLIC_BASELINE.md`](./PUBLIC_BASELINE.md) for the full public/private boundary.

For detailed module docs and usage, see [`modules/README.md`](./modules/README.md).

---

## Quick start

### Hermes Agent

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS
hermes setup   # Configure model and API keys (creates ~/.hermes/config.yaml)
./runtimes/hermes/setup.sh   # Installs jarvOS and attempts to set Hermes terminal.cwd to this workspace
# Edit USER.md and ONTOLOGY.md with your info
hermes         # Start chatting
```

### OpenClaw

**Prerequisites:** Node.js v18+, [OpenClaw](https://github.com/openclaw/openclaw) (`npm install -g openclaw`)

```bash
git clone https://github.com/levineam/jarvOS.git
cd jarvOS

# Option A — interactive Node.js installer (prompts for names, paths, vault)
node bootstrap.js
# or: bash bootstrap.sh
# or without cloning: npx jarvos-bootstrap

# Option B — shell script into an existing OpenClaw workspace
./runtimes/openclaw/setup.sh /path/to/your/openclaw-workspace

# Option C — set up in a new directory (defaults to current dir)
mkdir ~/my-agent && cd ~/my-agent
/path/to/jarvOS/runtimes/openclaw/setup.sh .
```

`bootstrap.js` generates `AGENTS.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`, and `MEMORY.md` from templates with your values filled in. Run `npm test` at any time to re-verify the setup.

When bootstrap finishes:

```bash
# 1. Fill in your personal details
$EDITOR USER.md        # name, timezone, priorities
$EDITOR ONTOLOGY.md    # mission, values, goals

# 2. Start OpenClaw
openclaw gateway start

# 3. Tell your agent to read BOOTSTRAP.md
# The bootstrap ritual sets up identity, memory, and journal on first run
```

See `runtimes/openclaw/README.md` for advanced wiring (HEARTBEAT.md, scripts, workflows).

## Modules: the software that actually runs

jarvOS ships three executable Node.js modules in `modules/`. These are the code layer behind the templates.

| Module | What it does |
|---|---|
| [`@jarvos/memory`](./modules/jarvos-memory/) | Compact agent-state recall — lessons, decisions, facts, preferences |
| [`@jarvos/ontology`](./modules/jarvos-ontology/) | Structured worldview — beliefs, goals, predictions, values |
| [`@jarvos/secondbrain`](./modules/jarvos-secondbrain/) | Content layer — journal entries and notes with env-aware path resolution |

### Verify the modules work

```bash
# No install step needed — modules have zero external dependencies
node tests/modules-smoke-test.js
```

Expected output: `17 checks: 17 passed, 0 failed.`

### Use a module in your own code

```js
// Memory
const { createMemoryRecord } = require('./modules/jarvos-memory/src');

const result = createMemoryRecord({
  class: 'lesson',
  content: 'Prefer env-var path resolution over hardcoded home directories.',
  confidence: 0.95,
});
console.log(result.record);
// → { schema: 'jarvos-memory/v1', class: 'lesson', content: '...', id: '...', ... }

// Ontology
const { createLayer } = require('./modules/jarvos-ontology/src');

const belief = createLayer('belief', {
  statement: 'Reliable automation compounds faster than heroic one-off effort.',
  confidence: 0.9,
});

// Second Brain
const { createJournalEntry, resolveJournalDir } = require('./modules/jarvos-secondbrain/src');

const entry = createJournalEntry({ date: '2026-03-27', title: 'Daily log', body: '...' });
```

### Content and execution flow

```
Raw capture (journal/notes)
  → @jarvos/secondbrain     ← content layer
    → @jarvos/memory        ← compact retained state
      → @jarvos/ontology    ← worldview / belief graph
        → Paperclip         ← live execution tracking
```

---

## The five systems

1. **Project Management** — Portfolios → Programs → Project Boards → Tasks. Your assistant works from "Autonomous Now" without being asked, routes blockers through "Needs You", and doesn't confuse the two.

2. **Governance** — Compliance scanning, milestone gates, OKR integration. When a project drifts from its goals, the system flags it. Decisions queue with an escalation ladder.

3. **ONTOLOGY.md** — The "why" layer. Maps your beliefs, mission, values, and goals. Every project should trace back to a goal. Orphan detection flags disconnected work.

4. **Continuous Learning & Execution** — Autonomous work loops, briefings, reflection passes. On OpenClaw this is custom-built via scripts; on Hermes it's native.

5. **Security** — Automated version checks, external messaging approval gates, secret handling rules.

## Troubleshooting and rollout notes

- `starter-kit/README.md` — starter-kit setup and rollout checklist (export slug: `starter-kit/readme.md`)
- `docs/architecture/jarvos-architecture.md` — architecture overview and operating model
- `docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md` — architecture decision context

## Current dogfood baseline status

This repo is now documented as a **public docs/template baseline candidate** and portable cross-runtime core, not a zero-config clone of Andrew's live workspace.

Before Andrew can dogfood it as the real baseline, these conditions still need to be true:

1. README and starter-kit docs stay aligned with the files actually shipped here.
2. Public metadata stays sanitized — no Andrew-local absolute paths in exported docs.
3. Local overlay files exist for `USER.md`, `MEMORY.md`, `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, and `ONTOLOGY.md`.
4. A clean canary workspace proves the shipped OpenClaw adapter path works correctly with those overlays.
5. Only after that can broader automation be enabled with confidence.

## Philosophy

- Behaviors are on by default. Turn things off when they don't fit.
- Everything is markdown. No database, no cloud service, no proprietary format.
- If a behavior can run without pulling you in, it should. If it can't, it surfaces a clear ask with a recommended default.
- **Generic over specific.** Prefer portable patterns over platform hacks.
- **Portable over proprietary.** Solutions should work with any AI runtime.

## Follow along

The creator shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
