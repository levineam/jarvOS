# jarvos-secondbrain bridge/synthesis

Journal-spine synthesis is the portable pattern for turning a daily journal into reusable knowledge work:

1. Read a recent window of journal entries.
2. Follow their `[[wiki-links]]` into durable notes.
3. Expand one hop through note relationships.
4. Cluster candidates by shared concepts and retrieval seeds.
5. Return a tight candidate set and prompts an LLM can use to propose explore/expand work.

The bridge does not create a special Ideas datastore. The journal stays the chronological spine, notes stay the durable graph, and synthesis is a derived view over both.

## CLI

```bash
node scripts/journal-spine-synthesis.js --date=today --days=7 --json
node scripts/journal-spine-synthesis.js --date=2026-05-20 --write
node scripts/journal-spine-synthesis.js --mcp
```

Use environment variables or `jarvos.config.json` for paths:

- `JARVOS_NOTES_DIR` / `VAULT_NOTES_DIR`
- `JARVOS_JOURNAL_DIR` / `JOURNAL_DIR`
- `JARVOS_KNOWLEDGE_DIR`

The MCP surface is intentionally plain JSON: any local assistant can wrap `buildMcpSurface(report)` as a tool result without depending on a specific MCP SDK.
