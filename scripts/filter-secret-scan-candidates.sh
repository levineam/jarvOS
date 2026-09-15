#!/usr/bin/env bash
set -euo pipefail

safe_github_secret_reference='^([^:]+:[0-9]+:|\+)[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*:[[:space:]]*\$\{\{[[:space:]]*secrets\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\}\}[[:space:]]*$'
secret_pattern='(gh[p]_|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|BEGIN (RSA|OPENSSH|EC|DSA|PRIVATE) KEY|api[_-]?key[[:space:]]*[:=]|private[_-]?key[[:space:]]*[:=]|access[_-]?token[[:space:]]*[:=]|bearer[_-]?token[[:space:]]*[:=]|password[[:space:]]*[:=]|secret[_-]?key[[:space:]]*[:=]|auth[_-]?token[[:space:]]*[:=])'

# Strip only the three inspected non-literal forms introduced by Desktop.
# Re-scan the rest of each line: a minified bundle can contain a safe input-type
# flag and a real credential on the same line. Never exempt a whole asset/file.
sed -E \
  -e 's/api[K]ey:[[:space:]]*resolved\.key([[:space:]]*[,}])/LOCAL_CREDENTIAL_REFERENCE\1/g' \
  -e 's/pass[w]ord:!0,/INPUT_TYPE_FLAG,/g' \
  -e 's/process\.env\.OPENAI_API_KEY[[:space:]]*=[[:space:]]*previous;/RESTORED_ENVIRONMENT_REFERENCE;/g' \
  | grep -Ei "$secret_pattern" \
  | grep -Eiv "$safe_github_secret_reference"
