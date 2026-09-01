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

## Runtime modes and ownership

jarvOS has no load-bearing harness. A compatible runtime is one optional way
to host a jarvOS interaction, never the permanent owner of the product's
identity, context, or governance contract. Runtime modes are intentionally
parallel:

- **Native runtime mode:** a harness runs its own model, tools, scheduling,
  delivery, and native session lifecycle. Native session identifiers and their
  storage remain harness-owned.
- **jarvOS service mode:** jarvOS-owned services provide portable context,
  policy, candidate, and receipt boundaries to compatible callers. Active
  Assistant is a jarvOS-owned service boundary in this mode; it is not the
  load-bearing owner of a particular harness.
- **Compatibility-read mode:** a harness may read compatible jarvOS context
  through an adapter or documented file/API contract. The read direction is
  from jarvOS-owned portable context to the harness; it does not import a
  harness's private session state, require a harness to be installed, or grant
  jarvOS ownership of native sessions.

Portable conversation identity, explicit mappings from native sessions where a
harness safely exposes them, and cross-surface promotion receipts remain
jarvOS-owned contracts. A mapping is metadata, not a takeover: it cannot mint,
rename, replay, or infer a native session identity.

Conformance is tiered so an adapter cannot borrow confidence from another
harness: contract/fixture conformance proves portable shape; adapter
conformance proves a named compatibility reader; and installed or live proof,
when a future adapter elects to provide it, proves only that named adapter.
The current foundation provides contract/fixture conformance only. It does not
claim adapter, installed, or live behavior.

## Product Realization Boundary

The product architecture permits a future adapter to observe eligible AI
interactions and prepare bounded, source-backed candidates for notes, journals,
memory, ontology, Projects, skills, or work. That future path could help
construct a useful digital twin across harnesses without treating every
transcript or model statement as true. This draft foundation implements no
source adapter, candidate storage, or promotion consumer.

The boundary is explicit:

- portable identities connect a mind, its installations, harness sessions,
  source events, candidates, artifacts, policies, Projects, and receipts
  without making one machine the permanent home of jarvOS;
- an asserted candidate is immutable and non-authoritative, contains evidence
  pointers rather than raw source content, and cannot claim completion,
  verification, destination state, or Project identity;
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
