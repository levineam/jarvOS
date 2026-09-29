'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  CANDIDATE_ROOTS_ENV,
  COLLECT_ENABLED_ENV,
  COLLECT_TRIGGER_ENV,
  DURABLE_WORK_COLLECT_CONTRACT,
  collectTrigger,
  decodeCandidateRoots,
  encodeCandidateRoots,
  extractCandidateRoots,
  unavailableCollectResponse,
  validateCollectResponse,
} = require('../src/durable-work-collect.js');
const {
  OPTIONAL_STEWARDSHIP_ACTIONS,
  STEWARDSHIP_ACTIONS,
  validateStewardshipBootstrap,
} = require('../src/stewardship-bootstrap.js');
const { checkDispatcher } = require('../src/dispatcher-conformance.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLAUDE_SESSION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const CODEX_SESSION_ID = '019fbf11-8aca-79c0-981e-15abcd2392f4';
const KEY = `dwe_${'a'.repeat(32)}`;
const INV = `inv_${'b'.repeat(32)}`;

function collected(overrides = {}) {
  return {
    contract: DURABLE_WORK_COLLECT_CONTRACT,
    status: 'collected',
    trigger: 'post_tool_use',
    invocationRef: INV,
    causalKeys: [KEY],
    admitted: 1,
    deduped: 0,
    unattributed: 0,
    rejected: 0,
    receiptDigest: 'c'.repeat(64),
    ...overrides,
  };
}

function cleanEnv(overrides = {}) {
  const base = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^JARVOS_/.test(key) && key !== 'CODEX_THREAD_ID') base[key] = value;
  return { ...base, ...overrides };
}

test('collect responses are exact, metadata-only, and bounded', () => {
  assert.deepEqual(validateCollectResponse(collected()), { ok: true, errors: [] });
  assert.equal(validateCollectResponse(unavailableCollectResponse('stop')).ok, true);
  assert.equal(validateCollectResponse({ ...collected(), path: '/tmp/repo' }).ok, false);
  assert.equal(validateCollectResponse(collected({ causalKeys: ['git commit -m secret'] })).ok, false);
  assert.equal(validateCollectResponse(collected({ causalKeys: [KEY, KEY] })).ok, false);
  assert.equal(validateCollectResponse(collected({ invocationRef: 'raw-nonce' })).ok, false);
  assert.equal(validateCollectResponse(collected({ receiptDigest: null })).ok, false);
  assert.equal(validateCollectResponse(collected({ admitted: -1 })).ok, false);
  assert.equal(validateCollectResponse(collected({ trigger: 'PostToolUse' })).ok, false);
  assert.equal(validateCollectResponse({ ...unavailableCollectResponse(), causalKeys: [KEY] }).ok, false);
});

test('candidate roots come only from explicit absolute targets and the harness cwd', () => {
  const input = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    cwd: '/work/scratch',
    tool_input: { command: 'cd /work/fx-alpha && git commit -m "fix: token=abc" && git -C "/work/fx-shared" log -1 && cd relative && cd ~/home && cd $HOME/x && cd /work/../etc' },
  };
  assert.deepEqual(extractCandidateRoots(input), ['/work/fx-alpha', '/work/fx-shared', '/work/scratch']);
  const encoded = encodeCandidateRoots(extractCandidateRoots(input));
  assert.equal(encoded.includes('commit'), false);
  assert.equal(encoded.includes('token'), false);
  assert.deepEqual(decodeCandidateRoots(encoded), ['/work/fx-alpha', '/work/fx-shared', '/work/scratch']);
  assert.deepEqual(decodeCandidateRoots('not json'), []);
  assert.deepEqual(decodeCandidateRoots(JSON.stringify(['relative', '/a/../b', '/ok'])), ['/ok']);
  assert.deepEqual(extractCandidateRoots({ cwd: 'relative' }), []);
  assert.equal(extractCandidateRoots({ tool_input: { command: Array.from({ length: 10 }, (_, i) => `cd /r${i}`).join(' && ') } }).length, 4);
});

