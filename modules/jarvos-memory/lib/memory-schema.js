'use strict';

const SCHEMA_VERSION = '0.2.0-bootstrap';

const ALLOWED_RECORD_STATUSES = new Set([
  'active',
  'superseded',
  'corrected',
  'archived',
  'abandoned',
]);

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
  getClassDefinition,
  isAllowedRecordStatus,
  hasAcceptedProvenance,
  isAcceptedProjectEntry,
};
