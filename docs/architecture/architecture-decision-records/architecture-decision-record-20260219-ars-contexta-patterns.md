---
architecture_decision_record: architecture-decision-record-20260219-ars-contexta-patterns
status: accepted
date: 2026-02-19
system: jarvOS
type: decision
project: ""
created: 2026-02-19
updated: 2026-02-19
author: both
---

# Architecture Decision Record 20260219: Selective Adoption of Ars Contexta Patterns

## Status
Accepted

## Context

jarvOS runs long-lived agent workflows where context can drift, bloat, or leak across unrelated work phases. We need stronger context hygiene without replacing jarvOS’s current operator contract, governance model, and deployment footprint.

Ars Contexta introduces useful context-operations patterns, but adopting the full framework would require broad process replacement and unnecessary migration overhead.

## Decision

Treat **Ars Contexta as a watchlist pattern source** and adopt three specific patterns into jarvOS:

1. **Three-space split (selective adoption)**
   - Separate:
     - operational/ephemeral execution context,
     - durable knowledge context,
     - transfer boundary/process between them.
   - In jarvOS terms: runtime state/queues stay operational; canonical notes/Architecture Decision Records remain durable; promotion is explicit.

2. **Fresh-context phases**
   - Break execution into explicit phases with context reset/reload boundaries.
   - Prevents stale or irrelevant context accumulation during multi-step loops.

3. **6R pipeline mindset**
   - Use a repeatable context lifecycle discipline for capture, refinement, and propagation.
   - Applied as an operating mindset for watchdog/briefing/doc-sync loops.

## Why this decision

- Improves context hygiene and reduces cross-task contamination.
- Makes autonomous loops more predictable and auditable.
- Preserves existing jarvOS strengths (current templates, governance, and runtime workflows).
- Low migration cost with immediate operational benefit.

## Why not full Ars Contexta adoption

- Full adoption would force broad workflow replacement with unclear near-term ROI.
- jarvOS already has working governance + automation loops; full migration risks disruption.
- Selective pattern import gives most of the hygiene benefits without platform churn.

## Consequences

### Positive
- Cleaner boundaries between ephemeral operations and durable memory/docs.
- Better propagation quality (internal → public artifacts) through explicit transfer steps.
- Easier troubleshooting when context decisions are phase-bounded and logged.

### Tradeoffs
- Requires disciplined maintenance of phase boundaries and promotion rules.
- Partial adoption means terminology mismatch across teams/documents unless kept explicit.

## Implementation Notes

- Canonical architecture note updated: [jarvOS — Architecture](../jarvos-architecture.md)
- Public-docs sync pipeline uses curated source mappings and no-change guards.
- Future Architecture Decision Records should reference whether changes affect ops context, durable context, or transfer boundary.

— Edited by Jarvis
