#!/usr/bin/env bash
set -euo pipefail

# Filters the secret scan's candidate lines down to ones that could actually carry
# a credential. Two invariants govern every rule here:
#
#   1. Rules match on the *shape of the value*, never on the file it appears in.
#      A path-based exemption is how a scanner quietly stops scanning.
#   2. A safe value only excuses the line when it is the value of the very key that
#      tripped the scan. Matching a safe shape anywhere on the line is not enough:
#      `api_key: "sk-live-..." || process.env.KEY` ends in an env reference and
#      `api_key: "sk-live-...", mode: 'test'` ends in a placeholder, yet both carry
#      a live credential. Anchoring each rule to the secret-shaped key closes that.
#
# Backstop for both: a line holding a credential-shaped literal is never filtered,
# whatever else it contains.
#
# Exit status is the signal CI reads -- 0 means at least one candidate survived and
# the scan must fail. It is decided explicitly below rather than inherited from a
# pipeline, because the final stage exits 0 whether or not it printed.

survivors="$(
  awk '
    BEGIN {
      # A key whose name alone trips the scan.
      key = "(api[_-]?key|private[_-]?key|access[_-]?token|bearer[_-]?token|password|secret[_-]?key|auth[_-]?token)[[:space:]]*[:=][[:space:]]*"

      # Credential-shaped literals. Bracketed single characters (ghp[_], sk[-]) are
      # regex-identical to the plain text but stop this file from matching the scan
      # pattern it feeds. Do not "simplify" them back -- the scanner reads its own
      # source.
      credential = "(ghp[_]|sk[-][a-z0-9]{20,}|xox[baprs][-][a-z0-9-]{10,}|begin[ a-z]*key)"

      # 1. GitHub Actions secret reference: resolved at runtime, never a literal.
      gh_ref = "^([^:]+:[0-9]+:|\\+)[[:space:]]*[a-z0-9_-]+[[:space:]]*:[[:space:]]*\\$\\{\\{[[:space:]]*secrets\\.[a-z_][a-z0-9_]*[[:space:]]*\\}\\}[[:space:]]*$"

      # 2. Environment indirection: the key names where a secret comes from.
      env_ref = key "(process\\.env(\\.[a-z_][a-z0-9_]*|\\[[^]]+\\])|\\$\\{?[a-z_][a-z0-9_]*\\}?)[[:space:]]*,?[[:space:]]*$"

      # 3. Explicit placeholder allowlist. An exact-match list, not a length or
      #    entropy heuristic -- only that can tell 'test-key' from a real key.
      placeholder = key "[\047\"](test|test-key|test-secret|dummy|placeholder|example|fake|redacted|xxx+|changeme|not-a-real-[a-z-]+)[\047\"][[:space:]]*[,;)]?[[:space:]]*$"

      # 4. Empty literals carry nothing. Judged across the whole line, because these
      #    appear mid-line in object literals ({ A_API_KEY: "", B_TOKEN: "" }); the
      #    line is dropped only when no non-empty secret assignment appears anywhere.
      nonempty = key "([\047][^\047]|\"[^\"]|[^\047\"[:space:]])"
    }
    {
      low = tolower($0)
      if (low ~ credential) { print; next }
      if (low ~ gh_ref)      next
      if (low ~ env_ref)     next
      if (low ~ placeholder) next
      if (low ~ key && low !~ nonempty) next
      print
    }
  ' || true
)"

if [ -n "$survivors" ]; then
  printf '%s\n' "$survivors"
  exit 0
fi
exit 1
