# @jarvos/ontology

Worldview layer for jarvOS. Provides the structured belief graph, predictions, goals,
values, and identity model for your AI agent.

## What this module owns

| Layer | Description |
|---|---|
| **Higher-order principles** | Organizing principles above every specific goal or belief |
| **Beliefs** | Foundational assumptions you hold about the world |
| **Predictions** | Testable, time-bound expectations (track record matters) |
| **Core self** | Mission statement, values, and key strengths |
| **Goals** | Time-bound objectives tied to core self |
| **Projects** | Organized efforts that serve one or more goals |

## What this module is NOT for

| Use this instead | For |
|---|---|
| `@jarvos/memory` | Day-to-day agent-state recall (decisions, lessons, facts) |
| `@jarvos/secondbrain` | Raw journal and note content |
| Paperclip | Live task tracking and execution state |

## Quick Start

```js
const { createLayer, validateEntry, LAYER_NAMES } = require('@jarvos/ontology');

// List available layers
console.log(LAYER_NAMES);
// ['higher-order', 'belief', 'prediction', 'core-self', 'goal', 'project']

// Create an ontology entry
const entry = createLayer('belief', {
  statement: 'Reliable automation compounds faster than heroic one-off effort.',
  confidence: 0.9,
  source: 'memory/lessons',
});

console.log(entry);
// { layer: 'belief', id: '...', statement: '...', confidence: 0.9, createdAt: '...' }

// Validate an entry
const { valid, errors } = validateEntry(entry);
console.log(valid); // true
```

## Ontology File Structure

By convention, ontology layers live in `ontology/<layer>/` as YAML or JSON files:

```
ontology/
  higher-order/
  beliefs/
  predictions/
  core-self/
  goals/
  projects/
```

The `ONTOLOGY.md` template in `templates/` gives you the complete Markdown-based format
for writing your ontology in a human-readable, agent-parseable form.

## Integration with jarvos-memory

Not every memory becomes ontology. Promote into ontology when:
- A belief is durable enough to shape decisions repeatedly
- A goal is worth tracking explicitly across weeks/months
- A prediction is testable and you want a track record
