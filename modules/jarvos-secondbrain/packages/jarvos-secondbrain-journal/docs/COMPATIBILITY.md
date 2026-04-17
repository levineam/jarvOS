# jarvos-secondbrain-journal — Compatibility Boundary

Issue: SUP-1064 (parent: SUP-1062)

## Canonical entrypoint

```
jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js
```

All journal-maintenance logic (entry creation, structure lock, section repair, auto-section refresh)
lives here. This is the **only** place that owns the journal write contract.

## Shims in clawd/scripts/

| File | Type | Status | Notes |
|---|---|---|---|
| `scripts/journal-maintenance.js` | Clean shim | Frozen, safe | Forwards all args unchanged to canonical. Keep until all automation callers are updated to use the package directly. |
| `scripts/journal-task-sync.js` | Legacy compat shim | Frozen, deprecated | Strips retired `--limit` flag, then forwards to canonical. Also exports `contentLossGuard` / `stripSection` / `comparableJournalContent` for backward-compat tests. Do not use from new code. |

## Compatibility exports in `journal-task-sync.js`

The following are **frozen legacy exports** kept only for `tests/scripts/journal-task-sync.test.js`:

- `contentLossGuard(original, updated, journalPath)` — ratio-based write guard (70% threshold)
- `stripSection(md, heading)` — strips a `##` section from markdown
- `comparableJournalContent(md)` — strips `## ✅ Tasks` before comparison

None of these are called from any production write path. The canonical journal package is the
right owner when explicit content-loss protection is added to the write path.

**Deprecation plan:** move these into `jarvos-secondbrain-journal/src/` when the canonical
package adds a content-loss guard to its own write path, and update the tests to import from
the canonical location.

## Path resolution

Path resolution is centralized in `bridge/config/jarvos-paths.js`:

```
JARVOS_VAULT_DIR  (env)
  → VAULT_NOTES_DIR / JOURNAL_DIR  (legacy env aliases)
    → jarvos.config.json paths.*  (config file in clawd root)
      → ~/Documents/Vault v3  (hardcoded fallback — override via env or config)
```

The `~/Documents/Vault v3` fallback is preserved for backward compatibility.
Production uses `jarvos.config.json` (updated to `~/Vaults/Vault v3` per SUP-1041).

## What not to do

- Do not add business logic to `scripts/journal-task-sync.js` — it is frozen.
- Do not import `contentLossGuard` from new production code — it is a deprecated test export.
- Do not create new shims in `clawd/scripts/` pointing at internal package paths — if automation
  needs a stable entrypoint, use `scripts/journal-maintenance.js`.
