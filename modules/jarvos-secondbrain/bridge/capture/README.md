# bridge/capture

jarVOS-owned universal capture entrypoint for intentional notes and ideas.

This bridge is the runtime-neutral surface agents should call when Andrew says
`note: ...`, `make a note`, `idea: ...`, `save this`, or similar intentional
capture prompts.

## Contract

```text
Any AI agent
-> CaptureEvent v2
-> jarvos-ambient routing
-> Obsidian Notes/Journal adapter
-> knowledge sidecars, qmd pending state, generated wiki input, memory queues
```

OpenClaw and Lobster can enforce or adapt this path, but they do not own the
abstraction. Claude Code, Codex, OpenClaw, Hermes, Grok Bot, ChatGPT, and future agents
should all call the same root shim:

```bash
node scripts/jarvos-capture.js
```

The command reads a JSON object from stdin. Minimum recommended input:

```json
{
  "source": "claude-code",
  "actor": { "type": "assistant", "name": "Claude Code" },
  "captureMode": "prompted",
  "privacyTier": "local-private",
  "origin": { "kind": "prompt", "ref": "session-or-message-id" },
  "evidence": [{ "type": "message", "text": "note: durable note text" }],
  "text": "note: durable note text"
}
```

Use `custom:<slug>` for a future agent that does not yet have a first-class
source enum. Do not raw-write daily journal files. The canonical journal is
`Journal/YYYY-MM-DD.md`; durable notes live under `Notes/`.

## Routing

- `note:` / `make a note` / `save this` create a note and exactly one journal
  backlink.
- Raw `idea:` / `Idea:` captures append to Journal Ideas only by default, even
  when the idea is a long single-line thought.
- Substantive `idea:` captures create a note and link that note from Journal
  Ideas only when the capture explicitly sets `substantive:true`, supplies a
  title, or sets a durable-note flag such as `createDurableNote:true`.
- Non-capture text is ignored unless a classifier/salience path explicitly
  routes it.

The Obsidian adapter disables the note writer's automatic today-link while
running routed captures so the routing plan owns the single intended backlink
and date.

## Identified durable evidence (optional)

Callers that need restart-safe retries can add an explicit `date` and
`captureIdentity` to a durable note capture:

```json
{
  "text": "note: The workshop date is undecided.",
  "date": "2030-02-03",
  "captureIdentity": {
    "namespace": "workshop-import",
    "id": "opening",
    "revision": "draft B",
    "relation": {
      "kind": "corrects",
      "target": { "namespace": "workshop-import", "id": "opening", "revision": "draft A" }
    }
  }
}
```

Namespace, local ID and revision are exact, case-sensitive nonempty strings
(up to 512 characters, without control characters). Revisions are opaque: a new
revision alone does not supersede an earlier one. `relation` is optional;
`corrects` and `withdraws` are supplied assertions linking to an exact target,
not target resolution or semantic inference. Only the same complete identity
and revision is an invalid self-target. Originals remain separate notes.

The extension requires an explicit valid date and a route that creates a
durable note. Journal-only captures do not yet support it. Legacy captures
without the extension keep their existing behavior. Identified note filenames
carry an identity digest before title coalescing; equal titles with distinct
identities remain distinct. The writer still assigns `jarvos_note_id`.

Request equality uses recursively key-sorted JSON of the routed capture and
its note/journal storage effects. String bytes and array order are significant;
undefined fields and the ignored caller-supplied `frontmatter.jarvos_note_id`
are excluded. Generated note IDs and clock-derived writer metadata are not
inputs. Changed canonical body, attribution, provenance, evidence, metadata,
references, date or relation under the same identity conflicts before backlink
dispatch. The original planned operation is reused after restart, including
its generated ID and create payload; retry does not regenerate create as append.
Direct routing callers must supply a stable title or nonempty content; a
clock-derived fallback title is rejected for identified captures.

`capture_identity` and `capture_provenance` frontmatter contain JSON strings
round-tripped through the existing note serializer/parser. Put supplied
Project references in existing `frontmatter` fields; this does not create or
modify a Project, commitment or Outcome.

One logical note also has a journal backlink. Success still requires all
promised artifacts to be acknowledged by the canonical writer. Planned,
deferred, conflicting and `unknown_after_dispatch` receipts are not success.
Use existing mutation reconciliation for uncertain writes: only app-owned
invariant readback can acknowledge an effect whose reply was lost, and an
unsatisfied ambiguous write remains blocked rather than being blindly retried.
Existing journals need no repeated scaffold operation; missing-journal
scaffolding uses the same stable operation on retry.

`tests/capture-lineage-storage.test.js` proves these foundation behaviors with
synthetic inputs, disposable destinations, a real mutation service/ledger and
a filesystem-backed simulated Obsidian API. Readback and retries run in new
processes. This is not live Obsidian, Sync, cross-harness, analysis-engine or
real-user acceptance evidence.
The root `npm test` includes the focused `npm run test:capture-lineage` gate.
