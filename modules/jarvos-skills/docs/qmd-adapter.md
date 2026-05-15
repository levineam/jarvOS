# QMD Optional Adapter

QMD is not part of the default jarvOS skill bundle.

jarvOS uses this boundary:

- **Operating-system skills** define agent behavior: planning, rule wiring,
  context hygiene, and cron safety.
- **Retrieval adapters** provide lookup capability: broad markdown search,
  exact note retrieval, transcript search, or semantic search.

QMD belongs in the second category. It can be a strong local markdown-search
backend for an Obsidian-compatible vault, but the core jarvOS workflow should not
depend on a QMD skill wrapper being present.

## When to add QMD

Add QMD as an adapter when a runtime needs:

- broad local markdown lookup across a vault
- exact note retrieval before reading large files
- comparison retrieval alongside GBrain or another structured recall layer
- transcript search where the QMD index already covers session exports

## Install pattern

Keep the default jarvOS skill bundle clean, then document QMD separately in the
runtime setup:

```bash
# Example only; use the install command for your runtime/distribution.
qmd index /path/to/vault
qmd search "project kickoff decision"
```

If your runtime requires a formal skill wrapper around QMD, ship it as an
optional adapter skill and mark it `default: false` in the runtime manifest.
