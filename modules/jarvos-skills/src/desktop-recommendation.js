'use strict';

const crypto = require('node:crypto');

const SKILL_SYNC_DESKTOP_SCHEMA = 'jarvos.skill-sync-desktop-recommendations/v1';
const SKILL_SYNC_DESKTOP_VERSION = 1;
const SUPPORTED_HARNESSES = new Set(['claude', 'codex', 'hermes', 'openclaw']);
const OPTION_LABELS = Object.freeze({
  share: 'Share',
  'keep-local': 'Keep local',
  exclude: 'Exclude',
  details: 'Review details',
});
const REFERENCE_RE = /^[A-Za-z0-9_-]{24,128}$/;
const SKILL_RE = /^[a-z][a-z0-9-]{0,63}$/;
const UNSAFE_DISPLAY_TEXT = /(?:\/(?:Users|home|private|var|etc|tmp)\/|[A-Za-z]:\\)|diff --git|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/u;

function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function safeText(value, name, max = 500) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text) || UNSAFE_DISPLAY_TEXT.test(text)) {
    throw new Error(`${name} must be bounded display-safe text`);
  }
  return text;
}

function validDecision(decision) {
  return decision
    && REFERENCE_RE.test(String(decision.decisionReference || ''))
    && Number.isSafeInteger(decision.revision) && decision.revision > 0
    && SKILL_RE.test(String(decision.skill || ''))
    && Array.isArray(decision.options) && decision.options.length > 0
    && decision.options.every((option) => Object.hasOwn(OPTION_LABELS, option))
    && new Set(decision.options).size === decision.options.length;
}

function harnesses(value) {
  if (!Array.isArray(value) || value.some((item) => !SUPPORTED_HARNESSES.has(item))) {
    throw new Error('affectedHarnesses must contain supported harness ids');
  }
  return [...new Set(value)].sort();
}

function operationHandle(decision, kind) {
  return crypto.createHash('sha256')
    .update(`${SKILL_SYNC_DESKTOP_SCHEMA}\0${kind}\0${decision.decisionReference}\0${decision.revision}`)
    .digest('base64url');
}

function availability(enabled) {
  return enabled === true
    ? { available: true }
    : { available: false, reason: 'verified_host_adapter_unavailable' };
}

function acknowledgement(decision, capabilities) {
  return {
    label: 'Not now',
    resolves: false,
    operation: {
      kind: 'acknowledge_skill_decision',
      decisionReference: decision.decisionReference,
      revision: decision.revision,
      ...availability(capabilities.acknowledgeDecision),
    },
  };
}

function analysisRequired(decision, generatedAt, capabilities, invalidated = null) {
  return {
    decisionReference: decision.decisionReference,
    revision: decision.revision,
    skillName: decision.skill,
    affectedHarnesses: harnesses(decision.affectedHarnesses || []),
    state: 'analysis_required',
    freshness: invalidated
      ? { state: 'invalidated', invalidatedAt: generatedAt, reason: invalidated }
      : { state: 'not_generated' },
    primaryAction: {
      label: 'Generate recommendation',
      operation: {
        kind: 'generate_skill_recommendation',
        handle: operationHandle(decision, 'generate'),
        ...availability(capabilities.generateRecommendation),
      },
    },
    acknowledgement: acknowledgement(decision, capabilities),
  };
}

