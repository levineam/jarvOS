# bridge/routing

Routing rules for deciding when captured context stays in Journal, becomes a durable
Note, or is promoted outward to adjacent systems.

## Current implementation

- `src/keyword-capture-router.js` — keyword-triggered capture routing
  - `idea` → journal `## 💡 Ideas`
  - substantive `idea` → journal Ideas + standalone note + journal note link
  - `note` → standalone note + journal note link
  - no explicit trigger → default vault-note bias

## Why this lives here

This is cross-package orchestration:

- `jarvos-secondbrain-journal` owns journal structure
- `jarvos-secondbrain-notes` owns note writing/schema
- `bridge/routing` decides which package path a capture should take

## Storage adapter boundary

Routing stays storage-agnostic by calling an adapter contract rather than writing
Vault files directly. The default implementation is:

- `adapters/obsidian/src/vault-storage-adapter.js`

That keeps routing policy separate from the current Obsidian/Vault storage backend.
