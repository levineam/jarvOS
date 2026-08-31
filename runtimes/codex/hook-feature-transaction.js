'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const receiptApi = require('./hook-feature-receipt');

const STEWARDSHIP_KEYS = [
  'JARVOS_STEWARDSHIP_BRIDGE_COMMAND',
  'JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT',
  'JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE',
];

function fail(message) { throw new Error(`refusing Codex hook transaction: ${message}`); }
function own(object, key) { return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key); }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function samePath(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); }
  catch (_) { return path.resolve(left) === path.resolve(right); }
}
function getPath(config, keyPath) {
  let cursor = config;
  for (const key of keyPath.split('.')) {
    if (!own(cursor, key)) return { present: false, value: null };
    cursor = cursor[key];
  }
  return { present: true, value: clone(cursor) };
}
function snapshot(config) {
  return receiptApi.validateSnapshot(Object.fromEntries(receiptApi.OWNED_PATHS.map((key) => [key, getPath(config, key)])));
}
function parentPresence(config) {
  return receiptApi.validateParentPresence(Object.fromEntries(receiptApi.PARENT_PATHS.map((key) => [key, getPath(config, key).present])));
}
function applyPath(config, keyPath, item) {
  const keys = keyPath.split('.');
  let cursor = config;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] ||= {};
  if (item.present) cursor[keys.at(-1)] = clone(item.value);
  else delete cursor[keys.at(-1)];
}
function semanticEdits(current, target) {
  return receiptApi.OWNED_PATHS
    .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(target[key]))
    .map((keyPath) => ({ keyPath, value: target[keyPath].present ? target[keyPath].value : null, mergeStrategy: 'replace' }));
}
function rollbackEdits(config, current, target, parentBefore) {
  let edits = semanticEdits(current, target);
  const simulated = clone(config);
  for (const key of receiptApi.OWNED_PATHS) applyPath(simulated, key, target[key]);
  for (const parent of ['shell_environment_policy.set', 'hooks', 'features', 'shell_environment_policy']) {
    const item = getPath(simulated, parent);
    if (parentBefore[parent] || !item.present || !item.value || typeof item.value !== 'object'
      || Array.isArray(item.value) || Object.keys(item.value).length !== 0) continue;
    edits = edits.filter((edit) => edit.keyPath !== parent && !edit.keyPath.startsWith(`${parent}.`));
    edits.push({ keyPath: parent, value: null, mergeStrategy: 'replace' });
    applyPath(simulated, parent, { present: false, value: null });
  }
  return edits;
}
function shellQuote(value) { return `'${value.replace(/'/g, "'\"'\"'")}'`; }
function managedCommand(entry, ownedPaths) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((hook) => typeof hook?.command === 'string' && ownedPaths.some((target) => {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9._/-])${escaped}(?=$|[^A-Za-z0-9._/-])`).test(hook.command);
  }));
}
function desiredSnapshot(before, options) {
  const desired = clone(before);
  const ownedPaths = [options.hookScript, options.turnHookScript, options.dispatcher].filter(Boolean);
  if (path.isAbsolute(options.stagedRoot || '')) {
    ownedPaths.push(path.join(options.stagedRoot, 'runtimes', 'codex', 'jarvos-session-start-hook.js'));
    ownedPaths.push(path.join(options.stagedRoot, 'runtimes', 'codex', 'jarvos-session-turn-hook.js'));
  }
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const current = before[`hooks.${event}`];
    if (current.present && !Array.isArray(current.value)) fail(`hooks.${event} in the user layer is not an array`);
    desired[`hooks.${event}`] = { present: true, value: (current.present ? current.value : []).filter((entry) => !managedCommand(entry, ownedPaths)) };
  }
  const startCommand = options.dispatcher
    ? `${shellQuote(options.dispatcher)} --harness codex --action session-start`
    : `node ${shellQuote(options.hookScript)}`;
  const turnCommand = options.dispatcher
    ? `${shellQuote(options.dispatcher)} --harness codex --action session-turn`
    : `node ${shellQuote(options.turnHookScript)}`;
  desired['hooks.SessionStart'].value.push({ matcher: 'startup|resume', hooks: [{ type: 'command', command: startCommand, async: false, timeout: 30 }] });
  desired['hooks.UserPromptSubmit'].value.push({ hooks: [{ type: 'command', command: turnCommand, async: false, timeout: 30 }] });
  desired['features.hooks'] = { present: true, value: true };
  desired['features.codex_hooks'] = { present: false, value: null };
  if (options.bridgeCommand || options.mapRoot) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.bridgeCommand || '')) fail('JARVOS_STEWARDSHIP_BRIDGE_COMMAND is invalid');
    if (!path.isAbsolute(options.mapRoot || '')) fail('JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT must be absolute');
    desired['shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_COMMAND'] = { present: true, value: options.bridgeCommand };
    desired['shell_environment_policy.set.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT'] = { present: true, value: options.mapRoot };
    desired['shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE'] = { present: false, value: null };
  }
  return receiptApi.validateSnapshot(desired);
}
function hasUnreceiptedState(current, ownedPaths) {
  for (const event of ['hooks.SessionStart', 'hooks.UserPromptSubmit']) {
    const item = current[event];
    if (item.present && Array.isArray(item.value) && item.value.some((entry) => managedCommand(entry, ownedPaths))) return true;
  }
  return STEWARDSHIP_KEYS.some((key) => current[`shell_environment_policy.set.${key}`].present);
}

class AppServer {
  constructor(executable, cwd) { this.executable = executable; this.cwd = cwd; this.nextId = 1; this.pending = new Map(); this.buffer = ''; }
  async start() {
    this.child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], { cwd: this.cwd, env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('exit', (code) => this.rejectAll(new Error(`Codex app-server exited (${code ?? 'signal'})`)));
    await this.request('initialize', { clientInfo: { name: 'jarvos_setup', title: 'jarvOS Codex setup', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  send(message) {
    if (!this.child?.stdin?.writable) fail('Codex app-server is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex app-server timed out during ${method}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }
  consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch (_) { continue; }
      const pending = this.pending.get(message.id); if (!pending) continue;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex app-server request failed'));
      else pending.resolve(message.result);
    }
  }
  rejectAll(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  close() { if (this.child && !this.child.killed) this.child.kill(); }
}

async function transact(options) {
  if (!path.isAbsolute(options.configPath)) fail('CODEX_CONFIG must be absolute');
  const targetConfig = fs.realpathSync(options.configPath);
  const server = new AppServer(options.executable, options.root);
  try {
    await server.start();
    const read = await server.request('config/read', { includeLayers: true });
    if (!Array.isArray(read?.layers)) fail('Codex app-server returned no versioned configuration layers');
    const matches = read.layers.filter((layer) => layer?.name?.type === 'user' && typeof layer.name.file === 'string' && samePath(layer.name.file, targetConfig));
    if (matches.length !== 1 || typeof matches[0].version !== 'string' || !matches[0].version) fail('the exact Codex user layer is unavailable or ambiguous');
    const layer = matches[0];
    const currentConfig = layer.config || {};
    const current = snapshot(currentConfig);
    let receipt = receiptApi.readReceipt(options.receiptPath, options.codexHome, options.configPath);
    let recoveredNoop = false;
    if (receipt) {
      const atBefore = receiptApi.snapshotsEqual(receipt.before, current);
      const atAfter = receiptApi.snapshotsEqual(receipt.after, current);
      if (receipt.state === 'pending') {
        if (atBefore) {
          receiptApi.clearReceipt(options.receiptPath, options.codexHome, options.configPath, receipt.after);
          receipt = null; recoveredNoop = options.rollback;
        } else if (atAfter) {
          receiptApi.activateReceipt(options.receiptPath, options.codexHome, options.configPath, receipt.after);
          receipt = receiptApi.readReceipt(options.receiptPath, options.codexHome, options.configPath);
        } else fail('pending ownership record matches neither safe transaction state');
      } else if (atBefore) {
        receiptApi.clearReceipt(options.receiptPath, options.codexHome, options.configPath, receipt.after);
        receipt = null; recoveredNoop = options.rollback;
      } else if (!atAfter) fail('owned hook or feature state drifted after setup');
    }

    let target;
    if (options.rollback) {
      if (!receipt) {
        const ownedPaths = [options.hookScript, options.turnHookScript, options.dispatcher].filter(Boolean);
        if (path.isAbsolute(options.stagedRoot || '')) {
          ownedPaths.push(path.join(options.stagedRoot, 'runtimes', 'codex', 'jarvos-session-start-hook.js'));
          ownedPaths.push(path.join(options.stagedRoot, 'runtimes', 'codex', 'jarvos-session-turn-hook.js'));
        }
        if (!recoveredNoop && hasUnreceiptedState(current, ownedPaths)) fail('no ownership record exists for detected jarvOS hook state');
        console.log(`Codex hook-feature rollback found no owned state: ${options.configPath}`); return;
      }
      target = receipt.before;
    } else {
      if (fs.existsSync(options.legacyHooksPath)) fail(`legacy ${options.legacyHooksPath} requires an explicit semantic migration`);
      target = desiredSnapshot(current, options);
      if (receipt && !receiptApi.snapshotsEqual(receipt.after, target)) fail('the existing ownership record describes a different requested setup state');
      if (receiptApi.snapshotsEqual(current, target)) {
        console.log(`Codex config already has the requested jarvOS hooks: ${options.configPath}`); return;
      }
      if (!receipt) receipt = receiptApi.claimReceipt(
        options.receiptPath,
        options.codexHome,
        options.configPath,
        current,
        target,
        parentPresence(currentConfig),
      );
    }
    const edits = options.rollback
      ? rollbackEdits(currentConfig, current, target, receipt.parentBefore)
      : semanticEdits(current, target);
    let result;
    try {
      result = await server.request('config/batchWrite', { filePath: targetConfig, edits, expectedVersion: layer.version, reloadUserConfig: true });
    } catch (_) { fail('Codex app-server rejected the version-bound configuration transaction; preserving the ownership record'); }
    if (!result || !['ok', 'okOverridden'].includes(result.status) || typeof result.version !== 'string' || !result.version
      || typeof result.filePath !== 'string' || !samePath(result.filePath, targetConfig)) fail('Codex app-server did not confirm the exact configuration transaction');
    if (options.rollback) receiptApi.clearReceipt(options.receiptPath, options.codexHome, options.configPath, receipt.after);
    else receiptApi.activateReceipt(options.receiptPath, options.codexHome, options.configPath, target);
    console.log(`${options.rollback ? 'Restored' : 'Updated'} Codex hook-feature state transactionally: ${options.configPath}`);
  } finally { server.close(); }
}

async function main() {
  const [root, executable, configPath, codexHome, receiptPath, legacyHooksPath, hookScript, turnHookScript, dispatcher, rollback, bridgeCommand, mapRoot, stagedRoot] = process.argv.slice(2);
  await transact({ root, executable, configPath, codexHome, receiptPath, legacyHooksPath, hookScript, turnHookScript, dispatcher, rollback: rollback === '1', bridgeCommand, mapRoot, stagedRoot });
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { snapshot, parentPresence, desiredSnapshot, rollbackEdits, transact };
