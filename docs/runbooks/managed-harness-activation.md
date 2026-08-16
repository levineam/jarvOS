# Managed harness activation

Operator runbook for inspecting, dogfooding, and rolling back jarvOS managed
harness activation. Activation is a derived, evidence-bound state — not an
install flag, skill install, health check, or registration receipt.

## Purpose

- Assess whether a public runtime is **configured**, **prepared**, or **active**
  under the managed-activation contract.
- Run a **disposable** prepare → real harness lifecycle → verify loop without
  touching live profiles.
- Roll back only what this run owned, and refuse when bytes or modes drifted.

## Non-goals

- Not a second global activation registry. Public truth lives in each runtime’s
  `managedActivation` block inside `runtimes/{claude,codex,hermes,openclaw}/adapter.json`.
- Not a jarvOS-owned daemon, supervisor, or restart loop.
- Not skill installation, native skill discovery, MCP registration, plugin
  persistence, process liveness, or health as activation proof.
- Not permission to test against a dirty checkout root or an active real profile.
- Local `managed-launcher.json` (when present) is **installation evidence only**.
  It is not an activation flag and not an activation manifest.

## Ownership matrix

| Harness | Execution owner | Background process | Live proof |
| --- | --- | --- | --- |
| Claude | `native-hooks` | none; jarvOS does not start a process | Fresh native **session** or **turn** receipt |
| Codex | `native-hooks` | none; managed launcher is a **per-session fallback**, not a daemon | Fresh native **session** or **turn** receipt |
| Hermes | `harness-process` | Hermes host/gateway owns lifetime | Ordered harness-owned **session** then **`pre_llm_call` turn** |
| OpenClaw | `harness-process` | OpenClaw host/gateway owns lifetime | Ordered harness-owned **session** then **`agent_turn_prepare` turn** |

There is **no symmetry daemon**. Hermes and OpenClaw stay harness-process owned;
jarvOS must not add a supervisor “for parity” with Claude/Codex.

Skill installation and native discovery are **orthogonal and downstream**. The
package skill preflight stays `activating: false`, `readOnly: true`, with live
gates off. It may read only redacted activation status and **cannot** start or
promote a harness.

## State and evidence rules

State is **derived at read time** and never stored as an `active` boolean.

Closed states:

- `unconfigured`
- `prepared`
- `awaiting_live_proof`
- `active`
- `degraded`
- `rollback_pending`
- `rolled_back`

`active` requires a **fresh causal receipt** bound to the exact selected tuple:

1. canonical harness id
2. selected public/runtime generation
3. selected asset digest
4. stable-entrypoint digest
5. installed-config binding digest

Freshness: **15 minutes** (`900` seconds), with at most **30 seconds** forward
skew.

The following **cannot** activate, alone or combined:

- registration, health, plugin persistence, process liveness
- skill visibility or skill install receipts
- a stale, future, replayed, pre-baseline, or tuple-mismatched receipt
- fixture receipts that did not come from a real harness lifecycle event

Health may explain **degradation** (`health_degraded`) but **never** activates.

### Public status (closed / redacted)

Public status fields only:

- `schemaVersion`, `harness`, `state`, `generationDigest`
- `evidenceClasses`
- `freshThrough`, `evaluatedAt`
- allowlisted `reasons`

Never surface in public status: paths, commands, correlations, session or
process ids, or raw diagnostics.

### Owner-local retention

| Material | Mode | Retention |
| --- | --- | --- |
| Owner root / run dirs | `0700` | disposable challenge root |
| Raw challenge / receipt files | `0600` | expire after **24 hours**; deleted on success or rollback |
| Redacted status | `0600` | at most **30 days** |

## Read-only status procedure

Contract and adapter checks (not live activation proof):

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check all --json
```

Derived activation status for all harnesses (no evidence file → typically
unconfigured / missing configuration):

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js activation-status all --json
```

Status with an explicit owner-local evidence file:

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js activation-status codex --evidence /absolute/owner/evidence.json --json
```

These commands are **read-only evaluators**. They do not start harnesses, write
profiles, or promote state.

## Disposable dogfood: prepare → real event → verify

Use only an **explicit absolute disposable owner root** and exact absolute input
file paths. Prepare never starts a process.

Show help (flags must match this implementation):

```bash
node modules/jarvos-runtime-kit/scripts/dogfood-managed-activation.js --help
```

Expected help shape:

```text
Usage:
  dogfood-managed-activation.js prepare --harness <id> --owner-root <absolute-disposable-root> --generation <id> --asset <absolute-file> [--asset ...] --entrypoint <absolute-file> --config-binding <absolute-file> [--json]
  dogfood-managed-activation.js verify --harness <id> --owner-root <same-root> --run <opaque-run-id> [--json]
