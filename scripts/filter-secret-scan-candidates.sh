#!/usr/bin/env bash
set -euo pipefail

safe_reference='^([^:]+:[0-9]+:|[-+])[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*:[[:space:]]*\$\{\{[[:space:]]*secrets\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\}\}[[:space:]]*$'
scan_definition='^([^:]+:[0-9]+:|[-+])[[:space:]]*(pattern|safe_github_secret_reference)='

grep -Eiv "$safe_reference|$scan_definition"
