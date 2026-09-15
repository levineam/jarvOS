#!/usr/bin/env node
'use strict';

// Optional native-plugin maintenance only. This never launches a Codex session,
// replaces a managed launcher, writes TOML, or initializes a GBrain database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN = 'gbrain@gbrain';
const SOURCE = 'garrytan/gbrain@codex-plugin';
const REPOSITORY = 'https://github.com/garrytan/gbrain.git';
const ACTIONS = new Set(['doctor', 'install', 'update', 'remove']);

function run(command, args, options = {}) {
  return (options.spawnSyncImpl || spawnSync)(command, args, {
    env: options.env || process.env,
    cwd: options.cwd || os.homedir(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 5000,
    maxBuffer: 256 * 1024,
  });
}

function executable(file) {
  try {
    return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true);
  } catch { return false; }
}

function pathCommand(name, env) {
  if (typeof name !== 'string' || !name.trim()) return null;
  if (path.isAbsolute(name)) return executable(name) ? name : null;
  if (name.includes('/') || name.includes('\\')) return null;
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    // Relative PATH entries are workspace-controlled, not installed tooling.
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

function candidates(options, env) {
  const explicit = options.executable ?? env.JARVOS_CODEX_EXECUTABLE;
  if (explicit !== undefined) return [pathCommand(explicit, env)].filter(Boolean);
  const found = [pathCommand('codex', env)];
  if ((options.platform || process.platform) === 'darwin') {
    for (const root of options.applicationRoots || ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const app of ['Codex.app', 'ChatGPT.app']) {
        const candidate = path.join(root, app, 'Contents', 'Resources', 'codex');
        if (executable(candidate)) found.push(candidate);
      }
    }
  }
  return [...new Set(found.filter(Boolean))];
}

function parsePluginList(result) {
  if (result.status !== 0 || result.error) return null;
  try {
    const value = JSON.parse(result.stdout);
    return value && Array.isArray(value.installed) ? value.installed : null;
  } catch { return null; }
}

function resolveCodexExecutable(options = {}) {
  const env = options.env || process.env;
  const attempts = [];
  for (const command of candidates(options, env)) {
    const version = run(command, ['--version'], options);
    const versionText = String(version.stdout || '').trim();
    if (version.status !== 0 || version.error || !/^codex[^\n]{0,120}\d[^\n]*$/i.test(versionText)) {
      attempts.push({ executable: command, reason: 'version-unavailable' });
      continue;
    }
    // --help alone bypasses configuration loading in some Codex versions.
    const plugins = parsePluginList(run(command, ['plugin', 'list', '--json'], options));
    const commands = [
      ['plugin', 'add', '--help'],
      ['plugin', 'marketplace', 'add', '--help'],
      ['plugin', 'marketplace', 'list', '--help'],
      ['plugin', 'marketplace', 'upgrade', '--help'],
      ['plugin', 'remove', '--help'],
    ];
    if (!plugins || commands.some((args) => {
      const result = run(command, args, options);
      return result.status !== 0 || result.error;
    })) {
      attempts.push({ executable: command, reason: 'configuration-or-plugin-commands-incompatible' });
      continue;
    }
    return { ok: true, executable: command, version: versionText, attempts };
  }
  return {
    ok: false,
    reason: options.executable !== undefined || env.JARVOS_CODEX_EXECUTABLE !== undefined
      ? 'configured-codex-incompatible' : 'no-compatible-codex',
    message: 'Choose a Codex executable that can load this profile and manage plugins with JARVOS_CODEX_EXECUTABLE. Managed session launch authority is unchanged.',
    attempts,
  };
}

function readState(selection, options) {
  const plugins = parsePluginList(run(selection.executable, ['plugin', 'list', '--json'], options));
  // Native MCP listing merges plugin servers. A process-only policy override
  // hides plugin servers so the remaining gbrain entry identifies a manual owner.
  // This never persists the override or disables the installed plugin.
  const manualResult = run(selection.executable, ['--disable', 'plugins', 'mcp', 'list', '--json'], options);
  let manual;
  try { manual = manualResult.status === 0 && !manualResult.error ? JSON.parse(manualResult.stdout) : null; } catch { manual = null; }
  if (!plugins || !Array.isArray(manual)) throw new Error('native-registration-unavailable');
  const marketplaceResult = run(selection.executable, ['plugin', 'marketplace', 'list', '--json'], options);
  let marketplaces;
  try { marketplaces = marketplaceResult.status === 0 && !marketplaceResult.error ? JSON.parse(marketplaceResult.stdout).marketplaces : null; } catch { marketplaces = null; }
  if (!Array.isArray(marketplaces)) throw new Error('native-registration-unavailable');
  const matchingMarketplaces = marketplaces.filter((item) => item.name === 'gbrain');
  const marketplace = matchingMarketplaces[0];
  const plugin = plugins.find((item) => item.pluginId === PLUGIN && item.installed === true);
  let sourceRevision = null;
  if (path.isAbsolute(plugin?.source?.path || '')) {
    const revision = run('git', ['-C', plugin.source.path, 'rev-parse', 'HEAD'], options);
    if (revision.status === 0 && /^[a-f0-9]{40}$/.test(String(revision.stdout || '').trim())) sourceRevision = revision.stdout.trim();
  }
  return {
    installed: Boolean(plugin),
    enabled: plugin?.enabled === true,
    pluginVersion: plugin?.version || null,
    marketplaceRevision: sourceRevision,
    marketplacePresent: Boolean(marketplace),
    officialMarketplace: matchingMarketplaces.length === 1 && marketplace.marketplaceSource?.sourceType === 'git'
      && marketplace.marketplaceSource.source === REPOSITORY,
    officialInstalledPlugin: !plugin || (plugin.marketplaceSource?.sourceType === 'git' && plugin.marketplaceSource.source === REPOSITORY),
    manualServerEnabled: manual.some((item) => item.name === 'gbrain' && item.enabled !== false),
    otherEnabledVariants: plugins.filter((item) => item.pluginId !== PLUGIN && /^gbrain(?:-(coding|daily))?@/.test(item.pluginId || '') && item.installed === true && item.enabled !== false).map((item) => item.pluginId),
    hostBinding: 'not-probed',
    nativeSession: 'not-proven',
  };
}

