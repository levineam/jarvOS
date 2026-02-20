# jarvOS

**OpenClaw is the engine. jarvOS is the car you can actually drive.**

---

jarvOS is a set of markdown files, templates, and patterns that give your AI assistant a real operating system. Workspace rules, proactive behaviors, project governance, memory across sessions — drop these files into your working directory and your assistant starts behaving like it actually knows what it's doing.

It was built on top of [OpenClaw](https://openclaw.ai), which ships with a capable AI assistant, tool access, scheduling, and delivery channels. What it doesn't ship with is the layer that tells your assistant what to do with all that — when to check your email, how to track your projects, where to put what it learns, and what to work on while you sleep. jarvOS is that layer.

The patterns are general enough to work with any AI assistant that can read files and follow instructions.

## The problem

Most AI assistants are reactive. You ask, they answer. Close the chat, and they forget everything — ready to start from scratch next time.

jarvOS changes the default. Instead of an assistant that waits, you get one that checks your email on a schedule, surfaces calendar conflicts before they matter, tracks projects across sessions, and nudges you when something needs a decision. Without spamming you when it doesn't.

The underlying architecture is simple: a handful of markdown files your AI reads on startup. No proprietary database, no locked-in service. Plain text you can read, edit, and version-control like anything else.

## What's included

The repo has three main pieces.

**Core OS templates** live in `templates/`. These are the files your assistant reads to understand how to operate:

`AGENTS.md` is the kernel — workspace rules, orchestration behavior, and the policies that govern how your assistant makes decisions autonomously. Everything from model-selection defaults to how it routes memory to the right places.

`HEARTBEAT.md` defines what happens on each proactive check-in: email scan, calendar review, task health, project governance drift, post-session reflection. It's the schedule your assistant keeps when you're not actively talking to it.

`SOUL.md`, `IDENTITY.md`, and `USER.md` handle persona and context. Who your assistant is, how it carries itself, and what it knows about you — your schedule, your work, your pain points.

`BOOTSTRAP.md` is the first-run setup. It runs once, configures everything, and explains the system to your assistant in its own terms.

**The starter kit** (`starter-kit/`) includes two project templates: a Project Kickoff Pack that forces planning before building, and an OKR Task Board that keeps work outcome-driven instead of just task-churning.

**Architecture docs** (`docs/`) cover the design decisions behind the system — useful if you want to extend or adapt it, or just understand why things work the way they do.

## Quick start

Clone the repo. Copy the files from `templates/` into your AI workspace — wherever your assistant reads context on startup. Fill in `USER.md` with your actual schedule and work context. Adjust `HEARTBEAT.md` to match your life. Tell your assistant to read `BOOTSTRAP.md` and follow its instructions.

That's the setup. `BOOTSTRAP.md` is self-explaining and walks your assistant through the rest. The whole system is designed to be readable by both humans and AI, so when something doesn't work the way you expect, you can usually just read the relevant file and figure out why.

## What it does

Once running, jarvOS gives your assistant a set of behaviors it runs automatically.

On a timer, it works through a heartbeat checklist — new email worth surfacing? calendar event coming up in the next two hours? tasks overdue? project governance drift? Most of the time the answer is no to all of these, and it stays quiet. When something needs attention, it tells you once, in plain language, with a recommendation and a default action if you don't respond.

Decisions that need your input queue up instead of pinging you repeatedly. Each ask includes what's blocked, why it matters now, your options, which one is recommended, and what will happen automatically if you don't weigh in. Four-hour minimum between repeat nudges on the same topic. After two nudges with no response, it moves the item to your morning briefing and stops interrupting you.

Project work follows a lightweight governance model. Every project has a board, a brief, and 3-6 milestones. When work starts drifting from its goals, the system flags it. Memory across sessions lives in flat files — what happened, what's in progress, what decisions were made. No database, no service dependency.

On a schedule during working hours (default every 45 minutes), your assistant picks up unblocked tasks and works on them without being asked. It logs what it did and stays quiet unless it needs you.

Morning and evening briefings pull everything together — what came in, what's moving, what needs your input — formatted for quick reading.

## OpenClaw vs jarvOS

OpenClaw ships with the foundation: session management, cron scheduling, tool access, channel delivery (Telegram, etc.), and a set of baseline templates. A minimal `AGENTS.md`. Basic personality files. A first-run `BOOTSTRAP.md`. The heartbeat scheduler exists. The infrastructure works.

What isn't there: the behaviors.

OpenClaw gives you a capable AI assistant with access to tools. It doesn't tell that assistant what to check proactively, how to track your projects, where to store what it learns, or what to work on at 2am while you sleep. jarvOS is the layer that defines all of that.

The `AGENTS.md` in this repo replaces the minimal template with invisible orchestration — specialist mode detection that routes work to the right approach without exposing the machinery, auto model tiering that picks the right model silently, a full writer pipeline, red team checkpoints for development work, and a capture-first protocol so decisions don't fall through the cracks.

`HEARTBEAT.md` is a 12-section playbook: email scan, calendar review, task health, governance drift, post-session reflection, security checks, escalation routing, and an overnight work loop. OpenClaw provides the scheduler. jarvOS provides what runs on it.

The rest of what this repo adds doesn't exist at all in a base OpenClaw setup. There's a memory architecture: daily session files, long-term `MEMORY.md`, `heartbeat-state.json` for check-in tracking, and a briefing queue for decisions that need your attention. There's a project management system with portfolios, programs, boards, briefs, live plans, and OKR integration — each active project has a board and a brief your assistant keeps current. There's a governance layer with compliance scanning, frontmatter standards, and blocker routing. And there are scripts that tie it together: `governance-scan.js`, lint tools, a summarize wrapper that turns URLs into vault notes with journal links.

Your instance is the third layer: your persona, your schedule, your integrations. This repo gives you the second. OpenClaw provides the first.

If you're using a different AI runtime — Claude Code, Cursor, something else — the markdown files still work. You lose the cron scheduling and channel delivery unless you wire those up yourself, but the operating patterns translate.

## Philosophy

The behaviors are on by default. You turn things off when they don't fit rather than manually activating each feature. An assistant that requires constant configuration isn't a system — it's a to-do list you maintain for your to-do list.

Everything is markdown. No database, no cloud service, no proprietary format. The files are readable by humans, versionable with git, and moveable between AI platforms as the ecosystem changes.

When something doesn't fit your setup, the docs explain the reasoning behind it. That means you can adapt the pattern to your situation instead of copying the file structure and hoping it works. The goal throughout was to ask "could someone else use this?" before committing anything here. If the answer was no, it stayed out.

## Follow along

Andrew shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
