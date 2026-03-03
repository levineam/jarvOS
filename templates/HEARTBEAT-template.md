<!-- jarvOS HEARTBEAT Template v1.1.2 | Updated: 2026-02-17 | Added: governance drift checks + CIL loop automation contract -->

# HEARTBEAT.md — Proactive Check-In

When you receive a heartbeat poll, work through this checklist. **Do not skip steps.** If nothing needs attention after all checks, reply `HEARTBEAT_OK`.

## 1. Resume Active Work

- Check `memory/WORKING.md` or today's `memory/YYYY-MM-DD.md` for tasks in progress
- If a task was left mid-way, **resume it** before doing anything else
- Check for any pending user requests that haven't been addressed

## 2. Notifications & Mentions

- If notification tools are configured, check for unread mentions or messages
- Queue any findings — do NOT send replies directly during heartbeat
- Log important notifications in today's memory file

## 3. Email Check

*(Skip if no email tool configured)*

**Cadence (default):** Active hours, roughly hourly.

1. Check unread (and recent) messages, prioritizing:
   - Messages from known contacts
   - Family logistics / childcare / school
   - Travel & reservations (Airbnb, hotel, flights, check-in/out)
   - Deadlines, cancellations, confirmations, urgent language
2. **Do NOT reply during heartbeat** — queue items for the user's next session
   - Tag items that need a reply or confirmation
3. Auto-archive only safe routine notifications **when no action keywords are present**
   - Never auto-archive travel/reservation/security/family logistics emails
4. Log important emails in today's memory file and update `memory/heartbeat-state.json` with the last review timestamp

## 4. Calendar Check

*(Skip if no calendar tool configured)*

- Check events for the next 24-48 hours
- Flag anything requiring preparation or action
- If an event is within 2 hours, consider notifying the user

## 5. Journal Maintenance

- Ensure vault directories exist at `{{VAULT_PATH}}/Notes`, `{{VAULT_PATH}}/Journal`, `{{VAULT_PATH}}/Tags`. If any are missing (first run or accidental deletion), auto-create them before continuing.
- Ensure today's journal entry exists at `{{VAULT_PATH}}/Journal/YYYY-MM-DD.md`
- If the journal is empty or only has frontmatter, populate template sections:
  - `## ✅ Tasks` — Pull active tasks
  - `## 🎯 Current Focus` — What's the main priority?
  - `## 📅 Today's Calendar` — Upcoming events
  - `## 📝 Notes` — Links to any notes created today
  - `## 💡 Ideas` — Capture zone for quick thoughts
  - `## 📓 Journal Entry` — End-of-day reflection
- Update task statuses if any have changed
- Enforce **journal structure lock** on every maintenance pass:
  - Keep exactly these six sections present and in order: Tasks, Current Focus, Today's Calendar, Notes, Ideas, Journal Entry
  - Write updates inside the right section (no ad-hoc append-only logs)
  - If drift is detected, normalize structure immediately before moving on
- Trim bloat weekly — consolidate duplicates, merge overlaps, archive stale fragments (queue to briefing if needed)

## 6. Task Management

- Review active tasks — any completed? blocked? overdue?
- Update task statuses in project boards and task files
- If a task has been stalled for 7+ days, flag internally (surface during conversation, not heartbeat)
- If a blocked item requires user input, queue it under `🧭 INPUT`

### Recommend→Do + watchlist artifact capture (canonical reference)
Apply the policy in `TOOLS.md` (`Recommend→Do + Watchlist capture policy`) as the source of truth.
During heartbeat execution, perform the required watchlist artifacts in the same workflow (note + project-board task + journal link).

## 6.5 OKR-First Focus
- Check active OKR dashboards first (per Portfolio)
- Surface top Objectives/KRs + blockers before task‑level churn
- Deprioritize tasks not linked to a KR (link, merge, pause, or drop)

## 6.55 Project Governance Drift Check (heartbeat + overnight)

