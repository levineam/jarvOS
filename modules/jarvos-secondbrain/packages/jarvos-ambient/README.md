# @jarvos/ambient

Portable ambient intelligence primitives for JarvOS-style assistants.

This package starts with the pure intent layer and a replaceable adapter
contract. Intent classifiers return plain objects; adapter wrappers normalize
host side effects such as journal, note, memory, vault, or Paperclip writes.

## Contract

```js
const {
  classifyMessage,
  detectSalience,
  detectTrigger,
  hasCaptureIntent,
  buildThreePackagePlan,
  previewRouting,
  findBestCapture,
  validateCaptureEvent,
} = require('@jarvos/ambient');
```

The generic pattern is:

1. Classify text into structured intent.
2. Convert that intent into a route plan with explicit adapter actions.
3. Apply the plan through replaceable adapters.

`@jarvos/ambient` owns steps 1 and 2 plus the adapter result shape for step 3.
Host apps own routing policy and provide concrete backends.

## Stable Intent Exports

- `classifyMessage(text)` and `detectSalience(capture)` for salience scoring.
- `detectTrigger(capture)` and `hasCaptureIntent(capture)` for explicit capture
  wording.
- `findBestCapture(recentMessages)` and related helpers for retroactive
  "capture that" flows.
- `validateCaptureEvent(event)` plus canonical salience classes and keyword
  triggers.
- `buildThreePackagePlan(capture)` and `previewRouting(capture)` for pure
  journal, note, memory, and work-intake action plans.

These APIs accept plain JavaScript objects and return plain JavaScript objects.
They do not read or write files.

### Source-backed CaptureEvent v2

`CaptureEvent` v2 is the portable boundary for AI-tool activity and prompted
captures. Older v1-shaped events still validate, but new adapters should set
`schemaVersion: "2.0"` and include:

- `source`: tool metadata such as `codex`, `openclaw`, `claude-code`, or a
  `custom:<slug>` source.
- `actor`: `human`, `assistant`, `tool`, `system`, `mixed`, or structured actor
  metadata.
- `captureMode`: `prompted`, `ambient`, `session-summary`, `manual`, `journal`,
  `note-write`, `import`, or `unknown`.
- `privacyTier`: `public`, `local-private`, `private`, `sensitive`, or `secret`.
- `evidence`: source spans or pointers for ambient, import, and session-summary
  captures.
- `origin`: a session, journal, note, prompt, file, URL, or manual origin
  pointer.

The v2 contract is source-backed by design: generated notes, wiki pages, memory
promotion candidates, and graph imports should be able to cite the event that
produced them without depending on a host-specific transcript format.

## Stable Routing Exports

`@jarvos/ambient/routing` returns CRAM-oriented plans: capture first, then
explicit journal, note, memory, and work-intake actions that an adapter can
apply. Plans include `skillInvocations` entries that reference the bridge skill
contracts by name, so a loader/registry can execute the right skill without the
routing layer touching a vault or Paperclip.

## Adapter Results

```js
const {
  createLocalStorageAdapter,
  dispatchSkillInvocations,
  createUnsupportedAdapterResult,
} = require('@jarvos/ambient/adapters');

const adapter = createLocalStorageAdapter({
  storageAdapter: {
    writeNote({ title, content }) {
      return { written: true, path: `/notes/${title}.md`, title, content };
    },
  },
});

const result = adapter.writeNote({
  title: 'Portable capture',
  content: 'Storage-specific behavior stays behind adapters.',
});
```

Routing plans can be applied generically through their `skillInvocations`
entries:

```js
const classification = classifyMessage('The decision is final: use adapter writes');
const plan = buildThreePackagePlan({ text: 'The decision is final: use adapter writes', ...classification });
const dispatch = await dispatchSkillInvocations(plan, adapter);
```

This keeps the portable flow explicit: intent classification -> routing plan ->
skill dispatch -> adapter write. Legacy hosts can keep compatibility shims thin
by forwarding old operation names to the adapter aliases (`writeMemoryRecord`
and `ensureTrackedWork`) instead of duplicating routing behavior.

Every adapter operation returns an `AdapterResult` with:

- `status`: `ok`, `noop`, `unsupported`, or `error`
- `provenance`: adapter/backend/operation/target metadata
- `idempotent`: true when a duplicate or unsupported operation was handled
  without applying a second write
- `result` or `error`: backend-specific payload or explicit failure detail

The local wrapper accepts injected backends for journal, notes, memory, and
Paperclip work intake. The package does not hard-code a vault path, user home
directory, API URL, or token source.
