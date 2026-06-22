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
abstraction. Claude Code, Codex, OpenClaw, Hermes, ChatGPT, and future agents
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
- Lightweight `idea:` captures append to Journal Ideas only.
- Substantive `idea:` captures create a note and link that note from Journal
  Ideas.
- Non-capture text is ignored unless a classifier/salience path explicitly
  routes it.

The Obsidian adapter disables the note writer's automatic today-link while
running routed captures so the routing plan owns the single intended backlink
and date.
