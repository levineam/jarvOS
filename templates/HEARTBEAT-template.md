<!-- jarvOS HEARTBEAT Template v2.0.0 | Updated: 2026-02-28 | Added: §6.8 uncommitted work check, §10 escalation ladder, §11 autonomy levels, updated §6.7 quiet hours -->

# HEARTBEAT.md — Proactive Check-In

When you receive a heartbeat poll, work through this checklist. **Do not skip steps.** If nothing needs attention, reply `HEARTBEAT_OK`.

## 0. Fast Awareness Gate (cheap checks first)

Run cheap local checks before any heavy tool work:

1. Read `memory/heartbeat-state.json`
2. Check quick deltas for key files (Tasks, active project boards, ONTOLOGY.md)
3. Check cooldown windows (last heartbeat, escalation cooldowns, nudge cooldowns)

If no meaningful change since last check and no cooldown-expired blockers, immediately return `HEARTBEAT_OK`.

## 1. Resume Active Work

- Check `memory/WORKING.md` or today's `memory/YYYY-MM-DD.md` for tasks in progress
- If a task was left mid-way, **resume it** before doing anything else
- Check for any pending user requests that haven't been addressed

## 2. Notifications & Mentions

- If notification tools are configured, check for unread mentions or messages
- Queue findings — do NOT send replies directly during heartbeat
- Log important notifications in today's memory file

## 3. Email Check

*(Skip if no email tool configured)*

**Cadence:** Active hours, roughly hourly.

1. Prioritize: known contacts, family logistics, travel/reservations, deadlines
2. **Do NOT reply during heartbeat** — queue items for the user's next session
3. Auto-archive only safe routine notifications when no action keywords present
4. Log important emails in today's memory file

## 4. Calendar Check

*(Skip if no calendar tool configured)*

- Check events for the next 24-48 hours
- Flag anything requiring preparation or action
- If an event is within 2 hours, consider notifying the user

## 5. Journal Maintenance

- Ensure vault directories exist at `{{VAULT_PATH}}/Notes`, `{{VAULT_PATH}}/Journal`, `{{VAULT_PATH}}/Tags`. Auto-create if missing.
- Ensure today's journal entry exists at `{{VAULT_PATH}}/Journal/YYYY-MM-DD.md`
- If journal is empty, populate template sections: Tasks, Current Focus, Today's Calendar, Notes, Ideas, Journal Entry
- Enforce **journal structure lock** every pass: six sections in order, no ad-hoc append drift
- Trim bloat weekly

## 6. Task Management

- Review active tasks: completed? blocked? overdue?
- Update task statuses in project boards and task files
- Stalled 7+ days: flag internally (surface in conversation, not heartbeat)
- Blocked and needs user: queue under `INPUT` using escalation ladder format (Section 10)

## 6.5 OKR-First Focus
- Check active OKR dashboards first
- Surface top Objectives/KRs + blockers before task-level churn
- Deprioritize tasks not linked to a KR (link, merge, pause, or drop)

## 6.55 Project Governance Drift Check (heartbeat + overnight)

```bash
node scripts/governance-scan.js --mode=heartbeat
```

Checks: Portfolio/Program linkage, linked Project Brief, milestone/gate count (3-6), canonical frontmatter. Queue drift to `memory/briefing-queue.md` under `INPUT`.

## 6.6 Decision-Only Heartbeat Nudges (act-first, then ask)

- Active hours: 05:00–20:00 {{TIMEZONE}}
- If last user interaction <10 minutes, stay quiet
- Act first: complete work that does not require the user
- If a decision is needed, pull from `memory/briefing-queue.md` and respect escalation cooldowns (Section 10)
- Global nudge throttle: max one nudge per 60 minutes
- Use plain English; use escalation ladder format (Section 10) for blocker asks

## 6.7 Overnight Maintenance Mode (20:00–23:00)

- Window: 20:00–23:00 {{TIMEZONE}}
- After 23:00: **Quiet Hours** (23:00–05:00) — no nudges/notifications unless urgent
- **Autonomous work CONTINUES 24/7.** Quiet hours only affect notifications, not execution.
- No motivational nudges in this window
- Every 15 minutes, run maintenance:
  - Scan projects/task lists for stale, duplicate, or contradictory items
  - Consolidate and clean task lists directly (do NOT queue consolidation as questions unless genuinely ambiguous)
  - Progress tasks that can be done autonomously
  - Spawn subagents for work not requiring the user
  - Run overnight governance scan: `node scripts/governance-scan.js --mode=overnight`
- Log short progress summary to `memory/briefing-queue.md` under `TASK`:
  ```
  ## [YYYY-MM-DD HH:MM] TASK — Overnight progress
  ```
- Include overnight progress in the morning briefing

## 6.8 Uncommitted Work Check (every heartbeat)

```bash
cd {{WORKSPACE_PATH}} && git status --porcelain | wc -l
```

- If uncommitted changes exist AND last user interaction was >30 minutes ago: commit and push.
- Commit message: summarize changed files in one line.
- Config/memory changes: push to main.
- Code changes (scripts/, skills/, workflows/): create a branch + PR instead.
- Log to today's memory: "Auto-committed N files at HH:MM"

