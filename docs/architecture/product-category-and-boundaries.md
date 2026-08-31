---
status: active
created: 2026-05-17
updated: 2026-08-31
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
- Beads for managed-software execution state, with optional tracker projections
- runtime adapters for OpenClaw, Hermes, Codex, Claude, and future clients

The runtime owns model calls, shell execution, sandboxing, scheduling,
messaging, and tool orchestration. jarvOS owns the user-controlled context and
operating contract those runtimes hydrate from and write back to.

## Product Realization Boundary

jarvOS may autonomously observe eligible AI interactions and prepare bounded,
source-backed candidates for notes, journals, memory, ontology, Projects,
skills, or work. That is how the product can construct a useful digital twin
across harnesses without treating every transcript or model statement as true.

The boundary is explicit:

- portable identities connect a mind, its installations, harness sessions,
  source events, candidates, artifacts, policies, Projects, and receipts
  without making one machine the permanent home of jarvOS;
- a candidate is immutable and non-authoritative, contains evidence pointers
  rather than raw source content, and cannot claim completion, verification,
  destination state, or Project identity;
- promotion into authoritative memory, ontology, Projects, authored notes, or
  other durable surfaces is governed by the owning writer and policy;
- a promotion receipt distinguishes a committed destination revision from an
  already-satisfied, deferred, conflicted, or failed attempt and does not
  promise universal rollback; and
- the capability truth ledger keeps specification, implementation, repository,
  verification, activation, and authority state independent, so code or
  documentation cannot masquerade as a live working capability.

This is one mind across many harnesses, not one runtime controlling every
harness. Runtime-specific capabilities remain adapters behind portable jarvOS
contracts.

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
