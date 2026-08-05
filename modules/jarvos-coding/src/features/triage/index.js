'use strict';

const { releaseFitFromPaperclipReleaseIntake } = require('../../adapters/paperclip');
const { collectEvidence } = require('../../core/text');
const {
  TRIAGE_SCHEMA_VERSION,
  codingLifecyclePolicy,
  releaseGateState,
} = require('../../lifecycle/policy');
const { classifyProductFit } = require('./product-fit');

// No default active release parent/version: per docs/release-process.md,
// "v0.3-era release parents are historical and should not receive new
// candidates" and "If no parent exists yet, create one before claiming
// release readiness." A stale hardcoded parent here previously caused
// unconfigured callers to silently auto-attach new candidates to the
// long-closed v0.3 lane (SUP-1957) instead of visibly failing closed.
// Callers MUST supply `activeVersion`/`activeReleaseIssue` for the current
// lane; omitting them is treated as missing release-intake configuration.
const DEFAULT_CONFIG = {
  enabled: true,
  activeVersion: null,
  activeReleaseIssue: null,
  labels: {
    base: 'jarvos',
    candidate: 'jarvos-release-candidate',
    future: 'jarvos-future-release',
    ops: 'jarvos-release-ops',
    release: null,
  },
  productMarkers: [
    '/Users/andrew/jarvOS',
    'levineam/jarvOS',
    'repos/jarvOS',
    'jarvos-bootstrap',
    'modules/jarvos-',
    'jarvOS starter kit',
  ],
  supportLocalOpsMarkers: [
    'workflow-execution',
    'Paperclip intake',
    'OpenClaw rule',
    'clawd',
    'local runtime',
    'support',
  ],
  unrelatedMarkers: [
    'personal admin',
    'teeth cleaning',
    'dentist',
    'grocery',
    'calendar hold',
  ],
};

function mergeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    labels: { ...DEFAULT_CONFIG.labels, ...(config.labels || {}) },
    productMarkers: config.productMarkers || DEFAULT_CONFIG.productMarkers,
    supportLocalOpsMarkers: config.supportLocalOpsMarkers || DEFAULT_CONFIG.supportLocalOpsMarkers,
    unrelatedMarkers: config.unrelatedMarkers || DEFAULT_CONFIG.unrelatedMarkers,
  };
}

function classifyReleaseFit(productFit, options = {}) {
  if (options.releaseClassification) {
    return releaseFitFromPaperclipReleaseIntake(options.releaseClassification);
  }

  if (productFit.classification === 'jarvos' || productFit.classification === 'unknown') {
    return {
      classification: 'unknown',
      matched: false,
      labels: [],
      reasons: ['no release adapter classification supplied'],
      publicNotesImpact: 'unknown',
    };
  }

  return {
    classification: 'not-release',
    matched: false,
    labels: [],
    reasons: ['not jarvOS product work'],
    publicNotesImpact: 'no',
  };
}

function classifyReadiness(productFit, releaseFit) {
  const releaseGate = releaseGateState(releaseFit);
  if (releaseGate.state === 'blocked') {
    return { state: 'blocked', reasons: releaseGate.reasons };
  }

  if (productFit.classification === 'unrelated') {
    return {
      state: 'skipped',
      reasons: ['unrelated work does not need jarvOS coding triage'],
    };
  }

  if (productFit.classification === 'support-local-ops') {
    return {
      state: 'skipped',
      reasons: ['support/local ops work should not attach to jarvOS release lanes'],
    };
  }

  if (productFit.classification === 'unknown' || releaseFit.classification === 'unknown') {
    return {
      state: 'needs-triage',
      reasons: [...productFit.reasons, ...releaseFit.reasons],
    };
  }

  return {
    state: 'ready',
    reasons: ['coding triage has enough evidence to route the issue'],
  };
}

function routeCodingWork(productFit, releaseFit, readiness) {
  if (readiness.state === 'blocked') {
    return { lane: 'manual-coding-triage', reasons: readiness.reasons };
  }
  if (readiness.state === 'skipped') {
    return {
      lane: productFit.classification === 'support-local-ops'
        ? 'support-local-ops'
        : 'not-jarvos-coding',
      reasons: readiness.reasons,
    };
  }
  if (readiness.state === 'needs-triage') {
    return { lane: 'manual-coding-triage', reasons: readiness.reasons };
  }
  if (releaseFit.classification === 'release-candidate') {
    return { lane: 'jarvos-public-release-candidate', reasons: releaseFit.reasons };
  }
  if (releaseFit.classification === 'future-release') {
    return { lane: 'jarvos-future-release-dogfood', reasons: releaseFit.reasons };
  }
  if (releaseFit.classification === 'release-ops' || releaseFit.classification === 'release-parent') {
    return { lane: 'jarvos-release-ops', reasons: releaseFit.reasons };
  }
  return { lane: 'jarvos-coding-general', reasons: productFit.reasons };
}

function decideCodingTriage(readiness) {
  if (readiness.state === 'blocked') {
    return { action: 'fail-closed', reason: readiness.reasons[0] };
  }
  if (readiness.state === 'skipped') {
    return { action: 'skip', reason: readiness.reasons[0] };
  }
  if (readiness.state === 'needs-triage') {
    return { action: 'needs-review', reason: readiness.reasons[0] };
  }
  return { action: 'apply', reason: 'jarvOS coding-work triage applies' };
}

function triageCodingWork(issue = {}, options = {}) {
  const config = mergeConfig(options.config || {});
  const lifecycle = codingLifecyclePolicy();

  if (!config.enabled) {
    return {
      schemaVersion: TRIAGE_SCHEMA_VERSION,
      lifecycle,
      productFit: { classification: 'unknown', matched: false, reasons: ['coding triage disabled'], markers: [] },
      releaseFit: { classification: 'unknown', matched: false, labels: [], reasons: ['coding triage disabled'], publicNotesImpact: 'unknown' },
      readiness: { state: 'skipped', reasons: ['coding triage disabled'] },
      routing: { lane: 'triage-disabled', reasons: ['coding triage disabled'] },
      decision: { action: 'skip', reason: 'coding triage disabled' },
      evidence: [],
    };
  }

  const productFit = classifyProductFit(issue, config);
  const releaseFit = classifyReleaseFit(productFit, options);
  const readiness = classifyReadiness(productFit, releaseFit);
  const routing = routeCodingWork(productFit, releaseFit, readiness);
  const decision = decideCodingTriage(readiness);
  const evidence = collectEvidence(issue, {
    product: productFit.markers,
    release: releaseFit.reasons
      .map((reason) => String(reason).replace(/^(public|ops|product|support\/local ops|unrelated) marker:\s*/i, ''))
      .filter((reason) => !/^existing label:|^phrase:|^active release|^not jarvOS|^no release/.test(reason)),
  });

  return {
    schemaVersion: TRIAGE_SCHEMA_VERSION,
    lifecycle,
    productFit,
    releaseFit,
    readiness,
    routing,
    decision,
    evidence,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  classifyProductFit,
  classifyReadiness,
  classifyReleaseFit,
  decideCodingTriage,
  mergeConfig,
  routeCodingWork,
  triageCodingWork,
};
