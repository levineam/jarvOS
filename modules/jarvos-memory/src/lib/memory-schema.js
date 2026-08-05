'use strict';

const SCHEMA_VERSION = '0.3.0';

const ALLOWED_RECORD_STATUSES = new Set([
  'active',
  'superseded',
  'corrected',
  'archived',
  'abandoned',
]);

/**
 * MEMORY_STAGES — lifecycle stages for a memory item moving through the
 * jarvos-memory local-file promotion flow.
 *
 *   candidate  — captured from secondbrain or session, not yet reviewed
 *   promoted   — reviewed and written to a canonical memory surface (local file)
 *   rejected   — reviewed and determined not worth promoting
 *
 * Note: Hindsight-backed server promotion was explored in SUP-585 and superseded
 * in SUP-596. These stages are valid for the local-only file-based flow.
 */
const MEMORY_STAGES = {
  CANDIDATE: 'candidate',
  PROMOTED: 'promoted',
  REJECTED: 'rejected',
};

/**
 * Salience class → memory class mapping.
 * Mirrors the salienceClass values from the secondbrain capture-contract so
 * that the memory module can gate promotion without importing secondbrain.
 */
const SALIENCE_TO_MEMORY_CLASS = {
  decision: 'decision',
  belief_change: 'fact',
  preference: 'preference',
  factual_learning: 'fact',
  lesson: 'lesson',
};

/**
 * Minimum confidence score required to auto-promote a candidate to durable memory.
 * Events below this threshold are rejected unless the caller passes an explicit
 * memoryClass override.
 */
const MEMORY_PROMOTION_THRESHOLD = 0.8;

const EXPERIENCE_MEMORY_CONTRACT_VERSION = '0.1.0';

const EXPERIENCE_MEMORY_EVENT_TYPES = [
  'observation',
  'attempted-fix',
  'local-decision',
  'failure',
  'test-result',
  'handoff',
  'lesson',
  'anti-repeat-note',
];

const EXPERIENCE_MEMORY_RETENTION_CLASSES = [
  'session',
  'issue',
  'release-dogfood',
  'archive-candidate',
];

const EXPERIENCE_MEMORY_PROMOTION_TAGS = [
  'promote-fact-candidate',
  'promote-preference-candidate',
  'promote-decision-candidate',
  'promote-lesson-candidate',
  'promote-project-state-candidate',
  'promote-ontology-candidate',
  'paperclip-followup-candidate',
];

const EXPERIENCE_MEMORY_REQUIRED_PROVENANCE_FIELDS = [
  'host',
  'personality',
  'agentId',
  'sessionId',
  'sourceRoute',
  'observedAt',
];

const EXPERIENCE_MEMORY_RECOMMENDED_PROVENANCE_FIELDS = [
  'paperclipIssueId',
  'paperclipIssueIdentifier',
  'repo',
  'branch',
  'pullRequestUrl',
  'runId',
  'transcriptRef',
  'confidence',
  'sensitivityClass',
  'retentionClass',
];

const EXPERIENCE_MEMORY_ALLOWED_AGENTMEMORY_SURFACES = [
  {
    surface: 'GET /agentmemory/health',
    purpose: 'Daemon presence and degraded-mode diagnostics.',
  },
  {
    surface: 'GET /agentmemory/livez',
    purpose: 'Runtime liveness diagnostics.',
  },
  {
    surface: 'POST /agentmemory/session/start',
    purpose: 'Start an adapter-scoped session and fetch advisory context.',
  },
  {
    surface: 'POST /agentmemory/session/end',
    purpose: 'Close an adapter-scoped session without changing durable truth.',
  },
  {
    surface: 'POST /agentmemory/observe',
    purpose: 'Write low-risk shared experience observations only.',
  },
  {
    surface: 'POST /agentmemory/smart-search',
    purpose: 'Retrieve advisory cross-personality experience hits.',
  },
  {
    surface: 'POST /agentmemory/context',
    purpose: 'Generate bounded advisory context for issue pickup, handoff, or session start.',
  },
  {
    surface: 'GET /agentmemory/audit',
    purpose: 'Doctor and review evidence only.',
  },
  {
    surface: 'GET /agentmemory/export',
    purpose: 'Portability, backup, and vendor-lock-in proof only.',
  },
];

const EXPERIENCE_MEMORY_BLOCKED_AGENTMEMORY_SURFACES = [
  'direct host access to @agentmemory/mcp tools',
  'memory_save / memory_remember / POST /agentmemory/remember without adapter review',
  'POST /agentmemory/import',
  'POST /agentmemory/forget or governance deletion from ordinary hosts',
  'POST /agentmemory/graph/query as a GBrain or ontology source',
  'POST /agentmemory/team/share',
  'POST /agentmemory/enrich for automatic pre-tool context injection',
  'viewer or iii console exposure outside loopback',
  'memory slot mutation, reflection, or automatic MEMORY.md mirroring',
  'automatic hook capture before the jarVOS adapter allowlist exists',
];

const EXPERIENCE_MEMORY_DOGFOOD_EVIDENCE_FIELDS = [
  'relatedPaperclipIssueIdentifier',
  'writerPersonality',
  'readerPersonality',
  'recallPurpose',
  'usefulRecallHits',
  'missedContext',
  'badOrIntrusiveSuggestions',
  'sourceObservationIds',
  'memoryHelped',
  'reviewNote',
];

const EXPERIENCE_MEMORY_DOGFOOD_REVIEW_GATE = {
  releaseLane: 'jarVOS v0.6 shared experience memory dogfood',
  linkedIssue: 'SUP-2290',
  minimumRealCrossPersonalityHandoffs: 10,
  maximumDogfoodWindowDays: 14,
  requiredRecommendation: 'adopt | revise | remove',
};

