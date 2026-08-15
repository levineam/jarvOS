'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { computeBundleTree } = require('./catalog');
const { expandHome } = require('./config');

function resolveShadowPaths({ harness = {}, adapter = null, effectiveName } = {}) {
  const scopes = adapter?.skillProjection?.orderedScopes;
  if (!Array.isArray(scopes) || !effectiveName) return { paths: [], complete: true };
  const configured = harness.scopeRoots || {};
  const managedRoot = harness.root ? path.resolve(expandHome(harness.root)) : null;
  const higherScopes = scopes.slice(0, -1);
  const missingScopes = higherScopes.filter((scope) => !configured[scope]);
  return {
    paths: higherScopes
      .map((scope) => configured[scope] ? path.resolve(expandHome(configured[scope])) : null)
      // A declared user scope can coincide with the managed root; it is the
      // target being verified, not a higher-precedence shadow.
      .filter((root) => root && root !== managedRoot)
      .map((root) => path.join(root, effectiveName)),
    complete: missingScopes.length === 0 && harness.scopeRootsComplete !== false,
    missingScopes,
  };
}

function deriveShadowPaths(options = {}) {
  return resolveShadowPaths(options).paths;
}

/**
 * Report the strongest proof an adapter can safely produce.
 * Copied bytes are never upgraded to model-visible by inference alone.
 */
function verifyHarnessBundle({
  adapter = null,
  targetPath,
  expectedName,
  expectedTreeDigest,
  allowlist,
  remoteModelProbe = false,
  shadowPaths = [],
  shadowPathsComplete = true,
} = {}) {
  const projection = adapter?.skillProjection || null;
  const tier = projection?.verificationTier || adapter?.verificationTier || 'exact-path';

  if (tier === 'interactive-smoke' || tier === 'model-visible-smoke') {
    if (!remoteModelProbe) {
      return { status: 'verification_pending', reason: 'remote_probe_not_authorized', tier };
    }
    return { status: 'verification_pending', reason: 'interactive_probe_required', tier };
  }

  if (tier !== 'exact-path') {
    return { status: 'unverifiable', reason: 'adapter_verification_tier_unsupported', tier };
  }
  if (!shadowPathsComplete) {
    return { status: 'unverifiable', reason: 'higher_precedence_scope_unknown', tier: 'exact-path' };
  }
  if (Array.isArray(shadowPaths) && shadowPaths.some((candidate) => candidate && fs.existsSync(candidate))) {
    return { status: 'unverifiable', reason: 'higher_precedence_shadow', tier: 'exact-path' };
  }

  if (!targetPath || !expectedName || path.basename(targetPath) !== expectedName) {
    return { status: 'unverifiable', reason: 'exact_target_not_found', tier: 'exact-path' };
  }
  if (!fs.existsSync(targetPath)) {
    return { status: 'unverifiable', reason: 'exact_target_not_found', tier: 'exact-path' };
  }

  try {
    const tree = computeBundleTree(targetPath, {
      allowlist: allowlist || projection?.bundleAllowlist,
      expectedDigest: expectedTreeDigest,
    });
    return {
      status: 'model_visible',
      tier: 'exact-path',
      name: expectedName,
      treeDigest: tree.treeDigest,
    };
  } catch (error) {
    return {
      status: 'unverifiable',
      reason: 'exact_target_digest_mismatch',
      tier: 'exact-path',
      detail: error.message,
    };
  }
}

module.exports = { verifyHarnessBundle, deriveShadowPaths, resolveShadowPaths };
