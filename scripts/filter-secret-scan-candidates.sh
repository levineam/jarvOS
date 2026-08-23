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
safe_test_placeholder="[:=][[:space:]]*['\"](test|test-key|test-secret|dummy|placeholder|example|fake|redacted|xxx+|changeme|not-a-real-[a-z-]+)['\"][[:space:]]*[,;)]?[[:space:]]*\$"

# The exit status is the signal the CI job reads: 0 means at least one candidate
# survived filtering and the scan should fail. Because the final stage is awk (which
# exits 0 whether or not it printed), the status is decided here rather than
# inherited from the pipeline.
survivors="$(
  grep -Eiv "$safe_github_secret_reference" \
  | grep -Eiv "$safe_env_indirection" \
  | grep -Eiv "$safe_test_placeholder" \
  | awk '
    # 4. Empty string literals: KEY: "" carries nothing by construction. Unlike
    #    rules 1-3 this is judged across the whole line, because these appear
    #    mid-line in object literals ({ A_API_KEY: "", B_TOKEN: "" }). It drops a
    #    line only when it holds such a pair AND no non-empty one, so a single real
    #    value anywhere on the line still reports. The credential-shaped literals
    #    below are never filtered by this rule whatever else the line contains.
    {
      line = tolower($0)
      key_assignment = "(api[_-]?key|private[_-]?key|access[_-]?token|bearer[_-]?token|password|secret[_-]?key|auth[_-]?token)[[:space:]]*[:=]"
      nonempty = key_assignment "[[:space:]]*(\047[^\047]|\"[^\"]|[^\047\"[:space:]])"
      # Bracketed single characters below (ghp[_], sk[-]) are regex-identical to the
      # plain literals but keep this file from matching the scan pattern it feeds.
      # Do not "simplify" them back -- the scanner reads its own source.
      credential_literal = "(ghp[_]|sk[-]|xox[baprs][-]|begin[^\"]*key)"
      if (line ~ key_assignment && line !~ nonempty && line !~ credential_literal) next
      print
    }
  ' || true
)"

if [ -n "$survivors" ]; then
  printf '%s\n' "$survivors"
  exit 0
fi
exit 1
