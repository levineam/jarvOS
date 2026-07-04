---
title: Agent Self-Introspection (chat agent can read its own app) - Plan
type: feat
date: 2026-06-30
topic: agent-self-introspection
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Agent Self-Introspection (chat agent can read its own app) - Plan

**Target repo:** jarvos-desktop. All paths below are repo-relative.

## Goal Capsule

- **Objective:** Give the in-app jarvOS Desktop Chat agent the ability to understand and debug *itself* — read its own source, logs, and live health — so the user can ask "why did you just do that?" or "is anything broken in the app?" and get a grounded answer instead of a guess.
- **Product authority:** Andrew. Confirmed 2026-06-30. Run the compound-engineering workflow through to implementation.
- **Open blockers:** None. The agent currently only sees the *substrate* (journal, notes, memory, ontology, Paperclip) and is never told it *is* the jarvOS Desktop app.

---

## Product Contract

### Summary

Add a small, **read-only**, **app-root-confined** self-introspection toolset to the chat agent — `read_app_source` (read the app's own source/config files), `list_app_source` (enumerate the tree so the agent can navigate), `read_app_logs` (the `.gstack/browse-network.log` and any present log files), and `read_app_health` (the existing `/api/health` service check) — plus one system-prompt line telling the agent it runs inside the jarvOS Desktop app and can inspect itself to explain and debug its behavior. The tools are non-mutating and require no approval (they run automatically like the other read tools). Any *fix* the agent then proposes still flows through the existing approval-gated write/dispatch path. Security is the load-bearing concern: path traversal is blocked, reads are confined to the app root, a denylist + secret-redaction pass keeps credentials out of the model's context, and an extension allowlist + size cap keep the surface bounded.

### Problem Frame

`server/agent/tools/read.js` exposes only substrate adapters. `server/agent/index.js#instructions()` describes the agent as "the jarvOS Desktop Chat agent" but never says it *is* a running app it can inspect, and gives it no tool to do so. Result: the agent cannot answer questions about its own behavior, configuration, or health — it can only speculate. The user explicitly wants self-debugging ("debug its own behavior, which would be convenient").

### Requirements

- **R1.** The agent can read the text of its own source/config files within the app root, on request.
- **R2.** The agent can enumerate the app's file tree to discover what exists before reading.
- **R3.** The agent can read available app logs (at minimum `.gstack/browse-network.log`).
- **R4.** The agent can read live app health (the same data `/api/health` returns).
- **R5.** The agent's system prompt tells it that it runs inside the jarvOS Desktop app at the app root and that these tools let it explain/debug its own behavior.
- **R6.** All new tools are strictly read-only and require no user approval (consistent with existing read tools).
- **R7.** Reads cannot escape the app root (path-traversal safe), cannot return files outside an extension allowlist, and cannot leak secrets (denylist + redaction). Files are size-capped.
- **R8.** Proposed fixes the agent surfaces still go through the existing `GATED_TOOLS` approval path — this change adds no new write capability.

### Scope Boundaries

**In scope:** four read-only introspection tools, their registration in `buildAgent`, the `cfg.appRoot` derivation, one system-prompt line, and tests.

**Out of scope (true non-goals):**
- Any write/edit/patch capability against app source (fixes route through existing dispatch/approval — R8).
- Git history / blame / diff tools (would expand surface; revisit only if needed).
- Reading arbitrary filesystem paths outside the app root.

#### Deferred to Follow-Up Work
- A `tail_app_logs` streaming variant if a persistent server logfile is later added (today the server logs to stdout, not a file).
- Surfacing introspection results specially in the right-hand activity panel (`chat-src/main.tsx`) — the generic `ActivityPart` card already renders them adequately.

---

## Key Technical Decisions

- **KTD1 — Confine to a derived `cfg.appRoot`, not config.json.** `config.json` has no `appRoot`, and `jarvosRepo` (`~/jarvOS`) is a *different* repo. Derive the app root once in `server/config.js#loadConfig()` as `path.join(__dirname, '..')` and attach it as `cfg.appRoot`. Rationale: single source of truth, testable, and it makes confinement the default. Secrets already live **outside** this root by design (OpenAI key in OS keychain/`OPENAI_API_KEY`; Paperclip token in `~/.paperclip/auth.json`), so root-confinement alone excludes them — confirmed in `server/agent/credentials.js`.
- **KTD2 — Defense in depth on `read_app_source`.** Four independent guards, all must pass: (1) **path confinement** — resolve the requested path against `appRoot` and require `resolved === appRoot || resolved.startsWith(appRoot + path.sep)` (mirrors the `serveStatic` check in `server/index.js`); (2) **denylist** — reject any path whose segments include `node_modules`, `.git`, or that matches `.env`/`*.env`/`*.pem`/`*.key`; (3) **extension allowlist** — only `.js`, `.jsx`, `.ts`, `.tsx`, `.css`, `.html`, `.json`, `.md`, `.txt`, `.log`, `.yaml`, `.yml` (and extensionless files are rejected); (4) **secret redaction** — run returned content through a redactor that masks `sk-…` style keys and long hex/base64 runs, mirroring the hydration packet's "obvious secrets/API tokens redacted" posture. Plus a **size cap** (~256 KB) returning a truncation note, matching the Read-tool ergonomics already familiar in this codebase.
- **KTD3 — New `server/agent/tools/self.js` exporting `createSelfTools(cfg)`.** Mirrors the existing `read.js` / `write.js` / `dispatch.js` file-per-toolset convention; registered in `buildAgent` by spreading `...selfTools`. Keeps `read.js` focused on substrate.
- **KTD4 — No approval gating.** These tools are non-mutating, so they are *not* added to `GATED_TOOLS`; they run automatically like the other read tools (R6). The agent's *fixes* remain gated (R8) — this plan adds zero write surface.
- **KTD5 — `read_app_health` reuses the existing adapter.** Call `health.services(cfg, today.localDate())` directly (same as the `/api/health` route) rather than HTTP-calling the server from inside itself. No new health logic.
- **KTD6 — `read_app_logs` is present-or-absent tolerant.** Reads a known, root-confined set of log paths (at least `.gstack/browse-network.log`), returns the last N KB, and returns `{ found: false, path }` when a log is absent rather than throwing — the server logs to stdout today, so no general server logfile is guaranteed.

---

## High-Level Technical Design

Request path for a self-introspection call (all four tools share the confinement/redaction spine via shared helpers in `self.js`):

```
chat agent (ToolLoopAgent)
   │  picks read_app_source / list_app_source / read_app_logs / read_app_health
   ▼
server/agent/tools/self.js  ── createSelfTools(cfg)
   │
   ├─ resolveWithinRoot(cfg.appRoot, requested)   ← path confinement (KTD2.1)
   ├─ assertAllowed(path)                          ← denylist + ext allowlist (KTD2.2/2.3)
   ├─ fs.readFileSync (size-capped)                ← bounded read (KTD2 cap)
   ├─ redactSecrets(content)                       ← redaction (KTD2.4)
   └─ read_app_health → health.services(cfg, …)    ← reuse adapter (KTD5)
```

Confinement decision per `read_app_source` call:

```
requested path
   │
   ▼
path.resolve(appRoot, requested)
   │
   ├─ outside appRoot?        ─► reject 400 "outside app root"
   ├─ segment in denylist?    ─► reject 400 "path not permitted"
   ├─ extension not allowed?  ─► reject 400 "file type not permitted"
   ├─ not a file / missing?   ─► { found: false, path }
   └─ ok ─► read (cap 256KB) ─► redactSecrets ─► { path, content, truncated }
```

---

## Implementation Units

### U1. Derive and expose `cfg.appRoot`

- **Goal:** Make the app root available to tools as a single, trusted value.
- **Requirements:** R1, R7.
- **Dependencies:** none.
- **Files:** `server/config.js`, `test/chat-agent.test.js`.
- **Approach:** In `loadConfig()`, after `expandDeep`, attach `appRoot: path.join(__dirname, '..')` (the repo root, since `config.js` lives in `server/`). Do not read it from `config.json`. Keep `expandTilde` export unchanged.
- **Patterns to follow:** existing `loadConfig` in `server/config.js`; `path.join(__dirname, ...)` usage in `server/index.js`.
- **Test scenarios:**
  - `loadConfig().appRoot` is an absolute path whose `package.json` exists (i.e. it points at the app root, not `server/` and not `~/jarvOS`).
  - `appRoot` does not equal the expanded `jarvosRepo` value.
- **Verification:** `cfg.appRoot` resolves to the directory containing `package.json`.

### U2. Add `server/agent/tools/self.js` with confinement + redaction helpers

- **Goal:** Implement the four read-only tools behind shared, well-tested guards.
- **Requirements:** R1, R2, R3, R4, R6, R7.
- **Dependencies:** U1.
- **Files:** `server/agent/tools/self.js`, `test/chat-agent.test.js`.
- **Approach:** Export `createSelfTools(cfg)` returning four `tool({...})` definitions (same shape as `read.js`, `import('ai')` + `import('zod')`):
  - `read_app_source` — input `{ path: string }`; resolve within `cfg.appRoot`, apply denylist + extension allowlist, size-cap read, redact, return `{ path, content, truncated }` or `{ found: false, path }`.
  - `list_app_source` — input `{ dir?: string, depth?: number(1-3, default 1) }`; resolve within `cfg.appRoot`, return a directory listing (names + file/dir + size) with `node_modules`/`.git` pruned; never returns file contents.
  - `read_app_logs` — input `{ name?: enum, tailKb?: number }`; map to a root-confined allowlisted log path (default `.gstack/browse-network.log`), return last N KB or `{ found: false, path }`.
  - `read_app_health` — input `{}`; `return health.services(cfg, require('../../today').localDate())`.
  - Factor confinement (`resolveWithinRoot`), `assertAllowed`, `redactSecrets`, and the size cap into module-local helpers so U6 can unit-test them directly. Export the helpers (or a `__test` handle) for testing, consistent with how `notes.js` exports `assertSafeTitle`.
- **Patterns to follow:** `createReadTools` in `server/agent/tools/read.js` (tool shape, async dynamic imports); `assertSafeTitle` + `SAFE_TITLE_RE` in `server/adapters/notes.js`; the `path.normalize` + `startsWith(STATIC_DIR)` confinement in `server/index.js#serveStatic`; `health.services(cfg, today.localDate())` call in `server/index.js`.
- **Test scenarios:**
  - **Happy path:** `read_app_source({ path: 'server/agent/index.js' })` returns content containing `jarvOS Desktop Chat agent`.
  - **Happy path:** `list_app_source({ dir: 'server/agent/tools' })` lists `read.js`, `write.js`, `dispatch.js`, `self.js`; never includes file contents.
  - **Traversal blocked:** `read_app_source({ path: '../../.paperclip/auth.json' })` is rejected (outside root); `read_app_source({ path: '/etc/passwd' })` is rejected.
  - **Traversal blocked:** a symlink-style absolute escape and a `server/../../` escape both reject.
  - **Denylist:** `read_app_source({ path: 'node_modules/ai/package.json' })` and `{ path: '.git/config' }` are rejected even though they sit under the root.
  - **Extension allowlist:** a `.woff2`/`.png` path is rejected; an extensionless path is rejected.
  - **Secret redaction:** a fixture file containing `sk-ABC...` (long key) and a long hex/base64 run comes back with those runs masked, surrounding prose intact.
  - **Size cap:** a file larger than the cap returns `truncated: true` and content no longer than the cap.
  - **Absent log:** `read_app_logs({ name: 'browse' })` when the log file is missing returns `{ found: false }`, does not throw.
  - **Health:** `read_app_health({})` returns an array including a `paperclip` entry (shape parity with `/api/health`).
- **Verification:** every guard test above passes; tools return plain JSON-serializable objects.

### U3. Register `createSelfTools` in `buildAgent`

- **Goal:** Wire the new tools into the agent.
- **Requirements:** R6.
- **Dependencies:** U2.
- **Files:** `server/agent/index.js`.
- **Approach:** `require('./tools/self')`, add `createSelfTools(cfg)` to the `Promise.all` in `buildAgent`, and spread `...selfTools` into the `tools` object. Do **not** add any of them to `GATED_TOOLS` (KTD4).
- **Patterns to follow:** the existing `Promise.all([createReadTools, createWriteTools, createDispatchTools, …])` and `tools: { ...readTools, ...writeTools, ...dispatchTools }` in `server/agent/index.js`.
- **Test scenarios:** `Test expectation: none -- wiring only; behavior is covered by U2 tool tests and U5's smoke check that buildAgent constructs without error.`
- **Verification:** `buildAgent` returns an agent whose tool set includes the four self tools; existing tools unchanged.

### U4. Teach the agent it is the app (system prompt)

- **Goal:** Make the agent aware it can inspect itself.
- **Requirements:** R5, R8.
- **Dependencies:** U3.
- **Files:** `server/agent/index.js`.
- **Approach:** Add one line to `instructions()`: that it runs inside the jarvOS Desktop app (an Electron + Node-server + React app) at the app root, and can use the self-introspection tools to read its own source, logs, and health to explain and debug its own behavior — while reaffirming that any fix still goes through the approval-gated write/dispatch tools.
- **Patterns to follow:** the existing `instructions()` array-join style in `server/agent/index.js`.
- **Test scenarios:** `Test expectation: none -- prompt copy. A lightweight assertion that instructions() mentions self-inspection may be added alongside U2 if cheap.`
- **Verification:** `instructions()` text references self-inspection and reaffirms the approval gate.

### U5. Tests + smoke wiring

- **Goal:** Lock in the security guarantees and confirm the agent still builds.
- **Requirements:** R6, R7.
- **Dependencies:** U2, U3.
- **Files:** `test/chat-agent.test.js`.
- **Approach:** Add the U2 scenarios as `node --test` cases using a temp-dir app-root fixture where helpful (mirroring the existing `tempDir()` pattern), and reuse the real repo root for the happy-path source read. Follow the existing test that asserts traversal blocks (`note creation is additive and blocks path traversal`).
- **Patterns to follow:** existing `test/chat-agent.test.js` structure (`tempDir()`, `assert.throws(..., /regex/)`).
- **Test scenarios:** (the enumerated U2 scenarios live here as the concrete cases) plus: existing 13 tests still pass.
- **Verification:** `npm test` green; new cases cover every KTD2 guard.

---

## System-Wide Impact

- **Security surface:** introduces filesystem read access scoped to the app root. Risk is contained by KTD2's four guards + size cap; no write surface added. The agent already runs locally on the user's machine with substrate read access, so this widens *what* it reads (its own code) but not *where* it can reach (still local, still read-only, now additionally root-confined and redacted).
- **No API/route changes:** `/api/chat` and `/api/health` are untouched; this is internal to the agent toolset.
- **No new dependencies.**

---

## Risks & Dependencies

- **R-risk1 — Secret leakage via source read.** *Mitigation:* root-confinement excludes the keychain blob and `~/.paperclip/auth.json` (both outside root); denylist blocks `.env`/`.git`/keys; redaction masks anything key-shaped that slips into a repo file; `config.json` holds only non-secret IDs. Tests assert traversal + denylist + redaction.
- **R-risk2 — Confinement bypass via symlink/`..`.** *Mitigation:* resolve then `startsWith(appRoot + sep)` check (proven pattern in `serveStatic`); explicit traversal tests.
- **R-risk3 — Over-broad reads degrading context.** *Mitigation:* size cap + `list_app_source` so the agent navigates before reading; `node_modules` pruned from listings.

---

## Verification Contract

- `npm test` passes, including all new guard tests (traversal, denylist, extension allowlist, redaction, size cap, absent-log, health shape).
- Manual: in the running app, ask the agent "read your own chat tool definitions and explain what you can do" → it calls `list_app_source`/`read_app_source` and answers from real file content; ask "is anything broken?" → it calls `read_app_health`.
- No new write capability: `GATED_TOOLS` unchanged; the four new tools are absent from it.

## Definition of Done

- U1–U5 implemented; `cfg.appRoot` derived; `self.js` tools confined, allowlisted, denylisted, redacted, size-capped; registered in `buildAgent`; system prompt updated; tests green (13 existing + new).
- The agent can, on request, read its own source/logs/health and cannot read outside the app root or surface secrets.

---

## Open Questions (execution-time)

- Exact redaction regex set (which key prefixes / minimum entropy length) — settle against real `sk-`/token shapes during implementation; start conservative (mask, don't drop).
- Whether `read_app_logs` should also surface an Electron-written logfile if one exists at runtime — wire it in only if a stable path is found; otherwise `.gstack/browse-network.log` only.
- Whether to add a tiny `instructions()` assertion test (U4) — include if it stays cheap.
