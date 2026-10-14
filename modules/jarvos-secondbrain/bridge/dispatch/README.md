# bridge/dispatch

Dispatch turns classifier output into capture side effects.

The bridge stays generic:

1. Classifier output describes the message: salience class, confidence, and optional keyword trigger.
2. `@jarvos/ambient/routing` turns the output into explicit CRAM action plans.
3. Dispatch matches those plans against small capture skills.
4. A matched skill writes through an adapter or package-owned API.

Current capture skills:

- `journal-entry` writes idea captures to the journal package.
- `note-creation` creates durable notes through the storage adapter and links them from the journal.
- Medium-confidence captures are ignored by default; they no longer create a journal review section.
- `memory-promotion` promotes high-confidence durable salience through a memory adapter.
- `work-intake` prepares commitment/work candidates for a tracker adapter such as Paperclip.

A skill only runs when `@jarvos/ambient`'s `authorizeCapture` predicate finds
explicit durable-capture intent (strict command, caller-set trigger, or a
keyword/bounded natural-language directive). Salience and confidence never
authorize a capture on their own; unauthorized high-confidence salience is
returned as observation-only metadata (`captured:false`, `observed:true`,
`path:'salience_observed'`), with no adapter call and no artifact (SUP-3981).

This keeps routing policy out of storage code. Obsidian is only the default adapter; another markdown or app-backed adapter can implement the same write contract.
