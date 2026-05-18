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
| `JARVOS_TIMEZONE` | USER.md/system timezone/`UTC` | Local IANA timezone for journal dates |
| `JARVOS_JOURNAL_MAINTENANCE_SCHEDULE` | `1 0 * * *` | journal-maintenance cron schedule (12:01 AM local) |
| `JARVOS_JOURNAL_MAINTENANCE_TIMEZONE` | resolved local timezone | Explicit cron timezone for journal-maintenance |

Legacy env var aliases still honored: `CLAWD_DIR` → `JARVOS_CLAWD_DIR`,
`VAULT_NOTES_DIR` → `JARVOS_NOTES_DIR`, `JOURNAL_DIR` → `JARVOS_JOURNAL_DIR`

### Config file

Copy `jarvos.config.example.json` → `$JARVOS_CLAWD_DIR/jarvos.config.json` to
configure paths without env vars. Env vars always take precedence.

`journal-maintenance` defaults to `1 0 * * *` (12:01 AM, the first safe
minute of the local day). OpenClaw runtime wiring should pass the resolved
`timezone` field from `adapters/openclaw/src/journal-maintenance-job.js`; if no
explicit job timezone is configured, jarvOS uses `JARVOS_TIMEZONE`,
`jarvos.config.json`, `USER.md`, system timezone detection, then `UTC` as the
last-resort fallback.

```jsonc
// ~/clawd/jarvos.config.json (example)
{
  "timeZone": "America/New_York",
  "jobs": {
    "journalMaintenance": {
      "schedule": "1 0 * * *",
      "timezone": "America/New_York"
    }
  },
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

### Capture Your Thoughts contract

`@jarvos/secondbrain` v0.2.0 exposes a small portable capture API:

- `classifyCaptureIntent(capture)` returns `route`, `confidence`,
  `reviewRequired`, `reason`, and `skillIds`.
- `buildRoutingPlan(capture)` turns the classifier output into storage actions.
- `dispatchCaptureToSkills(capture, { adapter })` executes the plan through the
  adapter contract.

Skill contracts are plain JavaScript objects exported as `SKILL_CONTRACTS`:

- `journal-entry` appends a dated markdown list item to a journal section.
- `note-creation` creates an Obsidian-compatible note and links it from the
  journal Notes section.
- `idea-parking` parks an idea in the journal Ideas section, with an optional
  durable note for substantive ideas.

Default routing:

- "I have an idea about X" → journal `## 💡 Ideas`.
- "make a note about Y" → note file + journal `## 📝 Notes` wiki-link.
- Medium-confidence captures such as "remember this" / "capture this" →
  journal `## 🚩 Flagged` for review, without creating a note.

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