test('only Stop, turn boundaries, and git-shaped Bash tool calls trigger collection', () => {
  assert.equal(collectTrigger({ hook_event_name: 'Stop' }), 'stop');
  assert.equal(collectTrigger({ hook_event_name: 'UserPromptSubmit' }), 'turn_boundary');
  assert.equal(collectTrigger({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }), 'post_tool_use');
  assert.equal(collectTrigger({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cd /r && gh pr merge 4' } }), 'post_tool_use');
  assert.equal(collectTrigger({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'jarvos-durable-work-mark deployment_ready' } }), 'post_tool_use');
  assert.equal(collectTrigger({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } }), null);
  assert.equal(collectTrigger({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { command: 'git commit' } }), null);
  assert.equal(collectTrigger({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit' } }), null);
  assert.equal(collectTrigger(null), null);
});

test('session-event is optional and never changes the ordered required action ABI', () => {
  assert.deepEqual(OPTIONAL_STEWARDSHIP_ACTIONS, ['session-event']);
  assert.equal(STEWARDSHIP_ACTIONS.includes('session-event'), false);
  const claude = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'claude', 'adapter.json'), 'utf8')).stewardshipAdapter.bootstrap;
  assert.deepEqual(claude.actions, STEWARDSHIP_ACTIONS);
  assert.deepEqual(claude.optionalActions, ['session-event']);
  assert.equal(validateStewardshipBootstrap(claude, 'claude').ok, true);
  assert.equal(validateStewardshipBootstrap({ ...claude, optionalActions: ['session-event', 'session-event'] }, 'claude').ok, false);
  assert.equal(validateStewardshipBootstrap({ ...claude, optionalActions: ['harness-launch'] }, 'claude').ok, false);
  assert.equal(validateStewardshipBootstrap({ ...claude, actions: [...STEWARDSHIP_ACTIONS, 'session-event'] }, 'claude').ok, false);
});

test('a dispatcher advertising the optional action still passes the required-ABI conformance check', () => {
  const receipt = JSON.stringify({ schema: 'jarvos.managed-harness-dispatcher/v1', action: 'provenance-probe', actions: [...STEWARDSHIP_ACTIONS, 'session-event'] });
  const spawn = (_bin, args) => (args.includes('provenance-probe') ? { status: 0, stdout: receipt } : { status: 1, stdout: '' });
  const result = checkDispatcher('/fake/dispatcher', { spawn });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.receipt.actions.includes('session-event'));
});

function stubSpawn(result) {
  const calls = [];
  const impl = (command, args, opts) => { calls.push({ command, args, opts }); return result; };
  impl.calls = calls;
  return impl;
}

test('Claude session-event hook calls the bridge once with bounded roots and never forwards command text', () => {
  const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-event-hook.js'));
  const impl = stubSpawn({ status: 0, stdout: JSON.stringify(collected()) });
  const input = {
    hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: CLAUDE_SESSION_ID, cwd: '/work/scratch',
    tool_input: { command: 'cd /work/fx-alpha && git commit -m "private subject"' },
    tool_response: { stdout: '[main 1234567] private subject' },
  };
  const result = hook.collect(input, { env: cleanEnv({ JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'fake-bridge' }), spawnSyncImpl: impl });
  assert.equal(result.collected, true);
  assert.equal(impl.calls.length, 1);
  const call = impl.calls[0];
  assert.deepEqual(call.args, ['durableWorkCollect']);
  assert.equal(call.opts.timeout, 2000);
  assert.equal(call.opts.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID, CLAUDE_SESSION_ID);
  assert.equal(call.opts.env[COLLECT_TRIGGER_ENV], 'post_tool_use');
  assert.deepEqual(JSON.parse(call.opts.env[CANDIDATE_ROOTS_ENV]), ['/work/fx-alpha', '/work/scratch']);
  assert.equal(JSON.stringify(call.opts.env).includes('private subject'), false);
  assert.equal(JSON.stringify(call.args).includes('commit'), false);
});