Run a governance scan and queue blockers when drift exists:

```bash
node scripts/governance-scan.js --mode=heartbeat
```

Checks:
- missing Portfolio/Program linkage
- missing linked Project Brief
- missing/out-of-range milestone or decision gates (must be 3-6)
- missing canonical frontmatter on project artifacts (`status/type/project/created/updated/author`)
- Incubator review/expiry due

Queue drift items to `memory/briefing-queue.md` under `🧭 INPUT`.

## 6.555 Cron Policy Enforcement (anti-congestion)

Before creating or editing autonomous cron jobs, enforce `TOOLS.md` (`Cron Job Policy`) as the canonical source.
Validate session targeting, wake mode, scheduling/density guardrails, delivery routing, and output/noise constraints per that policy.

If a proposed cron change violates policy, queue a `🧭 INPUT` blocker instead of applying it silently.

## 6.557 Live Plan upkeep (canonical reference)

Use `TOOLS.md` (`Live Plan by Default Policy`) as the source of truth.

During heartbeat/overnight maintenance:
- Run `node scripts/live-plan-check.js`.
- If an active project is missing/stale/non-compliant, queue a `🧭 INPUT` or `📋 TASK` item with the exact fix.
- Do not redefine Live Plan rules here; keep policy centralized in TOOLS.md.

## 6.56 Continuous Integration of Learning (CIL) loop

Run the CIL watchdog on hourly cadence to keep project/runtime/template learning integrated with low noise:

```bash
node scripts/cil-loop-watchdog.js
```

Automation contract:
- Cron name: `cil-loop-watchdog`
- Recommended schedule: `7 * * * *` in {{TIMEZONE}}
- Session target: `isolated`
- Delivery mode: none (queue/state only)

CIL outputs:
- Deduped event/state ledger: `memory/cil-loop-state.json`
- Runtime summary: `memory/heartbeat-state.json` under `cilLoop.*`
- Integration queue items: `memory/briefing-queue.md` under `📋 TASK — CIL INTEGRATION`

Guardrails:
- Queue only net-new integration actions (capture/promotion/propagation/drift)
- Enforce cooldown and per-run cap to avoid repeats
- Never send autonomous external messages from CIL loop

## 6.6 OKR‑first heartbeat nudges (act‑first, then ask)
- Active hours only: 05:00–20:00 {{TIMEZONE}} (check every 15 minutes)
- If last user interaction <10 minutes, stay quiet (HEARTBEAT_OK)
- Scan top goals/OKR dashboards + active work
- Act first: immediately spawn subagents for any work you can do without user input
  - Every `sessions_spawn` call must include explicit `model`
  - Planning/orchestration or unknown scope → `openai-codex/gpt-5.3-codex`
  - Narrow execution chunks (1–3 files, clear acceptance criteria) → `openai-codex/gpt-5.3-codex-spark`
- Only message {{USER_NAME}} if blocked by a decision or human‑only step
- If no decision needed, stay silent
- Enforce cooldown: at most one nudge per 60 minutes (track in memory/heartbeat-state.json)
- Use plain English; no PM jargon
- Message format:
  ```
  I’m already working on:
  - X
  - Y

  I need you to decide:
  - A vs B
  ```

## 6.65 Daily Cross-Portfolio Momentum Sweep (HIGH PRIORITY, standing)

- Run once per calendar day ({{TIMEZONE}}) at the first eligible heartbeat pass, including overnight maintenance windows.
- Scope: every active in-process project tracked in `Tasks.md` / linked project boards.
- Safety guardrail: enforce once-per-day dedupe via `memory/heartbeat-state.json` (do not rerun the full sweep multiple times in the same day except manual force).
- Default behavior: complete at least **one autonomous forward action per active project per day**.
- If blocked, surface blocker as **Next Best Action ({{USER_NAME}})** under `🧭 INPUT` with:
  - `Blocked by:`
  - `Clear ask:`
  - `Why now:`
  - `Default if no reply:`
