# @jarvos/memory

Agent-state memory module for jarvOS. Provides compact recall that helps your AI agent
persist knowledge across sessions without turning Memory into a second content store.

## What this module owns

- Stable **facts** worth reusing later
- **Preferences** that change future decisions
- Durable **decisions** with rationale
- **Lessons** and corrections
- **Project-state** snapshots worth carrying across days

## What this module is NOT for

| Use this instead | For |
|---|---|
| `@jarvos/secondbrain` | Day-by-day journal and raw capture |
| `@jarvos/ontology` | Structured worldview (beliefs, goals, values) |
| Paperclip | Live task tracking and execution state |

## Quick Start

```js
const { createMemoryRecord, getMemoryClasses } = require('@jarvos/memory');

// Create a durable memory
const result = createMemoryRecord({
  class: 'lesson',
  content: 'Prefer env-var path resolution over hardcoded home directories.',
  rationale: 'Enables portability across machines and CI environments.',
  source: '2026-03-27',
  confidence: 0.95,
});

console.log(result.record); // { class: 'lesson', content: '...', id: '...', ... }

// List available memory classes
console.log(getMemoryClasses()); // ['fact', 'preference', 'decision', 'lesson', 'project-state']
```

## Memory Schema

```json
{
  "schema": "jarvos-memory/v1",
  "class": "lesson",
  "content": "Compact human-readable statement.",
  "rationale": "Why this matters.",
  "source": "2026-03-27",
  "confidence": 0.9,
  "id": "abc123",
  "createdAt": "2026-03-27T00:00:00.000Z"
}
```

## Promotion Rules

Promote into Memory only when the result is:
- Useful in a future session
- Compact enough to scan quickly
- Specific enough to source
- Better suited to recall than reopening a long note
