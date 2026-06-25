# Secondbrain External Integrations

This inventory names the external software and generated artifact layers that
jarvOS integrates with for the secondbrain stack. jarvOS-owned modules are
adapters, contracts, and guardrails around these surfaces; they are not listed
as external components here.

Status values:

- `active`: part of the current supported secondbrain path.
- `optional`: supported when installed, but not required for the core path.
- `dogfood-optional`: local/private experiment behind a jarvOS boundary.
- `generated`: produced by jarvOS as a derived artifact, not an external source
  of truth.
- `deferred`: intentionally not integrated until a future gate is met.
- `guarded`: explicitly blocked from owning canonical writes or truth.

## Current Inventory

| Component | Status | Role | Authority boundary |
|---|---|---|---|
| Obsidian-compatible Markdown vault | active | Human-facing notes and journals in plain files. | Canonical source of truth for authored notes and daily journals. Obsidian is a client; the Markdown contract is the portable layer. |
| Obsidian app | optional | Human editing, review, linking, and navigation. | Must not own daily journal creation for the jarvOS Journal folder. jarvOS guards against conflicting Daily Notes, Periodic Notes, and Journals plugin settings. |
| obsidian-cli | optional | Targeted app-backed note operations when installed. | Auxiliary operator tool only. It is not the canonical note writer. |
| Defuddle | optional | Web-page-to-Markdown extraction for source material workflows. | Extraction aid only. Source provenance must be preserved before material enters QMD, GBrain, or other retrieval layers. |
| QMD | active | Broad Markdown lookup, exact note retrieval, and retrieval-eval comparison. | Search/index layer, not durable truth and not the graph layer. Freshness is explicit through `qmd-refresh-pending.json`. |
| GBrain | active | Curated structured recall for people, companies, projects, concepts, meetings, and sources. | Reviewed structured graph memory. jarvOS queues/imports curated, provenance-rich notes; GBrain does not replace the vault or QMD. |
| OpenClaw memory-wiki | active | Runtime-native compiled wiki, diagnostics, and synthesis support. | Diagnostic/generated runtime layer. It is not the canonical GBrain import source and does not own authored notes. |
| OpenClaw runtime memory | active | Session continuity, diary/dreaming, compaction recall, and runtime health. | Runtime continuity layer. It must not mirror itself into durable memory or overwrite canonical notes. |
| generated LLM-wiki / secondbrain wiki | generated | Derived Markdown wiki pages compiled from source-backed sidecars. | Rebuildable retrieval artifact. Source notes, journals, and sidecars remain authoritative. |
| Paperclip | active | Live execution state for work that becomes tasks, blockers, reviews, and release evidence. | Project/task truth only. It is not long-form memory or the knowledge base. |
| agentmemory | dogfood-optional | Optional local shared experience-memory sidecar for recent cross-agent observations. | Advisory only. It is not public-core, not durable truth, not live task state, and must not auto-promote into GBrain, Vault notes, Paperclip, ontology, or durable memory. |
| Engraph | deferred | Potential future vault-native graph/retrieval backend. | Not production-integrated. It must stay behind the `qmd-plus-graph` / `qmd-plus-engraph` eval gate until a real adapter materially beats QMD plus generated LLM-wiki with source evidence. |
| Obsidian Linter | guarded | Manual cleanup inside Obsidian if a user chooses it. | Rejected for core automation. The note contract stays plain YAML plus Markdown and must not depend on GUI plugins. |
| Obsidian Bases and JSON Canvas | optional | Reading, review, and visual artifact surfaces through the Obsidian experience pack. | Presentation/review surfaces only. They are not live project management, canonical memory, or retrieval authority. |

## Operating Model

The active secondbrain path is:

```text
intentional capture
  -> Obsidian-compatible Markdown Notes/Journal
  -> source-backed sidecars and generated LLM-wiki
  -> QMD freshness / broad lookup
  -> GBrain curated structured recall
  -> OpenClaw memory-wiki and runtime recall diagnostics
```

Paperclip runs alongside that path for execution state. It records issues,
owners, blockers, reviews, release evidence, and follow-up work, but it is not
the knowledge base.

agentmemory, when used, belongs beside the runtime continuity layer as an
advisory dogfood sidecar. It should answer questions like "what did another
agent already try on this issue?" It should not answer "what is true about
Andrew, this project, or the world?" without a reviewed promotion into the
existing durable layers.

## Proof Surfaces

Active integrations should be proven through these public-safe signals:

- canonical notes and journals stay under configured `Notes/` and
  `Journal/YYYY-MM-DD.md` paths
- note writes emit provenance and knowledge sidecars
- `qmd-refresh-pending.json` records QMD freshness debt after note optimization
- `gbrain-import-queue.json` queues only privacy-eligible structured candidates
- `memory-wiki-queue.json` records runtime wiki queue decisions
- generated wiki tests prove pages are derived and rebuildable
- retrieval evals compare `qmd-only`, `qmd-plus-llm-wiki`, and graph-style
  adapters with source evidence
- release/readiness checks prevent public docs from presenting deferred or
  dogfood-only tools as core active dependencies

## Non-Goals

- No automatic ingestion of every AI conversation.
- No ChatGPT or Claude app first-class capture target in the current
  determinism contract.
- No direct agentmemory host access or automatic memory promotion.
- No Engraph production dependency without a passing adapter/eval gate.
- No Obsidian plugin or GUI tool owns the canonical note/journal writer.
