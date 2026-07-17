# Ontology Review Workflow

jarvOS ontology is reviewed hierarchy-of-meaning context. Automated systems may
notice signals, but they do not directly rewrite ontology source files.

## Records

Use Markdown files with frontmatter:

- `schema/templates/ontology-candidate.template.md` for proposed beliefs,
  predictions, goals, values, higher-order principles, core-self updates, or
  project relationships.
- `schema/templates/inquiry-item.template.md` for durable questions that may or
  may not eventually update ontology.

Every record needs source evidence. A candidate without `source.type` and
`source.ref` is invalid because the ontology should stay source-backed.

## Statuses

Supported statuses are:

- `new`
- `reviewing`
- `promoted`
- `dismissed`
- `resolved`
- `stale`

Promotion requires `status: reviewing`, `reviewer`, `reviewed_at`, source
evidence, `proposed_target`, and `proposal`.

## Review Surface

The preferred human review surface is Obsidian Bases over the Markdown records.
If Bases is unavailable, Dataview or plain Markdown lists are sufficient because
the records are ordinary files.

## Promotion

The library exposes `promoteReviewedCandidate(candidate, options)`. It refuses
unreviewed, stale, dismissed, already-promoted, or source-less records.

The bundled CLI validates the gate and prints the promotion plan:

```bash
node modules/jarvos-ontology/scripts/promote-reviewed.cjs path/to/candidate.md --dry-run
```

The current CLI is intentionally conservative: it proves whether a candidate is
eligible and emits the next record shape. Applying the resulting ontology edit is
an explicit operator step or a caller-provided `apply` integration.
