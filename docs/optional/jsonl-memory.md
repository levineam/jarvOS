# JSONL Memory — Optional Advanced Memory System

> **⚠️ OPTIONAL — Not part of the default jarvOS setup.**
>
> The default memory system uses markdown files (`memory/YYYY-MM-DD.md`, `MEMORY.md`). That's sufficient for most setups and is what you should start with.
>
> This document describes a structured JSONL-based memory layer for setups that need searchable, structured retrieval across large amounts of agent history. Adopt it when the markdown approach starts to break down — not before.

---

## When to Adopt JSONL Memory

Start considering JSONL memory when you hit one of these thresholds:

- **Volume:** Your daily memory files consistently exceed 500 lines, and you're losing important context to truncation.
- **Search friction:** You find yourself running `grep` across dozens of memory files to find a past decision or conversation.
- **Multi-agent coordination:** Multiple subagents need to share memory state without clobbering each other's writes.
- **Pattern detection:** You want to surface recurring themes, decision patterns, or failure modes across time.

**If none of these apply, stick with markdown.** JSONL adds overhead that isn't worth it at small scale.

---

## Schema

### experiences.jsonl

Append-only log of significant events, interactions, and completed work.

```jsonl
{"id":"exp_001","timestamp":"2026-02-28T18:00:00Z","type":"task_complete","session":"main","summary":"Refactored authentication module","outcome":"success","tags":["code","auth","backend"],"project":"[[My App Project Board]]","duration_min":45}
{"id":"exp_002","timestamp":"2026-02-28T19:30:00Z","type":"conversation","session":"main","summary":"User decided to pivot newsletter focus to AI tools","outcome":"decision","tags":["newsletter","strategy"],"project":null,"duration_min":20}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (`exp_NNNN`) |
| `timestamp` | ISO8601 | When this happened |
| `type` | enum | `task_complete` \| `conversation` \| `research` \| `error` \| `milestone` |
| `session` | string | Session ID or name |
| `summary` | string | One-sentence description |
| `outcome` | string | `success` \| `failure` \| `partial` \| `decision` \| `learning` |
| `tags` | array | Free-form tags for search |
| `project` | string\|null | Linked project board (wiki-link format) |
| `duration_min` | int\|null | How long this took |

---

### decisions.jsonl

Log of significant decisions made — by you, by the user, or jointly.

```jsonl
{"id":"dec_001","timestamp":"2026-02-28T14:00:00Z","question":"Should we use Supabase or PlanetScale for the DB?","decision":"Supabase","rationale":"Better DX, auth built-in, fits budget","alternatives":["PlanetScale","self-hosted Postgres"],"confidence":"high","reversible":true,"tags":["infrastructure","database"],"project":"[[My App Project Board]]"}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (`dec_NNNN`) |
| `timestamp` | ISO8601 | When the decision was made |
| `question` | string | The decision that needed to be made |
| `decision` | string | What was decided |
| `rationale` | string | Why this option was chosen |
| `alternatives` | array | Other options that were considered |
| `confidence` | enum | `high` \| `medium` \| `low` |
| `reversible` | bool | Can this be easily undone? |
| `tags` | array | Free-form tags |
| `project` | string\|null | Linked project board |

---

### failures.jsonl

Log of failures, errors, and things that went wrong — with root cause and fix.

```jsonl
{"id":"fail_001","timestamp":"2026-02-28T11:00:00Z","what_failed":"Subagent hallucinated a function signature","root_cause":"prompt didn't include current type definitions","impact":"low","fix":"inject relevant types into spawn prompt","prevention":"Added to spawn-code-subagent.lobster template","tags":["subagent","prompt-engineering"],"session":"main"}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (`fail_NNNN`) |
| `timestamp` | ISO8601 | When the failure occurred |
| `what_failed` | string | What broke or went wrong |
| `root_cause` | string | Why it happened |
| `impact` | enum | `high` \| `medium` \| `low` |
| `fix` | string | What was done to resolve it |
| `prevention` | string | How to prevent recurrence |
| `tags` | array | Free-form tags |
| `session` | string | Session where it happened |

---

## File Locations

```
memory/
  jsonl/
    experiences.jsonl
    decisions.jsonl
    failures.jsonl
```

---

## Append Discipline (Important)

JSONL is append-only. **Never edit or delete existing lines.** If something is wrong, add a correction entry:

```jsonl
{"id":"exp_001_correction","timestamp":"2026-03-01T09:00:00Z","type":"correction","corrects":"exp_001","note":"Duration was actually 20 min, not 45"}
```

This preserves audit history and prevents race conditions when multiple agents write to the same file.

---

## Search Patterns

```bash
# Find all decisions tagged "infrastructure"
grep '"infrastructure"' memory/jsonl/decisions.jsonl | python3 -c "import sys,json; [print(json.dumps(json.loads(l), indent=2)) for l in sys.stdin]"

# Find all failures with high impact
grep '"impact":"high"' memory/jsonl/failures.jsonl

# Find all experiences for a specific project
grep '"My App Project Board"' memory/jsonl/experiences.jsonl

# Count decisions by confidence level
grep -o '"confidence":"[^"]*"' memory/jsonl/decisions.jsonl | sort | uniq -c
```

---

## Integration with Heartbeat

If you adopt JSONL memory, add this to your heartbeat's memory maintenance section:

```bash
# Log today's session summary to experiences.jsonl
node scripts/log-experience.js --type=session_summary --session=main
```

And update your reflection routing to write structured entries:

```bash
# Route a decision to decisions.jsonl
node scripts/log-decision.js --question="..." --decision="..." --rationale="..."
```

---

## When to Migrate Back to Markdown

JSONL memory adds complexity. If you find yourself spending more time maintaining the memory system than using it, that's a signal to simplify. Markdown files with good naming and `grep` gets you 80% of the way there with 20% of the overhead.

The goal is useful memory, not sophisticated memory infrastructure.

---

*See also: `docs/optional/context-engineering.md` for tools that make structured memory more powerful.*
