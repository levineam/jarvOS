# bridge/routing

Routing rules for deciding when captured context stays in Journal, becomes a durable
Note, or is promoted outward to adjacent systems.

## Current implementation

- `src/keyword-capture-router.js` — keyword-triggered capture routing
  - `idea` → journal `## 💡 Ideas`
  - substantive `idea` → standalone note linked from journal `## 💡 Ideas`
  - `note` → standalone note + journal note link
  - no explicit trigger → default vault-note bias
- `../capture/src/universal-capture.js` — jarvOS-owned CaptureEvent v2
  entrypoint for agents
- `../dispatch/src/capture-dispatcher.js` — classifier-output dispatch into capture skills
  - high-confidence idea → journal entry
  - high-confidence non-idea salience → note creation plus memory where eligible
  - medium-confidence salience → journal `## 📌 Flagged`

## Why this lives here

This is cross-package orchestration:

- `jarvos-secondbrain-journal` owns journal structure
- `jarvos-secondbrain-notes` owns note writing/schema
- `bridge/routing` decides which package path a capture should take
- `bridge/capture` owns the stable coding-tool-facing entrypoint so OpenClaw,
  Codex, Claude Code, Hermes, and future coding adapters do not need
  one-off capture rules

## Storage adapter boundary

Routing stays storage-agnostic by calling an adapter contract rather than writing
Vault files directly. The default implementation is:

- `adapters/obsidian/src/vault-storage-adapter.js`

That keeps routing policy separate from the current Obsidian/Vault storage backend.
