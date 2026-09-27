#!/usr/bin/env bash
# jarvOS — Grok Bot setup (vault host only)
# Writes an owner-only HTTP token on THIS machine (the vault host) and prints
# the remote connector. Does not register stdio MCP on a Grok Bot disk.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOKEN_FILE="${JARVOS_MCP_HTTP_TOKEN_FILE:-$HOME/.jarvos/grok-bot-mcp.token}"
HOST="${JARVOS_MCP_HTTP_HOST:-127.0.0.1}"
PORT="${JARVOS_MCP_HTTP_PORT:-8765}"

echo "+--------------------------------------------------+"
echo "|          jarvOS — Grok Bot Setup                 |"
echo "|    Vault-host remote MCP (not stdio on Grok)     |"
echo "+--------------------------------------------------+"
echo ""
echo "  Source:     $REPO_ROOT"
echo "  Token file: $TOKEN_FILE"
echo ""
echo "  The vault is canonical on this host. Grok Bot is a separate computer."
echo "  Do not copy the vault. Do not register jarvos-mcp.js as stdio on Grok Bot."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js v18+ is required on the vault host."
  exit 1
fi

mkdir -p "$(dirname "$TOKEN_FILE")"
if [ -f "$TOKEN_FILE" ]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="${TOKEN_FILE}.bak-jarvos-${stamp}-$$"
  cp "$TOKEN_FILE" "$backup"
  chmod 600 "$backup" 2>/dev/null || true
  echo "  existing token kept; backup written to $backup"
else
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$TOKEN_FILE"
  else
    node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(32).toString('hex')+'\n', {mode:0o600})" "$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  echo "  + created owner-only bearer token"
fi

cat <<EOF

Next steps (vault host):

  export JARVOS_MCP_HTTP_TOKEN_FILE="$TOKEN_FILE"
  export JARVOS_MCP_HTTP_HOST="$HOST"
  export JARVOS_MCP_HTTP_PORT="$PORT"
  node "$REPO_ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp-http.js"

Grok Bot client (URL + token only):

  Token file (do not print the token): $TOKEN_FILE
  Vault-host bind: http://$HOST:$PORT/mcp
  That loopback URL is this machine, not Grok Bot. Tunnel or set
  JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK=1 (cleartext HTTP) as described in
  runtimes/grok-bot/README.md.

  Example tunnel: ssh -N -L $PORT:127.0.0.1:$PORT user@vault-host

If that URL is unreachable, Grok Bot should fail open and continue without
jarvOS context. Hydration is manual: boot_jarvos or jarvos_hydrate.

The bearer token grants the full MCP surface of jarvos-mcp.js, not only the
adapter requiredTools list.

This script does not write Grok Bot stdio MCP config.
EOF