```

### Phase 1 — prepare

Placeholder disposable paths only (replace with real absolute disposable files
you control; do not point at live profiles):

```bash
node modules/jarvos-runtime-kit/scripts/dogfood-managed-activation.js prepare \
  --harness codex \
  --owner-root /absolute/disposable/owner-root \
  --generation public-gen-example \
  --asset /absolute/disposable/selected-asset.js \
  --entrypoint /absolute/disposable/stable-entrypoint.js \
  --config-binding /absolute/disposable/config-binding.toml \
  --json
```

Prepare attests the selected tuple, mints an opaque run/correlation, and writes
owner-only challenge material under the disposable root. Outcome is
`dogfood.outcome: prepared` with state awaiting live proof — **not** active.

### Phase 2 — real external lifecycle

Between prepare and verify, the **real harness** must emit the qualifying
lifecycle event(s) for that harness (see ownership matrix). The owner-local
selected-runtime bridge records the resulting receipt for the prepared
challenge; operators should not hand-author receipts. Do **not** invent flags.
Do **not** claim fixture receipts prove a live harness.

### Phase 3 — verify

```bash
node modules/jarvos-runtime-kit/scripts/dogfood-managed-activation.js verify \
  --harness codex \
  --owner-root /absolute/disposable/owner-root \
  --run <opaque-run-id-from-prepare> \
  --json
```

Verify re-attests the stored absolute inputs, evaluates the managed-activation
contract, and on success performs **exact-owned** rollback of files this run
created (digest + mode must still match). On mismatch it **refuses**, leaves
material in place, and reports `rollback_pending` / `rollback_refused_modified`.

## Exact rollback and refusal

- Rollback ownership is **exact-owned** only: remove only inventory entries whose
  current bytes and modes still match the prepare baseline.
- Modified, ambiguous, or unreadable inventory → refuse deletion; state
  `rollback_pending` with reason `rollback_refused_modified`.
- Successful verify deletes raw challenge/receipt material and may retain only
  redacted status (≤ 30 days).
- Disposable dogfood rollback removes only run-owned challenge material. A
  separate installed-runtime rollback must invalidate its selected generation
  before public status can derive `rolled_back`.

## Safe post-merge local adoption checklist

Live local dogfood or adoption happens **only after** the public commit is
merged and staged through the selected-runtime mechanism.

1. Confirm the public change is merged and the selected runtime generation is
   the one you intend to attest.
2. Use a clean, staged selected-runtime tree — **never** a dirty root or active
   real profile.
3. Run `check all --json` and `activation-status all --json` as read-only
   baselines.
4. Dogfood only under an absolute disposable `--owner-root` with explicit asset,
   entrypoint, and config-binding paths.
5. Drive a real harness lifecycle between prepare and verify; treat anything
   short of fresh causal receipt as non-active.
6. On success, confirm exact-owned rollback completed; on refusal, stop and
   inspect redacted reasons without promoting the harness.

## Truthful result reporting

| Outcome | Meaning |
| --- | --- |
| `prepared` / `awaiting_live_proof` | Tuple attested; no qualifying live receipt yet |
| `active` | Fresh causal receipt bound to the exact tuple |
| `degraded` | Evidence present but stale, mismatched, out of order, replayed, or health-explained |
| `pending` (dogfood) | Verify ran; still waiting on live proof |
| `passed` (dogfood) | Active evaluation **and** exact-owned rollback completed |
| `rollback_pending` | Active or inventory path refused safe cleanup |
| `expired` | Raw challenge material past 24h TTL |
| `failed` | Invalid evidence, tuple drift, or evaluation did not reach active |

Static checks (`check`, adapter validation) are **not** live activation proof.

## Troubleshooting

| Symptom | Likely cause | Operator action |
| --- | --- | --- |
| Stays `awaiting_live_proof` / dogfood `pending` | No fresh qualifying receipt after prepare baseline | Run the real harness lifecycle; re-verify within 15 minutes |
| `receipt_stale` | Receipt older than 15 minutes | Produce a new live event; do not reuse stale material |
| `receipt_future` | Clock skew beyond 30s | Fix clocks; re-run with honest timestamps |
| `selected_tuple_mismatch` / asset / entrypoint / config digest mismatch | Inputs changed after prepare | Re-prepare with the intended absolute files |
| `sequence_incomplete` / `sequence_out_of_order` | Hermes/OpenClaw missing ordered session→turn | Emit both events in order for the same correlation |
| `evidence_unreadable` / `unsafe_path` | Non-absolute path, bad modes, or unreadable owner file | Use absolute owner-only paths (`0700` dirs, `0600` files) |
| `rollback_refused_modified` | Inventory bytes/modes drifted | Leave material; resolve manually; do not force-delete |
| `receipt_replay` / challenge consumed | Verify already consumed the challenge | Start a new prepare run |
| Skill preflight shows redacted status only | Expected | Preflight is read-only and cannot activate |

## No-daemon / no-symmetry decision

jarvOS does **not** introduce a managed-harness supervisor for any of the four
runtimes. Claude and Codex remain native-hook owned (launcher is fallback only).
Hermes and OpenClaw remain harness-process owned. Do not invent a shared
background process to make their activation stories look the same.
