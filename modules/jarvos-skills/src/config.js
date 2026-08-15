'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_SCHEMA_VERSION = 'jarvos.shared-skill-config/v1';
const DEFAULT_CONTROL_ROOT = path.join(os.homedir(), '.jarvos', 'shared-skills');
const DEFAULT_HARNESS_ROOTS = Object.freeze({
  codex: path.join(os.homedir(), '.codex', 'skills'),
  claude: path.join(os.homedir(), '.claude', 'skills'),
  openclaw: path.join(os.homedir(), '.openclaw', 'skills'),
  hermes: path.join(os.homedir(), '.hermes', 'skills'),
});
const SUPPORTED_HARNESSES = Object.freeze(Object.keys(DEFAULT_HARNESS_ROOTS));

function expandHome(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new Error('path value must be a string');
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function collapseHome(value) {
  const home = os.homedir();
  const resolved = path.resolve(value);
  if (resolved === home) return '~';
  if (resolved.startsWith(`${home}${path.sep}`)) return `~/${resolved.slice(home.length + 1).split(path.sep).join('/')}`;
  return resolved;
}

function assertSafeOwnedDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
}

function ensureDir(dirPath, label = 'directory') {
  const resolved = path.resolve(expandHome(dirPath));
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  assertSafeOwnedDirectory(stat, label);
  return fs.realpathSync(resolved);
}

function atomicWriteJson(filePath, value) {
  const parent = ensureDir(path.dirname(filePath), 'config parent');
  const target = path.resolve(parent, path.basename(filePath));
  const tmp = path.join(parent, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, target);
  return target;
}

function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    controlRoot: collapseHome(DEFAULT_CONTROL_ROOT),
    publicCatalogPath: collapseHome(path.join(DEFAULT_CONTROL_ROOT, 'public-catalog.json')),
    publicSourceRoot: null,
    localOverlayPath: collapseHome(path.join(DEFAULT_CONTROL_ROOT, 'local-overlay.json')),
    localSourceRoot: null,
    harnesses: Object.fromEntries(SUPPORTED_HARNESSES.map((id) => [id, {
      enabled: true,
      root: collapseHome(DEFAULT_HARNESS_ROOTS[id]),
    }])),
    scheduler: {
      enabled: false,
      intervalMinutes: 60,
      unitName: 'jarvos-shared-skills',
    },
    liveDogfood: { authorized: false, receiptPath: null, egress: {} },
  };
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('shared-skill config must be an object');
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`unsupported shared-skill config schemaVersion: ${raw.schemaVersion || 'missing'}`);
  }
  const defaults = defaultConfig();
  const harnesses = {};
  for (const id of SUPPORTED_HARNESSES) {
    const source = raw.harnesses && raw.harnesses[id] ? raw.harnesses[id] : defaults.harnesses[id];
    if (!source || typeof source !== 'object') throw new Error(`harness config missing for ${id}`);
    if (typeof source.enabled !== 'boolean') throw new Error(`harness ${id}.enabled must be boolean`);
    if (typeof source.root !== 'string' || !source.root) throw new Error(`harness ${id}.root is required`);
    harnesses[id] = {
      enabled: source.enabled,
      root: collapseHome(expandHome(source.root)),
      scopeRoots: source.scopeRoots && typeof source.scopeRoots === 'object'
        ? Object.fromEntries(Object.entries(source.scopeRoots).map(([scope, value]) => [scope, collapseHome(expandHome(value))]))
        : {},
    };
  }
  const scheduler = {
    enabled: raw.scheduler?.enabled === true,
    intervalMinutes: Number.isInteger(raw.scheduler?.intervalMinutes)
      ? raw.scheduler.intervalMinutes
      : defaults.scheduler.intervalMinutes,
    unitName: typeof raw.scheduler?.unitName === 'string' && raw.scheduler.unitName
      ? raw.scheduler.unitName
      : defaults.scheduler.unitName,
  };
  if (!Number.isInteger(scheduler.intervalMinutes) || scheduler.intervalMinutes < 5 || scheduler.intervalMinutes > 24 * 60) {
    throw new Error('scheduler.intervalMinutes must be between 5 and 1440');
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scheduler.unitName)) {
    throw new Error('scheduler.unitName is invalid');
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    controlRoot: collapseHome(expandHome(raw.controlRoot || defaults.controlRoot)),
    publicCatalogPath: collapseHome(expandHome(raw.publicCatalogPath || defaults.publicCatalogPath)),
    publicSourceRoot: raw.publicSourceRoot ? collapseHome(expandHome(raw.publicSourceRoot)) : null,
    localOverlayPath: raw.localOverlayPath === null || raw.localOverlayPath === undefined
      ? defaults.localOverlayPath
      : collapseHome(expandHome(raw.localOverlayPath)),
    localSourceRoot: raw.localSourceRoot ? collapseHome(expandHome(raw.localSourceRoot)) : null,
    harnesses,
    scheduler,
    liveDogfood: {
      authorized: raw.liveDogfood?.authorized === true,
      receiptPath: raw.liveDogfood?.receiptPath ? collapseHome(expandHome(raw.liveDogfood.receiptPath)) : null,
      egress: raw.liveDogfood?.egress && typeof raw.liveDogfood.egress === 'object' ? { ...raw.liveDogfood.egress } : {},
    },
  };
}

