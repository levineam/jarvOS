#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MCP_SERVER="$ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found on PATH" >&2
  exit 1
fi

if [ ! -f "$MCP_SERVER" ]; then
  echo "jarvOS MCP server not found: $MCP_SERVER" >&2
  exit 1
fi

if codex mcp get jarvos >/dev/null 2>&1; then
  codex mcp remove jarvos >/dev/null
fi

codex mcp add jarvos -- node "$MCP_SERVER"
echo "Registered jarvOS MCP server for Codex: $MCP_SERVER"
