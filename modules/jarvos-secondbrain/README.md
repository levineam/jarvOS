# jarvos-secondbrain

Canonical local content layer for the `jarvos-secondbrain` architecture.

Public package state:
- package, bridge, adapter, and docs directories provide the portable secondbrain
  contract
- host entrypoints may delegate journal, note, routing, and provenance work into
  this package without changing its ownership rules
- package contract docs are maintained under package-local `docs/`
- Paperclip remains an optional execution-state integration
- automatic capture, generated wiki, retrieval evals, promotion gates, and
  watch status are generic jarvOS surfaces; private vault content and raw
  transcripts are not part of this package

## Layout

```text
jarvos-secondbrain/
  packages/
    jarvos-ambient/
    jarvos-secondbrain-journal/
    jarvos-secondbrain-notes/
    jarvos-secondbrain-wiki/
    jarvos-memory (at JarvOS level)/
  bridge/
    config/
    paperclip/
    provenance/
    routing/
  adapters/
    claude-code/
    codex/
    openclaw/
    obsidian/
    session-source/
  docs/
    architecture/
    contracts/
    migration/
```

## Environment Variables

Path resolution is centralized in `bridge/config`. Non-mutating consumers may
retain compatibility defaults, but journal mutation uses the stricter
`resolveJournalConfig()` boundary: **explicit environment/configuration →
fail closed**.

| Env var | Description | Default |
|---|---|---|
| `JARVOS_JOURNAL_DIR` | Explicit journal Markdown directory for mutation | none; required unless configured below |
| `JOURNAL_DIR` | Legacy explicit journal-directory alias | none |
| `JARVOS_TIMEZONE` | Explicit IANA timezone for journal dates | none; required for mutation |
| `JARVOS_VAULT_DIR` | Explicit vault root; derives `<vault>/Journal` when no journal path is set | none |
| `JARVOS_NOTES_DIR` / `VAULT_NOTES_DIR` | Notes directory for note capture | host/configured |
| `JARVOS_TAGS_DIR` | Tags directory | host/configured |
| `JARVOS_CONFIG_PATH` / `JARVOS_CONFIG_FILE` | Explicit config file path | unset |

Alternatively, set paths under `paths.*` in `jarvos.config.json`:
```json
{
  "paths": {
    "journal": "~/Documents/MyVault/Journal",
    "notes": "~/Documents/MyVault/Notes"
  }
}
```

For journal mutation, timezone may be `user.timezone`, `user.timeZone`,
`timezone`, or `timeZone` in that config. The process `TZ` value is not an
implicit journal fallback. See the [journal install contract](../../docs/journal-install-contract.md)
for the full precedence table and compatibility rules.

## Journal lifecycle and agent access

The package-owned lifecycle creates only the missing current-date file with
exclusive creation, re-reads it, and reports a verified idempotent outcome. It
does not repair an existing daily file or the derived `Journaling.md` index.

Human CLI checks:

```bash
node modules/jarvos-secondbrain/scripts/journal-health.js --json
node modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js \
  --create-if-missing --json
```

Host schedulers may invoke the creation-only command after injecting explicit
configuration, but scheduler delivery and operational evidence stay outside
this package. The stdio MCP health action is read-only; MCP ensure is reserved
for an explicit user request or host-declared journal-maintenance trigger.

## Shared-Vault Runtime Onboarding

When a new runtime such as Hermes should reuse an existing secondbrain, make
`jarvos-secondbrain` own the vault handoff instead of adding runtime-specific
path instructions. Run the shared-vault onboarding helper from the runtime's
workspace:

```bash
npm --prefix jarvos-secondbrain run onboard:shared-vault -- \
  --vault "$HOME/Vaults/MyVault" \
  --workspace "$PWD" \
  --config "$PWD/jarvos.config.json"
```

The helper validates that the vault contains `Notes/` and `Journal/`, then writes
a `jarvos.config.json` whose `paths.vault`, `paths.notes`, and `paths.journal`
all point at the existing vault. After that, any runtime using
`resolveConfig()` writes through the same Journal and Notes surfaces as the
configured host. Use `--dry-run` first when you want to inspect the
resolved paths without writing the config.

## Bootstrap choices

- Empty implementation areas are represented with tracked placeholders only.
- Bridge and adapter directories contain the portable routing seams; host
  integrations remain injectable and optional.

See `docs/architecture/jarvos-secondbrain-monorepo-spec.md` for the boundary model.

## Ambient Package

`packages/jarvos-ambient` exposes `@jarvos/ambient`, the portable intent layer
for salience classification, keyword capture detection, retroactive capture
selection, and capture-event validation. It is intentionally side-effect free:
host apps classify first, build routing plans second, then apply those plans
through their own adapters.

## Universal Capture Entrypoint

Agents should call the jarVOS-owned capture entrypoint instead of raw-writing
Markdown or using runtime-specific note rules:

```bash
printf '%s\n' '{
  "source": "codex",
  "actor": { "type": "assistant", "name": "Codex" },
  "captureMode": "prompted",
  "privacyTier": "local-private",
  "origin": { "kind": "prompt", "ref": "codex:session-message" },
  "evidence": [{ "type": "message", "text": "note: capture this architecture decision" }],
  "text": "note: capture this architecture decision"
}' | node scripts/jarvos-capture.js
```

Supported source tools include `openclaw`, `codex`, `claude-code`, `hermes`,
`chatgpt`, and `custom:<slug>` for future agents. The entrypoint normalizes the
input into `CaptureEvent` v2, routes it through `jarvos-ambient`, writes through
the canonical Obsidian adapter, and uses the note optimizer so durable notes
enter the secondbrain stack. Lightweight `idea:` captures stay in the Journal
Ideas section; substantive ideas become source-backed notes linked from Ideas.

The canonical journal path is `Journal/YYYY-MM-DD.md`. Agents must not create
guessed daily journal files under `Notes/`.

## Journal Backlink Recovery

When a note is written but its daily journal backlink is deferred, use the
[recovery operations guide](docs/operations/journal-backlink-recovery.md).
It starts with a non-mutating queue report; applying a retry or manually
reconciling a moved note requires an explicit `--apply`.

## Automatic Secondbrain Stack

The public stack is source-backed and rebuildable:

- `CaptureEvent` v2 records source tool, actor, capture mode, privacy tier, origin, and evidence.
- Session source adapters normalize OpenClaw, Codex, and Claude Code records into `CaptureEvent` v2.
- Note sidecars write generalized `knowledgeUnits` with stable IDs, source attribution, evidence, confidence, privacy decisions, and downstream eligibility.
- `packages/jarvos-secondbrain-wiki` compiles generated Markdown wiki pages from sidecars. Generated pages are derived artifacts and can be deleted/rebuilt.
- Retrieval evals compare qmd-only, qmd plus generated wiki, and qmd plus graph retrieval with expected source evidence.
- Promotion gates keep memory and ontology downstream of cited, privacy-eligible knowledge units.
- The watch surface reports artifacts, private skips, qmd freshness, generated wiki state, queue counts, eval status, and stale/failure signals.

See `docs/architecture/automatic-secondbrain-public-boundary.md` for the public/private packaging boundary and local-to-public release path. See [the public-safe inventory of active, optional, dogfood, and deferred external integrations](https://github.com/levineam/jarvOS/blob/main/docs/architecture/secondbrain-external-integrations.md).
