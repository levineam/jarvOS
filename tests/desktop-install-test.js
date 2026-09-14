'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { desktopStatus, installDesktop, launchDesktop, preflightDesktop } = require('../lib/jarvos-desktop');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-desktop-install-'));
  const workspace = path.join(root, 'workspace with spaces');
  const source = path.join(root, 'desktop source');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'jarvos.config.json'), JSON.stringify({ paths: { vault: 'vault relative to workspace' } }));
  for (const file of ['package.json', 'package-lock.json', 'config.default.json', 'electron/main.js', 'server/index.js', 'static/index.html', 'static/app.js', 'static/style.css', 'static/chat/chat.js', 'static/chat/style.css']) {
    const target = path.join(source, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file === 'config.default.json' ? JSON.stringify({ vault: { root: null, journalDir: null, notesDir: null }, systemDoctor: { workspace: null } }) : file);
  }
  return { root, workspace, source };
}

function runner({ fail = false, missingElectron = false, calls = [] } = {}) {
  return (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args[0] === '--version') return { status: 0, stdout: '10.0.0' };
    if (fail) return { status: 1, stderr: 'offline' };
    if (command !== process.execPath || missingElectron) return { status: 0 };
    const electron = path.join(options.cwd, 'node_modules', 'electron', 'dist', 'electron.exe');
    fs.mkdirSync(path.dirname(electron), { recursive: true });
    fs.writeFileSync(electron, 'electron');
    return { status: 0 };
  };
}

function installOptions(f, extra = {}) {
  return { workspace: f.workspace, sourceRoot: f.source, platform: 'win32', nodeVersion: '22.12.0', ...extra };
}

function withPatched(object, property, replacement, action) {
  const original = object[property];
  object[property] = replacement(original);
  try { return action(); } finally { object[property] = original; }
}

