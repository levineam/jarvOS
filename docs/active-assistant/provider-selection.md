# Active Assistant provider selection

The public runtime kit defines a provider-neutral, data-driven contract for
choosing a provider. It describes a catalog of possible choices, an explicit
preference/proposal flow, a generation-bound preview outcome, and a closed
safe status projection. It does not store credentials, resolve a host
executable, call a provider, authenticate a choice, or deliver a message.

## Catalog

Catalog entries use `jarvos-provider-catalog-entry/v1`. An entry identifies
its provider and model, a closed, non-secret `authCategory`
(`none`, `subscription`, or `usage_metered`), and the reasoning-effort
vocabulary it accepts (`low`, `medium`, `high`, `max`). An entry has no
credential, host path, executable location, or provider-output field.

The built-in default catalog (`getDefaultProviderCatalogEntries`,
`createProviderCatalog()`) contains exactly one entry: a deterministic,
non-paid fixture with `authCategory: 'none'`. A fresh public installation
never hard-codes or advertises a paid Claude, OpenAI, or Grok choice as
authenticated or admitted. A private host supplies its own catalog — which
may be empty, or may include real `subscription`/`usage_metered` entries —
via `createProviderCatalog({ entries })`.

The `authCategory` on a catalog entry, and on the `selected` field of a safe
status, is the only signal a user or agent needs to tell a subscription- or
usage-metered choice apart from a free one. It never carries profile
identity or credentials.

## Preference, proposal, and preview

A preference (`jarvos-provider-preference/v1`) is the current, explicit,
generation-bound choice: `entryId` (or `null` when unselected), an opaque
`generation`, and a bounded `lastPreview` record. `createInitialProviderPreference()`
starts unselected.

A proposal (`jarvos-provider-proposal/v1`) is an explicit request to switch
to a catalog entry, bound to the preference generation it expects
(`createProviderProposal({ catalog, entryId, expectedGeneration })`).

`previewProviderProposal({ catalog, preference, proposal, result })` applies
a generation-bound preview outcome:

- If `proposal.expectedGeneration` does not exactly match
  `preference.generation`, the call returns `{ ok: false, code:
  'stale_generation' }` and leaves the preference untouched. This rejects a
  stale or replayed proposal.
- A `'failed'` result never selects or advances the candidate: it preserves
  the incumbent `entryId` and `generation` exactly, and only records a
  bounded `lastPreview: { entryId, generation, result: 'failed' }`.
- A `'passed'` result advances the preference to the proposed entry and
  computes a fresh generation, so a subsequent replay of the same proposal is
  stale rather than silently re-applied.

## Safe status

`renderProviderSafeStatus({ catalog, preference })` produces a closed,
allowlisted projection (`jarvos-provider-status/v1`): opaque `generation`,
`state` (`unselected` or `selected`), a `selected` summary (`entryId`,
`provider`, `model`, `authCategory`, `reasoningEffort`) when selected, and
the last `lastPreview` record. It contains no credential, path, capability
body, or raw provider output, and rejects any unknown or authority-shaped
field.

## Legacy classifier

`classifyLegacyProviderRecord(record)` is a narrow, inert classifier for a
record left over from an earlier public host schema. It requires an exact
recognized old schema version (`jarvos-provider-profile/v1` or
`jarvos-provider-runtime-view/v1`) **and** a recognized old provider
identifier (`claude`, `grok`, `deterministic`). A missing or unknown provider
always returns `null` — it never grants rollback authority. An exact active
incumbent old profile (or an active old runtime view exposing an active
profile) classifies as `'rollback_only'`; any other recognized record
classifies as `'migration_required'`. The classifier only classifies; it is
inert and never mutates state or grants authority on its own.

## Public contract demonstration CLI

These commands are read-only fixtures for inspecting the portable contract.
They run against a fresh in-memory catalog and preference, so they never
inspect or modify an installed owner's provider configuration:

```bash
node scripts/active-assistant-provider-preference.js catalog --json
node scripts/active-assistant-provider-preference.js status --json
node scripts/active-assistant-provider-preference.js propose <entry-id> --json
node scripts/active-assistant-provider-preference.js preview <entry-id> --result passed --json
```

Selecting and delivering with a real, paid provider is a private owner-side
operator concern; it is not implemented on this public surface.
