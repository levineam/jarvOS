#!/usr/bin/env bash
set -euo pipefail

# Known-safe shapes the secret pattern matches but which cannot carry a credential.
# Each rule must be narrow enough that a real secret still trips the scan: these
# filter on the *shape of the value*, never on the file it appears in, because a
# path-based exemption is how a scanner quietly stops scanning.

# 1. GitHub Actions secret references: KEY: ${{ secrets.NAME }} -- the value is a
#    reference resolved at runtime, never a literal.
safe_github_secret_reference='^([^:]+:[0-9]+:|\+)[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*:[[:space:]]*\$\{\{[[:space:]]*secrets\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\}\}[[:space:]]*$'

# 2. Environment-variable indirection: the value is process.env.NAME (or a bracket
#    lookup), i.e. the line names where a secret comes from without containing one.
safe_env_indirection='(process\.env(\.[A-Za-z_][A-Za-z0-9_]*|\[[^]]+\])|\$\{?[A-Z_][A-Z0-9_]*\}?)[[:space:]]*,?[[:space:]]*$'

# 3. Obvious test placeholders: a short quoted literal that is self-evidently not a
#    credential. Deliberately an explicit allowlist of placeholder words rather than
#    a length or entropy heuristic -- 'test-key' is safe, an actual key is not, and
#    only an exact-match list can tell them apart reliably.
safe_test_placeholder="[:=][[:space:]]*['\"](test|test-key|test-secret|dummy|placeholder|example|fake|redacted|xxx+|changeme|not-a-real-[a-z-]+)['\"][[:space:]]*[,;)]?[[:space:]]*$"

grep -Eiv "$safe_github_secret_reference" \
  | grep -Eiv "$safe_env_indirection" \
  | grep -Eiv "$safe_test_placeholder"