test('fresh install, identical no-op, and content upgrade retain configuration', () => {
  const f = fixture(); const calls = []; const spawnSync = runner({ calls });
  fs.writeFileSync(path.join(f.source, 'config.json'), '{"private":"must not ship"}');
  fs.mkdirSync(path.join(f.source, 'nested-private'), { recursive: true });
  fs.writeFileSync(path.join(f.source, 'nested-private', 'config.json'), '{"also":"private"}');
  fs.symlinkSync(f.root, path.join(f.source, 'nested-private', 'node_modules'), 'dir');
  const env = { NODE_ENV: 'production', ELECTRON_OVERRIDE_DIST_PATH: '/unsafe', ELECTRON_PLATFORM: 'darwin', ELECTRON_ARCH: 'arm64', ELECTRON_INSTALL_PLATFORM: 'darwin', ELECTRON_INSTALL_ARCH: 'arm64', npm_config_arch: 'arm64' };
  const first = installDesktop(installOptions(f, { spawnSync, env }));
  assert.equal(first.installed, true); assert.equal(first.changed, true);
  assert.equal(fs.statSync(first.configPath).mode & 0o777, 0o600);
  const installCall = calls.find((call) => call.command === process.execPath && call.args[0].endsWith(path.join('electron', 'install.js')));
  const ciCall = calls.find((call) => call.args[0] === 'ci');
  assert.equal(ciCall.options.env.npm_config_production, 'false');
  assert.equal(ciCall.options.env.ELECTRON_OVERRIDE_DIST_PATH, undefined);
  assert.equal(ciCall.options.env.ELECTRON_INSTALL_PLATFORM, undefined);
  assert.equal(ciCall.options.env.ELECTRON_INSTALL_ARCH, undefined);
  assert.equal(installCall.options.env.ELECTRON_OVERRIDE_DIST_PATH, undefined);
  assert.equal(installCall.options.env.ELECTRON_PLATFORM, undefined);
  assert.equal(installCall.options.env.ELECTRON_ARCH, undefined);
  assert.equal(installCall.options.env.ELECTRON_INSTALL_PLATFORM, undefined);
  assert.equal(installCall.options.env.ELECTRON_INSTALL_ARCH, undefined);
  assert.equal(installCall.options.env.npm_config_arch, undefined);
  assert.equal(fs.existsSync(path.join(first.appPath, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(first.appPath, 'nested-private', 'config.json')), false);
  assert.equal(fs.existsSync(path.join(first.appPath, 'nested-private', 'node_modules')), false);
  assert.equal(JSON.parse(fs.readFileSync(first.configPath, 'utf8')).vault.root, path.join(f.workspace, 'vault relative to workspace'));
  const savedConfig = fs.readFileSync(first.configPath, 'utf8');
  const ciBefore = calls.filter((call) => call.args[0] === 'ci').length;
  const unchanged = installDesktop(installOptions(f, { spawnSync }));
  assert.equal(unchanged.installed, false); assert.equal(unchanged.changed, false);
  assert.equal(calls.filter((call) => call.args[0] === 'ci').length, ciBefore);
  fs.appendFileSync(path.join(f.source, 'config.json'), 'changed private config');
  fs.appendFileSync(path.join(f.source, 'nested-private', 'config.json'), 'changed nested private config');
  const privateConfigChange = installDesktop(installOptions(f, { spawnSync, env }));
  assert.equal(privateConfigChange.id, first.id);
  assert.equal(calls.filter((call) => call.args[0] === 'ci').length, ciBefore);
  fs.appendFileSync(path.join(f.source, 'static', 'app.js'), 'upgrade');
  const upgrade = installDesktop(installOptions(f, { spawnSync }));
  assert.notEqual(upgrade.id, first.id); assert.equal(upgrade.changed, true);
  assert.equal(fs.readFileSync(first.configPath, 'utf8'), savedConfig);
});

test('failed dependencies and missing Electron preserve CURRENT and user config; retry is safe', () => {
  const f = fixture();
  const original = installDesktop(installOptions(f, { spawnSync: runner() }));
  fs.writeFileSync(original.configPath, '{"user":"kept"}\n', { mode: 0o600 });
  const current = path.join(f.workspace, '.jarvos', 'desktop', 'CURRENT');
  const desktop = path.dirname(current);
  fs.mkdirSync(path.join(desktop, '.staging-foreign'), { recursive: true });
  fs.writeFileSync(path.join(desktop, '.staging-foreign', 'keep'), 'foreign staging');
  const before = { current: fs.readFileSync(current, 'utf8'), config: fs.readFileSync(original.configPath, 'utf8') };
  fs.appendFileSync(path.join(f.source, 'static', 'app.js'), 'broken');
  assert.throws(() => installDesktop(installOptions(f, { spawnSync: runner({ fail: true }) })), /dependency installation failed/);
  assert.deepEqual({ current: fs.readFileSync(current, 'utf8'), config: fs.readFileSync(original.configPath, 'utf8') }, before);
  assert.deepEqual(fs.readdirSync(desktop).filter((name) => name.startsWith('.staging-')), ['.staging-foreign']);
  assert.throws(() => installDesktop(installOptions(f, { spawnSync: runner({ missingElectron: true }) })), /Electron executable is missing/);
  assert.deepEqual({ current: fs.readFileSync(current, 'utf8'), config: fs.readFileSync(original.configPath, 'utf8') }, before);
  assert.deepEqual(fs.readdirSync(desktop).filter((name) => name.startsWith('.staging-')), ['.staging-foreign']);
  const retry = installDesktop(installOptions(f, { spawnSync: runner() }));
  assert.notEqual(retry.id, original.id);
});

test('concurrent and unsafe lock, source, state, and config targets are refused', () => {
  const f = fixture();
  const desktop = path.join(f.workspace, '.jarvos', 'desktop');
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, '.install.lock'), JSON.stringify({ pid: process.pid, token: 'active-lock' }));
  assert.throws(() => installDesktop(installOptions(f, { spawnSync: runner() })), /already running/);
  fs.unlinkSync(path.join(desktop, '.install.lock'));
  fs.writeFileSync(path.join(desktop, '.install.lock'), JSON.stringify({ pid: 999999, token: 'dead-lock' }));
  assert.equal(installDesktop(installOptions(f, { spawnSync: runner() })).installed, true);
  fs.writeFileSync(path.join(f.source, 'linked.txt'), 'source');
  fs.symlinkSync(path.join(f.source, 'linked.txt'), path.join(f.source, 'unsafe-link'));
  assert.throws(() => preflightDesktop(installOptions(f, { spawnSync: runner() })), /contains a symlink/);
  fs.unlinkSync(path.join(f.source, 'unsafe-link'));
  const hardlinked = path.join(f.root, 'hardlinked-config');
  fs.writeFileSync(hardlinked, '{}');
  fs.unlinkSync(path.join(desktop, 'config.json'));
  fs.linkSync(hardlinked, path.join(desktop, 'config.json'));
  assert.throws(() => preflightDesktop(installOptions(f, { spawnSync: runner() })), /hardlinked/);
});

