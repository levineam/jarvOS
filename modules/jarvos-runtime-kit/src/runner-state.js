'use strict';

// This module is deliberately a read-only compatibility seam.  It has no
// default host path: callers must provide a fixture root.  Production adapters
// can adopt the declared jarvOS location later, after their own live-runtime
// gate; this contract must not inspect or migrate a user's installation.
const fs = require('node:fs');
const path = require('node:path');

const RUNNER_STATE_VERSION = 'jarvos-runner-state/v1';
const JARVOS_RUNNER_STATE_RELATIVE_PATH = '.jarvos/runner-state.json';
const LEGACY_OPENCLAW_RUNNER_STATE_RELATIVE_PATH = '.openclaw/cron/external-runner-state.json';
const ROUTE_ID_RE = /^[a-z][a-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._/-]{0,127})+$/;
const SECRET_STORE_REF_RE = /^[a-z][a-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._/@-]{0,255}$/;
// A revision is an opaque identifier, never a credential. Colons are
// intentionally excluded: they are required by Telegram bot-token shapes.
const OPAQUE_REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stateFailure(code) {
  return { ok: false, code };
}

function fixtureRootPath(fixtureRoot) {
  if (typeof fixtureRoot !== 'string' || !fixtureRoot.trim()) return null;
  return path.resolve(fixtureRoot);
}

function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(first, second) {
  return first && second && first.dev === second.dev && first.ino === second.ino;
}

// Read each existing component with lstat.  realpath alone is not sufficient:
// it would silently follow the very symlink this boundary must reject.
function inspectFixtureFile(relativePath, { fixtureRoot, fsImpl = fs } = {}) {
  const root = fixtureRootPath(fixtureRoot);
  if (!root) return { status: 'invalid-fixture-root' };
  if (!path.isAbsolute(root) || !relativePath || path.isAbsolute(relativePath)) return { status: 'invalid-path' };
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return { status: 'invalid-path' };

  let rootStat;
  try { rootStat = fsImpl.lstatSync(root); } catch (error) {
    return error && error.code === 'ENOENT' ? { status: 'missing-root' } : { status: 'unreadable' };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { status: 'unsafe-path' };

  const chain = [{ path: root, identity: identityOf(rootStat), directory: true }];
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fsImpl.lstatSync(current); } catch (error) {
      return error && error.code === 'ENOENT' ? { status: 'missing', path: current } : { status: 'unreadable' };
    }
    if (stat.isSymbolicLink()) return { status: 'unsafe-path' };
    if (index < parts.length - 1 && !stat.isDirectory()) return { status: 'unsafe-path' };
    if (index === parts.length - 1 && !stat.isFile()) return { status: 'unsafe-path' };
    chain.push({ path: current, identity: identityOf(stat), directory: index < parts.length - 1 });
  }
  return { status: 'present', path: current, root, chain };
}

function revalidateFixtureFile(inspected, { fsImpl = fs } = {}) {
  if (!inspected || inspected.status !== 'present' || !Array.isArray(inspected.chain)) return { status: 'unsafe-path' };
  if (path.relative(inspected.root, inspected.path).startsWith(`..${path.sep}`) || path.relative(inspected.root, inspected.path) === '..') {
    return { status: 'unsafe-path' };
  }
  for (const entry of inspected.chain) {
    let stat;
    try { stat = fsImpl.lstatSync(entry.path); } catch (_) { return { status: 'unsafe-path' }; }
    if (stat.isSymbolicLink() || !sameIdentity(entry.identity, identityOf(stat))
      || (entry.directory ? !stat.isDirectory() : !stat.isFile())) return { status: 'unsafe-path' };
  }
  return { status: 'present' };
}

