# jarvOS — Muse Runtime

Muse is an optional jarvOS runtime. The Obsidian-compatible **vault is
canonical**. Muse runs on a **separate computer**. Native Muse memory and
routines stay host-owned. jarvOS does not clone the vault onto the Muse host,
does not auto-ingest all chats, and does not expose `SendMessage` or
CloudAgent from this adapter.

This connector is **operator-supervised** and sits **outside conformance**. It
is not in `CANONICAL_HARNESS_IDS` and has no live lifecycle coverage. Nothing
in this directory claims live readiness.

## Why remote HTTP, not stdio

`jarvos-mcp.js` is a stdio server that reads the vault on the machine where it
runs. Registering that stdio command on the Muse host disk hydrates **the
Muse host's files**, not the vault host. Muse instead connects to a dedicated
**read-only Streamable HTTP gateway on the vault host**
(`runtimes/muse/gateway.js`). The Muse client is only a **URL + Muse token**.

If the gateway is unreachable, Muse should fail open: continue the chat
without jarvOS context instead of pretending the local box is the vault.

## Read-only gateway

`runtimes/muse/gateway.js` reuses `jarvos-mcp-http.js` with read-only mode
fixed on. No environment variable turns it off. Every rule below is enforced
before anything reaches the `jarvos-mcp.js` child.

Exposed tools (exactly four, with gateway-owned closed argument schemas):

| Tool | Accepted arguments |
|---|---|
| `jarvos_hydrate` | `maxChars` (integer 1–20000) |
| `jarvos_startup_brief` | `query` (string 1–2000), `maxChars` (integer 1–20000) |
| `jarvos_recall` | `query` (required, string 1–2000), `includeQmd`, `autoGraph` (booleans) |
| `jarvos_projects_context` | `profile` (`orientation` or `recent-activity`), `date` (`YYYY-MM-DD`), `timeZone`, `from`/`to` (UTC ISO-8601) |

Unknown or nested arguments, wrong types, out-of-range values, and recall
`config`, `seeds`, `mode` or `synthesize` are rejected. Allowed calls are
rebuilt from the accepted keys only.

Also enforced:

- `initialize` is forwarded with no client capabilities and bounded
  `clientInfo`; the reply advertises tools only.
- `ping` is answered by the gateway; `tools/list` returns only the four tools.
- Prompts (including `boot_jarvos`), resources, completion, logging, other
  notifications, client responses and batches are denied.
- GET returns 405, so there is no SSE stream. Messages the child originates
  are never delivered.
- The child runs without the gateway tokens, control-plane credentials,
  work/common-work service bindings, shared-skills config or the meaning
  provider module. Host read configuration (vault paths, Projects context,
  recall backends) is kept.

## What read-only does not do

- **Read-only still exposes sensitive vault content.** Hydration packets,
  session-thread context, recall results and Projects context are returned
  by design.
- This is **RPC authorization, not an OS sandbox** and not per-note
  confidentiality. There is **no per-note ACL**. Which data Muse may see, and
  which read backends the host configuration selects, remain the operator's
  decision.
- Host providers may still write their own caches and logs, and recall may
  run host-selected backends. The gateway removes caller influence, not host
  configuration.
- The child-environment denylist covers today's bindings. Review it when new
  credentials or service bindings are added.

## Checked-in adapter status

`muse-http` uses **manual hydration**. `startupHydration` is unsupported.
When the gateway is reachable, call the `jarvos_hydrate` tool at session
start. Do not expect a SessionStart hook on the Muse host.

Unsupported in this adapter:

- note capture, note updates and journal links (`jarvos_create_note` is denied)
- session handoff (`jarvos_hydrate` may include session-thread context, but
  session-thread reads and writes are denied)
- skill projection (the skills manager does not project to Muse, and
  `jarvos_shared_skills` is denied)
- MCP prompts
- operator notification delivery (`not-configured`)

CloudAgent-as-coding-host and bidirectional memory sync are out of scope.

## What's here

- `adapter.json` — public runtime declaration (not a canonical managed harness)
- `gateway.js` — Muse read-only gateway launcher (vault host)
- `setup.sh` — Muse token helper that prints the start commands
- this README

## Setup (vault host)