test('stale lock recovery is fenced and only releases the lock it owns', () => {
  const f = fixture();
  const desktop = path.join(f.workspace, '.jarvos', 'desktop');
  const lock = path.join(desktop, '.install.lock');
  const recovery = `${lock}.recovery`;
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'stale' }));
  fs.writeFileSync(recovery, JSON.stringify({ pid: process.pid, token: 'other-recovery' }));
  assert.throws(() => installDesktop(installOptions(f, { spawnSync: runner() })), /recovery is already in progress/);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'stale');
  fs.unlinkSync(recovery);
  withPatched(fs, 'openSync', (originalOpen) => function patchedOpen(file, flags, ...rest) {
    const descriptor = originalOpen.call(this, file, flags, ...rest);
    if (file === recovery && flags === 'wx') {
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live-replacement' }));
    }
    return descriptor;
  }, () => assert.throws(() => installDesktop(installOptions(f, { spawnSync: runner() })), /lock changed while recovering/));
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live-replacement');
  fs.unlinkSync(lock);
  withPatched(fs, 'readFileSync', (originalRead) => function patchedRead(file, ...rest) {
    if (file === lock) {
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'foreign-replacement' }));
    }
    return originalRead.call(this, file, ...rest);
  }, () => installDesktop(installOptions(f, { spawnSync: runner() })));
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'foreign-replacement');
  fs.unlinkSync(lock);
});

test('configuration publication never overwrites a concurrent writer', () => {
  const f = fixture();
  const config = path.join(f.workspace, '.jarvos', 'desktop', 'config.json');
  withPatched(fs, 'linkSync', (originalLink) => function patchedLink(source, destination, ...rest) {
    if (destination === config) fs.writeFileSync(config, '{"external":true}\n', { mode: 0o600 });
    return originalLink.call(this, source, destination, ...rest);
  }, () => assert.throws(() => installDesktop(installOptions(f, { spawnSync: runner() })), /appeared during installation/));
  assert.equal(fs.readFileSync(config, 'utf8'), '{"external":true}\n');
  assert.equal(fs.existsSync(path.join(f.workspace, '.jarvos', 'desktop', 'CURRENT')), false);
});

test('valid JSON Desktop configs must still be objects', () => {
  const f = fixture();
  const installed = installDesktop(installOptions(f, { spawnSync: runner() }));
  for (const value of ['null', '[]', '"string"', '42']) {
    fs.writeFileSync(installed.configPath, value);
    const status = desktopStatus(installOptions(f));
    assert.equal(status.ready, false);
    assert.match(status.problem, /JSON object/);
    assert.throws(() => installDesktop(installOptions(f, { spawnSync: runner() })), /JSON object/);
    assert.equal(fs.readFileSync(installed.configPath, 'utf8'), value);
  }
});

test('status is read-only and launch uses the selected app from any caller cwd', () => {
  const f = fixture();
  const first = installDesktop(installOptions(f, { spawnSync: runner() }));
  const before = fs.readdirSync(path.join(f.workspace, '.jarvos', 'desktop')).sort();
  const status = desktopStatus(installOptions(f));
  assert.equal(status.ready, true); assert.equal(status.appPath, first.appPath);
  assert.deepEqual(fs.readdirSync(path.join(f.workspace, '.jarvos', 'desktop')).sort(), before);
  const calls = [];
  const launched = launchDesktop(installOptions(f, { env: { PORT: '4988' }, spawnSync: runner({ calls }) }));
  const call = calls.at(-1);
  assert.equal(call.command, status.electronPath); assert.deepEqual(call.args, [first.appPath]);
  assert.equal(call.options.cwd, first.appPath); assert.equal(call.options.env.JARVOS_DESKTOP_CONFIG, first.configPath);
  assert.equal(call.options.env.PORT, '4988'); assert.equal(launched.launched, true);
  assert.equal(call.options.stdio, 'inherit');
  assert.equal(call.options.env.JARVOS_ELECTRON_USER_DATA_DIR, path.join(f.workspace, '.jarvos', 'desktop', 'user-data'));
  const overridden = launchDesktop(installOptions(f, { env: { JARVOS_ELECTRON_USER_DATA_DIR: '/explicit-user-data' }, spawnSync: runner({ calls }) }));
  assert.equal(calls.at(-1).options.env.JARVOS_ELECTRON_USER_DATA_DIR, '/explicit-user-data');
  assert.equal(overridden.launched, true);
});

test('Node 18 rejects Desktop before npm or filesystem writes', () => {
  const f = fixture(); let invoked = false;
  assert.throws(() => preflightDesktop(installOptions(f, { nodeVersion: '18.20.0', spawnSync() { invoked = true; return { status: 0 }; } })), /Node.js 22.12/);
  assert.equal(invoked, false);
  assert.equal(fs.existsSync(path.join(f.workspace, '.jarvos')), false);
});
