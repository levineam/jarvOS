'use strict';

// Pure repository -> canonical Project binding. The host supplies bindings and
// an observation already reduced to host-keyed digests; this module only
// decides, with fixed precedence, whether that observation binds to exactly
// one canonical record. Ambiguous or unmapped observations never guess: they
// resolve to `unattributed` with a typed reason.
//
// Precedence: explicit worktree -> repository + pull request -> repository +
// branch -> single unqualified repository binding.

const crypto = require('node:crypto');

const REPO_BINDING_CONTRACT = 'jarvos.repo-binding/v1';
const REPO_OBSERVATION_CONTRACT = 'jarvos.repo-observation/v1';
const BINDING_FIELDS = Object.freeze(['contract', 'canonicalId', 'repositoryDigest', 'worktreeDigest', 'branchDigest', 'pullRequest']);
const OBSERVATION_FIELDS = Object.freeze(['contract', 'repositoryDigest', 'worktreeDigest', 'branchDigest', 'pullRequest']);
const BINDING_TIERS = Object.freeze(['worktree', 'pull_request', 'branch', 'repository']);
const UNATTRIBUTED_REASONS = Object.freeze(['unmapped', 'ambiguous', 'unqualified', 'invalid']);
const MAX_BINDINGS = 512;
const TOKEN_KINDS = Object.freeze(['repository', 'worktree', 'branch', 'session']);

