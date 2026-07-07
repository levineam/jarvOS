'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEMA_VERSION,
  ALLOWED_RECORD_STATUSES,
  ACCEPTED_PROVENANCE_FIELDS,
  CORE_MEMORY_CLASSES,
  CANONICAL_MEMORY_SURFACES,
  INPUT_ONLY_SURFACES,
  EXTERNAL_ADAPTER_SURFACES,
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
} = require('../src/lib/memory-schema');

describe('memory-schema constants', () => {
  it('exports a schema version string', () => {
    assert.ok(typeof SCHEMA_VERSION === 'string', 'SCHEMA_VERSION should be a string');
    assert.ok(SCHEMA_VERSION.length > 0, 'SCHEMA_VERSION should not be empty');
  });

  it('ALLOWED_RECORD_STATUSES contains expected values', () => {
    for (const s of ['active', 'superseded', 'corrected', 'archived', 'abandoned']) {
      assert.ok(ALLOWED_RECORD_STATUSES.has(s), `expected status '${s}' to be allowed`);
    }
  });

  it('ALLOWED_RECORD_STATUSES does not contain invalid values', () => {
    assert.ok(!ALLOWED_RECORD_STATUSES.has('pending'), 'pending should not be a valid status');
    assert.ok(!ALLOWED_RECORD_STATUSES.has('draft'), 'draft should not be a valid status');
  });

  it('ACCEPTED_PROVENANCE_FIELDS is a non-empty array', () => {
    assert.ok(Array.isArray(ACCEPTED_PROVENANCE_FIELDS));
    assert.ok(ACCEPTED_PROVENANCE_FIELDS.length > 0);
    assert.ok(ACCEPTED_PROVENANCE_FIELDS.includes('source'));
    assert.ok(ACCEPTED_PROVENANCE_FIELDS.includes('issue'));
  });

  it('CORE_MEMORY_CLASSES defines core classes', () => {
    for (const cls of ['fact', 'preference', 'decision', 'lesson', 'project-state']) {
      assert.ok(cls in CORE_MEMORY_CLASSES, `expected class '${cls}' to be defined`);
    }
  });

  it('CANONICAL_MEMORY_SURFACES is a non-empty array', () => {
    assert.ok(Array.isArray(CANONICAL_MEMORY_SURFACES));
    assert.ok(CANONICAL_MEMORY_SURFACES.length > 0);
  });

  it('INPUT_ONLY_SURFACES and EXTERNAL_ADAPTER_SURFACES are arrays', () => {
    assert.ok(Array.isArray(INPUT_ONLY_SURFACES));
    assert.ok(Array.isArray(EXTERNAL_ADAPTER_SURFACES));
  });

  it('defines the agentmemory experience-memory adapter contract surface', () => {
    assert.match(EXPERIENCE_MEMORY_CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
    assert.ok(EXPERIENCE_MEMORY_EVENT_TYPES.includes('handoff'));
    assert.ok(EXPERIENCE_MEMORY_RETENTION_CLASSES.includes('release-dogfood'));
    assert.ok(EXPERIENCE_MEMORY_PROMOTION_TAGS.includes('promote-lesson-candidate'));
    assert.ok(EXPERIENCE_MEMORY_REQUIRED_PROVENANCE_FIELDS.includes('personality'));
    assert.ok(EXPERIENCE_MEMORY_RECOMMENDED_PROVENANCE_FIELDS.includes('paperclipIssueIdentifier'));
  });

  it('keeps agentmemory access narrow and blocks durable-truth shortcuts', () => {
    const allowed = EXPERIENCE_MEMORY_ALLOWED_AGENTMEMORY_SURFACES.map((item) => item.surface);

    assert.ok(allowed.includes('POST /agentmemory/observe'));
    assert.ok(allowed.includes('POST /agentmemory/smart-search'));
    assert.ok(!allowed.includes('POST /agentmemory/remember'));
    assert.ok(
      EXPERIENCE_MEMORY_BLOCKED_AGENTMEMORY_SURFACES.some((surface) => surface.includes('POST /agentmemory/remember'))
    );
    assert.ok(
      EXPERIENCE_MEMORY_BLOCKED_AGENTMEMORY_SURFACES.some((surface) => surface.includes('automatic MEMORY.md'))
    );
  });

  it('defines dogfood evidence and review gates for v0.6', () => {
    assert.ok(EXPERIENCE_MEMORY_DOGFOOD_EVIDENCE_FIELDS.includes('usefulRecallHits'));
    assert.ok(EXPERIENCE_MEMORY_DOGFOOD_EVIDENCE_FIELDS.includes('badOrIntrusiveSuggestions'));
    assert.strictEqual(EXPERIENCE_MEMORY_DOGFOOD_REVIEW_GATE.linkedIssue, 'SUP-2290');
    assert.strictEqual(EXPERIENCE_MEMORY_DOGFOOD_REVIEW_GATE.maximumDogfoodWindowDays, 14);
    assert.ok(EXPERIENCE_MEMORY_DOGFOOD_REVIEW_GATE.minimumRealCrossPersonalityHandoffs > 0);
  });
});

describe('getClassDefinition()', () => {
  it('returns definition for known classes', () => {
    const fact = getClassDefinition('fact');
    assert.ok(fact !== null);
    assert.ok(typeof fact.description === 'string');
    assert.ok(Array.isArray(fact.requiredFields));
  });

  it('returns null for unknown classes', () => {
    assert.strictEqual(getClassDefinition('unknown-class'), null);
    assert.strictEqual(getClassDefinition(''), null);
    assert.strictEqual(getClassDefinition(undefined), null);
  });

  it('decision class has record-file storageMode', () => {
    const d = getClassDefinition('decision');
    assert.strictEqual(d.storageMode, 'record-file');
  });

  it('fact class has registry-section storageMode', () => {
    const f = getClassDefinition('fact');
    assert.strictEqual(f.storageMode, 'registry-section');
  });

  it('project-state class has project-surface storageMode', () => {
    const ps = getClassDefinition('project-state');
    assert.strictEqual(ps.storageMode, 'project-surface');
  });
});

describe('isAllowedRecordStatus()', () => {
  it('returns true for valid statuses', () => {
    assert.strictEqual(isAllowedRecordStatus('active'), true);
    assert.strictEqual(isAllowedRecordStatus('superseded'), true);
    assert.strictEqual(isAllowedRecordStatus('corrected'), true);
    assert.strictEqual(isAllowedRecordStatus('archived'), true);
    assert.strictEqual(isAllowedRecordStatus('abandoned'), true);
  });

  it('returns false for invalid statuses', () => {
    assert.strictEqual(isAllowedRecordStatus('pending'), false);
    assert.strictEqual(isAllowedRecordStatus(''), false);
    assert.strictEqual(isAllowedRecordStatus(null), false);
    assert.strictEqual(isAllowedRecordStatus(undefined), false);
    assert.strictEqual(isAllowedRecordStatus('ACTIVE'), false); // case-sensitive
  });
});

describe('hasAcceptedProvenance()', () => {
  it('returns true when a provenance field is present', () => {
    assert.strictEqual(hasAcceptedProvenance({ source: 'journal/2026-01-01' }), true);
    assert.strictEqual(hasAcceptedProvenance({ issue: 'SUP-123' }), true);
    assert.strictEqual(hasAcceptedProvenance({ session: 'abc123' }), true);
    assert.strictEqual(hasAcceptedProvenance({ related: 'some-note.md' }), true);
  });

  it('returns false when no provenance fields are present', () => {
    assert.strictEqual(hasAcceptedProvenance({}), false);
    assert.strictEqual(hasAcceptedProvenance({ title: 'test', status: 'active' }), false);
  });

  it('returns false when provenance field is empty string', () => {
    assert.strictEqual(hasAcceptedProvenance({ source: '' }), false);
    assert.strictEqual(hasAcceptedProvenance({ source: '   ' }), false);
  });
});

describe('isAcceptedProjectEntry()', () => {
  it('accepts README.md', () => {
    assert.strictEqual(isAcceptedProjectEntry('README.md', false), true);
  });

  it('accepts directories', () => {
    assert.strictEqual(isAcceptedProjectEntry('my-project', true), true);
  });

  it('accepts markdown files', () => {
    assert.strictEqual(isAcceptedProjectEntry('state.md', false), true);
    assert.strictEqual(isAcceptedProjectEntry('notes.MD', false), true);
  });

  it('rejects non-markdown files', () => {
    assert.strictEqual(isAcceptedProjectEntry('data.json', false), false);
    assert.strictEqual(isAcceptedProjectEntry('image.png', false), false);
  });
});
