# Context Management Overload

Use this playbook when a long-running session starts stalling, forgetting fresh instructions, or failing with context-size or prompt-too-large errors.

## Common signals

- The agent repeats itself or loses track of the active task
- Tool calls slow down sharply or fail after large reads
- Summaries become vague after a long session with many injected files
- The runtime surfaces prompt-size, overflow, or compaction-related failures

## Immediate containment

1. Pause non-essential automation so the failing session stops accumulating more context.
2. Start a fresh session instead of trying to rescue an overloaded one indefinitely.
3. Re-enter with the smallest viable context set: the active task, one short status note, and only the files needed for the next step.
4. Move state out of chat and into a markdown handoff note before resuming work.
5. Resume with one bounded task, not a multi-project catch-up.

## Recovery pattern

### 1) Create a short handoff note

Capture only:

- current objective
- completed work
- open blocker
- next one or two actions

If the handoff note is more than a screenful, it is probably too large.

### 2) Trim live context aggressively

- Drop old logs, stack traces, and large pasted outputs from the active session
- Prefer links or filenames over pasting full documents into chat
- Load one project board or one brief at a time instead of the whole workspace

### 3) Separate durable memory from working memory

- Keep durable decisions in stable files such as plans, briefs, or memory notes
- Keep execution scratch work in a smaller session note that can be archived or replaced
- Archive verbose incident detail instead of keeping it in the active loop forever

### 4) Re-enable automation gradually

After a stable fresh-session run, turn background jobs back on in this order:

1. read-only or reporting tasks
2. low-risk maintenance tasks
3. write-capable or autonomous execution loops

If the session destabilizes again, roll back to the previous stage.

## Prevention rules

- Keep the active context small and task-specific
- Prefer concise file summaries over large chat transcripts
- Split reference material from execution material
- Rotate or compact scratch notes before they become long-running dumps
- Use canary periods before enabling always-on automation in a new workspace

## When to escalate

Escalate beyond normal cleanup if overload returns across multiple fresh sessions, or if the failure appears tied to model/runtime behavior rather than workspace size. In those cases, capture a short repro, keep the failing context bundle small, and investigate the runtime separately from the workspace content.

For rollout guidance, pair this with `docs/dogfood/phase-b-canary-runbook.md`.
