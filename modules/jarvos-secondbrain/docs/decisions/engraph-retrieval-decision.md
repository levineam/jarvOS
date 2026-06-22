# Engraph Retrieval Decision

Decision: defer production Engraph integration for v0.6. Keep the graph lane behind an explicit adapter/eval gate.

## Why

Engraph is directly relevant to jarvOS secondbrain retrieval: it is a local Obsidian/Markdown knowledge API with hybrid semantic search, BM25, wikilink graph traversal, temporal scoring, MCP, REST, and local model support. That maps well to the long-term goal of an agent-readable secondbrain stack.

The v0.6 release should still ship without a hard Engraph dependency because:

- `engraph` is not currently available in the local release environment.
- The checked-in `qmd-plus-graph` path is an eval harness adapter, not a real Engraph adapter.
- The generated LLM-wiki plus qmd path already has passing tests and source-backed evidence.
- Engraph introduces extra install/runtime/model surface that should not block the focused intentional-capture release.

## Gate For Integration

Integrate Engraph only when a real adapter can pass the retrieval eval pack and materially improve over qmd plus generated wiki.

Minimum gate:

1. `engraph` binary available or documented optional install path.
2. Adapter shells out to `engraph search` or calls Engraph REST/MCP without owning note writes.
3. Eval compares `qmd-only`, `qmd-plus-llm-wiki`, and `qmd-plus-engraph` on quote, decision, preference, project-context, and temporal questions.
4. Results include source paths/citations.
5. Failure mode is explicit disabled/deferred status, never silent fallback pretending graph retrieval is active.

Until that gate passes, qmd plus generated LLM-wiki remains the v0.6 retrieval baseline.