const DIGEST = /^[a-f0-9]{64}$/;
const CANONICAL_ID = /^(?:prj|out)_[0-9]{6,}$/;

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function digestOrNull(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${field} must be a sha256 digest or null`);
  return value;
}

function pullRequestOrNull(value, field) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) throw new TypeError(`${field} must be a positive pull request number or null`);
  return value;
}

// Normalizes a Git remote to `host/owner/repo` so https, ssh, scp-like, and
// credential-bearing spellings of the same remote agree. Credentials, ports,
// schemes, and a trailing `.git` are dropped. The result is only ever used as
// input to a host-keyed digest; it is never persisted by this module.
function normalizeRemote(remote) {
  if (typeof remote !== 'string') return null;
  let value = remote.trim();
  if (!value || value.length > 1024 || /\s/.test(value)) return null;
  let host;
  let pathname;
  const scp = value.match(/^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { return null; }
    host = parsed.hostname;
    pathname = parsed.pathname;
  } else if (scp) {
    host = scp[1];
    pathname = scp[2];
  } else {
    return null;
  }
  host = String(host || '').toLowerCase();
  pathname = String(pathname || '').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
  const parts = pathname.split('/');
  // A normalized remote names at least an owner and a repository.
  if (!host || !/^[a-z0-9.-]+$/.test(host) || parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')) return null;
  return `${host}/${pathname}`;
}

function normalizeBranch(branch) {
  if (typeof branch !== 'string') return null;
  const value = branch.trim().replace(/^refs\/heads\//, '');
  if (!value || value === 'HEAD' || value.length > 255 || /[\s~^:?*[\\]|\.\.|@\{/.test(value)) return null;
  return value;
}

// Host-keyed digest for one repository-identity dimension. Domain separation
// by kind keeps a branch named like a repository from colliding with it.
function bindingToken(kind, value, secret) {
  if (!TOKEN_KINDS.includes(kind)) throw new TypeError('binding token kind is unsupported');
  if (typeof value !== 'string' || !value) throw new TypeError('binding token value is required');
  if (!(typeof secret === 'string' && secret.length > 0) && !(Buffer.isBuffer(secret) && secret.length > 0)) {
    throw new TypeError('binding token secret is required');
  }
  return crypto.createHmac('sha256', secret).update(`${REPO_BINDING_CONTRACT}\0${kind}\0${value}`).digest('hex');
}

function validateRepoBinding(binding) {
  if (!exactKeys(binding, BINDING_FIELDS)) throw new TypeError('repo binding has unsupported fields');
  if (binding.contract !== REPO_BINDING_CONTRACT) throw new TypeError('repo binding has an unsupported contract');
  if (typeof binding.canonicalId !== 'string' || !CANONICAL_ID.test(binding.canonicalId)) throw new TypeError('repo binding canonicalId is invalid');
  if (typeof binding.repositoryDigest !== 'string' || !DIGEST.test(binding.repositoryDigest)) throw new TypeError('repo binding repositoryDigest is invalid');
  const normalized = {
    contract: REPO_BINDING_CONTRACT,
    canonicalId: binding.canonicalId,
    repositoryDigest: binding.repositoryDigest,
    worktreeDigest: digestOrNull(binding.worktreeDigest, 'repo binding worktreeDigest'),
    branchDigest: digestOrNull(binding.branchDigest, 'repo binding branchDigest'),
    pullRequest: pullRequestOrNull(binding.pullRequest, 'repo binding pullRequest'),
  };
  const qualifiers = [normalized.worktreeDigest, normalized.branchDigest, normalized.pullRequest].filter((value) => value !== null);
  if (qualifiers.length > 1) throw new TypeError('repo binding may carry at most one qualifier');
  return normalized;
}

function createRepoBinding(input) {
  if (!isPlainObject(input) || Object.prototype.hasOwnProperty.call(input, 'contract')) throw new TypeError('repo binding input must not assert its own contract');
  return validateRepoBinding({
    contract: REPO_BINDING_CONTRACT,
    canonicalId: input.canonicalId,
    repositoryDigest: input.repositoryDigest,
    worktreeDigest: input.worktreeDigest ?? null,
    branchDigest: input.branchDigest ?? null,
    pullRequest: input.pullRequest ?? null,
  });
}

function validateRepoObservation(observation) {
  if (!exactKeys(observation, OBSERVATION_FIELDS)) throw new TypeError('repo observation has unsupported fields');
  if (observation.contract !== REPO_OBSERVATION_CONTRACT) throw new TypeError('repo observation has an unsupported contract');
  if (typeof observation.repositoryDigest !== 'string' || !DIGEST.test(observation.repositoryDigest)) throw new TypeError('repo observation repositoryDigest is invalid');
  return {
    contract: REPO_OBSERVATION_CONTRACT,
    repositoryDigest: observation.repositoryDigest,
    worktreeDigest: digestOrNull(observation.worktreeDigest, 'repo observation worktreeDigest'),
    branchDigest: digestOrNull(observation.branchDigest, 'repo observation branchDigest'),
    pullRequest: pullRequestOrNull(observation.pullRequest, 'repo observation pullRequest'),
  };
}

// Reduces transient host facts to a digest-only observation. `repositoryKey`
// is the normalized remote when one exists, otherwise a host-chosen stable
// identity such as the resolved Git common directory -- which a linked
// worktree shares with its primary checkout, so both produce the same
// repository digest. `worktreeKey` is that worktree's own identity.
function createRepoObservation({ repositoryKey, worktreeKey = null, branch = null, pullRequest = null } = {}, secret) {
  if (typeof repositoryKey !== 'string' || !repositoryKey) throw new TypeError('repositoryKey is required');
  const normalizedBranch = branch === null ? null : normalizeBranch(branch);
  return validateRepoObservation({
    contract: REPO_OBSERVATION_CONTRACT,
    repositoryDigest: bindingToken('repository', repositoryKey, secret),
    worktreeDigest: typeof worktreeKey === 'string' && worktreeKey ? bindingToken('worktree', worktreeKey, secret) : null,
    branchDigest: normalizedBranch ? bindingToken('branch', normalizedBranch, secret) : null,
    pullRequest: pullRequest === null ? null : pullRequestOrNull(pullRequest, 'pullRequest'),
  });
}

function tierOf(binding) {
  if (binding.worktreeDigest !== null) return 'worktree';
  if (binding.pullRequest !== null) return 'pull_request';
  if (binding.branchDigest !== null) return 'branch';
  return 'repository';
}

function tierMatches(tier, binding, observation) {
  if (tier === 'worktree') return observation.worktreeDigest !== null && binding.worktreeDigest === observation.worktreeDigest;
  if (tier === 'pull_request') return observation.pullRequest !== null && binding.pullRequest === observation.pullRequest;
  if (tier === 'branch') return observation.branchDigest !== null && binding.branchDigest === observation.branchDigest;
  return true;
}

function unattributed(reason, tier = null) {
  return { status: 'unattributed', reason, tier, canonicalId: null };
}

// Resolves one observation. Returns
//   { status: 'bound', canonicalId, tier }
// or { status: 'unattributed', reason: 'unmapped'|'ambiguous'|'unqualified'|'invalid', tier }.
// `unqualified` means the repository is known but is shared by qualified
// bindings only and the observation carried no matching qualifier: the
// shared-repo case, where no child is guessed.
function resolveRepoBinding({ bindings, observation } = {}) {
  let normalizedObservation;
  let normalizedBindings;
  try {
    normalizedObservation = validateRepoObservation(observation);
    if (!Array.isArray(bindings) || bindings.length > MAX_BINDINGS) throw new TypeError('bindings must be a bounded array');
    normalizedBindings = bindings.map(validateRepoBinding);
  } catch (_) {
    return unattributed('invalid');
  }
  const candidates = normalizedBindings.filter((binding) => binding.repositoryDigest === normalizedObservation.repositoryDigest);
  if (!candidates.length) return unattributed('unmapped');
  for (const tier of BINDING_TIERS) {
    const matches = candidates.filter((binding) => tierOf(binding) === tier && tierMatches(tier, binding, normalizedObservation));
    const targets = [...new Set(matches.map((binding) => binding.canonicalId))];
    if (targets.length > 1) return unattributed('ambiguous', tier);
    if (targets.length === 1) return { status: 'bound', reason: null, tier, canonicalId: targets[0] };
  }
  return unattributed('unqualified');
}

module.exports = {
  BINDING_FIELDS,
  BINDING_TIERS,
  MAX_BINDINGS,
  OBSERVATION_FIELDS,
  REPO_BINDING_CONTRACT,
  REPO_OBSERVATION_CONTRACT,
  TOKEN_KINDS,
  UNATTRIBUTED_REASONS,
  bindingToken,
  createRepoBinding,
  createRepoObservation,
  normalizeBranch,
  normalizeRemote,
  resolveRepoBinding,
  validateRepoBinding,
  validateRepoObservation,
};
