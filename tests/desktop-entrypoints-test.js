'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts/jarvos.js');
const BOOTSTRAP = path.join(ROOT, 'bootstrap.js');
const [major, minor] = process.versions.node.split('.').map(Number);
const supportedNode = major > 22 || major === 22 && minor >= 12;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-entrypoints-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // A PATH-level npm stand-in exercises the real public entrypoints without
  // downloads. Actual Electron acceptance belongs to the packaged rehearsal.
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
if (process.argv[2] === '--version') { console.log('10.0.0'); process.exit(0); }
if (process.env.DESKTOP_FIXTURE_NPM_FAIL === '1') process.exit(42);
const dir = path.join(process.cwd(), 'node_modules/electron');
fs.mkdirSync(dir, { recursive: true });
const relative = process.platform === 'darwin' ? 'dist/Electron.app/Contents/MacOS/Electron' : 'dist/electron';
const executable = path.join(dir, relative);
fs.writeFileSync(path.join(dir, 'install.js'), '');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(executable, '#!/bin/sh\\nexit 0\\n', { mode: 0o700 });
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, JARVOS_YES: '1', JARVOS_RUNTIME: 'minimal', JARVOS_ASSISTANT_NAME: 'Fixture', JARVOS_USER_NAME: 'Tester', JARVOS_COACH_NAME: 'Coach' };
  for (const key of ['JARVOS_NO_DESKTOP', 'JARVOS_WORKSPACE_PATH', 'JARVOS_VAULT_PATH']) delete env[key];
  return { root, env };
}

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 10e6 });
}

test('default init installs through CLI, aliases and direct bootstrap', { skip: !supportedNode || process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  for (const surface of ['jarvos', 'jarvos-bootstrap', 'jarvos-init', 'bootstrap']) {
    const workspace = path.join(f.root, `${surface} workspace`);
    const args = ['--yes', '--workspace', workspace, '--vault', path.join(f.root, `${surface} vault`)];
    const result = surface === 'bootstrap' ? run(BOOTSTRAP, args, f.env)
      : surface === 'jarvos' ? run(CLI, ['init', ...args], f.env)
        : run('-e', [`require(${JSON.stringify(path.join(ROOT, 'lib/jarvos-cli'))}).runCli(${JSON.stringify(args)},process.env,${JSON.stringify(surface)}).then(code=>process.exit(code))`], f.env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const status = run(CLI, ['desktop', 'status', '--workspace', workspace, '--json'], f.env);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).ready, true);
    const configFile = path.join(workspace, '.jarvos/desktop/config.json');
    const before = fs.readFileSync(configFile, 'utf8');
    const rerun = run(CLI, ['init', ...args], f.env);
    assert.equal(rerun.status, 0, rerun.stderr + rerun.stdout);
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(workspace, '.jarvos/desktop/user-data')), false, 'init must not launch Electron');
  }
});

test('explicit skip avoids Desktop and default failure is partial and retryable', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  for (const flag of [true, false]) {
    const workspace = path.join(f.root, `headless-${flag}`);
    const env = { ...f.env, DESKTOP_FIXTURE_NPM_FAIL: '1', ...(!flag ? { JARVOS_NO_DESKTOP: '1' } : {}) };
    const result = run(CLI, ['init', '--yes', '--workspace', workspace, '--vault', path.join(f.root, `vault-${flag}`), ...(flag ? ['--no-desktop'] : [])], env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(fs.existsSync(path.join(workspace, '.jarvos/desktop')), false);
  }
  const workspace = path.join(f.root, 'partial');
  const failed = run(CLI, ['init', '--yes', '--workspace', workspace, '--vault', path.join(f.root, 'vault')], { ...f.env, DESKTOP_FIXTURE_NPM_FAIL: '1' });
  assert.notEqual(failed.status, 0);
  if (!supportedNode) {
    assert.match(failed.stdout + failed.stderr, /22\.12/);
    assert.equal(fs.existsSync(workspace), false, 'prerequisites fail before any init writes');
    return;
  }
  assert.match(failed.stdout + failed.stderr, /Partial installation/);
  const core = fs.readFileSync(path.join(workspace, 'jarvos.config.json'), 'utf8');
  const retry = run(CLI, ['desktop', 'install', '--workspace', workspace, '--json'], f.env);
  assert.equal(retry.status, 0, retry.stderr + retry.stdout);
  assert.equal(fs.readFileSync(path.join(workspace, 'jarvos.config.json'), 'utf8'), core);
  const launch = run(CLI, ['desktop', '--workspace', workspace], f.env);
  assert.equal(launch.status, 0, launch.stderr);
  assert.notEqual(run(CLI, ['desktop', 'typo', '--workspace', workspace], f.env).status, 0);
});
