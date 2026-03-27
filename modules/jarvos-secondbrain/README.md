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

```js
const { createJournalEntry, createNote, resolveJournalDir } = require('@jarvos/secondbrain');
const path = require('path');

// Resolve journal directory (respects JARVOS_JOURNAL_DIR env var)
const journalDir = resolveJournalDir();
console.log(journalDir); // ~/Documents/Vault v3/Journal

// Create a journal entry object (does not write to disk)
const entry = createJournalEntry({
  date: '2026-03-27',
  title: 'Daily capture',
  body: 'Completed SUP-462 — module stubs shipped.',
  tags: ['jarvos', 'progress'],
});

// Create a note reference
const note = createNote({
  title: 'Architecture decisions',
  body: 'Decision: use env-var path resolution...',
  tags: ['architecture'],
});
```

## Environment Variables

Path resolution follows: **env var → `jarvos.config.json` → `os.homedir()`-relative default**

| Env var | Description | Default |
|---|---|---|
| `JARVOS_JOURNAL_DIR` | Journal markdown files | `~/Documents/Vault v3/Journal` |
| `JARVOS_NOTES_DIR` | Notes vault directory | `~/Documents/Vault v3/Notes` |
| `JARVOS_TAGS_DIR` | Tags directory | `~/Documents/Vault v3/Tags` |
| `JARVOS_WORKSPACE` | Workspace root | `~/clawd` |

## Content Flow

```
Raw capture (journal/notes)
  → jarvos-secondbrain (content layer)
    → jarvos-memory (compact retained state)
      → jarvos-ontology (worldview / belief graph)
        → Paperclip (live execution)
```
