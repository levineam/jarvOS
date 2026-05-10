---
status: active
created: 2026-02-19
updated: 2026-05-10
canonical: true
type: decision
project: ""
author: both
---

# jarvOS — Architecture

This is the canonical architecture note for jarvOS.

**Related:** jarvOS - Architecture & Design, jarvOS - Config Management Architecture

## 1) Layer Model: OpenClaw vs jarvOS

jarvOS is a product/system layer that runs on top of OpenClaw runtime primitives.

### Layer A — OpenClaw Runtime (platform substrate)

Responsibilities:
- Agent runtime + model orchestration
- Tool execution surface (filesystem, shell, browser, messaging, nodes, etc.)
- Session lifecycle, cron/job scheduling, delivery channels
- Safety envelope and policy enforcement hooks

### Layer B — jarvOS Operating Patterns (system behavior)

Responsibilities:
- Workspace operating rules (`AGENTS.md`, `HEARTBEAT.md`, governance policies)
- Reusable workflows (briefings, watchdogs, sync loops, publication pipelines)
- Project + task operating cadence (boards, briefs, gates, anti-thrash)
- Knowledge lifecycle (capture → promote → propagate)

### Layer C — Customer/Instance Adaptation (deployment edges)

Responsibilities:
- Persona/context files (`SOUL.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`)
- Customer-specific schedules, integrations, and tone
- Local policy or domain-specific runbooks

## 2) Major Subsystems

1. **Core Workspace Contract**
   - Canonical files and behavior inheritance
   - Configuration ownership boundaries (coach-owned vs instance-owned)

2. **Execution & Automation Loop**
   - Cron-driven watchdogs and maintenance loops
   - Briefing queues, dedupe/state handling, no-spam guarantees

3. **Governance & Delivery System**
   - Project boards + briefs + milestone/decision gates
   - Priority policy (`P0`–`P3`), blocked-state surfacing, review cadence

4. **Knowledge & Documentation Propagation**
   - Internal canonical notes (vault)
   - Curated GBrain pages for people, companies, projects, concepts, meetings, and sources
   - Curated export set for public docs/templates
   - Sync scripts with “no change = no publish” safeguards

5. **Instance Packaging**
   - jarvOS templates + starter kit
   - Environment-fit guidance (OpenClaw, Cowork, Codex app/CLI)

## 3) Adopted Patterns

### Pattern: Layered memory and knowledge retrieval

Status: **Adopted as jarvOS module boundary.**

The current jarvOS repo separates memory-adjacent concerns into distinct owners:

- `@jarvos/secondbrain` owns human-facing journal and note content.
- `@jarvos/memory` owns compact operational recall.
- `@jarvos/ontology` owns worldview, beliefs, goals, and predictions.
- `@jarvos/gbrain` owns curated structured knowledge pages for GBrain.
- QMD remains a fast broad vault-search dependency, not the graph layer.
- OpenClaw `memory-wiki` remains a native runtime diagnostic/compiled-wiki layer, not the primary GBrain import source.

Decision rationale summary:
- Keeps Obsidian notes as the human source of truth.
- Gives agents structured pages for entity/project/concept recall.
- Avoids treating QMD, memory-wiki, and GBrain as interchangeable memory tools.
- Preserves portability by shipping templates and bridge code, not private knowledge.

Validated operating pattern:

1. The Obsidian-compatible vault remains the human source of truth.
2. QMD remains the broad full-vault lookup and exact-retrieval layer.
3. `@jarvos/gbrain` imports only curated, provenance-rich notes into GBrain.
4. GBrain direct search handles structured recall when the curated page already
   answers the question.
5. GBrain graph recall handles cross-source recall when a known or discovered
   seed page needs adjacent people, projects, concepts, meetings, or sources.
6. `jarvos-gbrain recall` is the runtime-facing adapter that can bundle direct
   GBrain search, optional QMD lookup, and graph sidecar context for OpenClaw or
   another runtime to consider.
7. OpenClaw `memory-wiki` remains a native diagnostic/synthesis layer and should
   not be treated as the canonical GBrain import source without a separate
   review and eval pass.

Public/private boundary:

- Public jarvOS includes reusable code, templates, docs, and empty example
  manifests/eval fixtures.
- Private deployments own real manifests, eval questions, generated GBrain
  pages, note content, and runtime-specific prompt injection choices.

### Pattern: Ars Contexta (watchlist adoption)

Status: **Adopted as watchlist pattern source**, not as a full framework replacement.

Adopted concepts:
- **Three-space context split**: operations context vs durable knowledge context (+ explicit transfer boundary)
- **Fresh-context phases**: reset/renew context across execution phases to reduce contamination
- **6R pipeline mindset**: a repeatable lifecycle for context hygiene and propagation discipline

Decision rationale summary:
- Improves context hygiene in long-running autonomous loops
- Reduces accidental bleed between ephemeral execution and durable memory
- Strengthens repeatability and auditability of changes

Constraint:
- jarvOS keeps existing operator model, governance model, and file contract; Ars Contexta patterns are selectively integrated where they improve hygiene.

**Canonical decision record:** [Architecture Decision Record - 20260219 - Ars Contexta Patterns](architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md)

## 4) Current Canonical References

- Architecture baseline: `[jarvOS — Architecture](jarvos-architecture.md)` (this note)
- Architecture Decision Records folder: `jarvOS — Architecture Decision Records`
- Prior context notes kept for history:
  - jarvOS - Architecture & Design
  - jarvOS - Config Management Architecture

## 5) Language Style Rule (Architecture Docs)

- Default to the full phrase **Architecture Decision Record** in headings and body text.
- Avoid acronyms by default.
- Use an acronym only if Andrew introduced it first in the active context.

— Edited by Jarvis
