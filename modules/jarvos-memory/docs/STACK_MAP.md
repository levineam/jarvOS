# JarVOS Memory Stack Map

This document is the placement and boundary guide for the JarVOS memory stack. It
does not introduce a new router, taxonomy service, doctor command, or source of
truth. It names the existing layers, explains where each kind of memory work
belongs, and points to the checks that already prove the stack is healthy.

The current package name is `@claw/jarvos-memory`; `@jarvos/memory` is the
architecture shorthand for this module's role: compact durable memory records
and boundary documentation at the JarVOS layer.

## Stack Layers

| Canonical name | Current surface | Owns | Does not own |
| --- | --- | --- | --- |
| `jarvos-secondbrain` | `jarvos-secondbrain/`, Journal, Notes | Human-readable chronology, raw capture, source notes, long-form research | Compact durable memory registry, live task status |
| `qmd` | OpenClaw QMD backend, standalone `qmd` CLI | Fast markdown lookup, note retrieval, transcript/session evidence search | Curated durable records, semantic graph truth |
| `gbrain` | GBrain and memory-wiki checks | Structured graph memory, graph-backed recall, promotion-candidate review evidence | Markdown source of truth, automatic promotion into memory |
| `@jarvos/memory` | `jarvos-memory/`, `MEMORY.md`, `memory/decisions/`, `memory/lessons/`, `memory/projects/` | Compact durable agent memory, schema vocabulary, promotion rules, lightweight audit helpers | Content authoring, runtime compaction, live project management |
| agentmemory via jarVOS adapter | Optional local agentmemory sidecar behind `jarvos-memory/docs/EXPERIENCE_MEMORY_AGENTMEMORY_CONTRACT.md` | Shared recent experience observations across personalities during dogfood | Durable truth, direct host access, automatic promotion, live task state |
| `jarvos-ontology` | `jarvos-ontology/` | Beliefs, goals, projects, predictions, relationships | Raw notes, daily logs, task comments |
| OpenClaw runtime memory | OpenClaw memory, diary, memory-wiki, compaction hooks | Session continuity, native recall/dreaming/diary behavior, runtime health | Canonical file-backed durable memory records |
| Paperclip | Paperclip issues, comments, statuses, blockers, reviews | Execution state, ownership, blockers, approvals, review path | Long-form memory, private journal content |

## Placement Guide

Use this as a plain-English boundary guide, not as a programmatic classifier.

| If the item is... | Put it in... | Then optionally link to... |
| --- | --- | --- |
| Day-by-day chronology, raw meeting notes, source capture, or long-form research | `jarvos-secondbrain` Journal or Notes | `@jarvos/memory` only after a compact durable fact, decision, preference, lesson, or project snapshot is promoted |
| A stable fact or preference that should change future agent behavior | `MEMORY.md` through `@jarvos/memory` conventions | `jarvos-ontology` if it should become a graph belief or relationship |
| A decision with rationale or consequences | `memory/decisions/YYYY-MM-DD-slug.md` | Paperclip issue or PR that caused the decision |
| A correction, failure pattern, or reusable operating lesson | `memory/lessons/YYYY-MM-DD-slug.md` | Source issue, transcript, or incident note |
| A compact project-state snapshot worth carrying across days | `memory/projects/` | Paperclip for live status, blockers, assignees, and review state |
| Live work, ownership, status, blockers, review, or approval | Paperclip | Memory only after closure if a durable lesson, decision, or project-state snapshot remains |
| Fast lookup of markdown notes or previous session evidence | QMD / OpenClaw QMD-backed recall | Source note or transcript; do not promote search results automatically |
| Structured worldview facts, relationships, goals, beliefs, predictions | `jarvos-ontology` | Memory record that supplied the durable signal |
| Runtime continuity, diary/dreaming, compaction, memory-wiki health | OpenClaw runtime memory | Existing audit reports; do not mirror runtime state into `MEMORY.md` |
| Recent cross-personality experience, such as what another host saw, tried, fixed, or should not repeat | agentmemory through the jarVOS adapter contract | Existing durable layers only after explicit reviewed promotion |