const ACCEPTED_PROVENANCE_FIELDS = [
  'related',
  'source',
  'sources',
  'provenance',
  'issue',
  'issues',
  'journal',
  'session',
  'transcript',
];

const CORE_MEMORY_CLASSES = {
  fact: {
    description: 'Stable factual context worth reusing later.',
    storageMode: 'registry-section',
    currentCanonicalHome: 'MEMORY.md',
    requiredFields: ['class', 'created', 'status'],
    provenanceAnyOf: ACCEPTED_PROVENANCE_FIELDS,
  },
  preference: {
    description: 'User or agent preference that affects future decisions.',
    storageMode: 'registry-section',
    currentCanonicalHome: 'MEMORY.md',
    requiredFields: ['class', 'created', 'status'],
    provenanceAnyOf: ACCEPTED_PROVENANCE_FIELDS,
  },
  decision: {
    description: 'Durable decision with rationale or consequence worth preserving.',
    storageMode: 'record-file',
    currentCanonicalHome: 'memory/decisions/*.md',
    requiredFields: ['class', 'created', 'status'],
    provenanceAnyOf: ACCEPTED_PROVENANCE_FIELDS,
    filenamePattern: 'YYYY-MM-DD-slug.md',
  },
  'project-state': {
    description: 'Compact snapshot of meaningful current project state that should survive beyond one day.',
    storageMode: 'project-surface',
    currentCanonicalHome: 'memory/projects/',
    acceptedEntryKinds: ['markdown-file', 'directory'],
  },
  lesson: {
    description: 'Failure pattern, correction, or reusable operating rule.',
    storageMode: 'record-file',
    currentCanonicalHome: 'memory/lessons/*.md',
    requiredFields: ['class', 'created', 'status'],
    provenanceAnyOf: ACCEPTED_PROVENANCE_FIELDS,
    filenamePattern: 'YYYY-MM-DD-slug.md',
  },
};

const CANONICAL_MEMORY_SURFACES = [
  {
    path: 'MEMORY.md',
    kind: 'curated-registry',
    classes: ['fact', 'preference'],
  },
  {
    path: 'memory/decisions/*.md',
    kind: 'record-backed-memory',
    classes: ['decision'],
  },
  {
    path: 'memory/lessons/*.md',
    kind: 'record-backed-memory',
    classes: ['lesson'],
  },
  {
    path: 'memory/projects/',
    kind: 'project-state-surface',
    classes: ['project-state'],
  },
];

const INPUT_ONLY_SURFACES = [
  {
    path: 'memory/YYYY-MM-DD.md',
    kind: 'journal-input',
    reason: 'Daily logs are input material for memory promotion, not the canonical durable memory registry.',
  },
  {
    path: 'jarvos-secondbrain/packages/jarvos-secondbrain-notes/',
    kind: 'content-input',
    reason: 'Notes are long-form source material, not compact retained memory.',
  },
  {
    path: 'jarvos-secondbrain/packages/jarvos-secondbrain-journal/',
    kind: 'content-input',
    reason: 'Journal is chronology and raw capture, not the durable memory registry.',
  },
];

const EXTERNAL_ADAPTER_SURFACES = [
  {
    path: '~/.openclaw/openclaw.json',
    area: 'lossless-claw runtime continuity',
    reason: 'Runtime compaction and continuity wiring stay outside the memory module core.',
  },
  {
    path: 'jarvos-ontology/',
    area: 'ontology integration',
    reason: 'Ontology consumes durable memory signals but remains a separate domain model.',
  },
];

function getClassDefinition(name) {
  return CORE_MEMORY_CLASSES[name] || null;
}

function isAllowedRecordStatus(value) {
  return ALLOWED_RECORD_STATUSES.has(String(value || '').trim());
}

function hasAcceptedProvenance(frontmatter) {
  return ACCEPTED_PROVENANCE_FIELDS.some((field) => {
    const value = frontmatter[field];
    return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
  });
}

function isAcceptedProjectEntry(name, isDirectory) {
  if (name === 'README.md') return true;
  if (isDirectory) return true;
  return name.toLowerCase().endsWith('.md');
}

module.exports = {
  SCHEMA_VERSION,
  ALLOWED_RECORD_STATUSES,
  ACCEPTED_PROVENANCE_FIELDS,
  CORE_MEMORY_CLASSES,
  CANONICAL_MEMORY_SURFACES,
  INPUT_ONLY_SURFACES,
  EXTERNAL_ADAPTER_SURFACES,
  MEMORY_STAGES,
  SALIENCE_TO_MEMORY_CLASS,
  MEMORY_PROMOTION_THRESHOLD,
  EXPERIENCE_MEMORY_CONTRACT_VERSION,
  EXPERIENCE_MEMORY_EVENT_TYPES,
  EXPERIENCE_MEMORY_RETENTION_CLASSES,
  EXPERIENCE_MEMORY_PROMOTION_TAGS,
  EXPERIENCE_MEMORY_REQUIRED_PROVENANCE_FIELDS,
  EXPERIENCE_MEMORY_RECOMMENDED_PROVENANCE_FIELDS,
  EXPERIENCE_MEMORY_ALLOWED_AGENTMEMORY_SURFACES,
  EXPERIENCE_MEMORY_BLOCKED_AGENTMEMORY_SURFACES,
  EXPERIENCE_MEMORY_DOGFOOD_EVIDENCE_FIELDS,
  EXPERIENCE_MEMORY_DOGFOOD_REVIEW_GATE,
  getClassDefinition,
  isAllowedRecordStatus,
  hasAcceptedProvenance,
  isAcceptedProjectEntry,
};
