# @jarvos/control-plane

Portable control-plane contracts and deterministic reconciliation primitives for
jarvOS managers.

The package is deliberately dependency-free. It defines the shared vocabulary
for desired state, observations, requests, policy decisions, commands, evidence,
manager manifests, mutation leases, and durable storage without depending on
Paperclip, OpenClaw, Codex, Claude Code, cron, or a private machine path.

## What It Does

- Validates v1 record and manager-manifest contracts.
- Canonicalizes command specs and derives stable action keys for dedupe.
- Registers managers and fails closed on unsupported or malformed versions, untrusted code,
  or conflicting mutation ownership.
- Separates per-request policy authorization from command dedupe.
- Acquires compare-and-set leases with monotonic fences before dispatch.
- Runs manager execution through checkpointed reconciliation and independent
  verification.
- Persists a write-ahead, framed, fsynced reference journal with atomic stale-lock
  recovery, torn-tail repair, and bounded checkpoint compaction.
- Provides an adapter-facing authenticated application service. Trusted
  credential resolution supplies principals; caller-provided principal fields
  cannot add capabilities. Approval is single-use and binds the action key,
  required capability, expiry, and current fence.

## What It Is Not

- It is not a task tracker. Paperclip or another tracker remains the execution
  authority.
- It is not a scheduler. Scheduler authorities create mediated requests through
  the same command path.
- It is not a private host. Machine credentials, absolute paths, runtime
  adapters, and personal policy live in the installed profile or private host.
- It is not permission to mutate by free-form text. Requests must declare a
  resource, mutation class, authority, command spec, budget, and lifecycle.

## Public human and agent adapters

The package ships `jarvos-manager` for a human CLI and exposes the same
boundary through `@jarvos/agent-context` as the `jarvos_control_plane` MCP
tool. Both transports delegate only to a host-provided authenticated
application service; neither keeps a state file, resolves credentials, or
dispatches mutations.

An installed host configures `JARVOS_CONTROL_PLANE_SERVICE_MODULE` to an
absolute local module that exports either an application service or a
zero-argument factory returning one. That host module owns credential
resolution, read disclosure policy, and the store. The human CLI and MCP
surface bind the credential server-side (env, credential file, or stdin);
raw `--credential` on argv is rejected by default because it is visible in
process listings and shell history. The service establishes the trusted
principal from that bound credential and ignores any caller-supplied
authority fields.

For persisted MCP registrations (Codex `setup.sh`), bind only a non-secret
credential *file path* via `JARVOS_CONTROL_PLANE_CREDENTIAL_FILE`. Setup must
never pass `JARVOS_CONTROL_PLANE_CREDENTIAL=...` through `codex mcp add --env`,
which would expose the secret on argv and persist it in host config. The MCP
server reads the file at runtime with owner-only permission checks. Ambient
`JARVOS_CONTROL_PLANE_CREDENTIAL` remains valid for non-persisted host sessions.

```bash
export JARVOS_CONTROL_PLANE_SERVICE_MODULE=/absolute/path/to/host-service.js
# Prefer file binding for long-lived sessions; ambient env is fine for one-shot CLI.
export JARVOS_CONTROL_PLANE_CREDENTIAL="$HOST_CREDENTIAL"
jarvos-manager request --input '{"actor":{"kind":"human"},"resource":{"machineId":"machine-a","type":"workspace","id":"one"},"mutationClass":"workspace.cleanup","desiredGeneration":"1","commandSpec":{"operation":"preview"}}'
```

Use `request`/`approve` (the CLI aliases) or the core
`createRequest`/`approve` operations. Terminal command outcomes remain the
reconciler's responsibility; the adapter can only create requests, read
filtered projections, and consume command-bound approvals.

## Core Concepts

### Records

Every portable control-plane object is a versioned record:

| Type | Purpose |
| --- | --- |
| `desired-state` | Authoritative target state with provenance and generation |
| `observation` | Current fact from an authoritative read path |
| `request` | Human, agent, schedule, or system intent with principal and scope |
| `policy-decision` | `allow`, `deny`, `require_approval`, or `defer` result |
| `command` | Idempotent manager action with lifecycle, lease, and checkpoint data |
| `evidence` | Manager and verifier output for a command |
| `lease` | Logical mutation lock with a monotonic fence |
| `manager-manifest` | Manager capability, compatibility, authority, and operation contract |

### Manager Registration

Managers register a manifest with:

- `contractVersion` and supported core versions
- observation capabilities and resource selectors
- mutation classes and required authorities
- artifact trust metadata
- final-side-effect fence capability
- verifier/postcondition port details

Only explicitly supported, well-formed contract versions and trusted manifests execute mutation code. A
trusted manager with compatible observation behavior but incompatible mutation
behavior must run observation-only until a reviewed contract revision exists.

### Requests, Policy, and Dedupe

Each request gets its own policy decision before command dedupe. The action key
is derived from:

- manager id
- resource key
- mutation class
- desired generation
- canonical command-spec digest

That means two equivalent authorized requests converge on one command, while a
denied or approval-pending request cannot accidentally inherit authority from a
different caller.

### Leases and Fences

The reference store grants one current holder for each independent mutation key.
Every granted lease allocates a monotonic fence. Managers must check the fence
immediately before an externally visible side effect and evidence commits are
rejected when the fence is stale.

## Quick Start

```js
const {
  createMemoryStore,
  createPolicyEngine,
  createReconciler,
  createRegistry,
  createRequest,
} = require('@jarvos/control-plane');

const registry = createRegistry({ machineId: 'machine-a' });
registry.registerManager({
  managerId: 'workspace-manager',
  trust: { level: 'trusted' },
  capabilities: ['observe', 'execute', 'verify'],
  mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
  operationContract: {
    finalSideEffectFence: { required: true, mode: 'compare-and-set' },
    verifier: { authoritativeReadPath: 'git worktree list' },
  },
});

const policy = createPolicyEngine({
  allowlist: ['git-repository:workspace.cleanup'],
});
const store = createMemoryStore();
const reconciler = createReconciler({
  registry,
  policy,
  store,
  managers: {
    'workspace-manager': {
      async executeFenced(command, { fence, assertCurrentFence }) {
        assertCurrentFence(); // invoke at the target's final mutation boundary
        return { applied: true, fence };
      },
      async verify() {
        return { outcome: 'satisfied', postcondition: { clean: true } };
      },
    },
  },
});

const request = createRequest({
  principal: { id: 'principal:codex' },
  actor: { kind: 'agent', harness: 'codex' },
  resource: { machineId: 'machine-a', type: 'git-repository', id: 'repo-1' },
  mutationClass: 'workspace.cleanup',
  desiredGeneration: 'gen-1',
  commandSpec: {
    operation: 'cleanup-worktree',
    arguments: { candidate: 'repo-1' },
    constraints: { destructive: false },
  },
});

await reconciler.reconcileRequest(request);
```

## Testing

```bash
cd modules/jarvos-control-plane
npm test
```

The focused test suite covers strict contract validation, collision-safe keys and
digests, deny/defer-only defaults, request dedupe, cross-process lease races,
target-side fencing, terminal verifier failures, stale evidence rejection,
torn-tail repair, checkpoint recovery, and filesystem journal recovery.
