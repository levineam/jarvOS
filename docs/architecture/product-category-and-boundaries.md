---
status: active
created: 2026-05-17
updated: 2026-05-17
canonical: true
type: architecture
---

# jarvOS Product Category and Boundaries

jarvOS is a local-first operating layer for personal AI agents. It gives
compatible agent runtimes portable memory, notes, ontology, workflow, and
execution context so your AI can carry continuity across tools without trapping
your data in one app.

## Category

The closest category name is **portable personal-AI operating layer**.

Short variants:

- personal AI operating layer
- local-first AI operating layer
- AI context operating layer
- personal AI OS starter kit

jarvOS is not mainly a chat app, hosted SaaS, note app, generic framework, or
agent runtime. Those are neighboring categories or integration surfaces.

## Architecture Boundary

jarvOS is organized as layers:

- secondbrain for human-readable content
- memory for compact durable recall
- ontology for worldview and project meaning
- structured knowledge for graph-style recall
- skills for portable operating procedures
- Paperclip or another configured tracker for execution state
- runtime adapters for OpenClaw, Hermes, Codex, Claude, and future clients

The runtime owns model calls, shell execution, sandboxing, scheduling,
messaging, and tool orchestration. jarvOS owns the user-controlled context and
operating contract those runtimes hydrate from and write back to.

## Guardrails

- Runtime adapters are replaceable glue, not the product core.
- Markdown remains the human-readable control plane.
- Notes, memory, ontology, journal, execution state, and runtime diagnostics stay
  separate.
- Public repo content is code, templates, schemas, generic scripts, adapters,
  examples, and docs. Private notes, beliefs, journal entries, Paperclip IDs,
  machine paths, and local configuration stay outside the repo.
- The installer bootstraps visible files and local tooling; it should not turn
  jarvOS into a black box.
- Say "works with" or "adapts to" runtimes unless the file is documenting a
  specific runtime adapter.
