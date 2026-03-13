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

## Autonomy Levels

| Level | What the assistant can do |
|-------|--------------------------|
| **L0 Observe** | Read, search, analyze |
| **L1 Draft** | Draft content, propose plans |
| **L2 Auto-execute** | Git commits, file reorgs, internal notes, task updates |
| **L3 Approval required** | Send/publish/spend/delete/change config |

Default: L2 for internal work, L3 for anything external or destructive.
