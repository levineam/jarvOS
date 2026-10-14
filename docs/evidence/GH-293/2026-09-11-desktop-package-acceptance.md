# GH-293 Desktop bundled installation — acceptance record

Scope: source integration and disposable installation only. No public release,
live workspace installation, runtime activation, or old-repository archival.
Harnesses remain the primary interfaces.

## History and package

- Imported Desktop history without squash through reconciled source
  `b910aa76ecc26ed673b847c72ef8174cdd5d41c3`; both reviewed source heads
  `011e75e` and `e6fe82d` remain ancestors.
- An actual root tarball contained the nested lockfile, portable configuration,
  server/Electron source, and prebuilt chat assets. No Desktop dependency tree,
  personal config, test fixtures or internal design documents shipped.
- The first rehearsal tarball used the branch's pre-integration `0.9.0` package
  metadata; this is a local test artifact, not an npm publication or release.
  The final source integration must preserve main's current release metadata.

## Disposable macOS rehearsal

The tarball was installed into a temporary global prefix and exercised through
its installed `jarvos` command, using paths with spaces and an unactivated vault.
Actual nested `npm ci` and Electron binary installation completed successfully.

| Scenario | Observed result |
| --- | --- |
| Default init | Core and a verified Electron app installed; no automatic launch |
| Identical init rerun | Exit 0; configuration and app selection hashes unchanged |
| Explicit headless init | Exit 0; no Desktop directory, dependencies or vault created |
| Failed upgrade | Real npm offline/cache failure returned nonzero; prior selection and config unchanged |
| Retry/upgrade | Real dependencies installed, new content version selected, prior version retained |
| Native launch | Installed Electron executable owned the isolated loopback listener and spawned its renderer |
| Browser rendering | The installed copy rendered Chat, Projects and System; no chat/model request sent |
| Missing providers | Projects explicitly unavailable; System displayed no verified observations |
| App closed | Only the rehearsal process was stopped; no remaining listener on its port |
| Doctor without app | Installed CLI's minimal Doctor returned exit 0 and `ok: true` |

Core configuration SHA-256 remained
`6cb5cc9f7790d9836d2e826a6e1a99250df4e6a4d908096d0660eb9a658c29ca`.
Desktop configuration remained
`832df7ae6e61cefaa214ec38e964ed5a85dcee7fc45cf5cf97e16e45e780d575`.
The dormant vault remained absent throughout. Native process/renderer evidence
and browser-rendered evidence are separate: a native-window screenshot was not
available. Linux/Windows native launches were not exercised on this host.

## Verification and review

- Desktop tests and configuration/HTTP port-collision cases passed; the build
  reproduced tracked prebuilt chat assets without a diff.
- Focused installer, real CLI/alias entrypoint, tarball and CI configuration
  tests passed. Tests cover default/skip/partial retry, configuration
  preservation, source exclusions and unsafe paths.
- The initial root `npm test` hit two timing-sensitive runtime-kit failures.
  Both affected files subsequently passed together, 58/58. A reduced-concurrency
  run passed the chain up to a stale CI-job count assertion introduced by this
  feature; that assertion was fixed and reverified. The remainder of the root
  chain then completed with exit 0. Exact-head CI remains the final full-chain
  gate; these segmented local checks are not described as a clean initial run.
- Independent managed Opus 5 review identified stale-lock takeover/release,
  launch stdio buffering, inconsistent nested source exclusions and failed-stage
  retention. Fixes fence recovery, release only owned locks, inherit launch
  stdio, use one exclusion predicate, and remove only the current attempt's
  verified failed stage. Prior/foreign stages and prior versions remain intact.
- A separate bounded native review of the CI scanner adjustment found no P1/P2
  blockers. Its tests retain literal and same-line credential detection while
  removing three inspected non-literal Desktop false positives. Generated
  bundles are not exempt from scanning.

## Submission boundary

This record is completed by the exact source PR/head and required CI result.
No live installation, publication, signing/notarization or provider activation
is implied by source merge. Runtime providers and observations still require
their existing host-authorized bindings and owners.
