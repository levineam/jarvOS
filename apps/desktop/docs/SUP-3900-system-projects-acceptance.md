# System and Projects acceptance

September 10, 2026. Continuation of PR #6 after PR #7.

## Source verification

- 57 tests pass, including receipt expiry, future/untrusted observations, per-row receipt timestamps, provider freshness, hidden-page refresh, single-flight reads, navigation races, failure backoff and recovery.
- `npm run build` and `npm run smoke` pass. No new dependencies.
- Managed Fable 5.1 plan review and Opus 5 code review completed with served-model receipts. No model calls are part of the app's System or Projects reads.
- The code review's per-row receipt freshness finding was fixed: envelope dates cannot overwrite individually expired observations. Receipt files are opened without following symlinks, checked by descriptor, and require an owned non-writable parent and owner-only file permissions.
- Provider map normalization, HTML attribute escaping, and pulse formatter were verified in their existing implementations. They were review hypotheses, not defects. The actual provider freshness enum is `fresh`, and a positive test proves its next-step path.
- The public owner validator remains the authority for trust, validity and the Memory roster. Desktop does not invent a separate maximum TTL or redefine optional-component policy.
- The obsolete generated live-host fixture from the original PR was retired; deterministic tests no longer rewrite source fixtures or depend on a developer's live health.

## Browser evidence

The actual local candidate served the System page with owner-published System generation 14, observed September 10 at 14:58:30 UTC. The page showed SearXNG requiring repair, stale GBrain continuity, eleven Memory rows and explicit source validity. Connection indicators were labeled separately from system verification. The narrow-window layout was visually checked and corrected.

The Projects candidate consumed the shared SUP-3926 producer through its host-authorized orientation interface. It displayed six projects from nine canonical records, including Desktop's goal and definition of done. Missing completion evidence and next steps stayed unavailable. Five incomplete supporting sources and record truncation were disclosed. Two root projects omitted by the existing byte limit are not claimed as displayed.

This is consumer acceptance of a scoped packet, not a claim of a complete portfolio or installed shared-runtime activation. Shared producer delivery, stable private host bindings, continuous snapshot publication and work follow-through disposition remain with their linked owners until separately verified.
