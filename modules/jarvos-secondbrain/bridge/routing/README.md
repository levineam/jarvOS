# bridge/routing

Routing rules for deciding when captured context stays in Journal, becomes a durable
Note, or is promoted outward to adjacent systems.

## Current implementation

- `src/keyword-capture-router.js` — keyword-triggered capture routing
  - `idea` → journal `## 💡 Ideas`
  - substantive `idea` → journal Ideas + standalone note + journal note link
  - `note` → standalone note + journal note link
  - medium-confidence capture → journal `## 🚩 Flagged` for review
- `src/skill-contracts.js` — portable contracts for `journal-entry`,
  `note-creation`, and `idea-parking`

## Classifier contract

`classifyCaptureIntent(capture)` returns:

- `route`: `idea`, `note`, `flagged`, or `null`
- `confidence`: `high`, `medium`, or `low`
- `reviewRequired`: boolean
- `skillIds`: the contracts that should handle the plan
- `reason`: stable machine-readable explanation

High-confidence idea/note phrasing dispatches directly. Medium-confidence
captures are review-first so the system does not create durable notes from
ambiguous language.

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
