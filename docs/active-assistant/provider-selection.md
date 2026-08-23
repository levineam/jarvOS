# Active Assistant provider selection

The public runtime kit defines the provider-neutral contract. It describes
portable adapter distributions, owner-private profiles, redacted health, and a
generation-bound read view. It does not store credentials, resolve host
executables, call a provider, select a runtime, schedule a cycle, or deliver a
message.

## Profiles and adapters

Profiles use `jarvos-provider-profile/v1`. A profile identifies its provider and
concrete model, adapter distribution and capability revision, explicit auth
mode, prompt transport, deny-all tool policy, egress-policy digest and
qualification state. The profile has no credential, host path, executable
location, provider output, or authority field.

Managed descriptors use `jarvos-managed-adapter/v1`. The portable runtime kit
ships a Claude CLI descriptor and a deterministic fixture descriptor. The Grok
subscription descriptor is intentionally `unsupported` with
`capability_proof_pending` until its separate capability proof is accepted.

The built-in registry has no default profile and no active profile. A fresh
installation is therefore `unconfigured`; registering a descriptor does not
authenticate it or make a paid call. `auth_required`, `unsupported`,
`unhealthy`, `available`, and `active` health classifications are separate,
redacted observations.

## Read-only lifecycle view

`renderProviderReadView()` reconstructs an allowlisted public view from an
owner-private operator snapshot. The view is marked `runtime-rendered` and
`readOnly`; it contains only public profile fields, opaque generation and tuple
references, redacted health, qualification, and rollback references. It does
not contain authority booleans, credentials, paths, capability bodies, raw
provider output, or generated repository state.

The public view cannot authorize preparation or delivery. Private operator code
must check `isProviderViewPreparationEligible(view, { operatorGeneration,
selectedTupleDigest })`; that check requires the view generation, private
operator generation, selected tuple, and profile tuple to match exactly. An
`active` profile with `qualificationState: legacy` remains eligible only on its
exact incumbent tuple. Delivery remains private and is never authorized by a
public view.

Changing any egress-policy identity field changes the profile identity and
requires fresh qualification. Owner acceptance is explicit in the profile.

## Public inspection and proposal CLI

These commands are read-only and use the same contract as an agent caller:

```bash
node scripts/active-assistant-provider.js list --json
node scripts/active-assistant-provider.js status --json
node scripts/active-assistant-provider.js propose-switch deterministic-fixture --tuple <sha256> --json
```

`authorize-and-run` and `rollback` return `owner_authorization_required` from
this public surface. The local owner operator is the only activation authority.

