<!-- markdownlint-disable MD024 -->
# claw-secondbrain Monorepo Architecture Spec

**Issue:** SUP-333  
**Date:** 2026-03-25  
**Status:** Draft for execution  
**Author:** Jarvis

## Purpose

Define the canonical architecture for the `claw-secondbrain` monorepo, including package boundaries, integration contracts, naming, and the execution boundary with Paperclip.

This spec exists to stop three kinds of drift:

1. using `claw-secondbrain` and `Notes` interchangeably
2. collapsing Journal, Notes, and Memory into one vague storage layer
3. letting durable context systems become a shadow task manager

## Bottom-line decision

`claw-secondbrain` should be the **umbrella monorepo and system concept**.

Inside that monorepo, the first-class packages should be:

- `claw-secondbrain-journal`
- `claw-secondbrain-notes`
- `claw-secondbrain-memory`

These packages are complementary, not redundant.

Their core roles are:

- **Journal** = chronological intake
- **Notes** = durable knowledge substrate
- **Memory** = compact durable memory, promotion, invalidation, and retrieval layer

The **repo-level secondbrain layer** owns:

- routing between packages
- provenance rules
- bridge logic to adjacent systems
- package contracts
- the boundary with Paperclip

**Paperclip remains the system of record for execution.**

So the clean boundary is:

- **claw-secondbrain** = capture, organize, relate, preserve, promote, reflect
- **Paperclip** = assign, track, execute, prove, close

## Naming decisions

### Monorepo
- Repository name: **`claw-secondbrain`**

### Package names
- **`claw-secondbrain-journal`**
- **`claw-secondbrain-notes`**
- **`claw-secondbrain-memory`**

### Naming rationale

This keeps the system-level identity and the package-level identities aligned.

It also avoids two bad outcomes:

- a generic package name like `journal` or `notes` that loses the architectural relationship
- a misleading package named just `claw-secondbrain` before there is enough code to justify a fourth runtime package

## Repository structure

Recommended initial structure:

```text
claw-secondbrain/
  packages/
    claw-secondbrain-journal/
    claw-secondbrain-notes/
    claw-secondbrain-memory/
  adapters/
    openclaw/
    obsidian/
    paperclip/
  docs/
    architecture/
    contracts/
    migration/
  examples/
    standalone/
    openclaw/
  scripts/
  tests/
```

## Architectural principle

The monorepo should **not invent a second competing storage layer**.

Instead:

- Journal stores chronological/day-scoped context
- Notes stores durable human-readable knowledge artifacts
- Memory stores compact durable memory artifacts and memory policies
- the repo-level secondbrain layer decides how information moves between them and when work should be promoted into Paperclip

This means `claw-secondbrain` is an orchestrated architecture, not a replacement file format.

## Package ownership boundaries

## 1) claw-secondbrain-journal

### Owns
- daily journal schema and structure
- daily entry creation
- section rules and repair/normalization
- day-level linking between events, notes, and memory artifacts
- chronological capture of what happened today
- journal-readable reflections and summaries
- automation rules for recurring day-scoped sections

### Does not own
- canonical durable note schema
- long-lived reference docs
- compact memory classes and invalidation policy
- execution queue state
- assignment or completion tracking

### Primary use cases
- "what happened today?"
- lightweight capture under uncertainty
- timeline/context before something deserves a note or memory promotion
- readable daily operating surface for Andrew

### Core design rule
When there is uncertainty, **Journal is the default intake surface**.

## 2) claw-secondbrain-notes

### Owns
- canonical note schema / frontmatter contract
- note writer behavior
- note lint / validation
- note migration rules
- durable reference-oriented note structure
- retrieval-oriented note formatting
- long-lived architecture, research, decision, and project notes

### Does not own
- day-level journal structure
- compact memory extraction/invalidation rules
- execution state or task lifecycle
- OpenClaw runtime compaction mechanics

### Primary use cases
- architecture docs
- research writeups
- durable project context
- durable summaries worth revisiting outside the day they were created

### Core design rule
Notes should optimize for **retrieval clarity and portability first**.

## 3) claw-secondbrain-memory

### Owns
- compact durable memory classes
- promotion rules into memory
- invalidation / decay / correction rules
- provenance requirements for memory artifacts
- retrieval-facing memory interfaces
- rules for what belongs in memory versus journal or notes

### Does not own
- raw journal intake
- general-purpose durable note authoring
- OpenClaw runtime transcript compaction internals
- execution status or assignment state

### Primary use cases
- stable facts worth retaining
- durable preferences
- project state snapshots worth compact recall
- decisions with durable future value
- lessons and corrections
- memory retrieval that must stay compact and auditable

### Core design rule
Memory is **not** a dump of everything important. It is the compact layer of durable context that should survive and stay queryable.

## Repo-level umbrella responsibilities

The monorepo root and repo-level contracts should own the logic that does **not** belong inside any single package.

### Repo-level secondbrain owns
- routing rules: journal vs note vs memory vs promotion-candidate
- provenance model across packages
- promotion bridge into Paperclip
- reflection rules from Paperclip back into journal/notes/memory
- integration contracts between packages
- migration guidance from older jarvOS naming and behavior
- shared examples and end-to-end tests

### Repo-level secondbrain should not own
- a separate long-term artifact format
- shadow copies of journal/note/memory content
- a parallel execution queue

## Integration contracts between packages

## Journal ↔ Notes

### Journal to Notes
Promote into a note when content becomes:
- durable
- reusable
- structured enough to stand alone
- useful outside the current day

