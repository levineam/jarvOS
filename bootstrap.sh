#!/usr/bin/env bash
# jarvOS bootstrap entry point — delegates to bootstrap.js
# Usage: bash bootstrap.sh
#        ./bootstrap.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check Node.js is available
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required. Install from https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18 or higher is required (found $(node --version))." >&2
  exit 1
fi

exec node "$SCRIPT_DIR/bootstrap.js" "$@"