// Open the already-inspected leaf with O_NOFOLLOW and read from the descriptor,
// not the path. Rechecking every ancestor after the read closes the remaining
// rename/symlink window before an accepted document can influence resolution.
function readPinnedFixtureFile(inspected, { fsImpl = fs } = {}) {
  const constants = fsImpl.constants || fs.constants;
  if (!Number.isInteger(constants?.O_RDONLY) || !Number.isInteger(constants?.O_NOFOLLOW)) return { ok: false, code: 'descriptor_nofollow_unavailable' };
  let descriptor;
  try {
    descriptor = fsImpl.openSync(inspected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return { ok: false, code: error?.code === 'ELOOP' ? 'unsafe-path' : 'runner_state_unreadable' };
  }
  try {
    const opened = fsImpl.fstatSync(descriptor);
    const expected = inspected.chain[inspected.chain.length - 1];
    if (!opened.isFile() || !sameIdentity(expected.identity, identityOf(opened))) return { ok: false, code: 'unsafe-path' };
    if (revalidateFixtureFile(inspected, { fsImpl }).status !== 'present') return { ok: false, code: 'unsafe-path' };
    const content = fsImpl.readFileSync(descriptor, 'utf8');
    const after = fsImpl.fstatSync(descriptor);
    if (!after.isFile() || !sameIdentity(expected.identity, identityOf(after))
      || revalidateFixtureFile(inspected, { fsImpl }).status !== 'present') return { ok: false, code: 'unsafe-path' };
    return { ok: true, content };
  } catch (_) {
    return { ok: false, code: 'runner_state_unreadable' };
  } finally {
    try { fsImpl.closeSync(descriptor); } catch (_) {}
  }
}

function parseRunnerState(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { return { ok: false, code: 'runner_state_unreadable' }; }
  if (!isObject(parsed) || parsed.version !== RUNNER_STATE_VERSION || !Array.isArray(parsed.routes)
    || Object.keys(parsed).some((key) => key !== 'version' && key !== 'routes')) {
    return { ok: false, code: 'runner_state_invalid' };
  }

  const routeIdentities = new Set();
  const routes = [];
  for (const candidate of parsed.routes) {
    if (!isObject(candidate)
      || Object.keys(candidate).some((key) => !['routeIdentity', 'secretStoreRef', 'revision'].includes(key))
      || typeof candidate.routeIdentity !== 'string' || !ROUTE_ID_RE.test(candidate.routeIdentity)
      || typeof candidate.secretStoreRef !== 'string' || !SECRET_STORE_REF_RE.test(candidate.secretStoreRef)
      || typeof candidate.revision !== 'string' || !OPAQUE_REVISION_RE.test(candidate.revision)
      || routeIdentities.has(candidate.routeIdentity)) {
      // Do not include an invalid value in this result: a malformed document
      // could itself contain a raw credential.
      return { ok: false, code: 'runner_state_invalid' };
    }
    routeIdentities.add(candidate.routeIdentity);
    routes.push(Object.freeze({
      routeIdentity: candidate.routeIdentity,
      secretStoreRef: candidate.secretStoreRef,
      revision: candidate.revision,
    }));
  }
  return { ok: true, state: Object.freeze({ version: RUNNER_STATE_VERSION, routes: Object.freeze(routes) }) };
}

function logCompatibility(logger, event) {
  // Events contain a source label only; never surface fixture paths or parsed
  // values through diagnostics. The event is also returned as required
  // evidence, so an omitted observer cannot make a fallback invisible.
  if (typeof logger === 'function') logger(event);
}

function readCandidate(relativePath, options) {
  const inspected = inspectFixtureFile(relativePath, options);
  if (inspected.status !== 'present') return inspected;
  const pinned = readPinnedFixtureFile(inspected, options);
  if (!pinned.ok) return { status: pinned.code };
  const parsed = parseRunnerState(pinned.content);
  return parsed.ok ? { status: 'present', state: parsed.state } : { status: parsed.code };
}

function equivalentRoutes(first, second) {
  return first.routeIdentity === second.routeIdentity
    && first.secretStoreRef === second.secretStoreRef
    && first.revision === second.revision;
}

function telegramRoutes(state) {
  // Identity remains opaque and unmodified. Telegram is simply a route
  // dimension: legacy `openclaw:telegram:*`, `hermes:telegram:*`, and future
  // `<adapter>:telegram:*` identities all retain their original form.
  return state.routes.filter((route) => route.routeIdentity.split(':').includes('telegram'));
}

function telegramRoute(state) {
  const matches = telegramRoutes(state);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Read a declared runner state from an explicitly supplied fixture tree.
 * jarvOS state wins.  A legacy document is considered only when the jarvOS
 * document is absent, and is never written or migrated.
 */
function readRunnerState({ fixtureRoot, fsImpl = fs, logger } = {}) {
  const options = { fixtureRoot, fsImpl };
  const primary = readCandidate(JARVOS_RUNNER_STATE_RELATIVE_PATH, options);
  if (primary.status === 'invalid-fixture-root') return stateFailure('fixture_root_required');
  if (primary.status !== 'present' && primary.status !== 'missing') return stateFailure(primary.status);

  const legacy = readCandidate(LEGACY_OPENCLAW_RUNNER_STATE_RELATIVE_PATH, options);
  if (legacy.status !== 'present' && legacy.status !== 'missing') return stateFailure(legacy.status);

  if (primary.status === 'present') {
    // A legacy document must not quietly disagree with a selected jarvOS
    // Telegram route.  Equivalent documents are harmless; differing route
    // identities, pointers, or revisions are ambiguous and fail closed.
    if (legacy.status === 'present') {
      const primaryTelegram = telegramRoute(primary.state);
      const legacyTelegramRoutes = telegramRoutes(legacy.state);
      if (legacyTelegramRoutes.length > 1) return stateFailure('legacy_telegram_credential_reference_ambiguous');
      const legacyTelegram = legacyTelegramRoutes[0] || null;
      if (primaryTelegram && legacyTelegram && !equivalentRoutes(primaryTelegram, legacyTelegram)) {
        return stateFailure('runner_state_conflict');
      }
    }
    return { ok: true, source: 'jarvos', compatibility: null, state: primary.state };
  }
  if (legacy.status === 'present') {
    if (telegramRoutes(legacy.state).length > 1) return stateFailure('legacy_telegram_credential_reference_ambiguous');
    const event = Object.freeze({ event: 'jarvos.runner_state.legacy_fallback', source: 'legacy-openclaw', readOnly: true });
    logCompatibility(logger, event);
    return {
      ok: true,
      source: 'legacy-openclaw',
      compatibility: Object.freeze({ readOnly: true, migration: false, evidence: Object.freeze([event]) }),
      state: legacy.state,
    };
  }
  return stateFailure('runner_state_missing');
}

/** Resolve the one Telegram route without ever reading or returning a token. */
function resolveTelegramCredentialReference(options = {}) {
  const resolved = readRunnerState(options);
  if (!resolved.ok) return resolved;
  const route = telegramRoute(resolved.state);
  if (!route) return stateFailure('telegram_credential_reference_ambiguous');
  return {
    ok: true,
    source: resolved.source,
    compatibility: resolved.compatibility,
    credential: route,
  };
}

module.exports = {
  JARVOS_RUNNER_STATE_RELATIVE_PATH,
  LEGACY_OPENCLAW_RUNNER_STATE_RELATIVE_PATH,
  RUNNER_STATE_VERSION,
  readRunnerState,
  resolveTelegramCredentialReference,
};