function currentRecommendation(decision, recommendation, capabilities) {
  const recommendationGeneratedAt = iso(recommendation.generatedAt);
  const selected = recommendation.decision;
  if (!recommendationGeneratedAt || !decision.options.includes(selected) || selected === 'details') {
    throw new Error('recommendation decision or generatedAt is invalid');
  }
  const alternatives = Array.isArray(recommendation.alternatives) ? recommendation.alternatives : [];
  const expectedAlternatives = decision.options.filter((option) => option !== selected);
  if (alternatives.length !== expectedAlternatives.length
    || alternatives.some((item) => !item || !expectedAlternatives.includes(item.option))
    || new Set(alternatives.map((item) => item.option)).size !== alternatives.length) {
    throw new Error('recommendation alternatives must map every remaining decision option exactly once');
  }
  const affectedHarnesses = harnesses(recommendation.affectedHarnesses);
  if (JSON.stringify(affectedHarnesses) !== JSON.stringify(harnesses(decision.affectedHarnesses || []))) {
    throw new Error('recommendation affectedHarnesses must match the current decision');
  }
  return {
    decisionReference: decision.decisionReference,
    revision: decision.revision,
    skillName: decision.skill,
    affectedHarnesses,
    state: 'recommendation_available',
    freshness: { state: 'current', generatedAt: recommendationGeneratedAt },
    primaryAction: { label: 'See recommendation', operation: { kind: 'show_skill_recommendation' } },
    recommendation: {
      decision: selected,
      decisionLabel: OPTION_LABELS[selected],
      rationale: safeText(recommendation.rationale, 'rationale', 800),
      affectedHarnesses,
      expectedResult: safeText(recommendation.expectedResult, 'expectedResult', 500),
      materialRisk: safeText(recommendation.materialRisk, 'materialRisk', 500),
      uncertainty: safeText(recommendation.uncertainty, 'uncertainty', 500),
      alternatives: alternatives.map((item) => ({
        option: item.option,
        label: OPTION_LABELS[item.option],
        tradeoff: safeText(item.tradeoff, 'alternative tradeoff', 500),
      })),
      applyOperation: {
        kind: 'resolve_skill_decision',
        decisionReference: decision.decisionReference,
        revision: decision.revision,
        option: selected,
        revalidate: true,
        ...availability(capabilities.resolveDecision),
      },
    },
    acknowledgement: acknowledgement(decision, capabilities),
  };
}

function projectSkillSyncDesktop({ decisions = [], recommendations = [], capabilities = {}, generatedAt = new Date().toISOString() } = {}) {
  const at = iso(generatedAt);
  if (!at) throw new Error('generatedAt must be an ISO timestamp');
  if (!Array.isArray(decisions) || decisions.some((decision) => !validDecision(decision))) {
    throw new Error('decisions must contain valid public skill decisions');
  }
  if (new Set(decisions.map((decision) => decision.decisionReference)).size !== decisions.length) {
    throw new Error('decision references must be unique');
  }
  if (!Array.isArray(recommendations)) throw new Error('recommendations must be an array');
  const byReference = new Map();
  for (const recommendation of recommendations) {
    if (!recommendation || !REFERENCE_RE.test(String(recommendation.decisionReference || ''))
      || !Number.isSafeInteger(recommendation.revision) || recommendation.revision < 1
      || byReference.has(recommendation.decisionReference)) {
      throw new Error('recommendation identity is invalid or duplicated');
    }
    byReference.set(recommendation.decisionReference, recommendation);
  }
  return {
    schema: SKILL_SYNC_DESKTOP_SCHEMA,
    version: SKILL_SYNC_DESKTOP_VERSION,
    generatedAt: at,
    freshness: { state: 'current' },
    capabilities: {
      generateRecommendation: capabilities.generateRecommendation === true,
      resolveDecision: capabilities.resolveDecision === true,
      acknowledgeDecision: capabilities.acknowledgeDecision === true,
    },
    decisions: decisions.map((decision) => {
      const recommendation = byReference.get(decision.decisionReference);
      if (!recommendation) return analysisRequired(decision, at, capabilities);
      if (recommendation.revision !== decision.revision) {
        return analysisRequired(decision, at, capabilities, 'decision_revision_changed');
      }
      return currentRecommendation(decision, recommendation, capabilities);
    }),
  };
}

module.exports = {
  SKILL_SYNC_DESKTOP_SCHEMA,
  SKILL_SYNC_DESKTOP_VERSION,
  projectSkillSyncDesktop,
};
