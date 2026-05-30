'use strict';

const {
  findMarkers,
  hasLabel,
  issueText,
} = require('../../core/text');

function classifyProductFit(issue = {}, config = {}) {
  const text = issueText(issue);
  const labels = config.labels || {};
  const productMarkers = findMarkers(text, config.productMarkers || []);
  const supportMarkers = findMarkers(text, config.supportLocalOpsMarkers || []);
  const unrelatedMarkers = findMarkers(text, config.unrelatedMarkers || []);
  const hasJarvosWord = /\bjarvos\b/i.test(text);
  const hasJarvosLabel = [labels.base, labels.candidate, labels.ops]
    .filter(Boolean)
    .some((label) => hasLabel(issue, label));
  const isActiveReleaseIssue = Boolean(
    config.activeReleaseIssue &&
    String(issue.identifier || issue.id || '').toLowerCase() === String(config.activeReleaseIssue).toLowerCase()
  );

  if (productMarkers.length > 0 || hasJarvosWord || hasJarvosLabel || isActiveReleaseIssue) {
    return {
      classification: 'jarvos',
      matched: true,
      reasons: [
        ...productMarkers.map((marker) => `product marker: ${marker}`),
        hasJarvosWord && productMarkers.length === 0 ? 'word: jarvos' : null,
        hasJarvosLabel ? 'existing jarvOS label' : null,
        isActiveReleaseIssue ? 'active release parent issue' : null,
      ].filter(Boolean),
      markers: productMarkers.length > 0 ? productMarkers : ['jarvos'],
    };
  }

  if (unrelatedMarkers.length > 0) {
    return {
      classification: 'unrelated',
      matched: false,
      reasons: unrelatedMarkers.map((marker) => `unrelated marker: ${marker}`),
      markers: unrelatedMarkers,
    };
  }

  if (supportMarkers.length > 0) {
    return {
      classification: 'support-local-ops',
      matched: false,
      reasons: supportMarkers.map((marker) => `support/local ops marker: ${marker}`),
      markers: supportMarkers,
    };
  }

  if (!String(issue.title || '').trim() && !String(issue.description || '').trim()) {
    return {
      classification: 'unknown',
      matched: false,
      reasons: ['missing title and description'],
      markers: [],
    };
  }

  return {
    classification: 'unknown',
    matched: false,
    reasons: ['no jarvOS product evidence found'],
    markers: [],
  };
}

module.exports = {
  classifyProductFit,
};
