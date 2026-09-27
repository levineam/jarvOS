# jarvOS — Muse Runtime

Muse is an optional jarvOS runtime. The Obsidian-compatible **vault is
canonical**. Muse runs on a **separate computer**. Native Muse memory and
routines stay host-owned. jarvOS does not clone the vault onto the Muse host,
does not auto-ingest all chats, and does not expose `SendMessage` or
CloudAgent from this adapter.

This connector is **operator-supervised** and sits **outside conformance**. It
is not in `CANONICAL_HARNESS_IDS` and has no live lifecycle coverage.

## Why remote HTTP, not stdio

`jarvos-mcp.js` is a stdio server that reads the vault on the machine where it
runs. Registering that stdio command on the Muse host disk hydrates **the
Muse host's files**, not the vault host. v1 is an authenticated
**Streamable HTTP** connector **on the vault host** (JSON-RPC responses in the
POST body, `Mcp-Session-Id` per client). The Muse client is only a
**URL + token**.

If the vault-host connector is unreachable, Muse should fail open: continue
the chat without jarvOS context instead of pretending the local box is the
vault.

## Checked-in adapter status

`muse-http` uses **manual hydration**. `startupHydration` is unsupported.

When the remote connector is up:

1. Use the MCP prompt `boot_jarvos`, or
2. Call the `jarvos_hydrate` tool at session start.

Do not expect a SessionStart hook on the Muse host.

## What's here

- `adapter.json` — public runtime declaration (not a canonical managed harness)
- `setup.sh` — vault-host token + HTTP gateway helper
- this README

CloudAgent-as-coding-host and bidirectional memory sync are out of scope.

## Setup (vault host)

Run from a jarvOS checkout **on the machine that holds the vault**:

```bash
./runtimes/muse/setup.sh
```

The script:

- refuses to write a stdio MCP command as if the vault lived on the Muse host
- creates an owner-only bearer token on the vault host (backed up first)
- prints how to start the gateway and where the token file lives
- does **not** print the live bearer token

Start the gateway on the vault host:

```bash
export JARVOS_MCP_HTTP_TOKEN_FILE="$HOME/.jarvos/muse-mcp.token"
node modules/jarvos-agent-context/scripts/jarvos-mcp-http.js
```

Defaults: bind `127.0.0.1:8765`. Missing token fails closed (the process will
not start). The gateway speaks Streamable HTTP: POST `/mcp`, JSON response in
the body, `Mcp-Session-Id` issued on `initialize`. Each session gets its own
`jarvos-mcp.js` child.

### Reaching the Muse host

`http://127.0.0.1:8765/mcp` is reachable only **on the vault host**. Pick one:

1. **Tailscale** (recommended): bind the gateway to the vault host's tailnet
   IP and add the Muse host to the same tailnet. The bearer token stays on
   the private tailnet.

2. **SSH tunnel** (token stays on loopback at both ends):

   ```bash
   ssh -N -L 8765:127.0.0.1:8765 user@vault-host
   ```

3. **Non-loopback bind** (explicit, and the bearer token is cleartext HTTP
   unless you terminate TLS in front):

   ```bash
   export JARVOS_MCP_HTTP_HOST=0.0.0.0
   export JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK=1
   ```

   Put a TLS reverse proxy in front before exposing this beyond a trusted LAN.

`JARVOS_MCP_HTTP_TOKEN_FILE` may override the default token path; treat that
file as secret and do not paste it into agent transcripts.

### Muse client

The Muse host needs a Streamable HTTP JSON-RPC client pointed at the
reachable vault-host URL:

- URL: the **tailnet, tunneled, or TLS** vault-host URL (not the vault host's
  loopback unless a tunnel is listening on the Muse side)
- Auth: `Authorization: Bearer <token from the token file>`

Do not add `node .../jarvos-mcp.js` as a stdio server on the Muse host.

The bearer token grants the **full MCP surface** of `jarvos-mcp.js` (all
registered tools, including writes and control-plane), not only the five
`requiredTools` listed in `adapter.json`. Those names are the hydration
contract, not a gateway allowlist.

If the URL does not respond, leave jarvOS unhydrated and continue. That is the
supported fail-open path.

## Skills

Unlike the grok-bot adapter, Muse declares skill projection **supported**.
The shared skill bundle (workflow execution, rule creation, context
management, cron hygiene, operator communication) is projected over the owner
channel into the Muse workspace skills directory, and parity across harnesses
is tracked with the `jarvos_shared_skills` MCP tool. Include/exclude
decisions stay owner-approved; sync never invents skills the vault has not
blessed.

## Intentional capture

When the user asks to save a note or idea through Muse, use the shared
capture path (`jarvos_create_note`) with source `muse`. Do not raw-write
vault Markdown on the Muse host disk.

## Continuity across AIs

Use `jarvos_session_thread_write` / `jarvos_session_thread_read` for the
rolling journal-backed live session thread, so work handed off between Muse,
Claude Code, Codex, and OpenClaw stays continuous.

## Verification

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check muse
```

No live Muse session is required for public tests.
