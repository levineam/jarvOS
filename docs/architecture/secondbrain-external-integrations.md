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
| Obsidian app | optional | Human editing, review, linking, navigation, and acknowledgement of live vault mutations. | When running, its `app.vault` API owns live file mutation so the app and Sync observe the change. Its Daily Notes and community plugins must not independently create jarvOS journals. |
| obsidian-cli | optional | Bounded transport into the running app's reviewed `app.vault` operations. | It carries fixed, data-only create/transform/replace/delete programs and cannot accept arbitrary evaluated source from an agent. |
| Defuddle | optional | Web-page-to-Markdown extraction for source material workflows. | Extraction aid only. Source provenance must be preserved before material enters QMD, GBrain, or other retrieval layers. |
| QMD | active | Broad Markdown lookup, exact note retrieval, and retrieval-eval comparison. | Search/index layer, not durable truth and not the graph layer. Freshness is explicit through `qmd-refresh-pending.json`. |
| GBrain | optional | Curated structured recall and provider-owned skills for people, companies, projects, concepts, meetings, and sources. Andrew's private profile requires one shared GBrain for Codex, Hermes, and OpenClaw; portable jarvOS does not. | Reviewed structured graph memory. GBrain owns structured recall and its resolver/quality gates, not Paperclip task state, raw Vault notes, journal mutation, or jarvOS governance. jarvOS pins and observes the provider but does not proxy it or supervise its database. |
| OpenClaw memory-wiki | active | Runtime-native compiled wiki, diagnostics, and synthesis support. | Diagnostic/generated runtime layer. It is not the canonical GBrain import source and does not own authored notes. |
| Grok Bot runtime | optional | Separate-computer agent runtime that hydrates from a vault-host authenticated HTTP/SSE MCP connector. | Optional runtime, not a knowledge authority. Native Grok memory, routines, and CloudAgent stay host-owned. jarvOS does not clone the vault, auto-ingest chats, or expose SendMessage/CloudAgent. |
| OpenClaw runtime memory | active | Session continuity, diary/dreaming, compaction recall, and runtime health. | Runtime continuity layer. It must not mirror itself into durable memory or overwrite canonical notes. |
| generated LLM-wiki / secondbrain wiki | generated | Visible derived Markdown wiki pages compiled from source-backed sidecars. | Rebuildable retrieval and inspection artifact. Source notes, journals, and sidecars remain authoritative. The generated output is managed and marked as generated so it can be safely rebuilt without becoming editable truth. |
| Paperclip | active | Live execution state for work that becomes tasks, blockers, reviews, and release evidence. | Project/task truth only. It is not long-form memory or the knowledge base. |
| agentmemory | dogfood-optional | Optional local shared experience-memory sidecar for recent cross-agent observations. | Advisory only. It is not public-core, not durable truth, not live task state, and must not auto-promote into GBrain, Vault notes, Paperclip, ontology, or durable memory. |
| Engraph | deferred | Potential future vault-native graph/retrieval backend. | Not production-integrated. It must stay behind the `qmd-plus-graph` / `qmd-plus-engraph` eval gate until a real adapter materially beats QMD plus generated LLM-wiki with source evidence. |
| Obsidian Linter | guarded | Manual cleanup inside Obsidian if a user chooses it. | Rejected for core automation. The note contract stays plain YAML plus Markdown and must not depend on GUI plugins. |
| Obsidian Bases and JSON Canvas | optional | Reading, review, and visual artifact surfaces through the Obsidian experience pack. | Presentation/review surfaces only. They are not live project management, canonical memory, or retrieval authority. |

## Journal ownership and host boundary

The public journal lifecycle is the package-owned boundary between these
integrations and the canonical Markdown record:

- `Journal/YYYY-MM-DD.md` is the canonical human thought record.
- An explicit configured directory and valid IANA timezone are required for
  journal mutation; absent or malformed configuration fails closed.
- The lifecycle creates only a missing current-date file. In the same run it
  may add missing embeds for the current date and previously created dates to
  an existing, pure generated `Journaling.md` index; it never rebuilds/reorders
  that page or touches an index containing human-authored content, and it never
  repairs an existing authored daily file.
- Obsidian remains a human editing/client surface. Its active-day backlink seam
  may append an authorized entry after lifecycle existence is ensured, while
  Daily Notes, Periodic Notes, Journals, and template automations must not own
  creation of the same dated files.
- Host schedulers and runtimes inject configuration and own delivery/retry
  evidence. They are not part of the public package's journal truth or release
  evidence.
