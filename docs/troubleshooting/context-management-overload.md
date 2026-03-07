# Context management overload

Use this note when a jarvOS session becomes too large, too noisy, or too fragmented for the assistant to keep working reliably.

## Symptoms

- repeated loss of task context across turns
- duplicated asks or summaries
- slow or inconsistent execution on an otherwise simple task
- a growing pile of decisions that are only present in chat, not in files

## Immediate recovery

1. Stop asking for new work in the overloaded session.
2. Move the current state into files the system already expects, such as the project brief, plan, briefing queue, or memory notes.
3. Summarize the open task in a short handoff note: goal, current status, blockers, and next recommended action.
4. Start a fresh session and point the assistant at the updated files instead of the old chat transcript.

## Prevention

- keep long-lived facts in markdown files instead of chat
- route unresolved decisions into the briefing queue
- split unrelated work into separate sessions or boards
- prefer concise proof-of-work updates over long conversational recaps

## When to escalate

Escalate the issue if a fresh session still cannot recover from the file state. That usually means the project documents are underspecified, contradictory, or missing the next action.
