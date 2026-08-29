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
exclusive creation, re-reads it, and reports a verified idempotent outcome. In
the same scheduled pass it may add missing embeds for the current date and
previously created dates to an existing pure-generated `Journaling.md` index.
It never rewrites an existing daily file, rebuilds or reorders the index, or
touches an index containing human prose.

Human CLI checks:

```bash
node modules/jarvos-secondbrain/scripts/journal-health.js --json
node modules/jarvos-secondbrain/scripts/journal-health-alarm.js
node modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js \
  --create-if-missing --json
```

Host schedulers may invoke the creation-only command after injecting explicit
configuration, but scheduler delivery and operational evidence stay outside
this package. The stdio MCP health action is read-only; MCP ensure is reserved
for an explicit user request or host-declared journal-maintenance trigger.

## Sync with an Existing jarvOS Installation

When a new harness such as Hermes should reuse an existing secondbrain, make
`jarvos-secondbrain` own the vault handoff instead of adding harness-specific
path instructions. From the public jarvOS checkout, inspect the sync plan first:

```bash
jarvos sync \
  --vault "$HOME/Vaults/MyVault" \
  --workspace "$PWD" \
  --name "Your Name" \
  --timezone Area/City \
  --dry-run
```

Rerun without `--dry-run` to create the config. The command validates that the
vault contains `Notes/`, `Journal/`, and `Tags/`, then writes a
`jarvos.config.json` whose shared paths all point at the existing vault. It
never writes inside the vault, rejects symlinked config targets, and refuses to
replace a different existing config. A compatible existing config lets
`jarvos sync --workspace "$PWD" --dry-run` reuse its configured vault, name, and
timezone without repeating those flags. After that, any harness using `resolveConfig()` reads and writes through
the same Journal, Notes, and Tags surfaces as the configured host. Run
`jarvos doctor --profile minimal --workspace "$PWD"` afterward; a successful
config handoff does not by itself claim the rest of the harness is installed.

The lower-level `onboard:shared-vault` npm script remains available for module
consumers, with the same config-only and no-overwrite safety contract.

## Bootstrap choices

- Empty implementation areas are represented with tracked placeholders only.
- Bridge and adapter directories contain the portable routing seams; host
  integrations remain injectable and optional.

See `docs/architecture/jarvos-secondbrain-monorepo-spec.md` for the boundary model.

## Vault mutation ownership

Authored Markdown does not count as saved merely because a filesystem write
completed. The top-level mutation service records the intent, sends live
creates and latest-content transforms through Obsidian's `app.vault` API, and
waits for app-owned readback before returning `committed`. Notes, journals,
backlinks, project pages, session threads, and maintenance repairs all compose
this same lifecycle.

If Obsidian is unavailable, a host may authorize only a safe exclusive create
or exact-hash local replacement. The result is
`saved_locally_sync_pending`, retained outside the vault, and must later be
reconciled through Obsidian. Use:

```bash
JARVOS_VAULT_ROOT=/path/to/vault npm run health:vault-mutations
JARVOS_VAULT_ROOT=/path/to/vault npm run maintain:vault-mutations
```

Sync verification is a separate, optional status. Obsidian has no supported
per-file Sync API, so the private inspector is disabled by default and returns
only bounded `converged`, `pending`, `diverged`, or `unknown` projections.

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
`grok-bot`, `chatgpt`, and `custom:<slug>` for future agents. The entrypoint normalizes the
input into `CaptureEvent` v2, routes it through `jarvos-ambient`, writes through
the canonical Obsidian adapter, and uses the note optimizer so durable notes
enter the secondbrain stack. Lightweight `idea:` captures stay in the Journal
Ideas section; substantive ideas become source-backed notes linked from Ideas.

Host runtimes that intercept strict capture commands must follow the
[hard-capture host-adapter contract](docs/contracts/HARD_CAPTURE_HOST_ADAPTERS.md):
one public grammar, one receipt-derived response, and one native pre-model
terminal owner.

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