### Notes back to Journal
Every newly created standalone note should be linkable back to the day it was created so provenance is preserved.

### Contract
- Journal may reference Notes
- Notes may store journal provenance metadata
- Journal does not become a substitute for the Note body

## Journal ↔ Memory

### Journal to Memory
Promote when the content becomes a durable memory candidate such as:
- preference
- stable fact
- durable lesson
- meaningful project state change
- correction worth preserving

### Memory back to Journal
Journal may include compact reflections or writeback summaries, but not the full memory registry.

### Contract
- Journal is the intake layer
- Memory is the compact retained layer
- Journal should never mirror the full memory store

## Notes ↔ Memory

### Notes to Memory
Extract memory only when the durable note contains compact future-relevant facts, decisions, lessons, or project state that should survive beyond the note itself.

### Memory to Notes
Memory may point back to source notes for provenance and deeper detail.

### Contract
- Notes preserve rich context
- Memory preserves compact retained context
- Memory should reference Notes, not replace them

## secondbrain ↔ Paperclip

### Promotion into Paperclip
Promote when something becomes:
- an explicit commitment
- tracked work
- something needing owner + status
- multi-step execution
- something requiring done/not-done accountability

### Reflection from Paperclip
Mirror back only when the event improves future understanding, for example:
- milestone completion with useful summary
- blocker with explanation
- decision with rationale
- outcome worth remembering later

### Explicit non-goal
Do **not** mirror routine execution churn back into the secondbrain.

Examples of Paperclip-only data:
- assignee changes
- queue ordering
- raw checklists as live execution state
- every status transition
- run locks / checkout semantics

## Relationship to Paperclip

Paperclip is the **execution system of record**.

It owns:
- issue lifecycle
- assignment
- status transitions
- active work queues
- execution evidence
- closure

`claw-secondbrain` owns the **meaningful context around work**, not the canonical state of the work itself.

This preserves the already-tested separation:

- secondbrain owns meaning
- Paperclip owns execution

## Relationship to OpenClaw runtime memory and compaction

`claw-secondbrain-memory` must stay distinct from OpenClaw runtime mechanics.

### OpenClaw runtime memory/compaction owns
- transcript trimming
- context budget management
- compaction prompts
- session continuity mechanics
- ephemeral runtime summarization

### claw-secondbrain-memory owns
- durable memory classes
- memory promotion rules
- durable retrieval expectations
- correction and invalidation policy
- human-auditable retained context

### Practical rule
Runtime compaction may **feed candidates** into durable memory, but it is not itself the Memory package.

## Recommended implementation order

1. **SUP-333** — finalize umbrella architecture and package boundaries
2. **SUP-247** — define `claw-secondbrain-notes` package contract and toolchain
3. **SUP-262** — define `claw-secondbrain-journal` package contract and integration rules
4. **SUP-264** — define `claw-secondbrain-memory` package contract and retention policy
5. implement shared provenance/routing contracts only after package boundaries are stable
6. implement Paperclip bridge and reflection rules against those finalized contracts

## Non-goals

This architecture should **not**:

- collapse Journal, Notes, and Memory into one generic markdown bucket
- let Paperclip become a knowledge base
- let secondbrain become a shadow task manager
- treat runtime compaction as equivalent to durable memory
- split into multiple repos before contracts are stable
- invent a fourth package just called `claw-secondbrain` before there is real code that justifies it

## Anti-patterns to avoid

1. **Notes as execution tracker**
   - durable notes should not become the canonical source of task status

2. **Journal as giant archive**
   - daily entries should not absorb all durable knowledge just because capture starts there

3. **Memory as important-stuff dump**
   - if everything important becomes memory, memory loses its compact value

4. **Paperclip reflection spam**
   - only mirror meaningful execution outcomes, not routine operational churn

5. **Premature repo splitting**
   - publishable packages inside a monorepo first; separate repos only after stable APIs and clear independent use cases

## Migration notes from older jarvOS naming

Older planning/issues used `jarvOS Notes`, `jarvOS Journal`, and `jarvOS Memory` language.

Those should now be read as:

- `jarvOS Notes` → `claw-secondbrain-notes`
- `jarvOS Journal` → `claw-secondbrain-journal`
- `jarvOS Memory` → `claw-secondbrain-memory`

`claw-secondbrain` should no longer be used as a synonym for Notes.
It is the umbrella architecture above all three.

## Decision summary

If we need a one-sentence rule:

**Use Journal for day-scoped intake, Notes for durable knowledge, Memory for compact durable recall, and Paperclip for execution. Let the repo-level secondbrain layer handle routing, provenance, and bridges.**

## Michael execution brief

Use this spec as the architectural source for the next execution phase.

### Your execution goals
1. turn `SUP-333` into the canonical boundary doc
2. align `SUP-247`, `SUP-262`, and `SUP-264` to this package model
3. identify what existing docs/scripts belong to package contracts vs adapters vs migration notes
4. propose the minimum implementation sequence that preserves current working behavior
5. avoid broad refactors until package contracts are locked

### Guardrails
- do not invent a new storage layer
- do not merge Memory into Notes
- do not move execution authority out of Paperclip
- do not overfit package boundaries to current incidental script layout
- keep the first pass documentation-led and contract-first

### Expected outputs
- updated issue comments or specs under SUP-333 / 247 / 262 / 264
- a concrete package map
- a migration checklist
- a list of follow-on implementation issues, if needed
