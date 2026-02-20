# jarvOS

**jarvOS is a set of tools that sit on top of OpenClaw which make it into a reliable, secure, and powerful personal assistant.**

---

jarvOS has 5 main components:
1. Project Management System
2. Governance
3. Ontology
4. Continuous Learning and Execution
5. Security


It was built on top of [OpenClaw](https://openclaw.ai), which ships with a capable AI assistant, tool access, scheduling, and delivery channels. jarvOS is the layer that tells it what to actually do with all that.

## The problem

Most AI assistants are reactive. You ask, they answer. Close the chat, and they forget everything — ready to start from scratch next time.

jarvOS changes the default. Instead of an assistant that waits, you get one that tracks projects across sessions, routes decisions to you instead of dropping them, runs work autonomously while you sleep, and connects everything you're building to why you're building it.

## The five systems

1. **Project Management System (PMS)** is structured project tracking your assistant can read and write without you. Projects live in a hierarchy: Portfolios contain Programs, Programs contain Project Boards, Boards drive Tasks. Every active project has two companion documents — a Project Brief with scope and goals, and a Live Plan with four locked sections: Decisions Confirmed, Execution Phases, Autonomous Now, and Needs you. That division is the point. Your assistant works from Autonomous Now without being asked, routes blockers through Needs Andrew, and doesn't confuse the two.

2. **Governance**. A governance layer runs underneath: compliance scanning, frontmatter standards, milestone gates, OKR integration. When a project drifts from its goals, the system flags it. Decisions queue with an escalation ladder — context, options, recommended path, and what happens automatically if you don't respond. The assistant handles the follow-up.

3. **ONTOLOGY.md** is the why layer. It's a single document that maps your belief system from the ground up: Higher Order purpose, Beliefs, Predictions, Core Self (Mission, Values, Strengths), Goals, then Portfolios and Projects at the bottom. Everything routes through it. A new project should trace back to a Goal. A Goal should trace back to your Mission. When reflection sessions surface new insights — a belief shift, a prediction proved wrong, a goal that no longer fits — those route into ONTOLOGY.md instead of getting lost in chat.

The practical output: orphan detection flags work that isn't connected to any stated Goal. Weekly health checks surface when your active projects have drifted from what you said matters. Prioritization has an actual basis.

4. **Continuous Learning and Execution (CLE)** is the autonomous work loop. On a schedule, your assistant picks up unblocked tasks from active project boards, executes them, and writes proof-of-work so you know what happened. After each session, a structured reflection pass extracts what was learned to memory, routes understanding shifts to ONTOLOGY.md, and queues open questions in the briefing system.

Briefings tie it together — morning, creative, evening, wind-down. Each one pulls the relevant slice of what's happening and what needs you, formatted for quick reading. Overnight maintenance mode handles lower-priority work while you sleep. Capture-first means ideas get saved before they get discussed, so nothing falls through when a conversation moves on.

5. **Security** is automated daily scanning and incident response. Every morning a cron job checks the installed OpenClaw version against the latest release, scans security advisories and CVE databases for relevant vulnerabilities, and evaluates each finding by credibility, relevance, and severity. Results feed into a security intelligence document in the vault and surface through the briefing system — critical findings get urgent alerts, routine checks get logged quietly.

The system also tracks version drift on customer and partner instances (flagging when someone is running behind on security patches), runs credential exposure detection during heartbeat scans, and maintains an active threats tracker. The credential detection has caught real things — it triggered rotation of leaked database and OAuth credentials in production. When something goes wrong, the incident response isn't theoretical. It's been used.

## OpenClaw is the prerequisite

OpenClaw provides the foundation: session management, cron scheduling, tool access, channel delivery, and a set of baseline workspace files. jarvOS runs on top of it. The governance layer, the briefing system, the project hierarchy — none of it replaces OpenClaw's infrastructure; it runs on it.

What this repo adds on the behavior side: an enhanced AGENTS.md with invisible orchestration, specialist mode detection, auto model tiering, a full writer pipeline, and red team checkpoints for development work. An enhanced HEARTBEAT.md that's a 12-section proactive playbook — what actually runs on OpenClaw's scheduler. A memory architecture that adds daily session files, heartbeat-state.json for check-in tracking, and a briefing queue for decisions that need your attention. Scripts that handle governance scanning, frontmatter linting, and maintenance work.

Your instance is the third layer: your persona, your schedule, your integrations. This repo gives you the second. OpenClaw provides the first.

## Quick start

Clone the repo. Copy the files from `templates/` into your OpenClaw workspace. Tell your assistant to read `BOOTSTRAP.md` and follow its instructions — it handles setup and explains the system in its own terms.

From there: set up your ONTOLOGY.md (start with Mission and a few Goals), create your first project with a Board and Brief, and let the Live Plan drive what gets worked on. The whole system is readable by both humans and AI, so when something doesn't work the way you expect, reading the relevant file usually tells you why.

## Philosophy

The behaviors are on by default. You turn things off when they don't fit rather than manually activating each feature. An assistant that requires constant configuration isn't a system — it's a to-do list you maintain for your to-do list.

Everything is markdown. No database, no cloud service, no proprietary format. The files are readable, versionable with git, and moveable between AI platforms as the ecosystem shifts.

The design principle throughout: if a behavior can run without pulling you in, it should. If it can't, it surfaces a clear ask with a recommended default rather than a wall of options.

## Follow along

Andrew shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
