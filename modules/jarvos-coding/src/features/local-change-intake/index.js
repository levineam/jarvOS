'use strict';

const crypto = require('crypto');
const { localChangeRoute } = require('../../lifecycle/local-change-policy');

const LOCAL_CHANGE_INTAKE_SCHEMA_VERSION = 'jarvos-coding-local-change-intake/v1';
const LOCAL_CHANGE_EVENT_TYPES = Object.freeze([
  'local_change_detected',
  'upstream_update_available',
  'integration_impact_detected',
]);
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

function normalizedUnmergedBranches(branches) {
  const records = Array.isArray(branches) ? branches : [];
  return records
    .filter((branch) => branch && typeof branch.name === 'string' && branch.name.trim())
    .map((branch) => ({
      name: branch.name.trim(),
      commits: [...new Set((Array.isArray(branch.commits) ? branch.commits : [])
        .filter((commit) => typeof commit === 'string' && /^[a-f0-9]{1,64}$/i.test(commit)))]
        .sort(),
    }))
    .filter((branch) => branch.commits.length)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function privacyOutcome(input = {}, { required = false } = {}) {
  const scan = input && typeof input === 'object' ? input : {};
  const scanRequired = required || scan.required === true;
  const status = typeof scan.status === 'string' ? scan.status : scanRequired ? 'unavailable' : 'not-required';
  const blocked = scanRequired && ['match', 'error', 'unavailable'].includes(status);
  const reason = blocked ? `privacy-scan-${status}` : null;
  const reasonCodes = Array.isArray(scan.reasonCodes)
    ? scan.reasonCodes.filter((value) => typeof value === 'string' && /^[a-z0-9._-]{1,80}$/i.test(value)).slice(0, 16)
    : [];
  return { required: scanRequired, status, blocked, reason, reasonCodes };
}

function normalizeLocalRefInventory(refs) {
  return (Array.isArray(refs) ? refs : [])
    .filter((ref) => ref && typeof ref.name === 'string' && ref.name.trim())
    .map((ref) => ({
      name: ref.name.trim(),
      head: typeof ref.head === 'string' && /^[a-f0-9]{1,64}$/i.test(ref.head) ? ref.head : null,
      mergeBase: typeof ref.mergeBase === 'string' && /^[a-f0-9]{1,64}$/i.test(ref.mergeBase) ? ref.mergeBase : null,
      reachableFromIntegration: typeof ref.reachableFromIntegration === 'boolean' ? ref.reachableFromIntegration : null,
      commitsAhead: Number.isInteger(ref.commitsAhead) && ref.commitsAhead >= 0 ? ref.commitsAhead : null,
      worktreeAttached: ref.worktreeAttached === true,
      upstream: typeof ref.upstream === 'string'
        ? ref.upstream
        : typeof ref.upstream?.status === 'string' ? ref.upstream.status : 'unknown',
      lastActivityAt: typeof ref.lastActivityAt === 'string' ? ref.lastActivityAt : null,
      aliases: [...new Set((Array.isArray(ref.aliases) ? ref.aliases : [])
        .filter((alias) => typeof alias === 'string' && alias.trim())
        .map((alias) => alias.trim()))].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function requiresPrivacyScan(catalogEntry) {
  if (!catalogEntry) return false;
  return localChangeRoute(catalogEntry, { blocked: false, reason: null }).publicRouting.blocked === false;
}

function changeSet(repository, paths, unmergedBranches, localRefInventory) {
  if (!repository || typeof repository.canonicalId !== 'string' || !repository.canonicalId) {
    throw new Error('repository.canonicalId is required');
  }
  const baseRef = typeof repository.baseRef === 'string' && repository.baseRef ? repository.baseRef : 'unknown';
  const id = `change-set:${sha256({ canonicalId: repository.canonicalId, baseRef, paths, unmergedBranches })}`;
  const aliases = [
    `repository:${sha256(repository.canonicalId)}`,
    ...(typeof repository.branch === 'string' && repository.branch ? [`branch:${sha256(repository.branch)}`] : []),
    ...(typeof repository.worktreeId === 'string' && repository.worktreeId ? [`worktree:${sha256(repository.worktreeId)}`] : []),
    ...localRefInventory.flatMap((ref) => [
      `ref:${sha256(ref.name)}`,
      ...(ref.head ? [`commit:${sha256(ref.head)}`] : []),
      ...ref.aliases.map((alias) => `ref-alias:${sha256(alias)}`),
    ]),
  ];
  return { id, aliases: [...new Set(aliases)].sort() };
}

function packagingDecision(route, publicRouting) {
  if (publicRouting.blocked) return { decision: 'retain-private', reason: publicRouting.reason };
  if (route.kind === 'jarvos-release-proposal') return { decision: 'extract-portable-change', reason: 'jarvos-owned-public-policy' };
  if (route.kind === 'independent-project') return { decision: 'package-for-project', reason: 'independent-project-policy' };
  if (route.kind === 'external-integration') return { decision: 'prepare-external-policy-review', reason: 'third-party-policy' };
  return { decision: 'none', reason: route.kind };
}

function assessLocalChange({ repository, catalogEntry = null, privacyScan = null } = {}) {
  const changedPaths = visiblePaths(repository && repository.changedPaths);
  const unmergedBranches = normalizedUnmergedBranches(repository && repository.unmergedBranches);
  const localRefInventory = normalizeLocalRefInventory(repository && repository.localRefs);
  const unmergedInventory = localRefInventory.filter((ref) => ref.reachableFromIntegration === false || (ref.commitsAhead || 0) > 0);
  if (!changedPaths.length && !unmergedBranches.length && !unmergedInventory.length) {
    return {
      schemaVersion: LOCAL_CHANGE_INTAKE_SCHEMA_VERSION,
      eventType: 'no_local_change',
      route: { kind: 'none' },
      publicRouting: { blocked: true, reason: 'no-local-change' },
      evidence: { changedPaths: [] },
    };
  }
  const privacy = privacyOutcome(privacyScan, { required: requiresPrivacyScan(catalogEntry) });
  const route = localChangeRoute(catalogEntry, privacy);
  const publicRouting = route.publicRouting;
  return {
    schemaVersion: LOCAL_CHANGE_INTAKE_SCHEMA_VERSION,
    eventType: 'local_change_detected',
    changeSet: changeSet(repository, changedPaths, unmergedBranches, localRefInventory),
    repository: {
      canonicalId: repository.canonicalId,
      baseRef: repository.baseRef || 'unknown',
      integrationBranch: repository.integrationBranch || repository.baseRef || 'unknown',
    },
    catalogEntryId: catalogEntry && catalogEntry.id || null,
    evidence: {
      changedPaths,
      unmergedBranchCount: unmergedBranches.length,
      unmergedCommitCount: unmergedBranches.reduce((total, branch) => total + branch.commits.length, 0),
      localRefInventory,
    },
    privacy,
    route: { kind: route.kind },
    reusableChange: { status: 'candidate', reason: changedPaths.length ? 'visible-local-paths' : 'unmerged-local-ref' },
    destination: { kind: route.kind, visibility: publicRouting.blocked ? 'private' : 'public' },
    packaging: packagingDecision(route, publicRouting),
    publicRouting,
  };
}

module.exports = {
  DEFAULT_IGNORED_PATH_SEGMENTS,
  LOCAL_CHANGE_EVENT_TYPES,
  LOCAL_CHANGE_INTAKE_SCHEMA_VERSION,
  assessLocalChange,
  normalizedUnmergedBranches,
  normalizeLocalRefInventory,
  privacyOutcome,
  visiblePaths,
};
