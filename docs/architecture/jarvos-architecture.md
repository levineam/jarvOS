---
status: active
created: 2026-02-19
updated: 2026-02-19
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
   - Curated export set for public docs/templates
   - Sync scripts with “no change = no publish” safeguards

5. **Instance Packaging**
   - jarvOS templates + starter kit
   - Environment-fit guidance (OpenClaw, Cowork, Codex app/CLI)

## 3) Adopted Patterns

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
