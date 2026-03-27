# @jarvos/secondbrain

Content layer for jarvOS. Manages your agent's journal and notes — the raw capture
surface for day-to-day context, research, and long-form content.

## What this module owns

| Surface | Description |
|---|---|
| **Journal** | Day-by-day chronological log and raw capture |
| **Notes** | Longer-form research, architecture, and source material |
| **Bridge** | Routes content to downstream systems (Paperclip, ontology) |

## What this module is NOT for

| Use this instead | For |
|---|---|
| `@jarvos/memory` | Compact agent-state recall (decisions, lessons, facts) |
| `@jarvos/ontology` | Structured worldview (beliefs, goals, values) |
| Paperclip | Live task tracking and execution state |

## Quick Start

```bash
npm install ./modules/jarvos-secondbrain
```

```bash
cd modules/jarvos-secondbrain
npm install
# Copy jarvos.config.example.json → ~/clawd/jarvos.config.json and fill in your paths
JARVOS_VAULT_DIR=/path/to/your/vault node bridge/config/jarvos-paths.js
```

## Configuration & path discovery

All path resolution is handled by `bridge/config/jarvos-paths.js` — a shared module
imported by all packages. No hardcoded user-specific paths exist in the source.

### Environment Variables

Path resolution follows: **env var → `jarvos.config.json` → `os.homedir()`-relative default**

| Env var | Default | Purpose |
|---------|---------|---------|
| `JARVOS_CLAWD_DIR` | `~/clawd` | Clawd/workspace root |
| `JARVOS_VAULT_DIR` | `~/Documents/Vault v3` | Obsidian vault root |
| `JARVOS_JOURNAL_DIR` | `$JARVOS_VAULT_DIR/Journal` | Daily journal directory |
| `JARVOS_NOTES_DIR` | `$JARVOS_VAULT_DIR/Notes` | Notes directory |
| `JARVOS_TAGS_DIR` | `$JARVOS_VAULT_DIR/Tags` | Tags directory |
| `JARVOS_WORKSPACE` | `~/clawd` | Workspace root (alias) |

Legacy env var aliases still honored: `CLAWD_DIR` → `JARVOS_CLAWD_DIR`,
`VAULT_NOTES_DIR` → `JARVOS_NOTES_DIR`, `JOURNAL_DIR` → `JARVOS_JOURNAL_DIR`

### Config file

Copy `jarvos.config.example.json` → `$JARVOS_CLAWD_DIR/jarvos.config.json` to
configure paths without env vars. Env vars always take precedence.

```jsonc
// ~/clawd/jarvos.config.json (example)
{
  "paths": {
    "vault":   "~/Documents/MyVault",
    "journal": "~/Documents/MyVault/Journal",
    "notes":   "~/Documents/MyVault/Notes"
  }
}
```

## Content Flow

```
Raw capture (journal/notes)
  → jarvos-secondbrain (content layer)
    → jarvos-memory (compact retained state)
      → jarvos-ontology (worldview / belief graph)
        → Paperclip (live execution)
```

## Layout

```text
jarvos-secondbrain/
├── packages/
│   ├── jarvos-secondbrain-journal/
│   └── jarvos-secondbrain-notes/
├── bridge/
│   ├── config/jarvos-paths.js   # shared path resolution
│   ├── paperclip/
│   ├── provenance/
│   └── routing/
├── adapters/
│   ├── obsidian/
│   └── openclaw/
└── docs/
    ├── architecture/
    ├── contracts/
    └── migration/
```

## Bootstrap choices

This initial pass is intentionally structure-first:

- package, bridge, adapter, and docs directories now exist
- package contract docs have been copied into package-local `docs/` folders
- canonical umbrella docs have been copied into root `docs/`
- no executable logic has been migrated yet
- Paperclip remains the execution system of record

See `docs/architecture/jarvos-secondbrain-monorepo-spec.md` for the boundary model.

## Current scope boundary

This is a **bootstrap monorepo skeleton**, not a runtime migration.

Out of scope for this bootstrap:

- changing the actual vault or journal format
- moving content out of existing Obsidian vaults
- replacing OpenClaw compaction or `lossless-claw`
