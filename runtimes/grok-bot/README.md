# jarvOS — Grok Bot Runtime

Grok Bot is an optional jarvOS runtime. The Obsidian-compatible **vault is
canonical**. Grok Bot has a **separate computer**. Native Grok memory, routines,
and CloudAgent stay host-owned. jarvOS does not clone the vault onto Grok Bot,
does not auto-ingest all chats, and does not expose `SendMessage` or CloudAgent
from this adapter.

This connector is **operator-supervised** and sits **outside conformance**. It
is not in `CANONICAL_HARNESS_IDS` and has no live lifecycle coverage.

## Why remote HTTP, not stdio

`jarvos-mcp.js` is a stdio server that reads the vault on the machine where it
runs. Registering that stdio command on the Grok Bot disk hydrates **Grok Bot's
files**, not the vault host. v1 is an authenticated **Streamable HTTP** connector
**on the vault host** (JSON-RPC responses in the POST body, `Mcp-Session-Id` per
client). The Grok Bot client is only a **URL + token**.

If the vault-host connector is unreachable, Grok Bot should fail open: continue
the chat without jarvOS context instead of pretending the local box is the vault.

## Checked-in adapter status

`grok-bot-http` uses **manual hydration**. `startupHydration` is unsupported.

When the remote connector is up:

1. Use the MCP prompt `boot_jarvos`, or
2. Call the `jarvos_hydrate` tool.

Do not expect a SessionStart hook on Grok Bot.

## What's here

- `adapter.json` — public runtime declaration (not a canonical managed harness)
- `setup.sh` — vault-host token + HTTP gateway helper
- this README

Skill projection, CloudAgent-as-coding-host, and bidirectional memory sync are
out of scope.

## Setup (vault host)

Run from a jarvOS checkout **on the machine that holds the vault**:

```bash
./runtimes/grok-bot/setup.sh
```

The script:

- refuses to write a stdio MCP command as if the vault lived on Grok Bot
- creates an owner-only bearer token on the vault host (backed up first)
- prints how to start the gateway and where the token file lives
- does **not** print the live bearer token

Start the gateway on the vault host:

```bash
export JARVOS_MCP_HTTP_TOKEN_FILE="$HOME/.jarvos/grok-bot-mcp.token"
node modules/jarvos-agent-context/scripts/jarvos-mcp-http.js
```

Defaults: bind `127.0.0.1:8765`. Missing token fails closed (the process will
not start). The gateway speaks Streamable HTTP: POST `/mcp`, JSON response in
the body, `Mcp-Session-Id` issued on `initialize`. Each session gets its own
`jarvos-mcp.js` child.

### Reaching Grok Bot (loopback is the vault host)

`http://127.0.0.1:8765/mcp` is reachable only **on the vault host**. Grok Bot is
a different computer; its loopback is not this process. Pick one:

1. **SSH tunnel** (token stays on loopback at both ends):

   ```bash
   ssh -N -L 8765:127.0.0.1:8765 user@vault-host
   ```

   Then point Grok Bot at `http://127.0.0.1:8765/mcp` **on the machine where
   that tunnel is listening**.

2. **Tailscale Funnel** (or another TLS reverse proxy) to the vault-host
   loopback gateway. This is the practical path when Grok Bot runs on a
   separate cloud/Linux computer that shares a Tailscale network with the vault
   host, but peer `tailscale serve` / MagicDNS reverse paths are flaky
   (timeouts, asymmetric routing, or macOS Application Firewall). Example:

   ```bash
   # vault host — gateway must already be listening on 127.0.0.1:8765
   tailscale funnel --bg http://127.0.0.1:8765
   tailscale funnel status
   ```

   Point Grok Bot at the Funnel HTTPS URL plus `/mcp`, for example
   `https://<vault-host>.<tailnet>.ts.net/mcp`, with
   `Authorization: Bearer <token>`. Funnel must be enabled on the tailnet once
   (Tailscale admin “enable Funnel” link). Keep the gateway **supervised**
   (see below): if the Node process dies, Funnel returns 502.

   Note: on a Tailscale-joined Grok Bot box, MagicDNS may resolve the Funnel
   hostname to the vault host’s peer Tailscale IP, while public DNS resolves
   Funnel edge addresses. Both can work when the gateway is up; document the
   HTTPS `/mcp` URL either way.

3. **Non-loopback bind** (explicit, and the bearer token is cleartext HTTP
   unless you terminate TLS in front):

   ```bash
   export JARVOS_MCP_HTTP_HOST=0.0.0.0
   export JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK=1
   ```

   Put a TLS reverse proxy in front before exposing this beyond a trusted LAN.

### Keep the gateway alive (supervised)

Ad-hoc `node .../jarvos-mcp-http.js` under an SSH or remote-agent shell often
exits when that session ends, which makes Funnel/Serve return 502. Prefer a
user LaunchAgent (macOS) or equivalent supervisor. Minimal macOS example
(`~/Library/LaunchAgents/com.jarvos.mcp-http.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jarvos.mcp-http</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/ABS/PATH/TO/jarvOS/modules/jarvos-agent-context/scripts/jarvos-mcp-http.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JARVOS_MCP_HTTP_TOKEN_FILE</key>
    <string>/Users/YOU/.jarvos/grok-bot-mcp.token</string>
    <key>JARVOS_MCP_HTTP_HOST</key><string>127.0.0.1</string>
    <key>JARVOS_MCP_HTTP_PORT</key><string>8765</string>
    <key>JARVOS_CONFIG_PATH</key>
    <string>/Users/YOU/clawd/jarvos.config.json</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>/ABS/PATH/TO/jarvOS-or-config-cwd</string>
  <key>StandardOutPath</key><string>/tmp/jarvos-mcp-http.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/jarvos-mcp-http.err.log</string>
</dict>
</plist>
```

Load with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvos.mcp-http.plist`.
Adjust the `node` path (`which node`) and absolute paths for your machine.

### Protocol versions

Grok Bot / Cursor Streamable HTTP clients may send MCP `initialize`
`protocolVersion` values newer or older than the gateway default
(`2025-06-18`), including at least `2025-11-25`, `2025-03-26`, and
`2024-11-05`. The HTTP gateway accepts that set so remote MCP registration
does not fail with `unsupported initialize protocol version` /
`failed_to_load`.

### Obsidian acknowledgement

`jarvos_create_note` still follows the vault mutation contract: Obsidian should
be open on the vault host so pending mutations can be acknowledged/reconciled.
A note may appear as pending until reconcile succeeds.

`JARVOS_MCP_HTTP_TOKEN_FILE` may override the default token path; treat that
file as secret and do not paste it into agent transcripts.

### Grok Bot client

In Grok Bot, add a remote MCP server using **Streamable HTTP**:

- URL: the **tunneled or TLS** vault-host URL (not the vault host's loopback
  unless a tunnel is listening on the Grok Bot side)
- Auth: `Authorization: Bearer <token from the token file>`

Do **not** add `node .../jarvos-mcp.js` as a stdio server on Grok Bot.

The bearer token grants the **full MCP surface** of `jarvos-mcp.js` (all
registered tools, including writes and control-plane), not only the five
`requiredTools` listed in `adapter.json`. Those names are the hydration
contract, not a gateway allowlist.

If the URL does not respond, leave jarvOS unhydrated and continue. That is the
supported fail-open path.

## Intentional capture

When the user asks to save a note or idea through Grok Bot, use the shared
capture path with source `grok-bot`. Do not raw-write vault Markdown on the Grok
Bot disk.

## Verification

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check grok-bot
```

No live Grok Bot session is required for public tests.
