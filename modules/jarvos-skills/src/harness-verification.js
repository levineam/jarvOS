'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { computeBundleTree } = require('./catalog');
const { expandHome } = require('./config');

function deriveShadowPaths({ harness = {}, adapter = null, effectiveName } = {}) {
  const scopes = adapter?.skillProjection?.orderedScopes;
  if (!Array.isArray(scopes) || !effectiveName) return [];
  const configured = harness.scopeRoots || {};
  return scopes.slice(0, -1).map((scope) => configured[scope] ? path.join(path.resolve(expandHome(configured[scope])), effectiveName) : null).filter(Boolean);
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

module.exports = { verifyHarnessBundle, deriveShadowPaths };
