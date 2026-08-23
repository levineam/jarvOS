'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  assertStewardshipAdapter,
  LIVE_PROOF_FORWARD_SKEW_SECONDS,
  LIVE_PROOF_FRESHNESS_SECONDS,
  MANAGED_ACTIVATION_CONTRACT_VERSION,
  REQUIRED_LIFECYCLE_CAPABILITIES,
  STEWARDSHIP_ADAPTER_VERSION,
  STEWARDSHIP_ACTIONS,
  STEWARDSHIP_BOOTSTRAP_CONTRACT_VERSION,
  STEWARDSHIP_DISPATCHER,
  STEWARDSHIP_STABLE_ROOT_ENV,
  normalizeHarnessId,
  validateManagedActivationContract,
  validateManagedActivationAgainstStewardship,
  validateManifest,
  validateStewardshipBootstrap,
} = require('../src');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIMES = ['claude', 'codex', 'openclaw', 'hermes'];
const CAPABILITIES = [...REQUIRED_LIFECYCLE_CAPABILITIES, 'availability'];
const CLAUDE_HOOK_SESSION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const CODEX_HOOK_SESSION_ID = '019fbf11-8aca-79c0-981e-15abcd2392f4';

function manifestFor(runtime) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', runtime, 'adapter.json'), 'utf8'));
}

function adapterFromDeclaration(declaration) {
  const adapter = {
    version: declaration.version,
    harness: declaration.harness,
    // The static adapter claims a capability to supply isolation. It does not
    // claim that an arbitrary current checkout is already isolated.
    isolationMode: declaration.isolation.preferredMode,
    isolatedWorktrees: declaration.isolation.providesIsolatedWorktrees,
  };
  for (const capability of REQUIRED_LIFECYCLE_CAPABILITIES) adapter[capability] = () => declaration.capabilities[capability];
  return adapter;
}

test('checked-in runtime adapters expose one opt-in stewardship lifecycle contract', () => {
  for (const runtime of RUNTIMES) {
    const manifest = manifestFor(runtime);
    const declaration = manifest.stewardshipAdapter;
    assert.ok(declaration, `${runtime} must declare stewardshipAdapter`);
    assert.equal(declaration.version, STEWARDSHIP_ADAPTER_VERSION);
    assert.equal(declaration.activation.enabledByDefault, false);
    assert.equal(declaration.bootstrap.version, STEWARDSHIP_BOOTSTRAP_CONTRACT_VERSION);
    assert.equal(declaration.bootstrap.rootEnvironment, STEWARDSHIP_STABLE_ROOT_ENV);
    assert.equal(declaration.bootstrap.dispatcher, STEWARDSHIP_DISPATCHER);
    assert.deepEqual(declaration.bootstrap.actions, STEWARDSHIP_ACTIONS);
    assert.equal(validateStewardshipBootstrap(declaration.bootstrap, runtime).ok, true);
    for (const asset of declaration.bootstrap.selectedRuntimeAssets) assert.ok(fs.existsSync(path.join(ROOT, asset)), `${runtime} bootstrap asset must ship: ${asset}`);
    assert.equal(declaration.isolation.providesIsolatedWorktrees, true);
    assert.equal(declaration.isolation.requiresVerifiedWorktreeEvidence, true);
    if (['claude', 'codex'].includes(runtime)) {
      assert.match(declaration.bridge.contract, /nextTurnInput/);
      assert.match(declaration.bridge.contract, /2-3 choices/);
      assert.match(declaration.bridge.contract, /without granting authority/);
    }
    assert.deepEqual(Object.keys(declaration.capabilities).sort(), [...CAPABILITIES].sort());
    assert.equal(declaration.bridge.environment, 'JARVOS_STEWARDSHIP_BRIDGE_COMMAND');
    for (const capability of CAPABILITIES) {
      assert.ok(['native-hook', 'managed-launcher'].includes(declaration.capabilities[capability].mode));
    }
    assert.equal(assertStewardshipAdapter(adapterFromDeclaration(declaration)).harness, declaration.harness);
  }
});

test('Codex managed Compound Engineering declaration preserves the approved admission boundary', () => {
  const manifest = manifestFor('codex');
  const provider = manifest.managedProviders?.['compound-engineering'];
  assert.ok(provider);
  assert.equal(provider.status, 'supported');
  assert.equal(provider.profileBoundary, 'CODEX_HOME');
  assert.equal(provider.activation, 'approved-pinned-after-conformance');
  const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, provider.conformanceReceipt), 'utf8'));
  assert.equal(receipt.provider, 'compound-engineering');
  assert.equal(receipt.admission, 'supported');
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.invocation.status, 'passed');
  assert.equal(receipt.capabilityDenial.status, 'passed');
});

test('stewardship bootstrap declarations reject a missing action, selected asset, inspection contract, or unknown entrypoint', () => {
  const baseline = manifestFor('codex').stewardshipAdapter.bootstrap;
  for (const [label, mutate] of [
    ['action', (value) => { value.actions = value.actions.slice(1); }],
    ['asset', (value) => { value.selectedRuntimeAssets = []; }],
    ['inspection', (value) => { delete value.installedConfig.inspection; }],
    ['entrypoint', (value) => { value.entrypoint = { kind: 'unknown', path: 'unknown' }; }],
    ['wrong harness entrypoint', (value) => { value.entrypoint = { kind: 'hermesShell', path: 'jarvos-hermes-pre-llm-hook.js' }; }],
    ['wrong harness asset', (value) => { value.selectedRuntimeAssets = ['runtimes/hermes/jarvos-pre-llm-hook.js']; }],
  ]) {
    const invalid = JSON.parse(JSON.stringify(baseline));
    mutate(invalid);
    assert.equal(validateStewardshipBootstrap(invalid, 'codex').ok, false, `${label} must fail bootstrap validation`);
  }
});

