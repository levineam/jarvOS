#!/usr/bin/env bash
set -euo pipefail

safe_github_secret_reference='^([^:]+:[0-9]+:|\+)[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*:[[:space:]]*\$\{\{[[:space:]]*secrets\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\}\}[[:space:]]*$'

grep -Eiv "$safe_github_secret_reference"