- Stale/archive guardrail: **never** mark stale/archive candidate from inactivity alone. Only do so after a real forward attempt and an explicit {{USER_NAME}} decline to proceed.
- Write one queue summary entry under `📋 TASK — Daily Momentum Sweep` listing each active project + (`action taken` or `blocker surfaced`).

## 6.7 Work-While-I-Sleep Maintenance Mode (20:00–05:00)

- Canonical quiet-hours source: `TOOLS.md` (`Overnight autonomous mode`).
- Window: 20:00–05:00 {{TIMEZONE}} (quiet outreach unless urgent).
- From **23:00–05:00** (work-while-I-sleep window), continue autonomous maintenance/task execution silently.
- **No motivational nudges** in this window (do not run 6.6 nudges).
- No routine notifications in this window; notify only for genuinely urgent items.
- **Exception:** reflection watchdog processing/surfacing still runs on its own cadence (Section 9), with dedupe/cooldown intact.
- Every 15 minutes, run maintenance work:
  - Scan active projects and task lists for anything stale, duplicated, or contradictory
  - Consolidate/merge/clean up task lists (remove duplicates, clarify next actions, archive dead ends). **Execute consolidation directly — do NOT queue consolidation work as questions or decision items for {{USER_NAME}}. Only escalate to the briefing queue if genuine ambiguity exists that requires human judgment.**
  - Progress any tasks that can be done autonomously without {{USER_NAME}} (drafts, research, code scaffolds, organizing)
  - Spawn subagents for work that doesn’t need {{USER_NAME}}’s input
    - Every `sessions_spawn` call must include explicit `model`
    - Planning/orchestration or unknown scope → `openai-codex/gpt-5.3-codex`
    - Narrow execution chunks (1–3 files, clear acceptance criteria) → `openai-codex/gpt-5.3-codex-spark`
  - Run governance drift scan in overnight mode:
    ```bash
    node scripts/governance-scan.js --mode=overnight
    ```
- Log a short progress summary to `memory/briefing-queue.md` under category `📋 TASK` with timestamp label **Overnight progress**. Use this header format:
  ```
  ## [YYYY-MM-DD HH:MM] 📋 TASK — Overnight progress
  ```
- **Include Overnight progress summary in the 5:30 AM brief.**

## 7. Security Check (daily, first heartbeat after 10 AM)

1. Check OpenClaw version: `openclaw --version`
2. Compare against latest: `npm view openclaw version`
3. If update available, check release notes for security fixes
4. Queue findings to briefing (URGENT if security fix)
5. Update memory/heartbeat-state.json with security.lastCheck timestamp

## 8. Memory Maintenance (Weekly)

- Every few days, review recent `memory/YYYY-MM-DD.md` files
- Update `MEMORY.md` with significant learnings worth keeping long-term
- Clean up outdated entries in MEMORY.md

## 8.5 Ontology Health Check (Weekly)

