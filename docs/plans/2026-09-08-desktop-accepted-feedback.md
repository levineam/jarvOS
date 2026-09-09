# Desktop accepted feedback — DESKTOP-20260908

Status: implementation and local acceptance complete September 9; exact-head review and repository submission pending.
Owner: permanent Overseer, task 01a07313-13c6-7e13-af99-4f5f09d53527.
Authority: Andrew's September 8 request to continue Desktop after accepting both diffuse-cloud reference images and Projects A only.
Local tracking key: DESKTOP-20260908. This document tracks this finite implementation slice.
Repository: /Users/andrew/jarvos-desktop.
Branch: desktop-20260908/accepted-feedback, isolated worktree from origin/master f9939af490a71bfbffb4c9f25023a15aea06a01a.

## Outcome

Deliver an inspectable local Desktop build with subscription-first chat, the selected Projects portfolio design, a frontal diffuse particle avatar, avatar controls behind a gear, and Memory hidden with development deferred. Completion requires running UI evidence and an actual subscription-backed conversation; an image or successful build alone does not close the work.

## Accepted visual contract

Projects uses A only: portfolio list beside selected project outcome, definition of done, completion evidence and next step. No milestone journey or B detail view. Unknown criteria remain unknown; never infer percentages from issue counts.

Avatar references C4/C5 are acceptable direction, but Andrew's written rules are authoritative:

- Frontal human head and shoulders, facing directly toward the viewer.
- A probabilistic cloud with roughly uniform random spacing inside the implied human form.
- Particle placement is independent of eyes, nose, mouth and all other facial landmarks.
- Facial features emerge solely from a smooth brightness field.
- No point rows, outlines, rings, concentrated facial clusters or dense mouth particles.
- Outer head, shoulders and torso fade through broad probabilistic thinning and dimming without a clear silhouette boundary.
- Preserve cool point lights, calm adult proportions and restrained motion.

## Inspected implementation facts

The merged renderer uses weighted anatomical regions, including a dedicated mouth region, separate mouth particles/container and speech-driven mouth scaling/displacement. This directly contradicts the accepted placement rule. It also samples bounded ellipses/segments that create hard regional edges.

Chat currently rejects requests without an API key and runs an AI SDK provider with that key. Subscription-first behavior therefore requires a transport integration, not only changing the label.

The supported local integration is the bundled Codex app-server protocol. The installed ChatGPT-bundled Codex `0.153.4` is already authenticated through ChatGPT and supports account/model reads, ephemeral thread/turn creation, streamed agent-message deltas and turn interruption. Its current schema does not expose read roots within the read-only sandbox, so isolation must combine a server-owned empty working directory, empty environments/capability roots/dynamic tools, disabled shell/image/web features, empty MCP configuration and fail-closed handling of any unexpected tool or approval request. Existing app-server processes and the shared credential store must not be disturbed.

The available canonical Projects context read is scoped to the jarvOS subtree. It returns canonical definitions, but Beads and other activity evidence are missing/unverified/stale. The UI must accurately show this scope and quality; it cannot claim whole-portfolio coverage or fabricate verified criteria.

A fresh canonical Projects-provider read returned `PROJECTS_CONTEXT_STALE`. That is an expected honest unavailable state for this slice, not permission to bypass the provider. Fixture-backed tests will establish the available and partial render paths while the live UI preserves the current stale result.

PR #6, SUP-3900 System Doctor receipt, is still open and touches server/index.js, static/app.js, static/style.css, config.json and smoke tests. Keep this branch independent; preserve its System work and reconcile any actual overlapping changes before submission. Previous avatar PR #5 and SUP-3894 are complete and must not be reopened.

## Ordered implementation

### 1. Subscription-backed chat — highest product priority

Inspect the installed Codex app-server integration and use its managed ChatGPT authentication lifecycle rather than reading or repurposing stored tokens. Reuse an existing compatible adapter if present; otherwise build one small server-owned adapter around the supported protocol.

Primary UX: reuse an existing authenticated ChatGPT account when supported; otherwise Sign in with ChatGPT. Show account/allowance state from actual replies. Keep API-key access explicitly selected in Settings, with no automatic paid fallback.

Preserve streaming, cancellation, error/limit feedback and the existing approval boundaries for writes and dispatch. Discover available models from the selected connection instead of promising a hard-coded subscription model. Keep server-owned executable/configuration fixed; browser input cannot supply executable paths or credentials. Validate request origin for local control endpoints. Handle logout/login failure, process exit and timeouts without orphaned work.

Treat app-server as an agent execution boundary, not a completion endpoint. Use an empty server-owned working directory and read-only sandbox; do not inherit ambient user MCP/tool capabilities. Default-deny execution, patch and MCP requests and verify no command, filesystem write or remote mutation runs from ordinary chat. Only deliberately implemented Desktop actions may reach their existing approval boundary. Verify the supported protocol can enforce this before choosing adapter flags; unsupported isolation is a blocker, not permission to rely on prompt text. Validate loopback Host as well as Origin. Omit logout that would clear the shared terminal Codex credential store. If human sign-in is required, complete mock verification first and state that remaining acceptance dependency. Check official app-server/client authentication support before integration.

