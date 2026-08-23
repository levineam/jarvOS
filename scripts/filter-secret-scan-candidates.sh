#!/usr/bin/env bash
set -euo pipefail

# Filters the secret scan's candidate lines down to ones that could carry a
# credential. A line is dropped only when the whole line is accounted for:
#
#   1. Every secret-shaped assignment on it has a value that is ENTIRELY a known
#      safe form -- placeholder, empty literal, environment reference, or Actions
#      secret -- terminated by end of line or a delimiter. A safe prefix does not
#      excuse what follows it.
#   2. What remains after removing those assignments holds no unexplained string
#      literal. Checking assignments alone is not enough: a safe assignment ends at
#      its delimiter and the walk then skips straight to the next secret-shaped
#      key, so a credential sitting between them was never looked at.
#   3. No recognizable credential literal appears anywhere on the line, whatever
#      else is true of it.
#
# Rules match on the shape of a value, never on the file it appears in -- a
# path-based exemption is how a scanner quietly stops scanning.
#
# Known limit, stated rather than implied: this filter can only protect what the
# scan pattern itself detects. A secret that pattern never matches -- an unquoted
# password in a trailing comment, a value under a key it does not know -- is
# outside both its reach and this filter's. Widening that belongs in the pattern.
#
# Exit status is the signal CI reads: 0 means at least one candidate survived and
# the scan must fail. It is decided explicitly, not inherited from a pipeline.

survivors="$(
  awk '
    BEGIN {
      assign = "(api[_-]?key|private[_-]?key|access[_-]?token|bearer[_-]?token|password|secret[_-]?key|auth[_-]?token)[[:space:]]*[:=][[:space:]]*"

      # Recognizable credential literals. Vendor prefixes carry internal hyphens
      # (sk-proj-, sk-ant-api03-), so the body must admit them or a live key reads
      # as ordinary text. Bracketed single characters (gh[po]_, sk[-]) are regex
      # identical to the plain text but stop this file from matching the pattern it
      # is fed. Do not "simplify" them back -- the scanner reads its own source.
      credential = "(gh[pousr][_][a-z0-9]{16,}|sk[-][a-z0-9][a-z0-9-]{18,}|xox[baprs][-][a-z0-9-]{10,}|akia[a-z0-9]{16}|begin[ a-z]*key)"

      # An unexplained literal left over once safe assignments are removed. Short
      # strings are ordinary code (flags, keys of maps, small words); a long one
      # next to a secret-shaped key is not something to wave through.
      leftover = "([\"][^\"]{12,}[\"]|[\047][^\047]{12,}[\047])"

      term        = "[[:space:]]*([],;)}]|$)"
      placeholder = "^[\047\"](test|test-key|test-secret|dummy|placeholder|example|fake|redacted|xxx+|changeme|not-a-real-[a-z-]+)[\047\"]" term
      empty_lit   = "^([\047][\047]|\"\")" term
      env_lit     = "^(process\\.env(\\.[a-z_][a-z0-9_]*|\\[[^]]+\\])|\\$\\{[a-z_][a-z0-9_]*\\}|\\$[a-z_][a-z0-9_]*)" term
      gh_secret   = "^\\$\\{\\{[[:space:]]*secrets\\.[a-z_][a-z0-9_]*[[:space:]]*\\}\\}" term
    }
    # Length of the safe value at the start of v, or 0 when it is not safe.
    function safe_len(v) {
      if (match(v, placeholder)) return RLENGTH
      if (match(v, empty_lit))   return RLENGTH
      if (match(v, gh_secret))   return RLENGTH
      if (match(v, env_lit))     return RLENGTH
      return 0
    }
    {
      low = tolower($0)
      if (low ~ credential) { print; next }

      rest = low; residue = ""; seen = 0
      while (match(rest, assign)) {
        seen = 1
        residue = residue substr(rest, 1, RSTART - 1)
        after = substr(rest, RSTART + RLENGTH)
        n = safe_len(after)
        if (n == 0) { print; next }
        rest = substr(after, n + 1)
      }
      if (!seen) { print; next }
      residue = residue rest
      if (residue ~ leftover) { print; next }
    }
  ' || true
)"

if [ -n "$survivors" ]; then
  printf '%s\n' "$survivors"
  exit 0
fi
exit 1