## Boundary Rules

- One canonical home per active truth. Link across layers instead of copying the
  same status, decision, or memory into multiple places.
- Paperclip is the only live project-management surface. `memory/projects/`
  holds durable snapshots, not current board state.
- QMD retrieves source material and transcript evidence. It does not decide what
  becomes durable memory.
- Generated LLM-wiki pages are a derived retrieval layer over secondbrain
  sidecars and source notes. They can improve QMD recall, but source notes and
  journals remain authoritative.
- GBrain stores reviewed graph memory and supports recall/eval checks. Promotion
  candidates are suggestions until approved through the existing review path.
- Engraph or another vault-native graph backend must stay behind the
  `qmd-plus-graph` eval boundary until it beats the QMD and generated-wiki
  baseline with source evidence.
- OpenClaw runtime memory handles session continuity and native diary/dreaming.
  `@jarvos/memory` remains the small file-backed registry agents can inspect.
- `jarvos-secondbrain` stays human-readable. Do not move Journal or Notes content
  into `jarvos-memory` unless it has been condensed into a durable memory class.
- Agentmemory, when enabled for dogfood, is advisory shared experience memory
  behind the jarVOS adapter. Hosts must not call the full agentmemory tool/API
  surface directly, and agentmemory results must not auto-promote into GBrain,
  ontology, durable Memory, Vault notes, or Paperclip status.

## Hindsight Status

Hindsight is `legacy-optional`.

It may exist in older local adapter setups, but it is not the default JarVOS
memory storage layer, not the package naming target, and not required for memory
health. New work should treat Hindsight as a legacy integration unless a separate
issue explicitly reopens that adapter.

## Agentmemory Status

Agentmemory is `dogfood-optional`.

The contract for the jarVOS adapter lives in
`docs/EXPERIENCE_MEMORY_AGENTMEMORY_CONTRACT.md`. It defines the allowed
read/write schemas, the small allowed agentmemory endpoint subset, blocked
surfaces, promotion-candidate tags, fallback behavior, and the jarVOS v0.6
dogfood evidence/review gate.

## Existing Health Checks

Do not duplicate the completed memory audit loop. These are the existing proof
surfaces this map points to:

| Check | Existing owner | Purpose |
| --- | --- | --- |
| `node jarvos-memory/scripts/audit-memory.js --json` | `@jarvos/memory` | Validates the local durable memory surfaces and record metadata |
| `node scripts/jarvos-memory-ops-maintenance.js` | clawd ops | Runs the QMD/OpenClaw refresh, GBrain and memory-wiki checks, recall evals, and candidate scan |
| `node scripts/jarvos-memory-audit-report.js` | clawd ops | Produces the readable daily memory-health report from existing proof artifacts |
| `node scripts/jarvos-memory-final-audit.js` | clawd ops | Captures final audit evidence when a deeper proof pass is needed |
| `node scripts/jarvos-memory-audit-delivery-proof.js` | clawd ops | Verifies delivery/proof artifacts for the daily audit path |

The completed audit work tracked in [SUP-1512](/SUP/issues/SUP-1512),
[SUP-1520](/SUP/issues/SUP-1520), [SUP-1525](/SUP/issues/SUP-1525), and
[SUP-1615](/SUP/issues/SUP-1615) owns the operations loop. This issue only adds
the organization layer: naming, placement, and pointers.

## Naming Summary

- Use `jarvos-memory/` for the repository directory.
- Use `@claw/jarvos-memory` for the current package name until a separate package
  rename is intentionally planned.
- Use `@jarvos/memory` as the architecture shorthand for the durable memory
  module and boundary contract.
- Use `QMD` for markdown/search retrieval.
- Use `GBrain` for structured graph memory and graph recall.
- Use `OpenClaw runtime memory` for diary, compaction, memory-wiki, and session
  continuity.
- Use `Paperclip` for live execution state.