function manageGbrainPlugin(action, options = {}) {
  if (!ACTIONS.has(action)) return { ok: false, reason: 'unknown-action' };
  const selection = resolveCodexExecutable(options);
  if (!selection.ok) return selection;
  const receipt = { action, codex: selection, before: null, after: null, completedSteps: [], ok: false };
  try {
    receipt.before = readState(selection, options);
    if (action === 'doctor') {
      receipt.after = receipt.before;
      receipt.ok = receipt.before.installed && receipt.before.enabled
        && receipt.before.officialMarketplace && receipt.before.officialInstalledPlugin
        && !receipt.before.manualServerEnabled && receipt.before.otherEnabledVariants.length === 0;
      receipt.reason = receipt.ok ? 'registered-not-live-proven' : 'registration-needs-attention';
      return receipt;
    }
    if (action !== 'remove' && (receipt.before.manualServerEnabled || receipt.before.otherEnabledVariants.length)) {
      receipt.reason = 'existing-gbrain-owner-conflict';
      return receipt;
    }
    if (action !== 'remove' && ((!receipt.before.officialMarketplace && receipt.before.marketplacePresent) || !receipt.before.officialInstalledPlugin)) {
      receipt.reason = 'existing-marketplace-source-conflict';
      return receipt;
    }
    if (action === 'update' && (!receipt.before.installed || !receipt.before.marketplaceRevision)) {
      receipt.reason = 'update-requires-installed-source-revision';
      return receipt;
    }
    const steps = action === 'install'
      ? receipt.before.marketplacePresent ? [['plugin', 'add', PLUGIN]]
        : [['plugin', 'marketplace', 'add', SOURCE], ['plugin', 'add', PLUGIN]]
      : action === 'update'
        ? [['plugin', 'marketplace', 'upgrade', 'gbrain'], ['plugin', 'add', PLUGIN]]
        : receipt.before.installed ? [['plugin', 'remove', PLUGIN]] : [];
    for (const args of steps) {
      if (args[1] === 'add') {
        const current = readState(selection, options);
        if (!current.officialMarketplace || !current.officialInstalledPlugin || current.manualServerEnabled || current.otherEnabledVariants.length) {
          receipt.reason = 'registration-changed-before-install';
          receipt.failedStep = args;
          break;
        }
      }
      const result = run(selection.executable, args, { ...options, timeoutMs: options.mutationTimeoutMs || 60000 });
      if (result.status !== 0 || result.error) {
        receipt.reason = 'native-plugin-operation-failed';
        receipt.failedStep = args;
        break;
      }
      receipt.completedSteps.push(args);
    }
    receipt.after = readState(selection, options);
    receipt.ok = !receipt.failedStep && (action === 'remove' ? !receipt.after.installed
      : receipt.after.installed && receipt.after.enabled && receipt.after.officialMarketplace && receipt.after.officialInstalledPlugin
        && !receipt.after.manualServerEnabled && !receipt.after.otherEnabledVariants.length);
    receipt.reason ||= receipt.ok ? 'registration-updated-not-live-proven' : 'native-registration-postcondition-failed';
  } catch {
    receipt.reason = 'native-registration-unavailable';
  }
  return receipt;
}

if (require.main === module) {
  if (process.argv.length !== 3 || !ACTIONS.has(process.argv[2])) {
    process.stderr.write('Usage: node runtimes/codex/gbrain-plugin.js doctor|install|update|remove\nOptional: JARVOS_CODEX_EXECUTABLE=/absolute/codex. Install/update/remove change native plugin registration only.\n');
    process.exitCode = 2;
  } else {
    const result = manageGbrainPlugin(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}

module.exports = { resolveCodexExecutable, manageGbrainPlugin };