test('native hook adapters fall back until linked-worktree evidence is present', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stewardship-no-git-'));
  try {
    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-start-hook.js'));
      assertStewardshipAdapter(hook.stewardshipAdapter);
      const state = hook.stewardshipAdapter.availability({
        cwd: temp,
        bridgeCommand: '',
        env: { ...process.env, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: '' },
      });
      assert.deepEqual(state, {
        capability: 'availability',
        available: false,
        preferredIsolationMode: 'native',
        isolationMode: 'managed-launcher',
        isolatedWorktree: false,
        requiresVerifiedWorktreeEvidence: true,
        pendingInSessionInput: false,
        reason: 'bridge-not-configured',
      });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('all four adapters declare the settled managed activation owner/process/live-proof policy', () => {
  const expected = {
    claude: {
      executionOwner: 'native-hooks',
      backgroundOwner: 'none',
      liveProofMode: 'qualifying',
      qualifying: ['session', 'turn'],
    },
    codex: {
      executionOwner: 'native-hooks',
      backgroundOwner: 'none',
      liveProofMode: 'qualifying',
      qualifying: ['session', 'turn'],
    },
    hermes: {
      executionOwner: 'harness-process',
      backgroundOwner: 'harness',
      liveProofMode: 'sequence',
      sequence: ['session', 'turn'],
    },
    openclaw: {
      executionOwner: 'harness-process',
      backgroundOwner: 'harness',
      liveProofMode: 'sequence',
      sequence: ['session', 'turn'],
    },
  };

  for (const runtime of RUNTIMES) {
    const manifest = manifestFor(runtime);
    const contract = manifest.managedActivation;
    assert.ok(contract, `${runtime} must declare managedActivation beside stewardshipAdapter`);
    const validated = validateManagedActivationContract(contract);
    assert.equal(validated.ok, true, `${runtime}: ${validated.errors.join('; ')}`);
    assert.equal(validated.value.harness, runtime === 'claude' ? 'claude' : runtime);
    assert.equal(contract.version, MANAGED_ACTIVATION_CONTRACT_VERSION);
    assert.equal(contract.executionOwner, expected[runtime].executionOwner);
    assert.equal(contract.backgroundProcess.owner, expected[runtime].backgroundOwner);
    assert.equal(contract.backgroundProcess.jarvosStartsProcess, false);
    assert.equal(contract.preparation.requiresExactSetup, true);
    assert.equal(contract.preparation.requiresSelectedTuple, true);
    assert.equal(contract.liveProof.freshnessSeconds, LIVE_PROOF_FRESHNESS_SECONDS);
    assert.equal(contract.liveProof.forwardSkewSeconds, LIVE_PROOF_FORWARD_SKEW_SECONDS);
    assert.equal(contract.health.mayActivate, false);
    assert.equal(contract.health.mayExplainDegradation, true);
    assert.equal(contract.rollback.ownership, 'exact-owned');
    assert.equal(contract.rollback.invalidatesGeneration, true);
    assert.equal(contract.rollback.refuseModified, true);
    if (expected[runtime].liveProofMode === 'qualifying') {
      assert.deepEqual([...contract.liveProof.qualifyingEventClasses].sort(), expected[runtime].qualifying.slice().sort());
      assert.equal(contract.liveProof.requiredSequence, undefined);
    } else {
      assert.deepEqual(contract.liveProof.requiredSequence, expected[runtime].sequence);
      assert.equal(contract.liveProof.qualifyingEventClasses, undefined);
    }
    const against = validateManagedActivationAgainstStewardship(contract, manifest.stewardshipAdapter, manifest.id);
    assert.equal(against.ok, true, `${runtime}: ${against.errors.join('; ')}`);
    const manifestValidation = validateManifest(manifest);
    assert.equal(manifestValidation.ok, true, `${runtime}: ${manifestValidation.errors.join('; ')}`);
  }
});

test('managed activation rejects jarvosStartsProcess true and contradictory lifecycle mappings', () => {
  const codex = manifestFor('codex');
  const starts = validateManagedActivationContract({
    ...codex.managedActivation,
    backgroundProcess: { owner: 'none', jarvosStartsProcess: true },
  });
  assert.equal(starts.ok, false);
  assert.match(starts.errors.join('\n'), /jarvosStartsProcess/);

  const missingSession = JSON.parse(JSON.stringify(codex.stewardshipAdapter));
  delete missingSession.capabilities.startOrResume;
  missingSession.bootstrap.actions = missingSession.bootstrap.actions.filter((action) => action !== 'session-start' && action !== 'harness-launch');
  const noSession = validateManagedActivationAgainstStewardship(codex.managedActivation, missingSession, 'codex');
  assert.equal(noSession.ok, false);
  assert.match(noSession.errors.join('\n'), /session/);

  const badTurnEvent = JSON.parse(JSON.stringify(codex.stewardshipAdapter));
  badTurnEvent.capabilities.heartbeat = {
    mode: 'native-hook',
    event: 'SessionStart',
    script: 'jarvos-session-turn-hook.js',
  };
  const contradicted = validateManagedActivationAgainstStewardship(codex.managedActivation, badTurnEvent, 'codex');
  assert.equal(contradicted.ok, false);
  assert.match(contradicted.errors.join('\n'), /contradict|turn|session/i);
});

test('Claude managed activation stays on canonical claude even when stewardship uses claude-code', () => {
  const manifest = manifestFor('claude');
  assert.equal(manifest.id, 'claude');
  assert.equal(manifest.stewardshipAdapter.harness, 'claude-code');
  assert.equal(normalizeHarnessId(manifest.stewardshipAdapter.harness), 'claude');
  assert.equal(manifest.managedActivation.harness, 'claude');
  const validated = validateManagedActivationContract(manifest.managedActivation);
  assert.equal(validated.ok, true, validated.errors.join('; '));
  assert.equal(validated.value.harness, 'claude');
  const against = validateManagedActivationAgainstStewardship(
    manifest.managedActivation,
    manifest.stewardshipAdapter,
    manifest.id,
  );
  assert.equal(against.ok, true, against.errors.join('; '));
});

function runTurnHook(runtime, env, input) {
  const result = spawnSync('node', [path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('native hooks display a validated public judgment on the next turn', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stewardship-bridge-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  const oldClaudeSession = process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID;
  const oldCodexThread = process.env.CODEX_THREAD_ID;
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"A recovery window is ready. Which safe next step should be displayed?\",\"choices\":[\"Wait for confirmation\",\"Prepare a dry run\"],\"default\":\"Wait for confirmation\",\"correlation\":\"judgment-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = 'jarvos-stewardship-bridge';
    process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID = CLAUDE_HOOK_SESSION_ID;
    process.env.CODEX_THREAD_ID = CODEX_HOOK_SESSION_ID;

    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js'));
      const start = hook.stewardshipAdapter.startOrResume({ cwd: temp });
      const input = hook.stewardshipAdapter.nextTurnInput({ cwd: temp });
      assert.equal(start.available, true);
      assert.equal(start.pendingInSessionInput, false);
      assert.equal(input.available, true);
      assert.equal(input.pendingInSessionInput, true);
      assert.deepEqual(input.nextTurnInput, {
        prompt: 'A recovery window is ready. Which safe next step should be displayed?',
        choices: ['Wait for confirmation', 'Prepare a dry run'],
        default: 'Wait for confirmation',
        correlation: 'judgment-42',
      });
      assert.equal(input.isolationMode, 'managed-launcher');
      assert.deepEqual(Object.keys(input).sort(), [
        'available',
        'capability',
        'isolatedWorktree',
        'isolationMode',
        'nextTurnInput',
        'pendingInSessionInput',
        'preferredIsolationMode',
        'reason',
        'requiresVerifiedWorktreeEvidence',
      ]);
      const output = runTurnHook(runtime, process.env, runtime === 'claude'
        ? { session_id: CLAUDE_HOOK_SESSION_ID }
        : { hook_event_name: 'UserPromptSubmit', session_id: CODEX_HOOK_SESSION_ID });
      const context = output.hookSpecificOutput.additionalContext;
      assert.match(context, /A recovery window is ready\. Which safe next step should be displayed\?/);
      assert.match(context, /Wait for confirmation/);
      assert.match(context, /Prepare a dry run/);
      assert.match(context, /judgment-42/);
      assert.match(context, /authorizes only recording that preference through the bridge/);
      assert.match(context, /does not authorize changing code, merging, publishing, or any other downstream action/);
      assert.match(context, /Recording the preference is not approval to execute it/);
      assert.doesNotMatch(context, /display-only/);
      assert.doesNotMatch(context, /reports pending in-session input/);
    }
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    if (oldClaudeSession === undefined) delete process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID;
    else process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID = oldClaudeSession;
    if (oldCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = oldCodexThread;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude turn hooks accept only a consistent canonical or transcript-derived UUID identity', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-turn-identity-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const invoked = path.join(temp, 'bridge-invoked');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-turn-hook.js'));
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      `: > ${JSON.stringify(invoked)}`,
      `[ "$JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID" = "${CLAUDE_HOOK_SESSION_ID}" ] || exit 23`,
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose the safe recovery step.\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"claude-identity-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${oldPath || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
    };
    const accepted = [
      { session_id: CLAUDE_HOOK_SESSION_ID },
      { sessionId: CLAUDE_HOOK_SESSION_ID },
      { transcript_path: path.join(temp, 'private', `${CLAUDE_HOOK_SESSION_ID}.jsonl`) },
      { session_id: CLAUDE_HOOK_SESSION_ID, sessionId: CLAUDE_HOOK_SESSION_ID, transcript_path: path.join(temp, `${CLAUDE_HOOK_SESSION_ID}.jsonl`) },
    ];
    for (const input of accepted) {
      assert.equal(hook.hookSessionId(input), CLAUDE_HOOK_SESSION_ID);
      fs.rmSync(invoked, { force: true });
      const output = runTurnHook('claude', env, input);
      assert.equal(fs.existsSync(invoked), true);
      assert.match(output.hookSpecificOutput.additionalContext, /Choose the safe recovery step\./);
      assert.doesNotMatch(JSON.stringify(output), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    const rejected = [
      {},
      { session_id: 'arbitrary-session' },
      { sessionId: 'arbitrary-session' },
      { session_id: CLAUDE_HOOK_SESSION_ID, sessionId: '77777777-7777-4888-8999-aaaaaaaaaaaa' },
      { session_id: CLAUDE_HOOK_SESSION_ID, transcript_path: path.join(temp, '77777777-7777-4888-8999-aaaaaaaaaaaa.jsonl') },
      { transcript_path: path.join(temp, 'not-a-uuid.jsonl') },
      { transcript_path: `${CLAUDE_HOOK_SESSION_ID}.jsonl` },
      { transcript_path: path.join(temp, `${CLAUDE_HOOK_SESSION_ID}.jsonl`, 'nested') },
    ];
    for (const input of rejected) {
      assert.equal(hook.hookSessionId(input), null);
      fs.rmSync(invoked, { force: true });
      assert.deepEqual(runTurnHook('claude', env, input), {});
      assert.equal(fs.existsSync(invoked), false, `bridge must not run for ${JSON.stringify(input)}`);
    }
    fs.rmSync(invoked, { force: true });
    assert.equal(hook.stewardshipAdapter.nextTurnInput({ cwd: temp, sessionId: null, bridgeCommand: 'jarvos-stewardship-bridge', env }).reason, 'bridge-unavailable');
    assert.equal(fs.existsSync(invoked), false, 'a caller that explicitly lacks a session identity must not run the bridge');
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex SessionStart exposes a pending public judgment for both fresh and resumed sessions', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-session-start-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose the safe recovery step.\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"resume-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = 'jarvos-stewardship-bridge';

    const hook = require(path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-start-hook.js'));
    const context = hook.stewardshipContext({ cwd: temp, env: { ...process.env, CODEX_THREAD_ID: CODEX_HOOK_SESSION_ID } });
    assert.match(context, /Choose the safe recovery step\./);
    assert.match(context, /resume-42/);
    assert.match(context, /jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>/);
    assert.doesNotMatch(context, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex SessionStart derives a bridge-only thread identity from resume stdin', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-resume-stdin-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const invoked = path.join(temp, 'bridge-invoked');
  const sessionId = '019fbf11-8aca-79c0-981e-15abcd2392f4';
  const mismatchedId = '019fbf11-8aca-79c0-981e-15abcd2392f5';
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      `printf '%s\\n' "$1" >> ${JSON.stringify(invoked)}`,
      `[ "$CODEX_THREAD_ID" = "${sessionId}" ] || exit 23`,
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Resume safely?\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"codex-resume-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    const baseEnv = {
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: path.join(temp, 'clean-home'),
      JARVOS_SECONDBRAIN_DIR: path.join(temp, 'missing-secondbrain'),
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: path.join(temp, 'private-map'),
    };
    const start = (env, input) => spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-start-hook.js')], {
      cwd: temp,
      encoding: 'utf8',
      env,
      input: typeof input === 'string' || input === undefined ? input : JSON.stringify(input),
    });
    const turn = (env, input) => spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-turn-hook.js')], {
      cwd: temp,
      encoding: 'utf8',
      env,
      input: typeof input === 'string' || input === undefined ? input : JSON.stringify(input),
    });

    const resumed = start(baseEnv, { hook_event_name: 'SessionStart', session_id: sessionId });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /Resume safely\?/);
    assert.match(output.hookSpecificOutput.additionalContext, /codex-resume-42/);
    assert.match(output.hookSpecificOutput.additionalContext, /jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>/);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(fs.readFileSync(invoked, 'utf8').trim().split('\n'), ['startOrResume', 'sessionWaitBind', 'nextTurnInput', 'sessionWaitNextTurn']);

    fs.rmSync(invoked, { force: true });
    const mismatch = start({ ...baseEnv, CODEX_THREAD_ID: mismatchedId }, { hook_event_name: 'SessionStart', session_id: sessionId });
    assert.equal(mismatch.status, 0, mismatch.stderr || mismatch.stdout);
    assert.deepEqual(JSON.parse(mismatch.stdout), {});
    assert.equal(fs.existsSync(invoked), false);

    const invalidInputs = [
      undefined,
      '{',
      { hook_event_name: 'UserPromptSubmit', session_id: sessionId },
      `{"hook_event_name":"SessionStart","session_id":"${sessionId}","padding":"${'x'.repeat(4096)}"}`,
    ];
    const hydrationEnv = { ...baseEnv, JARVOS_SECONDBRAIN_DIR: path.join(ROOT, 'modules', 'jarvos-secondbrain') };
    for (const ambientThreadId of [sessionId, 'stale-thread-id']) {
      for (const input of invalidInputs) {
        fs.rmSync(invoked, { force: true });
        const rejected = start({ ...hydrationEnv, CODEX_THREAD_ID: ambientThreadId }, input);
        assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
        assert.match(JSON.parse(rejected.stdout).hookSpecificOutput.additionalContext, /# jarvOS Working Context Packet/);
        assert.equal(fs.existsSync(invoked), false, `bridge must not run for ${typeof input === 'string' ? input.slice(0, 32) : JSON.stringify(input)}`);
      }
    }

    const invalidTurnInputs = [
      undefined,
      '{',
      { hook_event_name: 'SessionStart', session_id: sessionId },
      { hook_event_name: 'UserPromptSubmit', session_id: mismatchedId },
    ];
    for (const ambientThreadId of [sessionId, 'stale-thread-id']) {
      for (const input of invalidTurnInputs) {
        fs.rmSync(invoked, { force: true });
        const rejected = turn({ ...baseEnv, CODEX_THREAD_ID: ambientThreadId }, input);
        assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
        assert.deepEqual(JSON.parse(rejected.stdout), {});
        assert.equal(fs.existsSync(invoked), false, `turn bridge must not run for ${typeof input === 'string' ? input : JSON.stringify(input)}`);
      }
    }
    fs.rmSync(invoked, { force: true });
    const mismatchedTurn = turn({ ...baseEnv, CODEX_THREAD_ID: mismatchedId }, { hook_event_name: 'UserPromptSubmit', session_id: sessionId });
    assert.equal(mismatchedTurn.status, 0, mismatchedTurn.stderr || mismatchedTurn.stdout);
    assert.deepEqual(JSON.parse(mismatchedTurn.stdout), {});
    assert.equal(fs.existsSync(invoked), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude SessionStart persists only a validated bridge command and neutral map root for later hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-env-file-'));
  const bin = path.join(temp, 'bin');
  const mappingRoot = path.join(temp, 'claude-session-map');
  const envFile = path.join(temp, 'claude.env');
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(mappingRoot, { mode: 0o700 });
    const bridge = path.join(bin, 'jarvos-stewardship-bridge');
    fs.writeFileSync(bridge, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(bridge, 0o700);
    fs.writeFileSync(envFile, 'export UNRELATED=value\n', { mode: 0o600 });
    fs.chmodSync(envFile, 0o600);
    const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-start-hook.js'));
    const env = {
      CLAUDE_ENV_FILE: envFile,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT: mappingRoot,
      PATH: bin,
    };
    assert.equal(hook.persistBridgeEnvironment({ env }), true);
    const expected = [
      'export UNRELATED=value',
      "export JARVOS_STEWARDSHIP_BRIDGE_COMMAND='jarvos-stewardship-bridge'",
      `export JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT='${mappingRoot}'`,
      `export PATH='${bin}':\"$PATH\"`,
      '',
    ].join('\n');
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
    assert.equal(hook.persistBridgeEnvironment({ env }), true);
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
    assert.equal(hook.persistBridgeEnvironment({ env: { ...env, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: '../invalid' } }), false);
    assert.equal(hook.persistBridgeEnvironment({ env: { ...env, JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT: 'relative-map' } }), false);
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
    fs.chmodSync(envFile, 0o644);
    assert.equal(hook.persistBridgeEnvironment({ env }), false);
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude SessionStart uses a smaller hydration budget after compact or resume', () => {
  const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-start-hook.js'));
  const previous = {
    claude: process.env.JARVOS_CLAUDE_HYDRATION_MAX_CHARS,
    shared: process.env.JARVOS_HYDRATION_MAX_CHARS,
  };
  delete process.env.JARVOS_CLAUDE_HYDRATION_MAX_CHARS;
  delete process.env.JARVOS_HYDRATION_MAX_CHARS;
  try {
    assert.equal(hook.hydrationMaxChars({ source: 'startup' }), hook.DEFAULT_MAX_CHARS);
    assert.equal(hook.hydrationMaxChars({ source: 'compact' }), hook.REORIENT_MAX_CHARS);
    assert.equal(hook.hydrationMaxChars({ source: 'resume' }), hook.REORIENT_MAX_CHARS);
    assert.equal(hook.hydrationMaxChars({}), hook.DEFAULT_MAX_CHARS);
    process.env.JARVOS_CLAUDE_HYDRATION_MAX_CHARS = '2000';
    assert.equal(hook.hydrationMaxChars({ source: 'startup' }), 2000);
    assert.equal(hook.hydrationMaxChars({ source: 'compact' }), 2000);
  } finally {
    for (const [key, value] of Object.entries({
      JARVOS_CLAUDE_HYDRATION_MAX_CHARS: previous.claude,
      JARVOS_HYDRATION_MAX_CHARS: previous.shared,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Claude PreCompact hook flushes mechanical session-thread state and fails open', () => {
  const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-precompact-hook.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-precompact-'));
  try {
    const summary = hook.mechanicalSummary({
      cwd,
      trigger: 'manual',
      session_id: CLAUDE_HOOK_SESSION_ID,
      custom_instructions: 'SECRET COMPACTION PROMPT MUST NEVER PERSIST',
      transcript_path: path.join(cwd, `${CLAUDE_HOOK_SESSION_ID}.jsonl`),
    });
    assert.match(summary, /Pre-compaction flush \(manual\)/);
    assert.match(summary, new RegExp(`cwd: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(summary, /dirty paths: 0/);
    assert.match(summary, new RegExp(`session: ${CLAUDE_HOOK_SESSION_ID}`));
    assert.doesNotMatch(summary, /SECRET COMPACTION PROMPT/);
    assert.doesNotMatch(summary, /transcript_path/);
    assert.doesNotMatch(summary, /\.jsonl/);

    const result = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'claude', 'jarvos-precompact-hook.js')], {
      cwd,
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: CLAUDE_HOOK_SESSION_ID,
        hook_event_name: 'PreCompact',
        trigger: 'auto',
        custom_instructions: 'SECRET COMPACTION PROMPT MUST NEVER PERSIST',
        cwd,
      }),
      env: {
        ...process.env,
        HOME: path.join(cwd, 'home'),
        JARVOS_SECONDBRAIN_DIR: path.join(cwd, 'missing-secondbrain'),
        JARVOS_VAULT_DIR: path.join(cwd, 'missing-vault'),
        JARVOS_WORKSPACE_DIR: cwd,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout || '{}'), {});
    assert.doesNotMatch(result.stdout, /SECRET COMPACTION PROMPT/);
    assert.doesNotMatch(result.stderr || '', /SECRET COMPACTION PROMPT/);

    const empty = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'claude', 'jarvos-precompact-hook.js')], {
      cwd,
      encoding: 'utf8',
      input: '',
      env: {
        ...process.env,
        HOME: path.join(cwd, 'home'),
        JARVOS_SECONDBRAIN_DIR: path.join(cwd, 'missing-secondbrain'),
        JARVOS_VAULT_DIR: path.join(cwd, 'missing-vault'),
        JARVOS_WORKSPACE_DIR: cwd,
      },
    });
    assert.equal(empty.status, 0, empty.stderr || empty.stdout);
    assert.deepEqual(JSON.parse(empty.stdout || '{}'), {});
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Claude SessionStart exposes a pending stewardship judgment even when hydration is unavailable', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-start-judgment-'));
  const bin = path.join(temp, 'bin');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  try {
    fs.mkdirSync(bin, { recursive: true });
    const bridge = path.join(bin, 'jarvos-stewardship-bridge');
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      `[ "$JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID" = "${CLAUDE_HOOK_SESSION_ID}" ] || exit 23`,
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose the safe recovery step.\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"claude-start-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = 'jarvos-stewardship-bridge';
    const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-start-hook.js'));
    const context = hook.stewardshipContext({ cwd: temp, sessionId: CLAUDE_HOOK_SESSION_ID });
    assert.match(context, /Choose the safe recovery step\./);
    assert.match(context, /claude-start-42/);
    assert.match(context, /jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>/);
    const started = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-start-hook.js')], {
      cwd: temp,
      encoding: 'utf8',
      input: JSON.stringify({ transcript_path: path.join(temp, 'private', `${CLAUDE_HOOK_SESSION_ID}.jsonl`) }),
      env: {
        ...process.env,
        JARVOS_SECONDBRAIN_DIR: path.join(temp, 'missing-secondbrain'),
      },
    });
    assert.equal(started.status, 0, started.stderr);
    const startupOutput = JSON.parse(started.stdout);
    assert.match(startupOutput.hookSpecificOutput.additionalContext, /Choose the safe recovery step\./);
    assert.match(startupOutput.hookSpecificOutput.additionalContext, /claude-start-42/);
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('native turn hooks reject malicious bridge payloads and stay quiet without public input', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stewardship-turn-reject-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  const oldClaudeSession = process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID;
  const oldCodexThread = process.env.CODEX_THREAD_ID;
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      "printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Read /Users/alice/private-router before deciding.\",\"choices\":[\"Wait\",\"Proceed\"],\"default\":\"Wait\",\"correlation\":\"judgment-42\",\"route\":\"private-router\"}'",
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = 'jarvos-stewardship-bridge';
    process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID = CLAUDE_HOOK_SESSION_ID;
    process.env.CODEX_THREAD_ID = CODEX_HOOK_SESSION_ID;

    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js'));
      const input = hook.stewardshipAdapter.nextTurnInput({ cwd: temp });
      assert.equal(input.available, false);
      assert.equal(input.pendingInSessionInput, false);
      assert.equal(input.reason, 'bridge-unavailable');
      assert.deepEqual(runTurnHook(runtime, process.env, runtime === 'claude'
        ? { session_id: CLAUDE_HOOK_SESSION_ID }
        : { hook_event_name: 'UserPromptSubmit', session_id: CODEX_HOOK_SESSION_ID }), {});
    }

    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      "printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":false}'",
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js'));
      const input = hook.stewardshipAdapter.nextTurnInput({ cwd: temp });
      assert.equal(input.available, true);
      assert.equal(input.pendingInSessionInput, false);
      assert.deepEqual(runTurnHook(runtime, process.env, runtime === 'claude'
        ? { session_id: CLAUDE_HOOK_SESSION_ID }
        : { hook_event_name: 'UserPromptSubmit', session_id: CODEX_HOOK_SESSION_ID }), {});
    }

    delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    for (const runtime of ['claude', 'codex']) assert.deepEqual(runTurnHook(runtime, process.env), {});
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    if (oldClaudeSession === undefined) delete process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID;
    else process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID = oldClaudeSession;
    if (oldCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = oldCodexThread;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('native hook declarations point at the packaged start and turn bridges', () => {
  for (const runtime of ['claude', 'codex']) {
    const declaration = manifestFor(runtime).stewardshipAdapter;
    assert.equal(declaration.capabilities.startOrResume.script, 'jarvos-session-start-hook.js');
    for (const capability of ['heartbeat', 'nextTurnInput', 'availability']) {
      assert.equal(declaration.capabilities[capability].script, 'jarvos-session-turn-hook.js');
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js')));
  }
  assert.equal(
    manifestFor('claude').capabilityDescriptor.capabilities.session.preCompactHook.evidence,
    'jarvos-precompact-hook.js',
  );
  assert.ok(fs.existsSync(path.join(ROOT, 'runtimes', 'claude', 'jarvos-precompact-hook.js')));
});

test('OpenClaw and Hermes package bounded per-turn stewardship bridge artifacts without activating user configuration', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'openclaw.plugin.json'), 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'package.json'), 'utf8'));
  assert.equal(manifest.id, 'jarvos-stewardship');
  assert.deepEqual(manifest.contracts, { tools: ['jarvos_stewardship_answer'] });
  assert.deepEqual(manifest.configSchema, {
    type: 'object', additionalProperties: false,
    properties: {
      mappingRoot: { type: 'string', pattern: '^/' }, toolAllowAddedByJarvos: { type: 'boolean' },
      agentToolGrantByJarvos: {
        type: 'object', additionalProperties: false,
        properties: {
          agentId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' }, added: { type: 'boolean' },
          createdAgent: { type: 'boolean' }, createdTools: { type: 'boolean' }, createdAlsoAllow: { type: 'boolean' },
        },
        required: ['agentId', 'added', 'createdAgent', 'createdTools', 'createdAlsoAllow'],
      },
    }, required: ['mappingRoot'],
  });
  assert.deepEqual(packageJson.openclaw.extensions, ['jarvos-next-turn-plugin.js']);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stewardship-public-turn-hook-'));
  const bin = path.join(temp, 'bin'); const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      "if [ \"$1\" = answer ]; then printf '%s\\n' '{\"status\":\"answered\"}'; else printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose a safe next step.\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"judgment-42\"}'; fi",
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge' };
    const hermesResult = spawnSync('node', [path.join(ROOT, 'runtimes', 'hermes', 'jarvos-pre-llm-hook.js')], { encoding: 'utf8', env });
    assert.equal(hermesResult.status, 0, hermesResult.stderr);
    const hermesContext = JSON.parse(hermesResult.stdout).context;
    assert.match(hermesContext, /Choose a safe next step/);
    assert.match(hermesContext, /authorizes only recording that preference through the bridge/);
    assert.doesNotMatch(hermesContext, /display-only/);
    const mappings = path.join(temp, 'mappings'); fs.mkdirSync(mappings);
    const sessionKey = 'agent:main:explicit:session-42';
    fs.writeFileSync(path.join(mappings, `${createHash('sha256').update(sessionKey).digest('hex')}.json`), `${JSON.stringify({ schemaVersion: 1, contextFile: path.join(temp, 'context.json'), bridgeExecutable: bridge })}\n`, { mode: 0o600 });
    fs.chmodSync(path.join(mappings, `${createHash('sha256').update(sessionKey).digest('hex')}.json`), 0o600);
    const plugin = require(path.join(ROOT, 'runtimes', 'openclaw', 'jarvos-next-turn-plugin.js'));
    // OpenClaw 2026.7.1 places the session identity on the typed hook
    // context, not the agent_turn_prepare event. Keep the event shape
    // faithful so this regression proves delivery on a normal agent turn.
    const directContext = plugin.agent_turn_prepare({ prompt: 'Continue', messages: [], queuedInjections: [] }, { sessionKey, pluginConfig: { mappingRoot: mappings } }).prependContext;
    assert.match(directContext, /Choose a safe next step/);
    assert.match(directContext, /call jarvos_stewardship_answer/);
    assert.match(directContext, /authorizes only recording that preference/);
    assert.doesNotMatch(directContext, /display-only/);
    assert.doesNotMatch(directContext, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(plugin.agent_turn_prepare({ prompt: 'Continue', messages: [], queuedInjections: [] }, { sessionKey: 'agent:other:explicit:session-42', pluginConfig: { mappingRoot: mappings } }), {});
    assert.deepEqual(plugin.agent_turn_prepare({ prompt: 'Continue', messages: [], queuedInjections: [] }, { sessionKey: 'unmapped', pluginConfig: { mappingRoot: mappings } }), {});
    const registrations = []; const tools = [];
    plugin({ pluginConfig: { mappingRoot: mappings }, on: (...args) => registrations.push(args), registerTool: (...args) => tools.push(args) });
    assert.equal(registrations.length, 1); assert.equal(registrations[0][0], 'agent_turn_prepare'); assert.equal(registrations[0][2].timeoutMs, 5000);
    const registeredContext = registrations[0][1]({ prompt: 'Continue', messages: [] }, { sessionKey }).prependContext;
    assert.match(registeredContext, /Choose a safe next step/);
    assert.doesNotMatch(registeredContext, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(registrations[0][1]({ prompt: 'Continue', messages: [] }, { sessionKey: 'agent:other:explicit:session-42' }), {});
    assert.equal(tools.length, 1); assert.equal(tools[0][1].name, 'jarvos_stewardship_answer');
    const answer = await tools[0][0]({ sessionKey }).execute('call-42', { correlation: 'judgment-42', choice: 'Wait' });
    assert.deepEqual(answer, { content: [{ type: 'text', text: 'Stewardship answer recorded.' }] });
    const rejected = await tools[0][0]({ sessionKey: 'agent:other:explicit:session-42' }).execute('call-43', { correlation: 'judgment-42', choice: 'Wait' });
    assert.equal(rejected.isError, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function runSetup(script, env) {
  const result = runSetupResult(script, env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runSetupResult(script, env) {
  return spawnSync('bash', [script], { cwd: ROOT, encoding: 'utf8', env });
}

function prepareStableStewardshipBundle(temp, rootName = 'managed-harness-bin') {
  const root = path.join(temp, rootName);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
  for (const name of ['jarvos-stewardship-dispatcher', 'jarvos-hermes-pre-llm-hook.js']) {
    const target = path.join(root, name);
    fs.writeFileSync(target, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(target, 0o700);
  }
  const plugin = path.join(root, 'jarvos-openclaw-stewardship-plugin');
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 }); fs.chmodSync(plugin, 0o700);
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"name":"jarvos-stewardship-openclaw"}\n', { mode: 0o600 });
  fs.chmodSync(path.join(plugin, 'package.json'), 0o600);
  fs.writeFileSync(path.join(plugin, 'openclaw.plugin.json'), '{"id":"jarvos-stewardship"}\n', { mode: 0o600 });
  fs.chmodSync(path.join(plugin, 'openclaw.plugin.json'), 0o600);
  fs.writeFileSync(path.join(plugin, 'jarvos-next-turn-plugin.js'), 'module.exports = {};\n', { mode: 0o600 });
  fs.chmodSync(path.join(plugin, 'jarvos-next-turn-plugin.js'), 0o600);
  return root;
}

function prepareFakeOpenClaw(temp) {
  const bin = path.join(temp, 'openclaw-bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'openclaw');
  fs.writeFileSync(executable, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('OpenClaw 2026.7.1\\n');
  process.exit(0);
}
if (args.join(' ') !== 'plugins inspect --all --json') process.exit(2);
if (process.env.JARVOS_FAKE_OPENCLAW_MODE === 'timeout') setInterval(() => {}, 1000);
if (process.env.JARVOS_FAKE_OPENCLAW_MODE === 'fail') process.exit(1);
if (process.env.JARVOS_FAKE_OPENCLAW_MODE === 'concurrent-fail') {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || process.env.OPENCLAW_CONFIG;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.concurrentUserChange = true;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\\n');
  process.exit(1);
}
const mode = process.env.JARVOS_FAKE_OPENCLAW_MODE || 'healthy';
const rootDir = mode === 'mismatch' ? '/synthetic/openclaw/other-plugin' : process.env.JARVOS_FAKE_OPENCLAW_PLUGIN_PATH;
const status = mode === 'unavailable' ? 'error' : 'loaded';
const enabled = mode !== 'disabled';
process.stdout.write(JSON.stringify([{ plugin: { id: 'jarvos-stewardship', status, enabled, rootDir, version: '1.0.0' }, diagnostics: [] }]));
`, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return bin;
}

function count(content, pattern) {
  return (content.match(pattern) || []).length;
}

function assertCodexParsesConfig(config) {
  const result = spawnSync('codex', ['features', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: path.dirname(config) },
  });
  // The unit suite also runs where the Codex executable is intentionally not
  // installed. The setup-specific assertions below still prove there is one
  // TOML representation; exercise Codex's own parser whenever it is present.
  if (result.error && result.error.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('OpenClaw stewardship-only setup preserves unrelated configuration and rolls back only its staged plugin', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-setup-'));
  const config = path.join(temp, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    const stable = prepareStableStewardshipBundle(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({ plugins: { load: { paths: ['/user/jarvos-openclaw-stewardship-plugin', path.join(staged, 'runtimes', 'openclaw')] }, allow: ['unrelated'], entries: { unrelated: { enabled: true } } }, tools: { profile: 'coding', allow: ['read'] }, agents: { list: [{ id: 'main', tools: { alsoAllow: ['browser'] } }] }, unrelated: { keep: true } }, null, 2)}\n`);
    const fakeOpenClaw = prepareFakeOpenClaw(temp);
    const env = { ...process.env, HOME: path.join(temp, 'home'), PATH: `${fakeOpenClaw}${path.delimiter}${process.env.PATH || ''}`, OPENCLAW_CONFIG: config, JARVOS_FAKE_OPENCLAW_PLUGIN_PATH: path.join(stable, 'jarvos-openclaw-stewardship-plugin'), JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const script = path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh');
    runSetup(script, env); const first = fs.readFileSync(config, 'utf8'); runSetup(script, env); assert.equal(fs.readFileSync(config, 'utf8'), first);
    let parsed = JSON.parse(first); assert.deepEqual(parsed.plugins.load.paths, ['/user/jarvos-openclaw-stewardship-plugin', path.join(stable, 'jarvos-openclaw-stewardship-plugin')]); assert.equal(parsed.unrelated.keep, true); assert.equal(parsed.plugins.entries.unrelated.enabled, true); assert.equal(parsed.plugins.entries['jarvos-stewardship'].config.mappingRoot, path.join(state, 'stewardship-bridge', 'openclaw-sessions')); assert.deepEqual(parsed.tools.allow, ['read', 'jarvos_stewardship_answer']);
    assert.equal(parsed.plugins.entries['jarvos-stewardship'].config.toolAllowAddedByJarvos, true);
    assert.deepEqual(parsed.agents.list[0].tools.alsoAllow, ['browser', 'jarvos_stewardship_answer']);
    assert.deepEqual(parsed.plugins.entries['jarvos-stewardship'].config.agentToolGrantByJarvos, { agentId: 'main', added: true, createdAgent: false, createdTools: false, createdAlsoAllow: false });
    const pluginSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'openclaw.plugin.json'), 'utf8')).configSchema;
    for (const key of Object.keys(parsed.plugins.entries['jarvos-stewardship'].config)) assert.ok(pluginSchema.properties[key], `${key} must be declared in the plugin config schema`);
    assert.equal(pluginSchema.properties.toolAllowAddedByJarvos.type, 'boolean');
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' }); parsed = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.deepEqual(parsed.plugins.load.paths, ['/user/jarvos-openclaw-stewardship-plugin']); assert.deepEqual(parsed.plugins.allow, ['unrelated']); assert.equal(parsed.plugins.entries['jarvos-stewardship'], undefined); assert.equal(parsed.plugins.entries.unrelated.enabled, true); assert.deepEqual(parsed.tools.allow, ['read']); assert.deepEqual(parsed.agents.list[0].tools.alsoAllow, ['browser']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw rollback preserves a stewardship tool grant that predated jarvOS setup', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-preexisting-tool-'));
  const config = path.join(temp, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    const stable = prepareStableStewardshipBundle(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({ tools: { profile: 'coding', allow: ['read', 'jarvos_stewardship_answer'] }, agents: { list: [{ id: 'main', tools: { alsoAllow: ['jarvos_stewardship_answer'] } }] } }, null, 2)}\n`);
    const fakeOpenClaw = prepareFakeOpenClaw(temp);
    const env = { ...process.env, HOME: path.join(temp, 'home'), PATH: `${fakeOpenClaw}${path.delimiter}${process.env.PATH || ''}`, OPENCLAW_CONFIG: config, JARVOS_FAKE_OPENCLAW_PLUGIN_PATH: path.join(stable, 'jarvos-openclaw-stewardship-plugin'), JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const script = path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh');
    runSetup(script, env); const installed = JSON.parse(fs.readFileSync(config, 'utf8')); assert.equal(installed.plugins.entries['jarvos-stewardship'].config.toolAllowAddedByJarvos, false); assert.equal(installed.plugins.entries['jarvos-stewardship'].config.agentToolGrantByJarvos.added, false);
    fs.rmSync(stable, { recursive: true, force: true });
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = JSON.parse(fs.readFileSync(config, 'utf8')); assert.deepEqual(rolledBack.tools.allow, ['read', 'jarvos_stewardship_answer']); assert.deepEqual(rolledBack.agents.list[0].tools.alsoAllow, ['jarvos_stewardship_answer']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw setup does not claim permission ownership when its configuration update fails', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-config-failure-'));
  const configRoot = path.join(temp, 'config'); const config = path.join(configRoot, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    const stable = prepareStableStewardshipBundle(temp);
    fs.mkdirSync(configRoot, { recursive: true }); fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({ tools: { allow: ['read'] } }, null, 2)}\n`); fs.chmodSync(configRoot, 0o500);
    const env = { ...process.env, HOME: path.join(temp, 'home'), OPENCLAW_CONFIG: config, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const result = runSetupResult(path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh'), env);
    assert.notEqual(result.status, 0); assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')).tools.allow, ['read']);
  } finally { fs.chmodSync(configRoot, 0o700); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw setup restores exact prior bytes and mode when staged registration verification fails', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-rollback-'));
  const config = path.join(temp, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    const stable = prepareStableStewardshipBundle(temp);
    const fakeOpenClaw = prepareFakeOpenClaw(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    const original = Buffer.from('{"unrelated":true}\n');
    fs.writeFileSync(config, original); fs.chmodSync(config, 0o640);
    const env = { ...process.env, HOME: path.join(temp, 'home'), PATH: `${fakeOpenClaw}${path.delimiter}${process.env.PATH || ''}`, OPENCLAW_CONFIG: config, JARVOS_FAKE_OPENCLAW_MODE: 'fail', JARVOS_FAKE_OPENCLAW_PLUGIN_PATH: path.join(stable, 'jarvos-openclaw-stewardship-plugin'), JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const result = runSetupResult(path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh'), env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readFileSync(config), original);
    assert.equal(fs.statSync(config).mode & 0o777, 0o640);
    assert.match(`${result.stdout}\n${result.stderr}`, /verification|registration/i);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw setup removes only a newly created config when verification fails', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-absent-config-'));
  const config = path.join(temp, 'config', 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    const stable = prepareStableStewardshipBundle(temp); const fakeOpenClaw = prepareFakeOpenClaw(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    const env = { ...process.env, HOME: path.join(temp, 'home'), PATH: `${fakeOpenClaw}${path.delimiter}${process.env.PATH || ''}`, OPENCLAW_CONFIG: config, JARVOS_FAKE_OPENCLAW_MODE: 'fail', JARVOS_FAKE_OPENCLAW_PLUGIN_PATH: path.join(stable, 'jarvos-openclaw-stewardship-plugin'), JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const result = runSetupResult(path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh'), env);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(config), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw setup preserves a concurrent config edit instead of rolling it back', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-concurrent-'));
  const config = path.join(temp, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    const stable = prepareStableStewardshipBundle(temp); const fakeOpenClaw = prepareFakeOpenClaw(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({ unrelated: true }, null, 2)}\n`);
    const env = { ...process.env, HOME: path.join(temp, 'home'), PATH: `${fakeOpenClaw}${path.delimiter}${process.env.PATH || ''}`, OPENCLAW_CONFIG: config, JARVOS_FAKE_OPENCLAW_MODE: 'concurrent-fail', JARVOS_FAKE_OPENCLAW_PLUGIN_PATH: path.join(stable, 'jarvos-openclaw-stewardship-plugin'), JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const result = runSetupResult(path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh'), env);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).concurrentUserChange, true);
    assert.match(`${result.stdout}\n${result.stderr}`, /manual reconciliation/i);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw setup rejects a symlinked config before any write', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-config-symlink-'));
  const target = path.join(temp, 'target.json'); const config = path.join(temp, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    const stable = prepareStableStewardshipBundle(temp); const fakeOpenClaw = prepareFakeOpenClaw(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    const original = '{"unrelated":true}\n'; fs.writeFileSync(target, original); fs.symlinkSync(target, config);
    const env = { ...process.env, HOME: path.join(temp, 'home'), PATH: `${fakeOpenClaw}${path.delimiter}${process.env.PATH || ''}`, OPENCLAW_CONFIG: config, JARVOS_FAKE_OPENCLAW_PLUGIN_PATH: path.join(stable, 'jarvos-openclaw-stewardship-plugin'), JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const result = runSetupResult(path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh'), env);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw rejects relative, missing, and unsafe stable plugin bundles without mutating configuration', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stable-root-validation-'));
  const config = path.join(temp, 'openclaw.json'); const state = path.join(temp, 'state');
  const original = `${JSON.stringify({ plugins: { load: { paths: ['/user/jarvos-openclaw-stewardship-plugin'] } }, unrelated: true }, null, 2)}\n`;
  try {
    fs.writeFileSync(config, original);
    const baseEnv = { ...process.env, HOME: path.join(temp, 'home'), OPENCLAW_CONFIG: config, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const script = path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh');
    for (const stableRoot of ['relative-stable-root', path.join(temp, 'missing-stable-root')]) {
      const result = runSetupResult(script, { ...baseEnv, JARVOS_STEWARDSHIP_STABLE_ROOT: stableRoot });
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(config, 'utf8'), original);
    }
    for (const file of ['package.json', 'openclaw.plugin.json', 'jarvos-next-turn-plugin.js']) {
      const stable = prepareStableStewardshipBundle(temp, `partial-${file}`);
      fs.unlinkSync(path.join(stable, 'jarvos-openclaw-stewardship-plugin', file));
      const result = runSetupResult(script, { ...baseEnv, JARVOS_STEWARDSHIP_STABLE_ROOT: stable });
      assert.notEqual(result.status, 0, file);
      assert.equal(fs.readFileSync(config, 'utf8'), original, file);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Hermes stewardship-only setup records exact consent idempotently and removes only that consent on rollback', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-hermes-stewardship-setup-'));
  const home = path.join(temp, 'home'); const config = path.join(temp, 'config.yaml'); const staged = path.join(temp, 'stage'); const allowlist = path.join(home, '.hermes', 'shell-hooks-allowlist.json');
  try {
    const stable = prepareStableStewardshipBundle(temp); const hook = path.join(stable, 'jarvos-hermes-pre-llm-hook.js');
    fs.mkdirSync(path.join(staged, 'runtimes', 'hermes'), { recursive: true }); fs.mkdirSync(path.dirname(allowlist), { recursive: true });
    const legacyHook = path.join(staged, 'runtimes', 'hermes', 'jarvos-pre-llm-hook.js');
    fs.writeFileSync(config, `hooks:\n  pre_tool_call:\n    - command: user-hook\n  pre_llm_call:\n    - command: ${legacyHook}\nunrelated: keep\n`);
    fs.writeFileSync(allowlist, `${JSON.stringify({ approvals: [{ event: 'pre_tool_call', command: 'user-hook' }, { event: 'pre_llm_call', command: legacyHook }] }, null, 2)}\n`);
    const env = { ...process.env, HOME: home, HERMES_CONFIG: config, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable };
    const script = path.join(ROOT, 'runtimes', 'hermes', 'setup.sh');
    runSetup(script, env); const firstConfig = fs.readFileSync(config, 'utf8'); const firstAllowlist = fs.readFileSync(allowlist, 'utf8'); runSetup(script, env); assert.equal(fs.readFileSync(config, 'utf8'), firstConfig); assert.equal(fs.readFileSync(allowlist, 'utf8'), firstAllowlist);
    assert.match(firstConfig, new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); const approvals = JSON.parse(firstAllowlist).approvals; const approval = approvals.find((item) => item.command === hook); assert.equal(approval.event, 'pre_llm_call'); assert.ok(approval.script_mtime_at_approval);
    fs.rmSync(stable, { recursive: true, force: true });
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.doesNotMatch(fs.readFileSync(config, 'utf8'), new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); const remaining = JSON.parse(fs.readFileSync(allowlist, 'utf8')).approvals; assert.deepEqual(remaining, [{ event: 'pre_tool_call', command: 'user-hook' }]); assert.match(fs.readFileSync(config, 'utf8'), /pre_tool_call/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Claude setup merges both jarvOS lifecycle hooks without replacing user hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-hook-setup-'));
  const settings = path.join(temp, 'settings.json');
  const desktop = path.join(temp, 'desktop.json');
  const staged = path.join(temp, 'staged-public');
  const stable = path.join(temp, 'managed-harness-bin');
  try {
    fs.mkdirSync(path.join(staged, 'runtimes', 'claude'), { recursive: true });
    fs.mkdirSync(stable, { recursive: true, mode: 0o700 }); fs.chmodSync(stable, 0o700);
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js', 'jarvos-precompact-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'claude', file), path.join(staged, 'runtimes', 'claude', file));
    fs.writeFileSync(path.join(stable, 'jarvos-stewardship-dispatcher'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(path.join(stable, 'jarvos-stewardship-dispatcher'), 0o700);
    fs.writeFileSync(settings, `${JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'user-session-start' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-prompt-submit' }] }],
      },
    }, null, 2)}\n`, 'utf8');
    const existingSettings = JSON.parse(fs.readFileSync(settings, 'utf8'));
    existingSettings.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command: `node ${JSON.stringify(path.join(staged, 'runtimes', 'claude', 'jarvos-session-start-hook.js'))}` }] });
    existingSettings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: `node ${JSON.stringify(path.join(staged, 'runtimes', 'claude', 'jarvos-session-turn-hook.js'))}` }] });
    fs.writeFileSync(settings, `${JSON.stringify(existingSettings, null, 2)}\n`);
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'),
      CLAUDE_SETTINGS: settings,
      CLAUDE_DESKTOP_CONFIG: desktop,
      JARVOS_SKIP_CLAUDE_CODE_MCP: '1',
      JARVOS_SKIP_CLAUDE_MD: '1',
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
      JARVOS_STEWARDSHIP_STABLE_ROOT: stable,
    };
    const script = path.join(ROOT, 'runtimes', 'claude', 'setup.sh');
    runSetup(script, env);
    const first = fs.readFileSync(settings, 'utf8');
    runSetup(script, env);
    const second = fs.readFileSync(settings, 'utf8');
    const parsed = JSON.parse(second);
    assert.equal(first, second);
    assert.equal(parsed.hooks.SessionStart.length, 2);
    assert.equal(parsed.hooks.UserPromptSubmit.length, 2);
    // A managed install registers no PreCompact hook: the dispatcher's v1 action
    // ABI has no compaction action and rejects unknown ones with exit 1 and empty
    // stdout, which on a block/allow channel would block compaction outright.
    assert.equal(parsed.hooks.PreCompact, undefined);
    assert.equal(parsed.hooks.SessionStart[1].matcher, 'startup|resume|compact');
    assert.equal(count(second, /jarvos-stewardship-dispatcher/g), 2);
    assert.doesNotMatch(second, /jarvos-(?:session-(?:start|turn)|precompact)-hook\.js/);
    assert.match(second, /user-session-start/);
    assert.match(second, /user-prompt-submit/);
    assert.match(second, new RegExp(stable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(second, /--harness claude --action session-start/);
    assert.match(second, /--harness claude --action session-turn/);
    // No compaction action may reach the dispatcher -- it is not on the v1 ABI.
    assert.doesNotMatch(second, /--action session-precompact/);
    for (const action of second.matchAll(/--action ([a-z-]+)/g)) {
      assert.ok(STEWARDSHIP_ACTIONS.includes(action[1]), `managed hook uses off-ABI action: ${action[1]}`);
    }
    assert.doesNotMatch(second, new RegExp(staged.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(second, new RegExp(`${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/runtimes/claude/jarvos-session`));
    assert.equal(fs.readdirSync(temp).filter((name) => name.startsWith('settings.json.bak-jarvos-')).length, 1);
    assert.equal(fs.existsSync(desktop), false);
    fs.rmSync(stable, { recursive: true, force: true });
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(rolledBack.hooks.SessionStart.length, 1);
    assert.equal(rolledBack.hooks.UserPromptSubmit.length, 1);
    assert.equal(rolledBack.hooks.PreCompact, undefined);
    assert.match(JSON.stringify(rolledBack), /user-session-start/);
    assert.match(JSON.stringify(rolledBack), /user-prompt-submit/);
    assert.doesNotMatch(JSON.stringify(rolledBack), /jarvos-stewardship-dispatcher/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude setup injects a private bridge command environment without retaining a context-file path', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-bridge-setup-'));
  const settings = path.join(temp, 'settings.json'); const desktop = path.join(temp, 'desktop.json'); const staged = path.join(temp, 'staged-public');
  const bin = path.join(temp, "bridge's-bin"); const mapRoot = path.join(temp, "claude's-map"); const contextFile = path.join(temp, 'private-context.json');
  try {
    fs.mkdirSync(bin, { mode: 0o700 }); fs.chmodSync(bin, 0o700);
    fs.mkdirSync(mapRoot, { mode: 0o700 }); fs.chmodSync(mapRoot, 0o700);
    fs.writeFileSync(contextFile, '{"private":"context"}\n', { mode: 0o600 }); fs.chmodSync(contextFile, 0o600);
    const bridge = path.join(bin, 'jarvos-stewardship-bridge');
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      'state=none',
      '[ "$JARVOS_STEWARDSHIP_BRIDGE_COMMAND" = "jarvos-stewardship-bridge" ] && state=command',
      `[ "$JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT" = ${JSON.stringify(mapRoot)} ] && state=map`,
      `[ "$JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID" = "${CLAUDE_HOOK_SESSION_ID}" ] && state=session`,
      '[ "$state" = "session" ] && state=ready',
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' \"{\\\"available\\\":true,\\\"pendingInSessionInput\\\":true,\\\"prompt\\\":\\\"Bridge configuration $state.\\\",\\\"choices\\\":[\\\"Wait\\\",\\\"Prepare a dry run\\\"],\\\"default\\\":\\\"Wait\\\",\\\"correlation\\\":\\\"configured-42\\\"}\"",
      'else',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":false}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o700 });
    fs.chmodSync(bridge, 0o700);
    const env = {
      ...process.env, HOME: path.join(temp, 'home'), CLAUDE_SETTINGS: settings, CLAUDE_DESKTOP_CONFIG: desktop,
      JARVOS_SKIP_CLAUDE_CODE_MCP: '1', JARVOS_SKIP_CLAUDE_MD: '1', JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT: mapRoot, JARVOS_STEWARDSHIP_BRIDGE_PATH: bin,
    };
    runSetup(path.join(ROOT, 'runtimes', 'claude', 'setup.sh'), env);
    const configured = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const command = configured.hooks.SessionStart[0].hooks[0].command;
    const turnCommand = configured.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.match(command, /JARVOS_STEWARDSHIP_BRIDGE_COMMAND='jarvos-stewardship-bridge'/);
    assert.match(turnCommand, /JARVOS_STEWARDSHIP_BRIDGE_COMMAND='jarvos-stewardship-bridge'/);
    assert.match(command, /JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT=/);
    assert.match(command, /PATH=/);
    assert.doesNotMatch(JSON.stringify(configured), new RegExp(contextFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: ROOT, encoding: 'utf8', input: JSON.stringify({ session_id: CLAUDE_HOOK_SESSION_ID, hook_event_name: 'SessionStart' }),
      env: { PATH: process.env.PATH || '', HOME: path.join(temp, 'clean-home') },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    // Run the generated command through sh rather than matching raw path text:
    // apostrophes are intentionally represented as shell quote boundaries.
    assert.match(output.hookSpecificOutput.additionalContext, /Bridge configuration ready\./);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(contextFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude setup rollback removes only the managed command from a mixed hook entry', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-hook-rollback-'));
  const settings = path.join(temp, 'settings.json'); const desktop = path.join(temp, 'desktop.json'); const staged = path.join(temp, 'staged-public');
  const userCommand = 'node "/user/hooks/jarvos-session-start-hook.js"';
  try {
    fs.writeFileSync(settings, `${JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [
      { type: 'command', command: userCommand },
      { type: 'command', command: `node ${JSON.stringify(path.join(staged, 'runtimes', 'claude', 'jarvos-session-start-hook.js'))}` },
    ] }] } }, null, 2)}\n`);
    const env = { ...process.env, HOME: path.join(temp, 'home'), CLAUDE_SETTINGS: settings, CLAUDE_DESKTOP_CONFIG: desktop, JARVOS_SKIP_CLAUDE_CODE_MCP: '1', JARVOS_SKIP_CLAUDE_MD: '1', JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged };
    const script = path.join(ROOT, 'runtimes', 'claude', 'setup.sh');
    runSetup(script, env);
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.deepEqual(rolledBack.hooks.SessionStart, [{ matcher: 'startup', hooks: [{ type: 'command', command: userCommand }] }]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex setup merges both jarvOS lifecycle hooks without replacing user hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-hook-setup-'));
  const bin = path.join(temp, 'bin');
  const config = path.join(temp, 'config.toml');
  const staged = path.join(temp, 'staged-public');
  try {
    const stable = prepareStableStewardshipBundle(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'codex'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'codex', file), path.join(staged, 'runtimes', 'codex', file));
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, [
      '#!/usr/bin/env sh',
      'if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi',
      'exit 0',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(codex, 0o755);
    fs.writeFileSync(config, [
      '[hooks]',
      'SessionStart = [{ matcher = "startup", hooks = [{ type = "command", command = "user-session-start" }] }]',
      'UserPromptSubmit = [{ hooks = [{ type = "command", command = "user-prompt-submit" }] }]',
      '',
      '[shell_environment_policy]',
      'set = { EXISTING = "keep" }',
      '',
      '[unrelated]',
      'value = true',
      '',
    ].join('\n'), 'utf8');
    let prior = fs.readFileSync(config, 'utf8');
    prior = prior.replace('SessionStart = [', `SessionStart = [{ matcher = "startup", hooks = [{ type = "command", command = ${JSON.stringify(`node ${JSON.stringify(path.join(staged, 'runtimes', 'codex', 'jarvos-session-start-hook.js'))}`)}, async = false, timeout = 30 }] }, `);
    prior = prior.replace('UserPromptSubmit = [', `UserPromptSubmit = [{ hooks = [{ type = "command", command = ${JSON.stringify(`node ${JSON.stringify(path.join(staged, 'runtimes', 'codex', 'jarvos-session-turn-hook.js'))}`)}, async = false, timeout = 30 }] }, `);
    fs.writeFileSync(config, prior);
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'),
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      CODEX_CONFIG: config,
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
      JARVOS_STEWARDSHIP_STABLE_ROOT: stable,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: path.join(temp, 'codex-session-map'),
    };
    const script = path.join(ROOT, 'runtimes', 'codex', 'setup.sh');
    runSetup(script, env);
    const first = fs.readFileSync(config, 'utf8');
    runSetup(script, env);
    const second = fs.readFileSync(config, 'utf8');
    assert.equal(first, second);
    assert.equal(count(second, /^\[hooks\]$/gm), 1);
    assert.equal(count(second, /jarvos-stewardship-dispatcher/g), 2);
    assert.match(second, /matcher = "startup\|resume"/);
    assert.match(second, /user-session-start/);
    assert.match(second, /user-prompt-submit/);
    assert.match(second, /EXISTING = "keep"/);
    assert.match(second, /JARVOS_STEWARDSHIP_BRIDGE_COMMAND = "jarvos-stewardship-bridge"/);
    assert.match(second, /JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT = ".*codex-session-map"/);
    assert.doesNotMatch(second, /JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE/);
    assert.match(second, new RegExp(stable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(second, /--harness codex --action session-start/);
    assert.match(second, /--harness codex --action session-turn/);
    assert.doesNotMatch(second, new RegExp(staged.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(second, new RegExp(`${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/runtimes/codex/jarvos-session`));
    assert.match(second, /\[unrelated\]\nvalue = true/);
    assert.equal(fs.readdirSync(temp).filter((name) => name.startsWith('config.toml.bak-jarvos-')).length, 1);
    const withoutBridge = { ...env };
    delete withoutBridge.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    delete withoutBridge.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT;
    runSetup(script, withoutBridge);
    assert.equal(fs.readFileSync(config, 'utf8'), second);
    fs.rmSync(stable, { recursive: true, force: true });
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = fs.readFileSync(config, 'utf8');
    assert.doesNotMatch(rolledBack, /jarvos-stewardship-dispatcher/);
    assert.doesNotMatch(rolledBack, /JARVOS_STEWARDSHIP_(?:BRIDGE_COMMAND|CODEX_SESSION_MAP_ROOT)/);
    assert.match(rolledBack, /EXISTING = "keep"/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex setup shell-quotes a stable dispatcher path before persisting hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-dispatcher-quote-'));
  const bin = path.join(temp, 'bin'); const config = path.join(temp, 'config.toml'); const capture = path.join(temp, 'captured-argv');
  try {
    const stable = prepareStableStewardshipBundle(temp, "managed's-$JARVOS_STEWARDSHIP_QUOTE_TEST-bin");
    const dispatcher = path.join(stable, 'jarvos-stewardship-dispatcher');
    fs.writeFileSync(dispatcher, '#!/usr/bin/env sh\nprintf "%s\\n" "$0" "$@" > "$JARVOS_CAPTURE"\n', { mode: 0o700 });
    fs.chmodSync(dispatcher, 0o700);
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/usr/bin/env sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(codex, 0o755);
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'), PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      CODEX_CONFIG: config, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STEWARDSHIP_STABLE_ROOT: stable, JARVOS_CAPTURE: capture, JARVOS_STEWARDSHIP_QUOTE_TEST: 'expanded',
    };
    runSetup(path.join(ROOT, 'runtimes', 'codex', 'setup.sh'), env);
    const commands = [...fs.readFileSync(config, 'utf8').matchAll(/command = ("(?:\\.|[^"\\])*")/g)].map((match) => JSON.parse(match[1]));
    const startCommand = commands.find((command) => command.endsWith('--action session-start'));
    assert.ok(startCommand);
    assert.equal(spawnSync('/bin/sh', ['-c', startCommand], { encoding: 'utf8', env }).status, 0);
    assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), [dispatcher, '--harness', 'codex', '--action', 'session-start']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex setup repairs the nested shell environment table without losing user variables', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-nested-environment-'));
  const bin = path.join(temp, 'bin');
  const codexHome = path.join(temp, 'codex-home');
  const config = path.join(codexHome, 'config.toml');
  const staged = path.join(temp, 'staged-public');
  try {
    const stable = prepareStableStewardshipBundle(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'codex'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'codex', file), path.join(staged, 'runtimes', 'codex', file));
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(config, [
      '[hooks]',
      'SessionStart = [{ hooks = [{ type = "command", command = "user-session-start" }] }]',
      '',
      '[shell_environment_policy.set]',
      'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
      'NODE_REPL_TRUSTED_CODE_PATHS = "/trusted/code"',
      '',
      // This is the real drift shape: a nested table plus a stale inline set.
      '[shell_environment_policy]',
      'set = { JARVOS_STEWARDSHIP_BRIDGE_COMMAND = "old-bridge", JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT = "/old/map" } # Preserve this trailing user note.',
      '# Keep this note for the person maintaining the environment policy.',
      '',
      '[unrelated]',
      'value = true',
      '',
    ].join('\n'), 'utf8');
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'),
      CODEX_HOME: codexHome,
      CODEX_CONFIG: config,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
      JARVOS_STEWARDSHIP_STABLE_ROOT: stable,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: path.join(temp, 'codex-session-map'),
    };
    const script = path.join(ROOT, 'runtimes', 'codex', 'setup.sh');
    runSetup(script, env);
    const configured = fs.readFileSync(config, 'utf8');
    assert.equal(count(configured, /^\[shell_environment_policy\.set\]$/gm), 1);
    assert.equal(count(configured, /^\[shell_environment_policy\]$/gm), 0);
    assert.doesNotMatch(configured, /^set\s*=/m);
    assert.match(configured, /BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"/);
    assert.match(configured, /NODE_REPL_TRUSTED_CODE_PATHS = "\/trusted\/code"/);
    assert.match(configured, /JARVOS_STEWARDSHIP_BRIDGE_COMMAND = "jarvos-stewardship-bridge"/);
    assert.match(configured, /JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT = ".*codex-session-map"/);
    assert.match(configured, /# Keep this note for the person maintaining the environment policy\./);
    assert.match(configured, /# Preserve this trailing user note\./);
    assertCodexParsesConfig(config);

    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = fs.readFileSync(config, 'utf8');
    assert.equal(count(rolledBack, /^\[shell_environment_policy\.set\]$/gm), 1);
    assert.equal(count(rolledBack, /^\[shell_environment_policy\]$/gm), 0);
    assert.doesNotMatch(rolledBack, /^set\s*=/m);
    assert.doesNotMatch(rolledBack, /JARVOS_STEWARDSHIP_(?:BRIDGE_COMMAND|CODEX_SESSION_MAP_ROOT|BRIDGE_CONTEXT_FILE)/);
    assert.match(rolledBack, /BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"/);
    assert.match(rolledBack, /NODE_REPL_TRUSTED_CODE_PATHS = "\/trusted\/code"/);
    assert.match(rolledBack, /\[unrelated\]\nvalue = true/);
    assert.match(rolledBack, /# Keep this note for the person maintaining the environment policy\./);
    assert.match(rolledBack, /# Preserve this trailing user note\./);
    assertCodexParsesConfig(config);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex stewardship setup migrates legacy hooks.json without losing unrelated hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-hooks-migration-'));
  const bin = path.join(temp, 'bin');
  const home = path.join(temp, 'home');
  const codexHome = path.join(temp, 'codex-home');
  const config = path.join(codexHome, 'config.toml');
  const hooksJson = path.join(codexHome, 'hooks.json');
  const staged = path.join(temp, 'staged-public');
  try {
    const stable = prepareStableStewardshipBundle(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'codex'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'codex', file), path.join(staged, 'runtimes', 'codex', file));
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/usr/bin/env sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(codex, 0o755);
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(config, [
      '[hooks]',
      'PreToolUse = [{ matcher = "Bash", hooks = [{ timeout = 9, command = "dcg --check", type = "command", async = true }] }]',
      'UserPromptSubmit = [{ hooks = [{ type = "command", command = "model-routing" }] }]',
      '',
      '[unrelated]',
      'value = true',
      '',
    ].join('\n'), 'utf8');
    const originalConfig = fs.readFileSync(config, 'utf8');
    const originalHooks = JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'dcg --check', async: true, timeout: 9 }] }],
      SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'unrelated-session-hook', timeout: 12 }] }],
    } }, null, 2);
    fs.writeFileSync(hooksJson, `${originalHooks}\n`, { mode: 0o600 });
    fs.chmodSync(hooksJson, 0o600);
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
      JARVOS_STEWARDSHIP_STABLE_ROOT: stable,
    };
    const script = path.join(ROOT, 'runtimes', 'codex', 'setup.sh');
    runSetup(script, env);
    const first = fs.readFileSync(config, 'utf8');
    assert.equal(fs.existsSync(hooksJson), false);
    assert.equal(count(first, /dcg --check/g), 1);
    assert.equal(count(first, /jarvos-stewardship-dispatcher/g), 2);
    assert.match(first, /model-routing/);
    assert.match(first, /unrelated-session-hook/);
    assert.match(first, /\[unrelated\]\nvalue = true/);
    const configBackups = fs.readdirSync(codexHome).filter((name) => name.startsWith('config.toml.bak-jarvos-'));
    const hooksBackups = fs.readdirSync(codexHome).filter((name) => name.startsWith('hooks.json.bak-jarvos-'));
    assert.equal(configBackups.length, 1);
    assert.equal(hooksBackups.length, 1);
    assert.equal(fs.readFileSync(path.join(codexHome, configBackups[0]), 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(path.join(codexHome, hooksBackups[0]), 'utf8'), `${originalHooks}\n`);
    assert.equal(fs.statSync(path.join(codexHome, hooksBackups[0])).mode & 0o777, 0o600);
    runSetup(script, env);
    assert.equal(fs.readFileSync(config, 'utf8'), first);
    assert.equal(fs.readdirSync(codexHome).filter((name) => name.startsWith('hooks.json.bak-jarvos-')).length, 1);
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = fs.readFileSync(config, 'utf8');
    assert.doesNotMatch(rolledBack, /jarvos-session-(?:start|turn)-hook\.js/);
    assert.match(rolledBack, /dcg --check/);
    assert.match(rolledBack, /model-routing/);
    assert.equal(fs.existsSync(hooksJson), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex hooks migration fails closed for malformed legacy hooks.json', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-hooks-malformed-'));
  const bin = path.join(temp, 'bin');
  const codexHome = path.join(temp, 'codex-home');
  const config = path.join(codexHome, 'config.toml');
  const hooksJson = path.join(codexHome, 'hooks.json');
  const staged = path.join(temp, 'staged-public');
  try {
    const stable = prepareStableStewardshipBundle(temp);
    fs.mkdirSync(path.join(staged, 'runtimes', 'codex'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'codex', file), path.join(staged, 'runtimes', 'codex', file));
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(codex, 0o755);
    fs.mkdirSync(codexHome, { recursive: true });
    const originalConfig = '[hooks]\nPreToolUse = [{ hooks = [{ type = "command", command = "keep-me" }] }]\n';
    const originalHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":{"unsupported":true}}]}]}}\n';
    fs.writeFileSync(config, originalConfig);
    fs.writeFileSync(hooksJson, originalHooks);
    const result = runSetupResult(path.join(ROOT, 'runtimes', 'codex', 'setup.sh'), {
      ...process.env,
      HOME: path.join(temp, 'home'),
      CODEX_HOME: codexHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
      JARVOS_STEWARDSHIP_STABLE_ROOT: stable,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing Codex hook migration/);
    assert.equal(fs.readFileSync(config, 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(hooksJson, 'utf8'), originalHooks);
    assert.deepEqual(fs.readdirSync(codexHome).filter((name) => name.includes('.bak-jarvos-')), []);

    const multilineConfig = '[hooks]\nPreToolUse = [\n  { hooks = [{ type = "command", command = "keep-me" }] }\n]\n';
    const validHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"dcg --check"}]}]}}\n';
    fs.writeFileSync(config, multilineConfig);
    fs.writeFileSync(hooksJson, validHooks);
    const multilineResult = runSetupResult(path.join(ROOT, 'runtimes', 'codex', 'setup.sh'), {
      ...process.env,
      HOME: path.join(temp, 'home'), CODEX_HOME: codexHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repository', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_STEWARDSHIP_STABLE_ROOT: stable,
    });
    assert.notEqual(multilineResult.status, 0);
    assert.match(multilineResult.stderr, /one-line inline-array/);
    assert.equal(fs.readFileSync(config, 'utf8'), multilineConfig);
    assert.equal(fs.readFileSync(hooksJson, 'utf8'), validHooks);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