test('Claude session-event hook fails open and skips non-durable events', () => {
  const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-event-hook.js'));
  const env = cleanEnv({ JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'fake-bridge' });
  const base = { hook_event_name: 'Stop', session_id: CLAUDE_SESSION_ID, cwd: '/work/fx-alpha' };
  for (const bad of [{ status: 1, stdout: '' }, { status: 0, stdout: 'not json' }, { status: 0, stdout: JSON.stringify({ ...collected(), prompt: 'x' }) }, { status: null, error: new Error('ETIMEDOUT') }]) {
    const impl = stubSpawn(bad);
    assert.equal(hook.collect(base, { env, spawnSyncImpl: impl }).collected, false);
    assert.equal(impl.calls.length, 1, 'no retry');
  }
  const none = stubSpawn({ status: 0, stdout: '{}' });
  assert.equal(hook.collect({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { env, spawnSyncImpl: none }).reason, 'not-a-collect-event');
  assert.equal(hook.collect({ ...base, session_id: 'not-a-session' }, { env, spawnSyncImpl: none }).reason, 'session-unavailable');
  assert.equal(hook.collect({ ...base, cwd: undefined }, { env, spawnSyncImpl: none }).reason, 'no-candidate-root');
  assert.equal(hook.collect(base, { env: cleanEnv(), spawnSyncImpl: none }).reason, 'bridge-not-configured');
  assert.equal(none.calls.length, 0);

  const result = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-event-hook.js')], {
    encoding: 'utf8', input: JSON.stringify(base), env: cleanEnv({ JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'definitely-not-on-path-bridge' }),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '{}');
  const garbage = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-event-hook.js')], { encoding: 'utf8', input: '{not json' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout.trim(), '{}');
});

function withBridge(handler, fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-durable-collect-hook-'));
  const bin = path.join(temp, 'bin');
  const calls = path.join(temp, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'jarvos-stewardship-bridge'), [
    '#!/usr/bin/env sh',
    `printf '%s|%s|%s\\n' "$1" "\${${COLLECT_TRIGGER_ENV}:-}" "\${${CANDIDATE_ROOTS_ENV}:-}" >> ${JSON.stringify(calls)}`,
    `if [ "$1" = durableWorkCollect ]; then printf '%s\\n' '${JSON.stringify(handler)}'; exit 0; fi`,
    'if [ "$1" = projectsContextRefresh ]; then printf \'%s\\n\' \'{"contract":"jarvos.projects-context-refresh/v1","status":"unavailable","stamp":null,"stampDigest":null,"fingerprint":null,"markdown":null}\'; exit 0; fi',
    'printf \'%s\\n\' \'{"available":true,"pendingInSessionInput":false}\'',
    '',
  ].join('\n'), { mode: 0o755 });
  try { return fn({ temp, bin, calls }); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function runCodexTurn(env, input) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-turn-hook.js')], {
    cwd: ROOT, encoding: 'utf8', env, input: JSON.stringify(input),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout || '{}');
}

test('Codex collects at the automatic UserPromptSubmit boundary only when the host enables it', () => {
  withBridge(collected({ trigger: 'turn_boundary' }), ({ bin, calls }) => {
    const input = { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SESSION_ID, cwd: '/work/fx-worktree', prompt: 'closing turn: private words' };
    const env = cleanEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge', CODEX_THREAD_ID: CODEX_SESSION_ID });

    assert.deepEqual(runCodexTurn(env, input), {});
    assert.equal(fs.readFileSync(calls, 'utf8').includes('durableWorkCollect'), false, 'collection is opt-in');

    fs.rmSync(calls, { force: true });
    assert.deepEqual(runCodexTurn({ ...env, [COLLECT_ENABLED_ENV]: '1' }, input), {}, 'collection never injects context');
    const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
    const collect = lines.filter((line) => line.startsWith('durableWorkCollect|'));
    assert.equal(collect.length, 1);
    assert.equal(collect[0], `durableWorkCollect|turn_boundary|${JSON.stringify(['/work/fx-worktree'])}`);
    assert.equal(fs.readFileSync(calls, 'utf8').includes('private words'), false);
    assert.ok(lines.some((line) => line.startsWith('projectsContextRefresh|')), 'the ordinary refresh still runs');
  });
});

