# SUP-3816: separate Projects profile receipts

This is the source-only submission brief for the accepted Projects receipt-binding repair, not a new runtime activation plan.

## Goal and scope

Keep `orientation` as the default normal-assistant read. Allow the existing optional `recent-activity` profile to use a distinct protected host receipt without widening canonical scope, changing principal/redaction, or falling back to an administrative capability.

The change belongs in `modules/jarvos-agent-context/src/projects-context-bootstrap.js`, its module README, and one focused regression file. Missing or invalid optional bindings must not disable orientation. Retain `projects-profiles-1`, exact-query verification, and all existing limits, including the 86,400-second recent-activity provider-age ceiling.

## Source acceptance

- Distinct signed receipts preserve default/orientation reads and select recent activity through the trusted host binding.
- Caller-shaped authority fields cannot replace host values; absent, aliased, unprotected, out-of-root, malformed, expired, or query-mismatched receipts fail closed.
- Calendar-day activity boundaries, provider coverage omissions, and bounded truncation remain enforced.
- Existing roster, proof, proposal, and neighboring assistant-context behavior remain unchanged.
- The README explains the optional configuration and the separate activation boundary.

Verify with `node --test --test-concurrency=1` against the profile-receipts, Projects context, roster-bootstrap, portfolio-proof-bootstrap, query-profiles, and packet-context test files. Record behavioral observations at the submitted head, not only test counts.

## Review and delivery

The immutable implementation commit `2d7e2caea13d6fa6c116a7ef9a116e46f4a9df73` received one independent native risk-targeted review: accepted, no actionable P1/P2, four focused checks passed. This brief adds only the portable Git plan pointer required by the submission trace; it does not change that reviewed implementation.

Submit on the existing issue-named branch, verify exact-head CI, and merge when the existing source-workflow gates pass. Preserve the dirty primary checkout and existing owner. Stop for failed gates, source conflicts, or a material scope change.

Capability issuance, credentials, live configuration, runtime installation/selection/restart, profile freshness changes, producer edits, scheduling, and release publication are excluded. Source merge does not complete the broader Projects/Todos outcome or prove installed recent-activity acceptance.
