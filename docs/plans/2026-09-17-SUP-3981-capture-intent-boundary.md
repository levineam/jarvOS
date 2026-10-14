# SUP-3981: Explicit-intent boundary for durable capture

## Communication Contract

Report outcome evidence separately for source, tests, review, merge, activation, and live behavior. Do not collapse them into "done."

## Recommendation

Require explicit durable-capture intent at both public authorization gates. Salience and confidence remain descriptive metadata after authorization; they never grant permission to create a note, journal backlink, or durable memory record.

This fixes the incident at the durable-mutation boundary rather than by deleting phrases or tuning classifier confidence. Public jarvOS owns the rule. Private clawd mirrors the public source and proves the host hook cannot bypass it.

## Current state

- Two ordinary Telegram work requests were classified as `preference` with confidence `0.9` and incorrectly routed to journal, notes, and memory.
- Both requests have no keyword trigger and no explicit capture intent.
- `bridge/dispatch/src/capture-dispatcher.js` currently promotes high-confidence salience into a synthetic capture route.
- `packages/jarvos-ambient/src/routing/index.js` independently un-ignores high-confidence salience and creates durable actions.
- Private `scripts/capture-router-hook.js` classifies ordinary messages and calls the public dispatcher.
- Current installed/private host code records ordinary contextual activity separately before capture routing; that non-durable observation path must remain intact.
- Content-origin hardening is already merged. Provenance describes intentional artifacts but never authorizes their creation.

## Scope and ownership

### Public jarvOS

1. Add one pure capture-authorization predicate under the ambient intent package and export it through the package and bridge surfaces.
2. Recognize explicit caller triggers, strict commands, keyword/natural-language note directives, save/write-down directives, and intentional Idea directives.
3. Remove salience-only authorization from the ambient routing plan.
4. Require authorization before dispatcher skills can invoke routing. Never synthesize a trigger from salience.
5. Return an observed-only result for unauthorized high salience: no routing object, destinations, adapter call, or acknowledged artifact receipt.
6. Preserve salience/confidence decoration on explicitly authorized captures.
7. Update portable contracts and docs that currently describe salience-only durable writes.
8. Add exact-shape regressions and positive controls.

### Private clawd

1. Mirror the changed public-owned jarvos-secondbrain files byte-for-byte after the public candidate is settled.
2. Keep `scripts/capture-router-hook.js` semantics unchanged unless tests reveal a host-only contract gap.
3. Change the legacy capture-hook smoke test so high-confidence decisions are observed-only.
4. Add a spawned-process regression using isolated temp Vault and memory roots for the two incident prompts, an arbitrary high-confidence preference, and explicit Note/save/Idea controls.
5. Document that salience is descriptive and explicit intent is required.

The private plugin's ordinary activity/Active Assistant observation path stays unchanged. No Vault, Telegram, or runtime mutation occurs during implementation.

## Authorization contract

The pure predicate returns:

```js
{
  authorized: boolean,
  source: 'hard_command' | 'caller_trigger' | 'keyword_trigger' | 'natural_language' | null,
  trigger: 'idea' | 'note' | 'journal' | null,
}
```

Priority: strict command, explicit caller trigger, keyword/natural-language note or Idea trigger, then bounded save/write-down/remember directives. Salience, confidence, provenance, role, and content-origin fields are not authorization inputs.

Unauthorized high salience returns `captured:false`, `observed:true`, `path:'salience_observed'`, descriptive observation metadata, empty destinations, and an empty artifact receipt. Medium/ordinary no-intent results keep existing ignored/no-capture semantics.

## Acceptance scenarios

Negative cases must make zero durable adapter calls and create no journal, note, backlink, or memory artifact:

- `I want to make sure that the article-generator skill is generic...`
- `I want you to look at the transcripts from the following videos...`
- Any high-confidence preference without explicit capture intent.
- The same no-intent preference even when supplied valid content-origin evidence.

Positive controls must retain current behavior and canonical content origin:

- `Note: ...`
- `make a note ...`
- `save this ...` and `save that ...`
- `Idea: ...` as journal Ideas only.
- Explicit note text with high salience may use that salience for downstream routing only after intent is established.
- Bare `Note:` remains `needs_input` with no write.

## Verification

Public targeted gates:

```bash
node --test modules/jarvos-secondbrain/tests/capture-intent-boundary.test.js modules/jarvos-secondbrain/tests/capture-dispatcher.test.js modules/jarvos-secondbrain/tests/keyword-capture-router.test.js modules/jarvos-secondbrain/tests/universal-capture.test.js modules/jarvos-secondbrain/tests/skill-contracts.test.js modules/jarvos-secondbrain/tests/three-package-router-invariant.test.js modules/jarvos-secondbrain/tests/content-origin-writer-conformance.test.js
node --test modules/jarvos-secondbrain/packages/jarvos-ambient/test/*.test.js
node modules/jarvos-secondbrain/bridge/routing/test/test-capture-system.js
npm --prefix modules/jarvos-secondbrain test
npm test
git diff --check
```

Private targeted gates:

```bash
npx vitest run tests/scripts/capture-router-hook-intent-boundary.test.js tests/extensions/capture-router.test.js tests/capture-path-integration.test.js
node scripts/test-capture-hook.js
git diff --check
```

After local verification, freeze exact candidate SHAs and obtain one Astra/medium read-only review. Material findings receive one bounded Sonnet correction and one fresh Astra review.

## Submission and activation

1. Open and merge the public PR first when local gates, Astra, and required CI are clean.
2. Reconcile the private mirror against the merged public commit, include the required `UPSTREAM_PLAN:` trailer, then open and merge the private PR when its gates are clean.
3. Activation is a separate proof layer. Continue only through the existing managed/protected runtime authority. Do not send Telegram.
4. No-send live proof uses the installed workspace hook with temp Vault/memory roots and verifies non-intent inputs produce observed-only results and zero files, while explicit controls still write only to temp roots.
5. Verify the selected/installed source tuple and rollback artifact. Passive log inspection may confirm no new salience-only durable rows, but absence alone is not behavior proof.

Rollback is private PR revert first, then public PR revert. There is no schema or data migration.

## Stop conditions

Stop before merge or activation if any no-intent case invokes a durable adapter; a positive control loses its receipt or origin metadata; writer-inventory conformance fails; the private mirror diverges from the reviewed public implementation; required CI/review is missing; or activation would exceed the managed protected-runtime path. Never delete the two accidental notes or send Telegram without separate authority.

## Planner receipt

- Planner: exact `claude-fable-5-1`
- Receipt UUID: `0ab403e3-bfcf-4af8-b1f4-44fb002f0a73`
- Result: `is_error:false`, `terminal_reason:completed`, first-party Max route
- Executor recommendation: exact `claude-sonnet-5`; Opus not required
