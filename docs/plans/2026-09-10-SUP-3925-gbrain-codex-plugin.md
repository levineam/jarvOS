# Native GBrain Codex plugin integration

Issue: SUP-3925. Parent outcome: out_000003 (Codex Integration).

The upstream plugin owns its MCP transport, curated skills and update tree.
jarvOS needs a small optional integration around that supported interface, not
another plugin manager or another brain. Existing managed provider and
continuity contracts remain authoritative for private runtime/brain provenance.

## Scope and design review

1. Add a portable native-plugin command adapter under `runtimes/codex/`.
   Resolve the configured `JARVOS_CODEX_EXECUTABLE` exclusively when set;
   otherwise try PATH and installed macOS app bundles. Probe the actual config
   with native plugin listing, validate required command support, and report
   executable/version. Never replace a managed launcher, alter PATH, or use
   this choice to start an agent session. Native installation/update operations
   use the same validated executable throughout each operation.
2. Offer explicit `doctor`, `install`, `update`, and `remove` operations. Doctor
   only reads native state. Mutations delegate to native Codex plugin commands;
   refuse an enabled manual GBrain server or another enabled GBrain variant.
   Record before/after native registration and completed steps so partial
   failures remain visible. Do not silently disable/rewrite existing owners.
   Document rollback through removal or restoration of the recorded upstream
   revision using native commands; no private registry or shadow plugin cache.
3. Let the existing descriptor-bound GBrain provider accept only its legacy
   no-argument invocation or the native plugin's exact guarded starter argv.
   Preserve descriptor brain/source and minimal environment; reject arbitrary
   CLI commands or broader surfaces. No proxy, new process supervisor or new
   database is introduced.
4. Document supported host environment binding and its limits. Codex plugin
   policy overlays do not accept transport `env` or `command` overrides.
   Host launch authority must supply the documented upstream environment;
   changing an active app's inherited environment/restarting it is outside this
   source slice. Installation/launcher discovery is not native-session proof.

Alternative considered: raw-write Codex/plugin configuration or clone the
upstream launcher. Rejected because either splits ownership/update provenance.
The existing native operations and guarded provider are sufficient. Updating
the general harness launcher or rewriting all Codex setup is outside this
bounded plugin integration.

## Verification and completion

- Fixtures: incompatible PATH versus compatible app bundle; explicit selection
  without fallback; no eligible executable; bounded/malformed probe failure;
  same executable for all install/update operations; manual/variant conflicts;
  unchanged unrelated configuration on doctor; partial mutation reporting.
- Provider: exact guarded argv and source binding; unknown argv rejected;
  inherited database credentials excluded; existing default launch preserved.
- Review the immutable source diff, run focused module/runtime checks and the
  required PR checks, then merge the aligned head. Publication is excluded.
- Separately accept installation lead receipts and genuine user work. Existing
  brain, source, skill policy, plugin version, native-session tool discovery and
  recall must be proven before the parent outcome closes. No synthetic live
  note/write, bootstrap, reindex, billing change, scheduler or active-app restart.

## Ownership and continuity

The existing Codex Integration task owns this isolated public issue lane;
Overseer owns immediate live installation/configuration. Projects owns the
canonical outcome, Memory Doctor owns memory recovery, and Steward sequences
runtime activation. SUP-3835 is already merged/done and is not reopened.

Stop dependent work for conflicting ownership, missing supported host binding,
failed required checks or a separate activation/privacy decision. Keep source
and native-session acceptance dispositions separate. No extra executor is
created by the tracking-only issue.
