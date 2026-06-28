# jarvos-secondbrain

Canonical local content layer for the `jarvos-secondbrain` architecture.

Current local state:
- package, bridge, adapter, and docs directories exist
- root `clawd` entrypoints for journal maintenance, note writing/linting, and related routing/provenance flows delegate into `jarvos-secondbrain`
- package contract docs are maintained under package-local `docs/`
- root canonical architecture/migration/contracts docs live under `clawd/docs/`
- Paperclip remains the execution system of record
- automatic secondbrain capture, generated wiki, retrieval evals, promotion gates, and watch status are generic/public jarvOS surfaces; private vault content and raw transcripts are not part of this package

## Layout

```text
jarvos-secondbrain/
  packages/
    jarvos-ambient/
    jarvos-secondbrain-journal/
    jarvos-secondbrain-notes/
    jarvos-secondbrain-wiki/
    jarvos-memory (at jarvOS level)/
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

Path resolution is centralized in `bridge/config` through `resolveConfig()`.
The portable pattern is: **env var → `jarvos.config.json` / XDG config → homedir-relative default**.

| Env var | Description | Default |
|---|---|---|
| `JARVOS_JOURNAL_DIR` | Journal markdown files | `~/Vaults/<vault>/Journal` |
| `JARVOS_NOTES_DIR` / `VAULT_NOTES_DIR` | Notes vault directory | `~/Vaults/<vault>/Notes` |
| `JARVOS_TAGS_DIR` | Tags directory | `~/Vaults/<vault>/Tags` |
| `CLAWD_DIR` | Root clawd workspace (for config discovery) | `~/clawd` |
| `JARVOS_CONFIG_PATH` / `JARVOS_CONFIG_FILE` | Explicit config file path | unset |
| `JARVOS_VAULT_DIR` | Vault root used to derive Notes, Journal, sidecars, and generated wiki defaults | `~/Vaults/Vault v3` |
| `JARVOS_KNOWLEDGE_ARTIFACTS_DIR` | Knowledge sidecar artifacts consumed by generated wiki builds | `$JARVOS_VAULT_DIR/.jarvos/knowledge/artifacts` |
| `JARVOS_GENERATED_WIKI_DIR` | Visible generated LLM-wiki output directory | `$JARVOS_VAULT_DIR/Generated Secondbrain Wiki` |

Alternatively, set paths under `paths.*` in `jarvos.config.json`:
```json
{
  "paths": {
    "journal": "~/Documents/MyVault/Journal",
    "notes": "~/Documents/MyVault/Notes"
  }
}
```

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
current OpenClaw setup. Use `--dry-run` first when you want to inspect the
resolved paths without writing the config.

## Bootstrap choices

- Docs were copied from `clawd/docs/...` instead of moved, to avoid breaking current references during the bootstrap phase.
- Empty implementation areas are represented with tracked placeholders only.
- Bridge and adapter directories are present but intentionally contain no logic yet.

See `docs/architecture/jarvos-secondbrain-monorepo-spec.md` for the boundary model.
The public external integration inventory lives at
[the secondbrain external integration inventory](https://github.com/levineam/jarvOS/blob/main/docs/architecture/secondbrain-external-integrations.md).

## Ambient Package

`packages/jarvos-ambient` exposes `@jarvos/ambient`, the portable intent layer
for salience classification, keyword capture detection, retroactive capture
selection, and capture-event validation. It is intentionally side-effect free:
host apps classify first, build routing plans second, then apply those plans
through their own adapters.

## Universal Capture Entrypoint

Agents should call the jarvOS-owned capture entrypoint instead of raw-writing
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

Supported coding-tool sources include `openclaw`, `codex`, `claude-code`,
`hermes`, and `custom:<slug>` for future coding agents. The entrypoint
normalizes the input into `CaptureEvent` v2, routes it through
`jarvos-ambient`, writes through the canonical Obsidian adapter, and uses the
note optimizer so durable notes enter the secondbrain stack. Lightweight `idea:`
captures stay in the Journal Ideas section; substantive ideas become
source-backed notes linked from Ideas.

The canonical journal path is `Journal/YYYY-MM-DD.md`. Agents must not create
guessed daily journal files under `Notes/`.

## Automatic Secondbrain Stack

The public stack is source-backed and rebuildable:

- `CaptureEvent` v2 records source tool, actor, capture mode, privacy tier, origin, and evidence.
- Session source adapters normalize OpenClaw, Codex, Claude Code, and Hermes
  records into `CaptureEvent` v2.
- Note sidecars write generalized `knowledgeUnits` with stable IDs, source attribution, evidence, confidence, privacy decisions, and downstream eligibility.
- `packages/jarvos-secondbrain-wiki` compiles generated Markdown wiki pages from sidecars. Generated pages are derived artifacts and can be deleted/rebuilt.
- Retrieval evals compare qmd-only, qmd plus generated wiki, and qmd plus graph retrieval with expected source evidence.
- Promotion gates keep memory and ontology downstream of cited, privacy-eligible knowledge units.
- The watch surface reports artifacts, private skips, qmd freshness, generated wiki state, queue counts, eval status, and stale/failure signals.

See `docs/architecture/automatic-secondbrain-public-boundary.md` for the public/private packaging boundary and local-to-public release path.
See the public
[secondbrain external integration inventory](https://github.com/levineam/jarvOS/blob/main/docs/architecture/secondbrain-external-integrations.md)
for the status of Obsidian-compatible Markdown, QMD, GBrain, memory-wiki,
generated LLM-wiki, agentmemory, Engraph, and related optional tools.

## Generated LLM-wiki

Generated LLM-wiki is the visible, rebuildable Markdown view over source-backed
knowledge sidecars. It is useful for inspection, Obsidian navigation, and
retrieval evals. It is not canonical memory: source notes, journals, provenance,
and `.jarvos/knowledge` sidecars remain authoritative.

Build it with:

```bash
npm run wiki:build
```

By default, the build reads artifacts from
`$JARVOS_VAULT_DIR/.jarvos/knowledge/artifacts` and writes generated Markdown
under `$JARVOS_VAULT_DIR/Generated Secondbrain Wiki`. Both locations can be
overridden:

```bash
npm run wiki:build -- \
  --artifacts-dir "$JARVOS_KNOWLEDGE_ARTIFACTS_DIR" \
  --output-dir "$JARVOS_GENERATED_WIKI_DIR"
```

The output directory is marked with `.jarvos-generated-wiki.json`. Rebuilds clean
only the generated `concepts/`, `sources/`, `daily/`, and `index.md` surfaces
inside that managed directory. A nonempty unmanaged output directory fails
closed so jarvOS cannot accidentally clean a user's unrelated vault folder.

When manually-created Obsidian notes need to enter the secondbrain stack, run
manual note maintenance first so the notes have sidecars, then run
`npm run wiki:build` to refresh the visible generated wiki.
