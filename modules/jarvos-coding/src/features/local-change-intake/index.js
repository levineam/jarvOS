'use strict';

const crypto = require('crypto');
const { localChangeRoute } = require('../../lifecycle/local-change-policy');

const LOCAL_CHANGE_INTAKE_SCHEMA_VERSION = 'jarvos-coding-local-change-intake/v1';
const DEFAULT_IGNORED_PATH_SEGMENTS = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '.git']);

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedPaths(paths) {
  const values = Array.isArray(paths) ? paths : [];
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.replace(/\\/g, '/').replace(/^\.\//, '')))]
    .sort();
}

function isIgnoredPath(filePath, ignoredSegments = DEFAULT_IGNORED_PATH_SEGMENTS) {
  return filePath.split('/').some((segment) => ignoredSegments.has(segment));
}

function visiblePaths(paths) {
  return normalizedPaths(paths).filter((filePath) => !isIgnoredPath(filePath));
}

function privacyOutcome(input = {}) {
  const scan = input && typeof input === 'object' ? input : {};
  const required = scan.required === true;
  const status = typeof scan.status === 'string' ? scan.status : required ? 'unavailable' : 'not-required';
  const blocked = required && ['match', 'error', 'unavailable'].includes(status);
  const reason = blocked ? `privacy-scan-${status}` : null;
  const reasonCodes = Array.isArray(scan.reasonCodes)
    ? scan.reasonCodes.filter((value) => typeof value === 'string' && /^[a-z0-9._-]{1,80}$/i.test(value)).slice(0, 16)
    : [];
  return { required, status, blocked, reason, reasonCodes };
}

function changeSet(repository, paths) {
  if (!repository || typeof repository.canonicalId !== 'string' || !repository.canonicalId) {
    throw new Error('repository.canonicalId is required');
  }
  const baseRef = typeof repository.baseRef === 'string' && repository.baseRef ? repository.baseRef : 'unknown';
  const id = `change-set:${sha256({ canonicalId: repository.canonicalId, baseRef, paths })}`;
  const aliases = [
    `repository:${sha256(repository.canonicalId)}`,
    ...(typeof repository.branch === 'string' && repository.branch ? [`branch:${sha256(repository.branch)}`] : []),
    ...(typeof repository.worktreeId === 'string' && repository.worktreeId ? [`worktree:${sha256(repository.worktreeId)}`] : []),
  ];
  return { id, aliases };
}

function assessLocalChange({ repository, catalogEntry = null, privacyScan = null } = {}) {
  const changedPaths = visiblePaths(repository && repository.changedPaths);
  if (!changedPaths.length) {
    return {
      schemaVersion: LOCAL_CHANGE_INTAKE_SCHEMA_VERSION,
      eventType: 'no_local_change',
      route: { kind: 'none' },
      publicRouting: { blocked: true, reason: 'no-local-change' },
      evidence: { changedPaths: [] },
    };
  }
  const privacy = privacyOutcome(privacyScan);
  const route = localChangeRoute(catalogEntry, privacy);
  return {
    schemaVersion: LOCAL_CHANGE_INTAKE_SCHEMA_VERSION,
    eventType: 'local_change_detected',
    changeSet: changeSet(repository, changedPaths),
    repository: { canonicalId: repository.canonicalId, baseRef: repository.baseRef || 'unknown' },
    catalogEntryId: catalogEntry && catalogEntry.id || null,
    evidence: { changedPaths },
    privacy,
    route: { kind: route.kind },
    publicRouting: route.publicRouting,
  };
}

module.exports = {
  DEFAULT_IGNORED_PATH_SEGMENTS,
  LOCAL_CHANGE_INTAKE_SCHEMA_VERSION,
  assessLocalChange,
  privacyOutcome,
  visiblePaths,
};
