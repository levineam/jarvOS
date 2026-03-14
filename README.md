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

## Architecture: Core + Runtime

jarvOS separates **what the agent believes and how it behaves** (portable) from **how it executes** (runtime-specific).

```
jarvos/
├── core/                  # Portable behavioral layer
│   ├── AGENTS.md          # Behavioral rules (works on any runtime)
│   ├── SOUL.md            # Personality and tone
│   └── IDENTITY.md        # Agent identity
├── templates/             # You fill these in
│   ├── USER.template.md   # About you
│   ├── MEMORY.template.md # Long-term memory seed
│   └── ONTOLOGY.template.md # Your values and goals
├── runtimes/
│   ├── openclaw/          # OpenClaw-specific (scripts, workflows, heartbeat)
│   └── hermes/            # Hermes-specific (setup script, lean adapter)
└── docs/                  # Documentation and architecture
```

**Core** is the behavioral backbone — rules, principles, persona, governance philosophy. It's pure markdown with zero runtime assumptions. It works on any AI agent that loads project context files.

**Runtimes** wire those principles into specific platforms:
- **OpenClaw** adds scripts, Lobster workflow gates, heartbeat automation, and custom memory management (because OpenClaw doesn't have built-in learning loops)
- **Hermes** is deliberately lean — Hermes has native skill creation, memory nudges, session search, and user modeling, so jarvOS just provides the behavioral layer and lets Hermes handle the mechanism

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

```bash
git clone https://github.com/levineam/jarvOS.git
# Copy core/ files into your OpenClaw workspace, then follow runtimes/openclaw/README.md for runtime adapter wiring
# Copy templates/ and fill in your details
cp templates/BOOTSTRAP-template.md BOOTSTRAP.md   # Create your first-run bootstrap file
# Tell your assistant to read BOOTSTRAP.md
openclaw gateway start
```

## The five systems

1. **Project Management** — Portfolios → Programs → Project Boards → Tasks. Your assistant works from "Autonomous Now" without being asked, routes blockers through "Needs You", and doesn't confuse the two.

2. **Governance** — Compliance scanning, milestone gates, OKR integration. When a project drifts from its goals, the system flags it. Decisions queue with an escalation ladder.

3. **ONTOLOGY.md** — The "why" layer. Maps your beliefs, mission, values, and goals. Every project should trace back to a goal. Orphan detection flags disconnected work.

4. **Continuous Learning & Execution** — Autonomous work loops, briefings, reflection passes. On OpenClaw this is custom-built via scripts; on Hermes it's native.

5. **Security** — Automated version checks, external messaging approval gates, secret handling rules.

## Philosophy

- Behaviors are on by default. Turn things off when they don't fit.
- Everything is markdown. No database, no cloud service, no proprietary format.
- If a behavior can run without pulling you in, it should. If it can't, it surfaces a clear ask with a recommended default.
- **Generic over specific.** Prefer portable patterns over platform hacks.
- **Portable over proprietary.** Solutions should work with any AI runtime.

## Follow along

The creator shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