Do not assume subscription access covers Realtime/audio API calls. Existing local dictation may remain; no separately billed voice path is added.

### 2. Projects A and Memory deferral

Use a small read-only server adapter to the existing host-authorized Projects provider. Preserve the provider's scope, timestamps, omissions and unavailable states. Do not raw-read the registry as a fallback or create a second project database.

Render the real available project list and selected outcome/definition. Show evidence only when its relationship to a specific completion criterion is established. With missing structured verification, show the definition plus 'Completion evidence unavailable'; omit fabricated segments. Show a clear partial-coverage explanation if only the jarvOS subtree is available. Whole-portfolio host admission remains a dependency if the configured provider cannot cover Andrew's full portfolio.

The adapter must pass through provider-declared scope and as-of timestamp. Missing/undeclared scope defaults to partial or unknown; full-portfolio wording requires an explicit provider declaration.

Rename navigation and page to Projects; redirect the legacy Work route. Hide Memory navigation and route to a concise deferred state without deleting underlying data. Record Memory development as deferred in this document.

### 3. Probabilistic avatar and hidden controls

Keep the existing Pixi renderer/state lifecycle. Replace the weighted bone/feature sampler with seeded random spatial sampling governed only by a smooth head/neck/shoulder envelope. Aim for consistent random spacing, rejecting only excessively close neighbors, with a bounded sampling loop.

Compute a separate, smooth luminance function on positions. Broad eye-socket shadows, nose-plane light and mouth-area shading may modulate brightness, never sampling probability or particle position. Remove the dedicated mouth particle group and anatomical mouth movement. Speech modulates a soft luminance field; subtle whole-cloud breathing/drift preserves frontal orientation and the same statistical distribution.

Use a broad tail on the spatial envelope and alpha falloff, retaining faint scattered peripheral points. Keep dot size roughly uniform and independent of facial features. Choose density using rendered comparison, not an arbitrary low point count.

Put state/gesture/energy/performance controls and metrics behind a closed-by-default settings gear. Normal view has the avatar and ordinary close/listening controls only. Preserve keyboard focus, Escape, reduced motion, low-performance mode, and zero rendering while hidden.

## Verification

- Subscription: mock protocol tests for login states, streamed response, cancellation, denied writes, process failure and no key fallback. Then a minimal explicit user-facing conversation through the authenticated subscription path; capture content-free connection/model evidence, never tokens.
- Projects: fixture-backed rendering for real criteria, missing evidence, stale/partial provider, empty list and provider unavailable. Validate escaping and selection. No completion count without supporting evidence.
- Avatar: positions depend only on seed and time; compare at identical seed and time while changing brightness or speech. Dot size depends on seed only. No dedicated facial particle group; matched interior eye/nose/mouth and cheek/forehead sampling windows have comparable density within a documented statistical tolerance that accounts for the global head envelope. Preserve soft envelope/tail and finite values. Render equal-brightness and normal views side by side in the development controls: the former should contain no facial landmarks.
- Browser: inspect the actual rendered avatar head-on, Projects A at desktop/narrow widths, hidden settings, missing-data labels and removed Memory navigation. Check idle/speaking/reduced-motion/hidden transitions and frame metrics at both budgets.
- Run existing tests/build/smoke appropriate to touched behavior. Review final diff once against the relevant risks and complete the repository submission path with exact head evidence.
- Preserve original checkout, other worktrees and PR #6. Rollback by abandoning this isolated candidate; do not change selected runtime or unrelated live state.
- Keep the new subscription/Projects adapters, Projects view and tests in cohesive modules with thin shared-file wiring. Before submission, refresh PR #6 and establish integration against its exact head in a disposable lane; record conflict-free or reconciled behavior. Coordinate existing ownership rather than merging PR #6 without authority or treating its mere existence as an indefinite wait.

## Review packet and current gate

One bounded Fable 5.1 review of this plan, focusing on (a) subscription/tool-approval boundary, (b) canonical Projects coverage and evidence truth, (c) independent particle placement and luminance, and (d) PR #6 overlap. The reviewer receives this plan only, not credentials, private notes or ambient history, and uses the mandated tool-less managed Max route. Integrate substantive findings before production edits.

Andrew explicitly authorized this Desktop review September 9. Managed Max authentication and the exact served Fable 5.1 model were verified. See [review receipt and dispositions](2026-09-09-desktop-fable-review.md). The review found four gaps, now incorporated in the execution and verification steps; no repeat review is required solely to restate these corrections. Live `/usage` was subsequently refreshed at 12:44:30Z: 4% short-window, 35% weekly, 12% Fable-weekly used; this is time-bound evidence, not a standing future grant.

## Execution disposition

Implemented in the isolated branch with passing source tests/build/smoke, a genuine subscription-backed adapter turn, a genuine rendered UI turn, provider-truthful Projects states, and desktop-width browser evidence. See [acceptance evidence](../evidence/DESKTOP-20260908/acceptance.md).

One acceptance item remains open: the selected host-native browser did not expose a narrow-viewport override, so a rendered narrow-width check is still required. Before submission, refresh PR #6, establish integration against its exact head in a disposable lane, run one final exact-head review, and complete the authorized repository submission path. Owner remains this task until terminal callback is acknowledged. No release, deployment or selected-runtime replacement is authorized.
