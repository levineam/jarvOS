# Manual Note Maintenance

Manual Obsidian notes bypass the canonical note writer, so they need a controlled backfill path into the secondbrain stack. Use `manual-notes-maintenance` as the one primitive for audits, sampled applies, batch applies, and routine checks.

## Safety Contract

- Dry-run is the default. Nothing writes unless `--apply` is present.
- Apply mode only normalizes frontmatter the canonical linter can infer safely.
- Note bodies are never rewritten by this command.
- Sensitive or private notes still get local artifacts and QMD pending records, but are removed from automatic GBrain and memory-wiki queues.
- QMD freshness remains explicit. A `qmd-refresh-pending.json` entry means search is not fresh until the QMD refresh path runs.
- Public docs and tracker comments should use `--summary-path` evidence, not full JSON output, because full JSON includes note paths, titles, and hashes.

## Baseline Audit

Run a full dry-run and write a private-safe summary:

```bash
node scripts/manual-notes-maintenance.js \
  --dry-run \
  --summary-path /tmp/manual-notes-maintenance-summary.json
```

The summary contains only counts and gate decisions:

- scanned notes
- candidate notes
- frontmatter violation counts
- sidecar and queue predictions
- sensitive skip counts
- errors count
- whether apply is allowed
- whether QMD refresh or queue review is required

If `gates.applyAllowed` is false, stop and review the full local output. Do not run full apply when unfixable frontmatter or command errors are present.

## Sample Apply

After the audit is clean, run a bounded sample:

```bash
node scripts/manual-notes-maintenance.js \
  --apply \
  --since-state \
  --limit 5 \
  --summary-path /tmp/manual-notes-maintenance-sample-summary.json
```

Verify:

- edited files only changed frontmatter
- note body content stayed byte-for-byte intact after the frontmatter block
- `.jarvos/knowledge/artifacts/` contains sidecars
- `optimization-audit.json` covers the sampled notes
- `qmd-refresh-pending.json` includes sampled notes
- safe notes entered the GBrain and memory-wiki queues
- private/sensitive notes did not enter automatic queues

## Batch Apply

Use small batches until the output is boring:

```bash
node scripts/manual-notes-maintenance.js \
  --apply \
  --since-state \
  --limit 25 \
  --summary-path /tmp/manual-notes-maintenance-batch-summary.json
```

Only use an unbounded apply after a clean full dry-run, a clean sample apply, and at least one clean batch review.

## Downstream Refresh

Apply mode writes queue and freshness state. It does not import into GBrain, rebuild generated wiki pages, or refresh QMD inline.

After reviewed apply output:

1. Refresh QMD before trusting search.
2. Review GBrain and memory-wiki queues before import.
3. Rebuild generated wiki output if the local stack uses it.
4. Run secondbrain status and retrieval evals.

The issue or routine can close only when the summary counts, QMD disposition, queue disposition, and retrieval/status result are all recorded.

## Routine Placement

Prefer a Paperclip Routine or tracked on-demand run over local cron for this workflow. A good routine runs a bounded since-state pass and reports one private-safe summary:

```bash
node scripts/manual-notes-maintenance.js \
  --apply \
  --since-state \
  --watch \
  --max-runs 1 \
  --summary-path /tmp/manual-notes-maintenance-routine-summary.json
```

Routine watch surface:

- Cadence: daily or on-demand after manual note sessions.
- Cost posture: local file scan and deterministic optimization only.
- Success signal: summary shows `ok: true`, low or expected candidate count, zero errors, and expected queue/QMD counts.
- Failure signal: nonzero errors, unfixable frontmatter, stale QMD pending state after refresh, or missing routine run.
- Owner/action if bad: pause apply/import, preserve the summary, and inspect the full local JSON output.
- Delivery channel: Paperclip issue/routine result with private-safe counts only.

## Generic Pattern

For any portable AI operating system, route manually created Markdown through the same deterministic contract as AI-created notes: audit first, repair only inferable metadata, write lossless sidecars, queue downstream systems instead of importing inline, and keep search freshness explicit.