- The public MCP surface is intentionally small: health is read-only, ensure is
  an empty-input today-only action, and both return bounded projections without
  paths, content, hashes, timestamps, receipts, or provenance.

## Vault Mutation Ownership

User-visible Markdown in a configured vault is mutation-owned. Callers submit
serialized operations with a stable identity, a normalized vault-relative
Markdown target, and a fixed transform name/version; they never submit source
code for evaluation. The Obsidian adapter owns transport and acknowledgement.
Packages define domain policies and must not depend on adapter or bridge code,
apart from an explicitly named temporary shim with a removal criterion.

The operation receipt is private. Agent-facing/public results contain only a
schema version plus persistence, Obsidian, Sync, and stable status projections;
they never expose paths, content, hashes, timestamps, operation records,
adapter evidence, or host identity. Unknown transform versions and malformed or
oversized replay payloads are quarantined without a mutation.

The checked writer inventory covers note, journal, backlink, project,
session-thread, maintenance, normalizer, audit, wiki, and index producers.
These are authored-Markdown migration candidates. Hidden operational metadata
and outputs outside the vault are the only direct-write classifications.

Every operation is recorded before a side effect. A running app must
acknowledge the invariant through `app.vault.read`; disk content alone never
marks an operation complete. If the app is proven unavailable, only an
explicitly authorized exclusive create or exact-hash replacement can write
locally. That result remains `saved_locally_sync_pending` until the same
operation is resubmitted through Obsidian. Latest-content transforms preserve
concurrent mobile edits instead of replacing the whole file from a stale
snapshot.

Per-file Obsidian Sync internals are unsupported and may change between app
releases. The optional inspector is read-only, disabled by default, isolated in
one adapter, bounded to 12 samples and three minutes, and requires two stable
samples where the content, locally tracked, and remotely tracked hashes all
match. Missing or incompatible private fields produce `unknown`; the global
“fully synced” label is never treated as per-file proof.

## Operating Model

The intended secondbrain model is below. Only intentional capture is active in
this repository today; the eligible-interaction candidate stages are future
adapter behavior.

```text
intentional capture
  -> Obsidian-compatible Markdown Notes/Journal

future eligible AI interactions
  -> eligibility and trust boundary
  -> immutable, source-backed, non-authoritative candidates
  -> governed review or policy admission
  -> destination-owned promotion plus outcome receipt

authoritative durable surfaces
  -> source-backed sidecars and generated LLM-wiki
  -> QMD freshness / broad lookup
  -> GBrain curated structured recall
  -> OpenClaw memory-wiki and runtime recall diagnostics
```

Intentional capture remains the direct authored path. Eligible ambient
observation is a future proposal path: a future adapter may prepare candidates,
but this foundation contains no source adapter that does so. It does not
automatically believe, promote, or retain every conversation. Source
trust, privacy, expiry, deduplication, and evidence binding are checked before
candidate construction. Destination owners still decide admission and emit a
receipt whose outcome distinguishes a committed revision from a failed,
deferred, conflicted, or already-satisfied attempt.

Paperclip runs alongside that path for execution state. It records issues,
owners, blockers, reviews, release evidence, and follow-up work, but it is not
the knowledge base.

Private shared-brain continuity uses one provider-native GBrain stdio
registration per harness, all launched through the same pinned-runtime
descriptor and all pointing at the same local Postgres brain. The public
runtime adapters declare this optional integration contract without shipping
private configuration. GBrain's resolver remains the only Skillify projection;
the jarvOS shared-skill distributor must not copy or fork it. Serve-time sweep
is disabled, leaving the scheduler-owned delta-maintenance path as the sole
maintenance owner.

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
- generated wiki build output is visible as Markdown under the configured vault
  root or explicit output directory, with a managed-output marker
- retrieval evals compare `qmd-only`, `qmd-plus-llm-wiki`, and graph-style
  adapters with source evidence
- release/readiness checks prevent public docs from presenting deferred or
  dogfood-only tools as core active dependencies

## Non-Goals

- No indiscriminate ingestion of every AI conversation, raw transcript
  hoarding, or automatic belief. A future eligible-interaction adapter may
  produce bounded non-authoritative candidates; durable promotion remains
  governed.
- No ChatGPT or Claude app first-class capture target in the current
  determinism contract.
- No direct agentmemory host access or automatic memory promotion.
- No Engraph production dependency without a passing adapter/eval gate.
- No Obsidian plugin or GUI tool owns the canonical note/journal writer.
