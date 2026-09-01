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
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
  }
  return { status: 'present', path: current };
}

function parseRunnerState(filePath, { fsImpl = fs } = {}) {
  let parsed;
  try { parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8')); } catch (_) { return { ok: false, code: 'runner_state_unreadable' }; }
  if (!isObject(parsed) || parsed.version !== RUNNER_STATE_VERSION || !Array.isArray(parsed.routes)
    || Object.keys(parsed).some((key) => key !== 'version' && key !== 'routes')) {
    return { ok: false, code: 'runner_state_invalid' };
  }

  const routeIdentities = new Set();
  const routes = [];
  for (const candidate of parsed.routes) {
    if (!isObject(candidate)
      || Object.keys(candidate).some((key) => !['routeIdentity', 'secretStoreRef', 'revision'].includes(key))
      || !ROUTE_ID_RE.test(candidate.routeIdentity || '')
      || !SECRET_STORE_REF_RE.test(candidate.secretStoreRef || '')
      || !REVISION_RE.test(candidate.revision || '')
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
  if (typeof logger !== 'function') return;
  // Events contain a source label only; never surface fixture paths or parsed
  // values through diagnostics.
  logger(Object.freeze({ event, source: 'legacy-openclaw', readOnly: true }));
}

function readCandidate(relativePath, options) {
  const inspected = inspectFixtureFile(relativePath, options);
  if (inspected.status !== 'present') return inspected;
  const parsed = parseRunnerState(inspected.path, options);
  return parsed.ok ? { status: 'present', state: parsed.state } : { status: parsed.code };
}

function equivalentRoutes(first, second) {
  return first.routeIdentity === second.routeIdentity
    && first.secretStoreRef === second.secretStoreRef
    && first.revision === second.revision;
}

function telegramRoute(state) {
  const matches = state.routes.filter((route) => route.routeIdentity.startsWith('telegram:'));
  if (matches.length !== 1) return null;
  return matches[0];
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
      const legacyTelegram = telegramRoute(legacy.state);
      if (primaryTelegram && legacyTelegram && !equivalentRoutes(primaryTelegram, legacyTelegram)) {
        return stateFailure('runner_state_conflict');
      }
    }
    return { ok: true, source: 'jarvos', compatibility: null, state: primary.state };
  }
  if (legacy.status === 'present') {
    logCompatibility(logger, 'jarvos.runner_state.legacy_fallback');
    return {
      ok: true,
      source: 'legacy-openclaw',
      compatibility: Object.freeze({ readOnly: true, migration: false }),
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
  inspectFixtureFile,
  readRunnerState,
  resolveTelegramCredentialReference,
};
