'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCodexExecutable, manageGbrainPlugin } = require('../runtimes/codex/gbrain-plugin');

function fixture(t, initial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shell = path.join(root, 'bin', 'codex');
  const app = path.join(root, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex');
  for (const file of [shell, app]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  const source = { sourceType: 'git', source: 'https://github.com/garrytan/gbrain.git' };
  const state = { installed: false, marketplace: false, enabled: true, revision: 'a'.repeat(40), ...initial };
  const calls = [];
  const options = {
    env: { PATH: path.dirname(shell), CODEX_HOME: root }, platform: 'darwin',
    applicationRoots: [path.join(root, 'Applications')],
    spawnSyncImpl(command, args, opts) {
      calls.push({ command, args, opts });
      const success = (value = '') => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value) });
      if (command === 'git') return success(state.revision);
      if (args[0] === '--version') return success('codex-cli 0.153.4');
      if (command === shell && !state.shellCompatible) return { status: 1, stderr: 'unknown nested features' };
      if (args.includes('--help')) return success('help');
      const op = args.join(' ');
      if (state.fail === op) return { status: null, error: new Error('timeout') };
      if (op === 'plugin list --json') {
        if (state.malformed) return success('{broken');
        return success({ installed: [
          ...(state.installed ? [{ pluginId: 'gbrain@gbrain', installed: true, enabled: state.enabled, version: '1.0', source: { path: root }, marketplaceSource: source }] : []),
          ...(state.variant ? [{ pluginId: state.variant, installed: true, enabled: true }] : []),
        ] });
      }
      if (op === 'mcp list --json') return success([{ name: 'gbrain', enabled: !!state.manual || state.installed }]);
      if (op === '--disable plugins mcp list --json') return success([{ name: 'gbrain', enabled: !!state.manual }]);
      if (op === 'plugin marketplace list --json') return success({ marketplaces: state.marketplace ? [{ name: 'gbrain', marketplaceSource: state.foreign ? { sourceType: 'local', source: root } : source }] : [] });
      if (op === 'plugin marketplace add garrytan/gbrain@codex-plugin') state.marketplace = true;
      else if (op === 'plugin marketplace upgrade gbrain') state.revision = 'b'.repeat(40);
      else if (op === 'plugin add gbrain@gbrain') { state.installed = true; state.enabled = true; }
      else if (op === 'plugin remove gbrain@gbrain') state.installed = false;
      else throw new Error(`Unexpected command: ${op}`);
      return success();
    },
  };
  return { root, shell, app, state, calls, options };
}
const mutations = (f) => f.calls.filter(({ args }) => !args.includes('--help') && (args[1] === 'add' || args[1] === 'remove' || ['upgrade', 'add'].includes(args[2])));

test('actual-profile failure skips old PATH launcher without changing its bytes or environment', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.shell);
  const env = { ...f.options.env };
  const result = resolveCodexExecutable(f.options);
  assert.equal(result.executable, f.app);
  assert.equal(result.version, 'codex-cli 0.153.4');
  assert.equal(result.attempts[0].executable, f.shell);
  assert.deepEqual(fs.readFileSync(f.shell), before);
  assert.deepEqual(f.options.env, env);
  assert.equal(mutations(f).length, 0);
});

test('explicit executable is exclusive even when a compatible app exists', (t) => {
  const f = fixture(t);
  f.options.env.JARVOS_CODEX_EXECUTABLE = f.shell;
  assert.equal(resolveCodexExecutable(f.options).reason, 'configured-codex-incompatible');
  assert.ok(f.calls.every(({ command }) => command === f.shell));
  f.options.env.JARVOS_CODEX_EXECUTABLE = f.app;
  assert.equal(resolveCodexExecutable(f.options).executable, f.app);
  f.options.env.JARVOS_CODEX_EXECUTABLE = '/missing/codex';
  assert.equal(resolveCodexExecutable(f.options).reason, 'configured-codex-incompatible');
});

test('no eligible binary and malformed or timed-out profile probes fail usefully', (t) => {
  const f = fixture(t, { malformed: true });
  assert.equal(resolveCodexExecutable(f.options).reason, 'no-compatible-codex');
  f.state.malformed = false;
  f.state.fail = 'plugin list --json';
  assert.equal(resolveCodexExecutable(f.options).ok, false);
  for (const call of f.calls) assert.ok(call.opts.timeout > 0 && call.opts.maxBuffer <= 256 * 1024);
  assert.equal(resolveCodexExecutable({ ...f.options, env: { PATH: '.' }, platform: 'linux' }).reason, 'no-compatible-codex');
});

