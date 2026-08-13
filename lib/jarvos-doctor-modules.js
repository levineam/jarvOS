'use strict';

const fs = require('fs');
const path = require('path');

const MODULE_SNAPSHOT_SCHEMA = 'jarvos-health-module-snapshot/v1';
const HEALTH_MODULE_DIRECTORY = path.join('.jarvos', 'health-modules');
const PUBLIC_MODULE_ID = 'memory';
const PUBLIC_MODULE_FILE = `${PUBLIC_MODULE_ID}.json`;
const PUBLIC_STATES = Object.freeze([
  'healthy',
  'update available',
  'repair needed',
  'needs your attention',
]);
const SNAPSHOT_FIELDS = Object.freeze([
  'schema',
  'moduleId',
  'generation',
  'observedAt',
  'validUntil',
  'trust',
  'repairable',
  'updateAvailable',
]);

function modulePath(workspace) {
  return path.join(path.resolve(workspace), HEALTH_MODULE_DIRECTORY, PUBLIC_MODULE_FILE);
}

function ownerOnly(stat) {
  // Windows does not expose a meaningful uid. The mode check still protects
  // the portable contract where it is available.
  const mode = stat?.mode;
  if (typeof mode === 'number' && (mode & 0o077) !== 0) return false;
  if (typeof process.getuid === 'function' && typeof stat?.uid === 'number' && stat.uid !== process.getuid()) return false;
  return true;
}

function ownedHealthDirectory(workspace, fsImpl = fs) {
  const root = path.resolve(workspace || '');
  const directory = path.resolve(root, HEALTH_MODULE_DIRECTORY);
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) {
    return { ok: false, reasonClass: 'module-invalid' };
  }

  try {
    const stat = fsImpl.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOnly(stat)) {
      return { ok: false, reasonClass: 'module-invalid' };
    }
    return { ok: true, directory };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, missing: true, directory };
    return { ok: false, reasonClass: 'module-invalid' };
  }
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function publicAttention(reasonClass = 'module-invalid', details = {}) {
  return {
    id: PUBLIC_MODULE_ID,
    state: 'needs your attention',
    generation: Number.isSafeInteger(details.generation) ? details.generation : 0,
    observedAt: details.observedAt || null,
    validUntil: details.validUntil || null,
    reasonClass,
  };
}

function validateSnapshot(snapshot, now = new Date()) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  const expectedFields = SNAPSHOT_FIELDS.slice().sort();
  const keys = Object.keys(snapshot).sort();
  if (keys.length !== expectedFields.length || keys.some((key, index) => key !== expectedFields[index])) {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  if (snapshot.schema !== MODULE_SNAPSHOT_SCHEMA || snapshot.moduleId !== PUBLIC_MODULE_ID) {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1) {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  const observedAt = isoDate(snapshot.observedAt);
  const validUntil = isoDate(snapshot.validUntil);
  if (!observedAt || !validUntil || validUntil <= observedAt || observedAt > now) {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  if (!['trusted', 'untrusted'].includes(snapshot.trust)) {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  if (typeof snapshot.repairable !== 'boolean' || typeof snapshot.updateAvailable !== 'boolean') {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  return { ok: true, snapshot, observedAt, validUntil };
}

function reduceHealthModule(snapshot, { now = new Date(), validation = null } = {}) {
  const checked = validation || validateSnapshot(snapshot, now);
  if (!checked.ok) return publicAttention(checked.reasonClass);

  let state = 'healthy';
  let reasonClass = 'none';
  if (snapshot.trust !== 'trusted') {
    state = 'needs your attention';
    reasonClass = 'module-untrusted';
  } else if (checked.validUntil <= now) {
    state = 'needs your attention';
    reasonClass = 'module-stale';
  } else if (snapshot.repairable) {
    state = 'repair needed';
    reasonClass = 'repairable-fault';
  } else if (snapshot.updateAvailable) {
    state = 'update available';
    reasonClass = 'update-available';
  }

  return {
    id: PUBLIC_MODULE_ID,
    state,
    generation: snapshot.generation,
    observedAt: snapshot.observedAt,
    validUntil: snapshot.validUntil,
    reasonClass,
  };
}

function loadHealthModules({ workspace, now = new Date(), fsImpl = fs } = {}) {
  const directory = ownedHealthDirectory(workspace, fsImpl);
  if (!directory.ok) {
    return { modules: [publicAttention(directory.reasonClass)], issues: [directory.reasonClass] };
  }
  if (directory.missing) return { modules: [], issues: [] };

  const filePath = path.join(directory.directory, PUBLIC_MODULE_FILE);
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { modules: [], issues: [] };
    return { modules: [publicAttention()], issues: ['module-invalid'] };
  }

  if (!stat.isFile() || stat.isSymbolicLink() || !ownerOnly(stat)) {
    return { modules: [publicAttention()], issues: ['module-invalid'] };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch {
    return { modules: [publicAttention()], issues: ['module-invalid'] };
  }

  const validation = validateSnapshot(snapshot, now);
  if (!validation.ok) {
    return { modules: [publicAttention(validation.reasonClass)], issues: [validation.reasonClass] };
  }
  const module = reduceHealthModule(snapshot, { now, validation });
  return { modules: [module], issues: [] };
}

module.exports = {
  HEALTH_MODULE_DIRECTORY,
  MODULE_SNAPSHOT_SCHEMA,
  PUBLIC_MODULE_ID,
  PUBLIC_STATES,
  PUBLIC_MODULE_FILE,
  loadHealthModules,
  modulePath,
  ownerOnly,
  reduceHealthModule,
  validateSnapshot,
};