test('Codex collection failure never blocks or changes the turn output', () => {
  withBridge({ bogus: true }, ({ bin }) => {
    const env = cleanEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge', CODEX_THREAD_ID: CODEX_SESSION_ID, [COLLECT_ENABLED_ENV]: '1' });
    assert.deepEqual(runCodexTurn(env, { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SESSION_ID, cwd: '/work/fx-alpha' }), {});
    assert.deepEqual(runCodexTurn(env, { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SESSION_ID }), {});
  });
  const hook = require(path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-turn-hook.js'));
  assert.equal(hook.durableWorkCollect({ env: { CODEX_THREAD_ID: CODEX_SESSION_ID }, hookCwd: null }).reason, 'no-candidate-root');
  assert.equal(hook.BRIDGE_CAPABILITY_TIMEOUT_MS.durableWorkCollect, 2000);
});

test('Projects start/refresh calls carry only the harness cwd as a transient candidate root', () => {
  const claude = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-turn-hook.js'));
  const codex = require(path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-turn-hook.js'));
  assert.deepEqual(claude.projectsCandidateEnvironment({ cwd: '/work/fx-alpha', prompt: 'private' }), { [CANDIDATE_ROOTS_ENV]: JSON.stringify(['/work/fx-alpha']) });
  assert.deepEqual(claude.projectsCandidateEnvironment({ cwd: 'relative' }), {});
  assert.deepEqual(claude.projectsCandidateEnvironment(null), {});
  assert.deepEqual(codex.projectsCandidateEnvironment('/work/fx-worktree'), { [CANDIDATE_ROOTS_ENV]: JSON.stringify(['/work/fx-worktree']) });
  assert.deepEqual(codex.projectsCandidateEnvironment(undefined), {});

  const impl = stubSpawn({ status: 0, stdout: JSON.stringify({ contract: 'jarvos.projects-context-refresh/v1', status: 'unavailable', stamp: null, stampDigest: null, fingerprint: null, markdown: null }) });
  claude.projectsContextStart({ sessionId: CLAUDE_SESSION_ID, bridgeCommand: 'fake-bridge', spawnSyncImpl: impl, env: claude.projectsCandidateEnvironment({ cwd: '/work/fx-alpha' }) });
  assert.equal(impl.calls[0].opts.env[CANDIDATE_ROOTS_ENV], JSON.stringify(['/work/fx-alpha']));
});

function dispatcherScript(advertise) {
  const receipt = { schema: 'jarvos.managed-harness-dispatcher/v1', action: 'provenance-probe', actions: advertise };
  const known = advertise.filter((action) => action !== 'provenance-probe');
  return [
    '#!/usr/bin/env sh', 'action=""',
    'while [ $# -gt 0 ]; do case "$1" in --action) action="$2"; shift 2 ;; *) shift ;; esac; done',
    'case "$action" in',
    `  provenance-probe) printf '%s' '${JSON.stringify(receipt)}'; exit 0 ;;`,
    `  ${known.join('|')}) exit 0 ;;`,
    '  *) exit 1 ;;', 'esac', '',
  ].join('\n');
}

function runClaudeSetup(temp, advertise, extra = {}) {
  const stable = path.join(temp, 'managed-harness-bin');
  fs.mkdirSync(stable, { recursive: true, mode: 0o700 }); fs.chmodSync(stable, 0o700);
  if (advertise) {
    fs.writeFileSync(path.join(stable, 'jarvos-stewardship-dispatcher'), dispatcherScript(advertise), { mode: 0o700 });
    fs.chmodSync(path.join(stable, 'jarvos-stewardship-dispatcher'), 0o700);
  }
  const env = cleanEnv({
    HOME: path.join(temp, 'home'), CLAUDE_SETTINGS: path.join(temp, 'settings.json'), CLAUDE_DESKTOP_CONFIG: path.join(temp, 'desktop.json'),
    JARVOS_SKIP_CLAUDE_CODE_MCP: '1', JARVOS_SKIP_CLAUDE_MD: '1', JARVOS_STEWARDSHIP_ONLY: '1',
    JARVOS_MANAGED_REPOSITORIES: '/managed/repository', JARVOS_STEWARDSHIP_STABLE_ROOT: stable, ...extra,
  });
  const result = spawnSync('bash', [path.join(ROOT, 'runtimes', 'claude', 'setup.sh')], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'), 'utf8'));
}

test('Claude setup registers PostToolUse/Stop only when the dispatcher advertises session-event, and rollback removes only its entries', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-session-event-setup-'));
  try {
    fs.writeFileSync(path.join(temp, 'settings.json'), `${JSON.stringify({ hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'user-post-tool' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }],
    } }, null, 2)}\n`);
    const without = runClaudeSetup(temp, STEWARDSHIP_ACTIONS);
    assert.equal(without.hooks.PostToolUse.length, 1);
    assert.equal(without.hooks.Stop.length, 1);

    const withEvent = runClaudeSetup(temp, [...STEWARDSHIP_ACTIONS, 'session-event']);
    assert.equal(withEvent.hooks.PostToolUse.length, 2);
    assert.equal(withEvent.hooks.Stop.length, 2);
    const post = withEvent.hooks.PostToolUse[1];
    assert.equal(post.matcher, 'Bash');
    assert.match(post.hooks[0].command, /--harness claude --action session-event/);
    assert.match(post.hooks[0].command, /printf '%s' '\{\}'/, 'wrapped fail-open');
    assert.match(withEvent.hooks.Stop[1].hooks[0].command, /--action session-event/);
    const again = runClaudeSetup(temp, [...STEWARDSHIP_ACTIONS, 'session-event']);
    assert.deepEqual(again, withEvent, 'idempotent');

    const downgraded = runClaudeSetup(temp, STEWARDSHIP_ACTIONS);
    assert.equal(downgraded.hooks.PostToolUse.length, 1, 'a dispatcher that stops advertising loses the hook');

    runClaudeSetup(temp, [...STEWARDSHIP_ACTIONS, 'session-event']);
    fs.rmSync(path.join(temp, 'managed-harness-bin'), { recursive: true, force: true });
    const rolledBack = runClaudeSetup(temp, null, { JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.deepEqual(rolledBack.hooks.PostToolUse, [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'user-post-tool' }] }]);
    assert.deepEqual(rolledBack.hooks.Stop, [{ hooks: [{ type: 'command', command: 'user-stop' }] }]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
