# jarvos-secondbrain-wiki

Generated Markdown wiki compiler for JarvOS secondbrain sidecars.

The generated wiki is a derived retrieval layer, not canonical truth. Source
notes, journals, and sidecar artifacts remain authoritative; generated pages can
be deleted and rebuilt from `.jarvos/knowledge/artifacts/*.json`.

## Output

- `index.md` root index
- `concepts/*.md` concept pages from knowledge units and concepts
- `sources/*.md` source-note pages with citations
- `daily/*.md` daily indexes when artifacts include journal backlink metadata

Every generated page starts with a rebuild-safe header.