Run from a jarvOS checkout **on the machine that holds the vault**:

```bash
./runtimes/muse/setup.sh
```

The script:

- reads only `JARVOS_MUSE_MCP_*` variables, never the generic
  `JARVOS_MCP_HTTP_*` credential
- creates an owner-only (0600) Muse token file and refuses to overwrite one
- keeps an existing Muse token file only if it is a regular owner-only file,
  after writing a backup; it refuses symlinks and insecure files
- prints how to start the gateway and does **not** print the token
- does not start the gateway and does not write Muse stdio MCP config

Start the gateway on the vault host:

```bash
export JARVOS_MUSE_MCP_TOKEN_FILE="$HOME/.jarvos/muse-mcp.token"
node runtimes/muse/gateway.js
```

Defaults: bind `127.0.0.1:8766`. The general gateway keeps `8765`. The
launcher fails closed when:

- no Muse token is set (`JARVOS_MUSE_MCP_TOKEN_FILE` or
  `JARVOS_MUSE_MCP_TOKEN`); the generic token alone is never accepted
- the Muse token equals the generic `JARVOS_MCP_HTTP_TOKEN` or the contents
  of a trusted `JARVOS_MCP_HTTP_TOKEN_FILE`, or both variables name the same
  file (this checks the configured environment only, not every process)
- the port is 8765
- the host is not loopback and `JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK=1` is unset

### Credentials

- **Never reuse the generic gateway credential** for Muse.
- **Never point Muse at the general gateway** (`jarvos-mcp-http.js`, port
  8765). It forwards the full MCP surface, including writes and control-plane.
- Treat the Muse token file as secret and do not paste it into transcripts.

### Reaching the Muse host

`http://127.0.0.1:8766/mcp` is reachable only **on the vault host**. Pick one:

1. **Tailscale** (recommended): bind to the vault host's tailnet IP and allow
   that bind explicitly:

   ```bash
   export JARVOS_MUSE_MCP_HOST="<vault-host-tailnet-ip>"
   export JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK=1
   node runtimes/muse/gateway.js
   ```

   Plain HTTP relies on WireGuard encryption. Which tailnet devices can reach
   the port depends on your tailnet access policy. Restrict this port to the
   Muse host with Tailscale ACLs before connecting Muse.

2. **SSH tunnel** (token stays on loopback at both ends):

   ```bash
   ssh -N -L 8766:127.0.0.1:8766 user@vault-host
   ```

3. **Other non-loopback binds** need `JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK=1`.
   The token is cleartext HTTP unless a TLS terminator sits in front.

### Muse client

- URL: the **tailnet, tunneled, or TLS** Muse gateway URL
- Auth: `Authorization: Bearer <token from the Muse token file>`

Do not add `node .../jarvos-mcp.js` as a stdio server on the Muse host.

If the URL does not respond, leave jarvOS unhydrated and continue. That is the
supported fail-open path.

### Client protocol

The gateway speaks Streamable HTTP over POST only:

1. POST `initialize` with `protocolVersion: "2025-06-18"`.
2. Keep the `Mcp-Session-Id` response header.
3. POST `notifications/initialized` (no `id`) with the `Mcp-Session-Id` and
   `MCP-Protocol-Version: 2025-06-18` headers.
4. Send every later POST (`tools/list`, `tools/call`, `ping`) with the same
   two headers.
5. If the gateway reports an expired or unknown session, drop the session id
   and start again at step 1.

GET/SSE is not supported (405). jarvOS ships no Muse client, and no real
client has been proven against this gateway.

### Revocation and rollback

- **Stop the Muse gateway** process. This invalidates every Muse session.
- **Replace the Muse token** while the gateway is stopped: write a new
  owner-only (0600) token file, then restart the gateway and update the Muse
  client. The token is loaded at startup, so editing the file alone does not
  revoke it in a running process.
- **Keep token backups secret.** `setup.sh` backups
  (`<token file>.bak-jarvos-*`) hold the old token.
- **Remove the enrolled Muse device** from the tailnet separately. Revoking a
  Tailscale enrollment key alone does not evict a node that already joined.

## Verification

```bash
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check muse
node --test modules/jarvos-runtime-kit/test/muse-readonly-gateway.test.js
```

No live Muse session is required for public tests.