test('install uses the validated executable for every native mutation and records state', (t) => {
  const f = fixture(t);
  const result = manageGbrainPlugin('install', f.options);
  assert.equal(result.ok, true);
  assert.equal(result.before.installed, false);
  assert.equal(result.after.installed, true);
  assert.equal(result.after.nativeSession, 'not-proven');
  assert.deepEqual(mutations(f).map(({ args }) => args), [
    ['plugin', 'marketplace', 'add', 'garrytan/gbrain@codex-plugin'], ['plugin', 'add', 'gbrain@gbrain'],
  ]);
  assert.ok(mutations(f).every(({ command }) => command === f.app));
});

test('existing official marketplace is reused and disabled installation can be repaired', (t) => {
  const f = fixture(t, { marketplace: true });
  assert.equal(manageGbrainPlugin('install', f.options).ok, true);
  assert.equal(mutations(f).length, 1);
  f.state.enabled = false;
  assert.equal(manageGbrainPlugin('install', f.options).after.enabled, true);
});

test('manual or variant ownership conflicts cause no mutations, including other marketplaces', (t) => {
  for (const initial of [{ manual: true }, { variant: 'gbrain-coding@gbrain' }, { variant: 'gbrain@elsewhere' }]) {
    const f = fixture(t, initial);
    assert.equal(manageGbrainPlugin('install', f.options).reason, 'existing-gbrain-owner-conflict');
    assert.equal(mutations(f).length, 0);
  }
});

test('foreign marketplace cannot be adopted', (t) => {
  const f = fixture(t, { marketplace: true, foreign: true });
  assert.equal(manageGbrainPlugin('install', f.options).reason, 'existing-marketplace-source-conflict');
  assert.equal(mutations(f).length, 0);
});

test('doctor only reads and preserves unrelated profile content', (t) => {
  const f = fixture(t, { installed: true, marketplace: true });
  const config = path.join(f.root, 'config.toml');
  const bytes = '[features]\nunknown_nested = { enabled = true }\n';
  fs.writeFileSync(config, bytes);
  const result = manageGbrainPlugin('doctor', f.options);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'registered-not-live-proven');
  assert.ok(f.calls.some(({ args }) => args.join(' ') === '--disable plugins mcp list --json'));
  assert.equal(mutations(f).length, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), bytes);
});

test('update retains before/after revision and uses the same selected executable', (t) => {
  const f = fixture(t, { installed: true, marketplace: true });
  const result = manageGbrainPlugin('update', f.options);
  assert.equal(result.ok, true);
  assert.equal(result.before.marketplaceRevision, 'a'.repeat(40));
  assert.equal(result.after.marketplaceRevision, 'b'.repeat(40));
  assert.ok(mutations(f).every(({ command }) => command === f.app));
});

test('update without rollback source evidence refuses to mutate', (t) => {
  const f = fixture(t, { installed: true, marketplace: true, revision: '' });
  assert.equal(manageGbrainPlugin('update', f.options).reason, 'update-requires-installed-source-revision');
  assert.equal(mutations(f).length, 0);
});

test('partial native failure reports completed steps without claiming installation', (t) => {
  const f = fixture(t, { fail: 'plugin add gbrain@gbrain' });
  const result = manageGbrainPlugin('install', f.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'native-plugin-operation-failed');
  assert.equal(result.completedSteps.length, 1);
  assert.equal(result.after.marketplacePresent, true);
  assert.equal(result.after.installed, false);
});

test('remove targets only the named plugin and preserves marketplace and manual owner', (t) => {
  const f = fixture(t, { installed: true, marketplace: true, manual: true });
  const result = manageGbrainPlugin('remove', f.options);
  assert.equal(result.ok, true);
  assert.equal(result.after.marketplacePresent, true);
  assert.equal(result.after.manualServerEnabled, true);
  assert.deepEqual(mutations(f).map(({ args }) => args), [['plugin', 'remove', 'gbrain@gbrain']]);
});
