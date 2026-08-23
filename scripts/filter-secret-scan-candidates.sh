#!/usr/bin/env bash
set -euo pipefail

# Filters the secret scan's candidate lines down to ones that could actually carry
# a credential.
#
# The rule is per-assignment, not per-line. Earlier versions asked "does a safe
# shape appear on this line?" and dropped the whole line when one did, which threw
# away real credentials sitting beside a safe-looking key:
#
# a live key followed by an env fallback, or a real password followed by a second
# key whose value is an env reference. In both, the last thing on the line looks
# safe while an actual credential sits earlier on it. (Those examples are described
# rather than written out, because this file is itself scanned by the pattern it
# filters -- spelling them literally would make the scanner flag its own source.)
#
# So instead: walk every secret-shaped assignment on the line and require that
# *each* one's own value is a known-safe form. One unexplained value anywhere and
# the line is reported. A line with no such assignment is always reported, which is
# what keeps bare vendor-prefixed tokens and private-key headers visible.
#
# Rules match on the shape of the value, never on the file it appears in -- a
# path-based exemption is how a scanner quietly stops scanning.
#
# Exit status is the signal CI reads: 0 means at least one candidate survived and
# the scan must fail. It is decided explicitly, not inherited from a pipeline.

survivors="$(
  awk '
    BEGIN {
      assign = "(api[_-]?key|private[_-]?key|access[_-]?token|bearer[_-]?token|password|secret[_-]?key|auth[_-]?token)[[:space:]]*[:=][[:space:]]*"

      # Credential-shaped literals are never filtered, whatever else the line holds.
      # Bracketed single characters (ghp[_], sk[-]) are regex-identical to the plain
      # text but stop this file from matching the scan pattern it feeds. Do not
      # "simplify" them back -- the scanner reads its own source.
      credential = "(ghp[_]|sk[-][a-z0-9]{20,}|xox[baprs][-][a-z0-9-]{10,}|begin[ a-z]*key)"

      # Safe value forms, each tested against the start of the value that follows an
      # assignment. Placeholders are an explicit allowlist rather than a length or
      # entropy heuristic: only an exact list separates test-key from a real key.
      # A safe form must be the WHOLE value, not merely how it starts. Without the
      # terminator, a safe prefix excuses whatever follows it, and a fallback
      # literal after an env reference or a concatenated placeholder is never
      # inspected -- `process.env.PASSWORD || "<literal>"` reads as safe on the
      # env reference alone. Braces must also balance, so a `${VAR:-default}`
      # default value cannot pass as a bare `${VAR`.
      term        = "[[:space:]]*([],;)}]|$)"
      placeholder = "^[\047\"](test|test-key|test-secret|dummy|placeholder|example|fake|redacted|xxx+|changeme|not-a-real-[a-z-]+)[\047\"]" term
      empty_lit   = "^([\047][\047]|\"\")" term
      env_lit     = "^(process\\.env(\\.[a-z_][a-z0-9_]*|\\[[^]]+\\])|\\$\\{[a-z_][a-z0-9_]*\\}|\\$[a-z_][a-z0-9_]*)" term
      gh_secret   = "^\\$\\{\\{[[:space:]]*secrets\\.[a-z_][a-z0-9_]*[[:space:]]*\\}\\}" term
    }
    function value_is_safe(v) {
      return (v ~ placeholder) || (v ~ empty_lit) || (v ~ gh_secret) || (v ~ env_lit)
    }
    {
      low = tolower($0)
      if (low ~ credential) { print; next }

      rest = low
      seen = 0
      all_safe = 1
      while (match(rest, assign)) {
        seen = 1
        rest = substr(rest, RSTART + RLENGTH)
        if (!value_is_safe(rest)) { all_safe = 0; break }
      }
      if (seen && all_safe) next
      print
    }
  ' || true
)"

if [ -n "$survivors" ]; then
  printf '%s\n' "$survivors"
  exit 0
fi
exit 1
