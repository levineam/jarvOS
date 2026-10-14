#!/usr/bin/env bash
# jarvOS — Grok Bot setup (vault host only)
# Prepares a Grok-only, owner-only bearer token file on THIS machine (the vault
# host) and prints how to start the scoped Grok launcher
# (runtimes/grok-bot/gateway.js). It never starts a server, never registers
# stdio MCP on a Grok Bot disk, and installs no daemon, service or Funnel.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCHER="$SCRIPT_DIR/gateway.js"
SHARED_HTTP="$REPO_ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp-http.js"
TOKEN_FILE="${JARVOS_GROK_MCP_TOKEN_FILE:-$HOME/.jarvos/grok-bot-mcp.token}"
HOST="${JARVOS_GROK_MCP_HOST:-127.0.0.1}"
PORT="${JARVOS_GROK_MCP_PORT:-8767}"
ALLOW_NON_LOOPBACK="${JARVOS_GROK_MCP_ALLOW_NON_LOOPBACK:-}"

echo "+--------------------------------------------------+"
echo "|          jarvOS — Grok Bot Setup                 |"
echo "|  Vault-host scoped remote MCP (not stdio on Grok)|"
echo "+--------------------------------------------------+"
echo ""
echo "  Source:     $REPO_ROOT"
echo "  Launcher:   $LAUNCHER"
echo "  Token file: $TOKEN_FILE"
echo ""
echo "  The vault is canonical on this host. Grok Bot is a separate computer."
echo "  Do not copy the vault. Do not register jarvos-mcp.js as stdio on Grok Bot."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js v18+ is required on the vault host."
  exit 1
fi

# 1. Validate host and port BEFORE creating or touching any token.
case "$PORT" in
  ''|*[!0-9]*) echo "JARVOS_GROK_MCP_PORT must be an integer port 1..65535"; exit 1 ;;
esac
if [ "${#PORT}" -gt 5 ] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "JARVOS_GROK_MCP_PORT must be an integer port 1..65535"
  exit 1
fi
if ! [[ "$HOST" =~ ^[A-Za-z0-9.:_-]{1,253}$ ]]; then
  echo "JARVOS_GROK_MCP_HOST is not a valid bind host"
  exit 1
fi
case "$TOKEN_FILE" in
  /*) ;;
  *) echo "error: JARVOS_GROK_MCP_TOKEN_FILE must be an absolute path" >&2; exit 1 ;;
esac
if ! node -e 'process.exit(require(process.argv[1]).isLoopbackHost(process.argv[2]) || process.argv[3] === "1" ? 0 : 1)' \
  "$SHARED_HTTP" "$HOST" "$ALLOW_NON_LOOPBACK"; then
  echo "refusing non-loopback JARVOS_GROK_MCP_HOST; loopback plus a TLS front is the supported default"
  exit 1
fi

# 2. Keep a trusted existing token (never rotated or printed); create one only if absent.
mkdir -p "$(dirname "$TOKEN_FILE")"
if [ -L "$TOKEN_FILE" ]; then
  echo "refusing: $TOKEN_FILE is a symlink; use an owner-only regular file"
  exit 1
fi
if [ -e "$TOKEN_FILE" ]; then
  if [ ! -f "$TOKEN_FILE" ] || ! node -e 'process.exit(require(process.argv[1]).trustedTokenFile(process.argv[2]) ? 0 : 1)' "$SHARED_HTTP" "$TOKEN_FILE"; then
    echo "refusing: $TOKEN_FILE is not a trusted owner-only token file (left untouched)"
    exit 1
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="${TOKEN_FILE}.bak-jarvos-${stamp}-$$"
  cp "$TOKEN_FILE" "$backup"
  chmod 600 "$backup" 2>/dev/null || true
  echo "  existing token kept (not rotated, not printed); backup written to $backup"
else
  node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(32).toString('hex')+'\n', {mode:0o600, flag:'wx'})" "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "  + created owner-only Grok bearer token (not printed)"
fi

# 3. Read-only validation with the launcher's own resolver; starts no server.
#    Refuses reuse of the generic or Muse token file/value when those are set.
if ! JARVOS_GROK_MCP_TOKEN_FILE="$TOKEN_FILE" JARVOS_GROK_MCP_HOST="$HOST" JARVOS_GROK_MCP_PORT="$PORT" \
  JARVOS_GROK_MCP_ALLOW_NON_LOOPBACK="$ALLOW_NON_LOOPBACK" \
  node -e 'try { require(process.argv[1]).resolveGrokConfig(process.env); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }' "$LAUNCHER"; then
  echo "Grok launcher configuration refused (see message above). Nothing was started."
  exit 1
fi
echo "  + Grok launcher configuration validated (no server started)"

cat <<EOF

Next steps (vault host; operator-supervised, start it yourself):

  export JARVOS_CONFIG_PATH="${JARVOS_CONFIG_PATH:-/ABS/PATH/TO/jarvos.config.json}"  # this host's canonical vault config
  export JARVOS_GROK_MCP_TOKEN_FILE="$TOKEN_FILE"
  export JARVOS_GROK_MCP_HOST="$HOST"
  export JARVOS_GROK_MCP_PORT="$PORT"
  node "$LAUNCHER"

The launcher requires an explicit JARVOS_GROK_MCP_PORT. It serves only the
scoped eight-tool Grok interface. Do not start the general full-surface
gateway (jarvos-mcp-http.js) for Grok Bot.

Grok Bot client (URL + token only):

  Token file (do not print the token): $TOKEN_FILE
  Vault-host bind: http://$HOST:$PORT/mcp
  That loopback URL is this machine, not Grok Bot. Expose it through TLS
  (for example Tailscale Funnel) as described in runtimes/grok-bot/README.md.

If that URL is unreachable, Grok Bot should fail open and continue without
jarvOS context. Hydration is manual: call the jarvos_hydrate tool.

This script does not write Grok Bot stdio MCP config.
EOF
