# jarvOS Governance

Governance is how your assistant handles decisions, escalations, and approval gates without losing things or overstepping.

## Escalation Ladder

When your assistant is blocked and needs your input, it uses this format:

```markdown
**Blocked:** [what's stuck]
**Why now:** [why this matters today]
**Options:** A) ... B) ... C) ...
**Recommended:** [best option and why]
**Default if no response by [time]:** [what I'll do]
```

Rules:
- First ask is concise, with options and a recommended default
- Minimum 4 hours between asks on the same topic
- After 2 nudges, move to digest (not repeated pings)
- Hard escalate only for time-critical or risk-critical blockers

## Approval Gates

Some actions require explicit user approval:

| Action | Approval Required? |
|--------|-------------------|
| Read files, search, analyze | No — always autonomous |
| Draft content, propose plans | No — autonomous |
| Git commits, file reorgs, internal notes | No — autonomous |
| **Send/publish externally** | **Yes — explicit approval** |
| **Spend money** | **Yes — explicit approval** |
| **Delete user data** | **Yes — explicit approval** |
| **Change system config** | **Yes — explicit approval** |

"Yes", "okay", "sounds good" are NOT approval. Only explicit "send it" / "do it" / "approved" counts.

## Decision Queue

When decisions accumulate, they go into a briefing queue rather than interrupting you:
- Items are timestamped and categorized
- Morning/evening briefings pull from the queue
- Each item uses the escalation ladder format
- Stale items (>7 days) get flagged for cleanup

## Milestone Gates

For governed projects, milestones have:
- **Exit criteria** — concrete, verifiable conditions
- **Decision owner** — who approves moving to the next phase
- **Stop/pivot condition** — when to kill or redirect

The assistant can flag: "Milestone 2 exit criteria aren't met yet — here's what's missing."

## Content Drift Detection

Files accumulate content that doesn't belong in them. This is the most common form of governance drift in AI-assisted systems.

**The pattern:** Your assistant needs to save a rule. TOOLS.md is always loaded, so it's the path of least resistance. Over time, TOOLS.md fills with policy, model routing, and process rules that have nothing to do with tools.

**The fix has three parts:**

1. **Routing guide:** Each file has a stated purpose. Before writing, check: "Does this match the file's purpose?" (See AGENTS.md § Where Rules Live)

2. **Enforcement:** Don't rely on the assistant "remembering" the rule. Build a check that detects misplaced content and flags it. A simple lint that scans section headers against expected patterns works well.

3. **Periodic cleanup:** Run drift detection on a schedule. When violations are found, migrate content to where it belongs. This is maintenance, not failure — drift is natural.

**Why this matters:** Every token in an always-loaded file competes for attention budget. Bloated files degrade reasoning quality. Keeping files focused isn't just organizational — it directly affects how well your assistant thinks.

## Autonomy Levels

| Level | What the assistant can do |
|-------|--------------------------|
| **L0 Observe** | Read, search, analyze |
| **L1 Draft** | Draft content, propose plans |
| **L2 Auto-execute** | Git commits, file reorgs, internal notes, task updates |
| **L3 Approval required** | Send/publish/spend/delete/change config |

Default: L2 for internal work, L3 for anything external or destructive.