function resolveConfigPaths(config) {
  const normalized = normalizeConfig(config);
  return {
    config: normalized,
    controlRoot: path.resolve(expandHome(normalized.controlRoot)),
    publicCatalogPath: path.resolve(expandHome(normalized.publicCatalogPath)),
    publicSourceRoot: normalized.publicSourceRoot ? path.resolve(expandHome(normalized.publicSourceRoot)) : null,
    localOverlayPath: normalized.localOverlayPath ? path.resolve(expandHome(normalized.localOverlayPath)) : null,
    localSourceRoot: normalized.localSourceRoot ? path.resolve(expandHome(normalized.localSourceRoot)) : null,
    harnesses: SUPPORTED_HARNESSES
      .filter((id) => normalized.harnesses[id].enabled)
      .map((id) => ({
        id,
        root: path.resolve(expandHome(normalized.harnesses[id].root)),
        enabled: true,
        scopeRoots: normalized.harnesses[id].scopeRoots,
      })),
    allHarnesses: SUPPORTED_HARNESSES.map((id) => ({
      id,
      root: path.resolve(expandHome(normalized.harnesses[id].root)),
      enabled: normalized.harnesses[id].enabled,
      scopeRoots: normalized.harnesses[id].scopeRoots,
    })),
  };
}

function defaultConfigPath(controlRoot = DEFAULT_CONTROL_ROOT) {
  return path.join(path.resolve(expandHome(controlRoot)), 'config.json');
}

function loadConfig(configPath) {
  const file = path.resolve(expandHome(configPath || defaultConfigPath()));
  if (!fs.existsSync(file)) {
    return {
      path: file,
      existed: false,
      config: defaultConfig(),
      resolved: resolveConfigPaths(defaultConfig()),
    };
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('config path must be a regular file');
  if ((stat.mode & 0o022) !== 0) throw new Error('config file has unsafe permissions');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = normalizeConfig(raw);
  return {
    path: file,
    existed: true,
    config,
    resolved: resolveConfigPaths(config),
  };
}

function saveConfig(config, configPath) {
  const normalized = normalizeConfig(config);
  const file = path.resolve(expandHome(configPath || defaultConfigPath(normalized.controlRoot)));
  ensureDir(path.dirname(file), 'config directory');
  atomicWriteJson(file, normalized);
  return {
    path: file,
    config: normalized,
    resolved: resolveConfigPaths(normalized),
  };
}

function ensureControlPlane(config) {
  const resolved = resolveConfigPaths(config);
  ensureDir(resolved.controlRoot, 'control root');
  if (!fs.existsSync(resolved.publicCatalogPath)) {
    atomicWriteJson(resolved.publicCatalogPath, {
      schemaVersion: 'jarvos.shared-skill-catalog/v1',
      entries: [],
    });
  }
  if (resolved.localOverlayPath && !fs.existsSync(resolved.localOverlayPath)) {
    atomicWriteJson(resolved.localOverlayPath, {
      schemaVersion: 'jarvos.shared-skill-local-overlay/v1',
      entries: [],
    });
  }
  return resolved;
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONTROL_ROOT,
  DEFAULT_HARNESS_ROOTS,
  SUPPORTED_HARNESSES,
  expandHome,
  collapseHome,
  defaultConfig,
  normalizeConfig,
  resolveConfigPaths,
  defaultConfigPath,
  loadConfig,
  saveConfig,
  ensureControlPlane,
  ensureDir,
  atomicWriteJson,
};
