'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { computeBundleTree } = require('./catalog');

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

module.exports = { verifyHarnessBundle };