*(Skip if `{{VAULT_PATH}}/My_Personal_Ontology/` doesn't exist)*

1. **Orphan detection:**
   - Check if all active Projects serve a Goal
   - Check if all Goals serve Core Self Mission
   - Flag any orphans to briefing queue

2. **Staleness checks:**
   - Predictions past their timeframe → queue for review
   - Projects with no activity in 30+ days → flag
   - Goals with no active Projects → surface

3. **Alignment verification:**
   - Compare recent work against stated Mission
   - Note any drift patterns

4. Update `memory/heartbeat-state.json` with `ontology.lastHealthCheck` timestamp

## 9. Post-Session Reflection

**Default: ENABLED** — Reflection runs automatically. To disable, set `REFLECTION_ENABLED=false` in environment or `reflection.enabled=false` in state.

**Runtime trigger:** explicit hourly cadence (24h) + idle/cooldown gates.

### Reflection Automation Contract

- Cron name: `reflection-watchdog-hourly`
- Recommended schedule: `5 * * * *` in {{TIMEZONE}}
- Command:
  ```bash
  node scripts/reflection-watchdog.js --idle-minutes=30 --cooldown-minutes=55
  ```
- Reflection processing/surfacing is not suppressed by overnight/quiet-hours maintenance rules.
- Surfacing should stay deduped + throttled (new decision signal only).

**Actions:**
1. Check `memory/heartbeat-state.json` for `reflection.lastReflectionTime` and `reflection.enabled`
2. If `enabled: false`, skip this section
3. On each hourly tick, run reflection when idle/cooldown gates pass
4. Process reflection outputs according to routing logic below
5. Update `memory/heartbeat-state.json` with reflection timestamp and dedupe fields

### Reflection Output Routing

**Memory Types → Destinations:**
- `commitment` → Check if relates to existing project boards. If yes, add task or update status. If unclear, queue for review with context.
- `moment` (significant decision) → Add to relevant MOC's "Actionable Insights" section. If no clear MOC, create entry in main MEMORY.md under "Critical Lessons Learned"
- `fact`/`preference` → Update MEMORY.md under appropriate section (About {{USER_NAME}}, Preferences & Patterns, or create new subsection)
- `principle` → Evaluate for inclusion in AGENTS.md (if process/behavior) or MEMORY.md (if personal learning)
- Questions generated → Add to `memory/briefing-queue.md` under "💭 REFLECTION QUESTIONS" for next briefing

### Session Definition

**Session ends** when:
- No user messages for 30+ minutes
- Explicit session end command
- New day begins (midnight rollover)

**Reset reflection eligibility** on:
- First user message after idle period
- Midnight rollover (new day = new session)

### Opt-Out

To disable reflection, set in `memory/heartbeat-state.json`:
```json
{
  "reflection": {
    "enabled": false
  }
}
```

Or set environment variable: `REFLECTION_ENABLED=false`

## Briefing Queue

**Queue file:** `memory/briefing-queue.md`

When you find something noteworthy during a heartbeat:
1. Append it to `memory/briefing-queue.md` with timestamp and category
2. Do NOT message {{USER_NAME}} directly
3. The next scheduled briefing will collect and deliver queued items (including governance drift entries)

**Queue format:**
```markdown
## [YYYY-MM-DD HH:MM] Category
- Item description
```

**Categories:**
- `🚨 URGENT` — Time-sensitive items requiring immediate attention
- `🧭 INPUT` — Requires user decision/approval/clarification
- `📧 EMAIL` — Important emails surfaced
- `📋 TASK` — Task updates, completions, blockers
- `💡 INFO` — General information worth noting

## Rules

- **Never summarize heartbeat work to the user.** Only reply HEARTBEAT_OK or NO_REPLY, except for 6.6 decision‑only nudges.
- **NO direct messaging** during heartbeats — except for 6.6 decision‑only nudges.
- Follow quiet-hours policy from `TOOLS.md`: outreach is quiet from **20:00–05:00** (urgent-only), and autonomous maintenance continues in the **23:00–05:00** work-while-I-sleep window. Reflection watchdog remains exempt and may surface deduped decision signals.
- **Track your checks** in `memory/heartbeat-state.json` to avoid redundant work
- **Be efficient** — heartbeats should be quick. If a task needs deep work, note it and handle in a full session

## When to Notify the User

- Important email requiring action
- Calendar event within 2 hours
- Blocked task that only the user can unblock
- Something genuinely urgent

## When to Stay Quiet (HEARTBEAT_OK)

- During TOOLS.md quiet-hours (20:00–05:00), keep outreach silent unless urgent; continue autonomous work silently during 23:00–05:00
- Nothing new since last check
- All tasks on track, no blockers
- Last check was <15 minutes ago (scans can run every 15m; nudges only if ≥60m since last nudge).

---

*Template provided by {{COACH_NAME}} via jarvOS*
