# Optional native GBrain plugin

Use this integration when a configured user already has a GBrain installation
and wants the upstream Codex plugin. General jarvOS setup keeps GBrain optional.
The plugin owns its MCP launcher and curated skills; the GBrain engine is a
separate installation. This command never initializes a brain, installs an
engine, changes a model, or starts a Codex session.

## Native registration

From the jarvOS checkout, run the read-only check first:

```bash
node runtimes/codex/gbrain-plugin.js doctor
```

The adapter tries the first executable `codex` on an absolute PATH entry, then
standard system/user Codex and ChatGPT app bundles on macOS. Each candidate must
load the actual Codex configuration and support the required plugin commands.
It reports the selected absolute executable, CLI version and rejected attempts.
Linux users can use PATH or explicit selection. The upstream launcher currently
requires a Unix host. No shell launcher, PATH, model or managed session selector
is replaced. This choice applies only to plugin maintenance.

Set `JARVOS_CODEX_EXECUTABLE` to select an absolute executable (or command name
resolved on PATH). An explicit choice is exclusive: failure never falls back.
`CODEX_HOME` remains the native profile boundary and is inherited unchanged.

```bash
JARVOS_CODEX_EXECUTABLE=/absolute/codex node runtimes/codex/gbrain-plugin.js install
JARVOS_CODEX_EXECUTABLE=/absolute/codex node runtimes/codex/gbrain-plugin.js update
JARVOS_CODEX_EXECUTABLE=/absolute/codex node runtimes/codex/gbrain-plugin.js remove
```

Install adds the upstream `garrytan/gbrain@codex-plugin` marketplace if absent,
then adds/enables only `gbrain@gbrain`. Repeating install repairs registration.
Update refreshes only the named marketplace and reinstalls the named plugin.
Every native operation within a call uses the same validated executable.
Neither operation silently disables an enabled manual `gbrain` MCP server or
another GBrain plugin variant, including one from another marketplace. Resolve
that ownership conflict explicitly before retrying. A foreign marketplace
named `gbrain` is refused. Remove targets only `gbrain@gbrain` and leaves the
marketplace, other servers, engine and brain intact.

Save the JSON receipt before updates. It includes registration before/after,
plugin version, selected Codex version and completed native commands. The
`marketplaceRevision` is the current Git marketplace checkout revision, **not**
a digest or attestation of the installed plugin cache. Update refuses to proceed
without that source revision. A failed step can leave a configured marketplace
or refreshed checkout; inspect the receipt and rerun doctor before recovery.
Command output that might contain private configuration is not copied into it.

## Existing managed brain binding

Codex plugin MCP policy overlays exclude transport `command` and `env` fields.
Do not invent an overlay or edit the installed plugin cache. The upstream
manifest forwards host environment variables including `GBRAIN_BIN`,
`GBRAIN_BRAIN_ID` and `GBRAIN_SOURCE`. Its launcher accepts an executable path in
`GBRAIN_BIN`; without it, the engine can fall back to a global installation.
The host's existing launch authority must bind these values durably before the
next permitted native session starts. Changing an already running desktop
process's environment is not part of installation.

For descriptor-managed jarvOS continuity, use an owner-controlled executable
wrapper as `GBRAIN_BIN`. It supplies the descriptor path itself, because the
plugin does not forward `JARVOS_GBRAIN_RUNTIME_DESCRIPTOR`. Example contents,
with all placeholder paths replaced by the host owner:

```sh
#!/bin/sh
export JARVOS_GBRAIN_RUNTIME_DESCRIPTOR='/absolute/owner-only-descriptor.json'
exec /absolute/node /absolute/jarvos-gbrain-provider.js "$@"
```

Keep the wrapper and every parent directory owner-controlled. Point to a
reviewed, retained provider installation, never an ephemeral worktree. The
[managed descriptor](../../modules/jarvos-gbrain/README.md#shared-brain-continuity)
must include both `providerEnv.GBRAIN_BRAIN_ID` and `providerEnv.GBRAIN_SOURCE`
for plugin use. The existing provider accepts only the plugin's exact
`serve --surface starter --source-guard` arguments, or its legacy no-argument
invocation. Broader surfaces and arbitrary commands fail before engine launch.
Leave host `GBRAIN_SURFACE` unset (or `starter`); the wrapper rejects wider
surface overrides. Descriptor values determine brain/source; ambient database
credentials, model overrides and source settings are excluded by the provider's
existing minimal environment. The descriptor still pins engine, interpreter,
provider skill tree and Skillify, and sets `GBRAIN_SWEEP=0`.

The upstream plugin's curated Codex skills and the engine's `list_skills` /
`get_skill` resolver are separate surfaces. Skillify remains in the pinned
engine skill tree. Do not copy it into global Codex skills. Prove resolver
availability on the actual starter surface before claiming skill acceptance;
a plugin skill listing alone is insufficient.

## Acceptance and recovery

A successful doctor means `registered-not-live-proven`. It deliberately does
not connect to the database or claim correct host binding. Before closing a
private integration, record all of the following from the installed flow:

- Native plugin ID/version and separately verified installed snapshot provenance.
- Chosen Codex executable/version and the engine/interpreter descriptor pins.
- Native-session tool discovery, stable brain/store identity and source binding.
- Provider skill resolution plus one bounded recall during genuine user work.

Preserve the existing database, source privacy and capture contracts. Do not
bootstrap, reindex or create a synthetic live note to obtain an acceptance
receipt. An active-session restart needs the existing host activation authority.

To roll back registration, run `remove` with the recorded Codex executable and
profile. Restore a previous manual server only after checking that its pinned
provider still exists, its descriptor validates, and the plugin is removed.
The adapter never re-enables a stale manual entry automatically.

To restore an older upstream version, use native marketplace registration with
an independently verified prior plugin-dist commit, then add `gbrain@gbrain`
again. The marketplace receipt alone does not identify old installed bytes if
someone refreshed its checkout before the receipt was taken. Check native
`plugin marketplace add --help` for the supported `--ref` option; if replacing
the marketplace is necessary, first inspect its other consumers and use the
host's ownership/recovery procedure. Do not delete shared caches or check out
files inside the installed cache. Re-run doctor and native-session acceptance
after recovery. No version restoration is inferred from a successful removal.
