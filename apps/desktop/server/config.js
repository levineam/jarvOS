'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function expandTilde(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function expandDeep(value) {
  if (typeof value === 'string') return expandTilde(value);
  if (Array.isArray(value)) return value.map(expandDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v);
    return out;
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectPrototypeKeys(value, label = 'configuration') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrototypeKeys(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`${label} contains forbidden key ${key}`);
    }
    rejectPrototypeKeys(item, `${label}.${key}`);
  }
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    throw new Error('configuration objects are required for deep merge');
  }
  rejectPrototypeKeys(override);
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value)
      ? deepMerge(base[key] || {}, value)
      : value;
  }
  return out;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${label} is missing or malformed: ${err.message}`);
  }
}

function nullableString(value, name) {
  if (value !== null && typeof value !== 'string') throw new Error(`${name} must be a string or null`);
}

function validateConfig(cfg) {
  if (!isPlainObject(cfg)) throw new Error('Desktop configuration must be a JSON object');
  rejectPrototypeKeys(cfg, 'Desktop configuration');
  for (const key of ['vault', 'memory', 'paperclip', 'projectsContext', 'whisper', 'systemDoctor']) {
    if (!isPlainObject(cfg[key])) throw new Error(`Desktop configuration.${key} must be an object`);
  }
  for (const [value, name] of [
    [cfg.vault.root, 'vault.root'], [cfg.vault.journalDir, 'vault.journalDir'], [cfg.vault.notesDir, 'vault.notesDir'],
    [cfg.ontologyDir, 'ontologyDir'], [cfg.memory.indexFile, 'memory.indexFile'], [cfg.memory.dailyDir, 'memory.dailyDir'],
    [cfg.paperclip.url, 'paperclip.url'], [cfg.paperclip.companyId, 'paperclip.companyId'], [cfg.paperclip.projectId, 'paperclip.projectId'], [cfg.paperclip.authFile, 'paperclip.authFile'],
    [cfg.projectsContext.contextModule, 'projectsContext.contextModule'], [cfg.whisper.binary, 'whisper.binary'], [cfg.whisper.ffmpeg, 'whisper.ffmpeg'], [cfg.whisper.model, 'whisper.model'],
    [cfg.jarvosRepo, 'jarvosRepo'], [cfg.systemDoctor.workspace, 'systemDoctor.workspace'], [cfg.systemDoctor.profile, 'systemDoctor.profile'], [cfg.systemDoctor.receiptFile, 'systemDoctor.receiptFile'],
  ]) nullableString(value, name);
  if (!Array.isArray(cfg.whisper.args)) throw new Error('whisper.args must be an array');
  if (typeof cfg.whisper.timeoutMs !== 'number' || !Number.isFinite(cfg.whisper.timeoutMs)) throw new Error('whisper.timeoutMs must be a number');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('port must be a TCP port between 1 and 65535');
}

function loadConfig({ env = process.env } = {}) {
  const defaultPath = path.join(__dirname, '..', 'config.default.json');
  const defaults = readJson(defaultPath, 'Desktop default configuration');
  const hasOverride = Object.hasOwn(env, 'JARVOS_DESKTOP_CONFIG') && env.JARVOS_DESKTOP_CONFIG !== undefined;
  const overridePath = env.JARVOS_DESKTOP_CONFIG;
  if (hasOverride && (typeof overridePath !== 'string' || !overridePath.trim())) {
    throw new Error('JARVOS_DESKTOP_CONFIG must name a configuration file');
  }
  const override = hasOverride ? readJson(expandTilde(overridePath), 'JARVOS_DESKTOP_CONFIG') : {};
  if (!isPlainObject(override)) throw new Error('JARVOS_DESKTOP_CONFIG must contain a JSON object');
  const cfg = expandDeep(deepMerge(defaults, override));
  if (env.JARVOS_DESKTOP_PROJECTS_CONTEXT_MODULE) {
    cfg.projectsContext = { ...cfg.projectsContext, contextModule: expandTilde(env.JARVOS_DESKTOP_PROJECTS_CONTEXT_MODULE) };
  }
  if (env.PORT !== undefined) cfg.port = Number(env.PORT);
  validateConfig(cfg);
  // The app's own root (the repo containing this server). Derived, not read
  // from config.json — `jarvosRepo` points at a *different* repo (~/jarvOS).
  // Self-introspection tools confine all reads to this directory.
  cfg.appRoot = path.join(__dirname, '..');
  return cfg;
}

module.exports = { loadConfig, expandTilde, deepMerge, validateConfig };
