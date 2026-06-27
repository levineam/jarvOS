# @jarvos/ontology

Worldview layer for jarvOS. Provides a reviewed hierarchy-of-meaning context:
beliefs, predictions, goals, values, identity, and project relationships for AI
coding agents.

See also: [`jarvos/ARCHITECTURE.md`](../jarvos/ARCHITECTURE.md) for the full module map.

## What this module owns

| Layer | Description |
|---|---|
| **Higher-order principles** | Organizing principles above every specific goal or belief |
| **Beliefs** | Foundational assumptions you hold about the world |
| **Predictions** | Testable, time-bound expectations (track record matters) |
| **Core self** | Mission statement, values, and key strengths |
| **Goals** | Time-bound objectives tied to core self |
| **Projects** | Organized efforts that serve one or more goals |

The agent-facing API is the ontology provider. Coding tools should consume the
bounded ontology context packet rendered by `createOntologyProvider()` or
`jarvos_hydrate`, not parse private ontology files directly.

## What this module is NOT for

| Use this instead | For |
|---|---|
| `@jarvos/memory` | Day-to-day agent-state recall (decisions, lessons, facts) |
| `@jarvos/secondbrain` | Raw journal and note content |
| Paperclip | Live task tracking and execution state |

### vs. `jarvos-memory`

`jarvos-memory` is the **agent-state** layer: compact recall that helps agents operate
across sessions. Day-to-day decisions, lessons, project-state snapshots, and durable
facts live there — not here.

### vs. `jarvos-secondbrain`

`jarvos-secondbrain` is the **content** layer: daily journals, research notes, long-form
writing. Raw capture lives there. Ontology is refined signal, not raw material.
Secondbrain evidence can create source-backed ontology candidates or inquiry
items, but review is required before promotion.

### vs. Paperclip

Live execution state — issue assignment, status, ownership, done/not-done — belongs
in Paperclip. `jarvos-ontology` does not duplicate task tracking.

## Quick Start

```bash
npm install ./modules/jarvos-ontology
```

```js
const {
  createLayer,
  createOntologyProvider,
  validateEntry,
  LAYER_NAMES,
} = require('@jarvos/ontology');

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

const provider = createOntologyProvider({ ontologyDir: './ontology' });
const packet = provider.renderAgentPacket({ maxChars: 2200 });
console.log(packet.markdown); // Bounded hierarchy-of-meaning context for agents.
```

Or use the CLI tools directly:

```bash
cd modules/jarvos-ontology
npm install
# Copy schema/templates/ to your ontology/ directory and fill them in
node scripts/validate.js --help
node scripts/render.js --help
```

Review records use Markdown plus frontmatter:

- `schema/templates/ontology-candidate.template.md` for proposed updates from
  source-backed secondbrain evidence.
- `schema/templates/inquiry-item.template.md` for durable unresolved questions.

Agents must not directly mutate ontology source files. Promote reviewed
candidates through the review workflow only.

## Data flow

Information flows into ontology from below. The direction is one-way:

```
Journal intake (jarvos-secondbrain-journal)
    │
    ▼
Notes / Memory (jarvos-secondbrain-notes, jarvos-memory)
    │
    ▼
Ontology shaping (jarvos-ontology)  ◀── you are here
```

**Memory → Ontology:** When a durable signal in memory reveals or updates a belief,
goal, prediction, value, or identity element, the extractor routes it here.

Not every memory entry becomes ontology. Ontology is refined from the most structurally
significant durable signals — the ones that define who you are, not just what you did.

## Ontology layers

| File | Layer | Contents |
|------|-------|----------|
| `1-higher-order.md` | Higher-order principles | The single organizing principle above everything else |
| `2-beliefs.md` | Beliefs | Foundational assumptions about the world |
| `3-predictions.md` | Predictions | Testable, time-bound expectations |
| `4-core-self.md` | Core self | Mission, values, strengths |
| `5-goals.md` | Goals | Time-bound objectives linked to core self |
| `6-projects.md` | Projects | Organized efforts serving one or more goals |

`schema/templates/index.md` is the blank layer map for new ontologies. The public
example fixture lives under `schema/examples/public-ontology/`; keep your filled-in
private ontology in a local `ontology/` directory outside published package files.

## CLI

```bash
# Validate the ontology
node scripts/validate.js

# View summary
node scripts/render.js --summary

# Render Mermaid relationship graph
node scripts/render.js

# Extract signals from recent memory files (dry run)
node scripts/extract.js --dry-run --days 7

# Generate combined ONTOLOGY.md (compatibility render)
node scripts/combined.js --output /tmp/ONTOLOGY.md

# Sync goals/projects to Paperclip (dry run)
node scripts/sync-to-paperclip.js --dry-run --verbose
```

## Integration with jarvos-memory

Not every memory becomes ontology. Promote into ontology when:

- A belief is durable enough to shape decisions repeatedly
- A goal is worth tracking explicitly across weeks/months
- A prediction is testable and you want a track record

Ontology does not write to memory directly. The flow is memory → ontology, not the reverse.

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

## Directory layout

```
jarvos-ontology/
├── schema/                   # Structure definitions
│   ├── heuristics.md         # Classification rules
│   ├── prompts.md            # Guided prompts for filling gaps
│   ├── templates/            # Blank templates for new ontologies
│   └── examples/             # Public example fixtures used by tests/docs
├── src/                      # Library
│   ├── index.js              # Barrel export
│   ├── provider.js           # Bounded ontology context provider
│   ├── review-workflow.js    # Review-gated promotion helpers
│   ├── reader.js             # Load & query ontology
│   ├── writer.js             # Append & update sections
│   ├── extractor.js          # Signal detection from text
│   ├── validator.js          # Integrity checks
│   ├── renderer.js           # Mermaid + combined markdown
│   └── bridge.js             # Paperclip bridge
├── scripts/                  # CLI tools
│   ├── extract.js            # Scan memory → route signals
│   ├── validate.js           # Run validation checks
│   ├── render.js             # Generate visualizations
│   ├── combined.js           # Produce single ONTOLOGY.md
│   ├── bootstrap.js          # Initialize new ontology from templates
│   └── sync-to-paperclip.js  # Push goals/projects to Paperclip
├── test/                     # Node.js test runner tests
└── docs/
    └── paperclip-bridge.md   # Paperclip integration contract (SUP-97)
```

## Tests

```bash
node --test test/*.test.js
```

## Current scope boundary

This is the canonical module for ontology data and tooling. It is **not** a migration
tool, a knowledge base, raw memory, or an execution tracker.

Out of scope:

- day-to-day operational memory (→ `jarvos-memory`)
- raw notes and journal content (→ `jarvos-secondbrain`)
- live task execution state (→ Paperclip)
- OpenClaw compaction internals (→ `lossless-claw`)