## 7. Security Check (daily, first heartbeat after 10 AM)

1. Check OpenClaw version: `openclaw --version`
2. Compare against latest: `npm view openclaw version`
3. If update available, check release notes for security fixes
4. Queue findings to briefing (URGENT if security fix)
5. Update `memory/heartbeat-state.json` with `security.lastCheck`

### 7.5 Disk Space Check (daily)

```bash
df -h / | awk 'NR==2{print $5, $4}'
```

If free space < 15%, queue URGENT briefing: "Disk space low — risk of read-only mode and compaction failure."
Update `memory/heartbeat-state.json` with `disk.lastCheck`.

## 8. Memory Maintenance (Weekly)

- Every few days: review recent `memory/YYYY-MM-DD.md`
- Update `MEMORY.md` with significant context worth keeping long-term
- Move operational/procedural items into TOOLS.md or skills
- Clean outdated entries in MEMORY.md

## 8.5 Ontology Health Check (Weekly)

*(Skip if ONTOLOGY.md doesn't exist)*

1. **Orphan detection:** active projects serving a goal? Goals serving Mission?
2. **Staleness:** predictions past timeframe? Projects with no activity 30+ days?
3. **Alignment:** compare recent work against Mission; note drift patterns
4. Update `memory/heartbeat-state.json` with `ontology.lastHealthCheck`

## 9. Post-Session Reflection

**Default: ENABLED.** Disable with `reflection.enabled=false` in `memory/heartbeat-state.json`.

**Trigger:** conversation idle >30 minutes, reflection not yet run for session.

### Reflection Output Routing

| Memory Type | Destination |
|---|---|
| `belief`, worldview, assumption | `ONTOLOGY.md` → Beliefs |
| `prediction` | `ONTOLOGY.md` → Predictions |
| `goal_shift` | `ONTOLOGY.md` → Goals |
| `mission` / `value` | `ONTOLOGY.md` → Core Self |
| `commitment` | Project boards |
| `moment` (significant decision) | `MEMORY.md` |
| `fact` / `preference` | `MEMORY.md` |
| `principle` | `AGENTS.md` or `MEMORY.md` |
| Reflection-generated questions | Decision queue (`memory/briefing-queue.md` under `INPUT`) |

**Session ends** when: no user messages for 30+ minutes, explicit session end, or midnight rollover.

## 10. Escalation Ladder (Decision Requests)

Use this format for **every** decision request (queue or direct nudge):

```markdown
**Blocked:** [what's stuck]
**Why now:** [why this matters today]
**Options:** A) ... B) ... C) ...
**Recommended:** [which option and why]
**Default if no response by [time]:** [what I'll do]
```

### Escalation Rules

- First ask: concise, includes options + recommendation + default + deadline
- Cooldown: **minimum 4 hours** between asks on same topic
- Second nudge: only if still blocked and deadline approaching
- After 2 nudges: move to daily decision digest, not repeated pings
- Hard escalate: allowed for time-critical or risk-critical blockers
- Track in `memory/heartbeat-state.json` under `escalation.blockers[]`

## 11. Autonomy Levels Policy

| Action Type | Level | Behavior |
|---|---|---|
| Read files, search, analyze | L0 Observe | Just do it |
| Draft content, propose plan | L1 Draft | Do it, present for review |
| Git commit, file reorg, internal notes | L2 Auto-execute | Do it, notify after |
| Send email/message, publish, spend money | L3 Approval required | Ask first with escalation format |
| Delete data, change system config | L3 Approval required | Ask first |

## Briefing Queue

**Queue file:** `memory/briefing-queue.md`

When you find something noteworthy:
1. Append to queue with timestamp + category
2. Do NOT message the user directly (except Section 6.6 nudges)
3. Scheduled briefings collect and deliver queued items

**Queue format:**
```markdown
## [YYYY-MM-DD HH:MM] Category
- Item description
```

**Categories:** `URGENT` | `INPUT` | `EMAIL` | `TASK` | `INFO`

### Briefing Wiring

Morning and evening briefings must include:
- Pending INPUT items from queue
- Governance drift items
- Output formatted with the Escalation Ladder (Section 10)

Mark delivered items as cleared to avoid repeats.

## Rules

- **Never summarize heartbeat work in chat.** Reply `HEARTBEAT_OK` or `NO_REPLY`, except Section 6.6 nudges.
- **No direct messaging during heartbeats** except Section 6.6 decision asks.
- **Quiet hours** (23:00–05:00 {{TIMEZONE}}): no nudges/notifications unless urgent. **Autonomous work continues 24/7.**
- **Track checks** in `memory/heartbeat-state.json`
- **Be efficient:** use fast gate first; deep work belongs in full sessions

## When to Notify the User

- Important email requiring action
- Calendar event within 2 hours
- Blocked task needing user decision
- Genuinely urgent issue

## When to Stay Quiet (HEARTBEAT_OK)

- Quiet hours (unless urgent)
- Nothing changed since last check
- All tasks on track, no blockers
- Last check was <15 minutes ago

---

*Template provided by {{COACH_NAME}} via jarvOS*
