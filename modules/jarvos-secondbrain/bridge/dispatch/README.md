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
- `flagged-review` writes medium-confidence captures to the journal `## 📌 Flagged` review section.
- `memory-promotion` promotes high-confidence durable salience through a memory adapter.
- `work-intake` prepares commitment/work candidates for a tracker adapter such as Paperclip.

This keeps routing policy out of storage code. Obsidian is only the default adapter; another markdown or app-backed adapter can implement the same write contract.
