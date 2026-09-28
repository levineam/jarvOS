#!/usr/bin/env bash
# jarvOS — Muse setup (vault host only)
# Prints the Muse read-only gateway commands. When the operator runs it, it
# creates an owner-only Muse token file (refusing to overwrite), or keeps a
# safe existing one after writing a backup. It never prints the token, never
# starts the gateway, and never registers stdio MCP on the Muse host disk.
# Only Muse-specific variables are read; the generic JARVOS_MCP_HTTP_*
# credential is never used as a default.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOKEN_FILE="${JARVOS_MUSE_MCP_TOKEN_FILE:-$HOME/.jarvos/muse-mcp.token}"
HOST="${JARVOS_MUSE_MCP_HOST:-127.0.0.1}"
PORT="${JARVOS_MUSE_MCP_PORT:-8766}"

case "$TOKEN_FILE" in
  /*) ;;
  *) echo "JARVOS_MUSE_MCP_TOKEN_FILE must be an absolute path"; exit 1 ;;
esac

echo "+--------------------------------------------------+"
echo "|            jarvOS — Muse Setup                   |"
echo "|   Vault-host read-only MCP (not stdio on Muse)   |"
echo "+--------------------------------------------------+"
echo ""
echo "  Source:     $REPO_ROOT"
echo "  Token file: $TOKEN_FILE"
echo ""
echo "  The vault is canonical on this host. Muse is a separate computer."
echo "  Do not copy the vault. Do not register jarvos-mcp.js as stdio on Muse."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js v18+ is required on the vault host."
  exit 1
fi

mkdir -p "$(dirname "$TOKEN_FILE")"
if [ -L "$TOKEN_FILE" ]; then
  echo "  refusing: $TOKEN_FILE is a symlink; remove it or set another JARVOS_MUSE_MCP_TOKEN_FILE"
  exit 1
elif [ -e "$TOKEN_FILE" ]; then
  if ! node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const stat = fs.lstatSync(file);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const ok = stat.isFile() && (uid === null || stat.uid === uid) && (stat.mode & 0o077) === 0
      && fs.readFileSync(file, "utf8").trim().length >= 16;
    process.exit(ok ? 0 : 1);
  ' "$TOKEN_FILE"; then
    echo "  refusing: $TOKEN_FILE is not a regular owner-only (0600) token file; fix or remove it"
    exit 1
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="${TOKEN_FILE}.bak-jarvos-${stamp}-$$"
  cp -p "$TOKEN_FILE" "$backup"
  chmod 600 "$backup"
  echo "  existing owner-only Muse token kept; backup written to $backup"
else
  node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(32).toString('hex')+'\n', {mode:0o600, flag:'wx'})" "$TOKEN_FILE"
  echo "  + created owner-only Muse bearer token"
fi

ALLOW_LINE=""
case "$HOST" in
  127.0.0.1|localhost|::1) ;;
  *) ALLOW_LINE="  export JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK=1" ;;
esac

cat <<EOF

Next steps (vault host; run these yourself, this script starts nothing):

  export JARVOS_MUSE_MCP_TOKEN_FILE="$TOKEN_FILE"
  export JARVOS_MUSE_MCP_HOST="$HOST"
  export JARVOS_MUSE_MCP_PORT="$PORT"
$ALLOW_LINE
  node "$REPO_ROOT/runtimes/muse/gateway.js"

Reaching Muse over Tailscale (recommended): bind the gateway to the vault
host's tailnet IP (shown by: tailscale ip -4) and allow that bind explicitly:

  export JARVOS_MUSE_MCP_HOST="<vault-host-tailnet-ip>"
  export JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK=1
  node "$REPO_ROOT/runtimes/muse/gateway.js"

  Muse URL: http://<vault-host-tailnet-ip>:$PORT/mcp
  Plain HTTP relies on Tailscale WireGuard encryption. Which tailnet devices
  can reach the port depends on your tailnet access policy; restrict this
  port to the Muse host with Tailscale ACLs before connecting Muse.

Muse client (URL + Muse token only):

  Token file (do not print or paste the token): $TOKEN_FILE
  Auth: Authorization: Bearer <contents of the Muse token file>

Security (read before connecting Muse):

  - Use only this Muse token. Never reuse the generic JARVOS_MCP_HTTP_TOKEN
    credential, and never point Muse at the general gateway (port 8765).
  - Read-only still exposes sensitive vault content: hydration packets,
    session-thread context, recall results and Projects context.
  - This is RPC authorization, not an OS sandbox and not per-note
    confidentiality. There is no per-note ACL: which data Muse may see, and
    which read backends the host config selects, remain the operator's
    decision.
  - Exposed tools: jarvos_hydrate, jarvos_projects_context, jarvos_recall,
    jarvos_startup_brief. Prompts, resources, note capture, session-thread
    writes and handoff, skills and control-plane are denied.
  - Hydration is manual: call jarvos_hydrate at session start.
  - Operator notification delivery is not configured by this adapter.
  - Nothing here proves live readiness; verify the connection yourself.

If the URL is unreachable, Muse should fail open and continue without
jarvOS context.

This script does not write Muse stdio MCP config.
EOF
