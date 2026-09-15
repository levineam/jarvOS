# DESKTOP-20260908 acceptance evidence

Captured through 2026-09-09T14:15:20Z from the isolated `desktop-20260908/accepted-feedback` worktree. The existing Desktop listener on port 4807 and all other owner worktrees remained untouched; final candidate acceptance ran separately on port 4821, with a fixture-backed Projects renderer on port 4822.

## Subscription conversation

- Transport: bundled `codex-cli 0.153.4` app-server over server-owned stdio.
- Account receipt: managed ChatGPT authentication, plan `pro`; no credential or token content was read or recorded.
- Model receipt: provider-discovered default `gpt-6-astra`.
- Adapter acceptance: one ephemeral low-effort turn completed and matched its harmless expected reply.
- Full UI acceptance: a second message was submitted through the final hardened Chat page and the streamed assistant reply matched its harmless expected reply.
- Boundary receipt: both successful turns completed with no command, file-change, MCP, dynamic-tool, web-search, image, collaboration or approval event. The adapter fails and interrupts the exact turn if any such event or server-initiated request appears.
- Paid fallback: none. API-key mode remained unselected during both acceptance turns.

This is content-free operational evidence. It intentionally omits account identity, credentials, prompt text and response text.

## Browser test results

Final candidate: `http://127.0.0.1:4821`

| Route / surface | Status | Evidence |
| --- | --- | --- |
| `/#/chat` | Pass | Subscription status and provider-discovered models rendered; a real streamed turn completed; the API-key path appeared only after explicit selection. |
| `/#/projects` | Pass | Current canonical provider state rendered as stale/unavailable with partial-scope and no-fallback wording. Available, empty and missing-evidence variants are fixture-tested. |
| `/#/work` | Pass | Legacy route maps to `/#/projects`. |
| `/#/memory` | Pass | Memory is absent from navigation; the direct legacy route renders the deferred state without reading or deleting underlying data. |
| Voice avatar | Pass | Frontal seeded point cloud rendered at 30 fps / 1,540 lights; controls and metrics were absent until the gear opened; the Explain control visibly applied restrained whole-cloud motion. |
| Narrow Projects | Pass | At the host browser's narrow layout, a two-project provider fixture rendered as a readable stacked list and detail surface with outcome, definition of done, unavailable evidence, next step and provider omissions. |

No visible application error remained after correcting the model-selection transport closure. Console-log inspection was unavailable in the selected host-native browser surface.

## Source verification

- `npm test`: 45 passing tests after final source changes.
- `npm run build`: production bundle built successfully.
- `npm run smoke`: HTTP/static/subscription-model/API-key-model/Projects smoke passed.
- `git diff --check`: clean.

## PR #6 integration qualification

- Compared against exact open PR #6 head `4394c6f196dac7801644bc04c461f58ba966322a` on base `f9939af`.
- `git merge-tree --write-tree 922d0f2 origin/SUP-3900/system-doctor-receipt` completed without conflicts and produced reviewed implementation tree `9f533653c960297529c2fdead54959514a2e1602` before this evidence-only update.
- A disposable worktree at that exact combined tree passed `npm test` (52 tests), `npm run build`, and `npm run smoke`.
- Smoke changed only PR #6's generated rendered-proof fixture inside the disposable lane; the disposable worktree was removed after verification. Neither PR #6 nor its owner branch was changed or merged.

These checks establish source and local candidate behavior only. They do not prove merge, release, deployment, selected-runtime replacement or cross-machine acceptance.
