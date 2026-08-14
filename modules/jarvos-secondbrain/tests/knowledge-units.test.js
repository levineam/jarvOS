'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildArtifact,
  optimizeNoteKnowledge,
} = require('../packages/jarvos-secondbrain-notes/src/knowledge-optimizer');

function noteFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ku-'));
  const notesDir = path.join(root, 'Notes');
  fs.mkdirSync(notesDir);
  return {
    root,
    notesDir,
    filePath: path.join(notesDir, 'Secondbrain Architecture.md'),
  };
}

test('buildArtifact emits generalized source-backed knowledge units for safe notes', () => {
  const { notesDir, filePath } = noteFixture();
  const body = [
    '# Secondbrain Architecture',
    '',
    'Generated wiki pages are rebuildable from source notes and journals.',
    'Memory promotion should only accept cited knowledge units with privacy eligibility.',
  ].join('\n');

  const first = buildArtifact({
    filePath,
    notesDir,
    title: 'Secondbrain Architecture',
    body,
    frontmatter: {
      author: 'andrew',
      type: 'reference',
    },
    created: true,
  });
  const second = buildArtifact({
    filePath,
    notesDir,
    title: 'Secondbrain Architecture',
    body,
    frontmatter: {
      author: 'andrew',
      type: 'reference',
    },
    created: true,
  });

  assert.equal(first.knowledgeUnits.length, 2);
  assert.deepEqual(
    first.knowledgeUnits.map((unit) => unit.id),
    second.knowledgeUnits.map((unit) => unit.id),
  );

  const unit = first.knowledgeUnits[0];
  assert.equal(unit.kind, 'claim');
  assert.equal(unit.author, 'andrew');
  assert.equal(unit.content_origin, 'human');
  assert.equal(unit.content_origin_basis, 'legacy_author');
  assert.equal(unit.human_evidence_eligible, true);
  assert.equal(unit.provenance.humanEvidenceEligible, true);
  assert.equal(unit.source.type, 'note');
  assert.equal(unit.source.path, 'Notes/Secondbrain Architecture.md');
  assert.equal(unit.privacyDecision.tier, 'local-private');
  assert.equal(unit.privacyDecision.excludedFromPromotion, false);
  assert.equal(unit.downstreamEligibility.memoryPromotion, true);
  assert.equal(unit.downstreamEligibility.ontologyPromotion, false);
  assert.equal(unit.evidence[0].sourcePath, 'Notes/Secondbrain Architecture.md');
  assert.equal(unit.evidence[0].bodySha256, first.bodyHash);
});

test('optimizeNoteKnowledge writes knowledge units into artifacts and queues', () => {
  const { root, notesDir, filePath } = noteFixture();
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');
  const result = optimizeNoteKnowledge({
    filePath,
    notesDir,
    knowledgeDir,
    title: 'Secondbrain Architecture',
    body: 'Generated wiki pages cite source notes. Durable memory receives only promoted knowledge units.',
    frontmatter: {
      author: 'jarvis',
      type: 'reference',
    },
    created: true,
  });

  assert.equal(result.optimized, true);
  const artifact = JSON.parse(fs.readFileSync(result.artifactPath, 'utf8'));
  const gbrainQueue = JSON.parse(fs.readFileSync(result.queuePath, 'utf8'));
  const memoryWikiQueue = JSON.parse(fs.readFileSync(result.memoryWikiQueuePath, 'utf8'));
  const sourceEntry = gbrainQueue.entries['Notes/Secondbrain Architecture.md'];

  assert.equal(artifact.knowledgeUnits.length, 2);
  assert.equal(sourceEntry.knowledgeUnits.length, 2);
  assert.equal(memoryWikiQueue.entries['Notes/Secondbrain Architecture.md'].knowledgeUnits.length, 2);
  assert.equal(sourceEntry.knowledgeUnits[0].author, 'jarvis');
  assert.equal(sourceEntry.knowledgeUnits[0].content_origin, 'assistant');
  assert.equal(sourceEntry.knowledgeUnits[0].human_evidence_eligible, false);
  assert.equal(sourceEntry.knowledgeUnits[0].downstreamEligibility.gbrain, true);
});

test('sensitive notes keep local knowledge units but block downstream promotion', () => {
  const { notesDir, filePath } = noteFixture();
  const artifact = buildArtifact({
    filePath,
    notesDir,
    title: 'Credential Handling',
    body: 'The deployment credential rotation note should never be promoted automatically.',
    frontmatter: {
      author: 'andrew',
      tags: ['private'],
    },
    created: true,
  });

  assert.equal(artifact.sensitivity.excluded, true);
  assert.equal(artifact.gbrain.status, 'skipped');
  assert.equal(artifact.memoryWiki.status, 'skipped');
  assert.equal(artifact.knowledgeUnits.length, 1);
  assert.equal(artifact.knowledgeUnits[0].privacyDecision.tier, 'sensitive');
  assert.equal(artifact.knowledgeUnits[0].privacyDecision.excludedFromPromotion, true);
  assert.equal(artifact.knowledgeUnits[0].downstreamEligibility.gbrain, false);
  assert.equal(artifact.knowledgeUnits[0].downstreamEligibility.memoryPromotion, false);
});

test('knowledge units preserve explicit origin while keeping searchable derivatives available', () => {
  const { notesDir, filePath } = noteFixture();
  const artifact = buildArtifact({
    filePath,
    notesDir,
    title: 'Generated Research',
    body: 'The assistant generated this summary for retrieval, but it is not Andrew\'s evidence.',
    frontmatter: {
      author: 'jarvis',
      type: 'reference',
      content_origin: 'assistant',
      content_origin_basis: 'assistant_generated',
      human_evidence_eligible: false,
    },
    created: true,
  });

  assert.equal(artifact.content_origin, 'assistant');
  assert.equal(artifact.knowledgeUnits[0].content_origin, 'assistant');
  assert.equal(artifact.knowledgeUnits[0].human_evidence_eligible, false);
  assert.equal(artifact.knowledgeUnits[0].downstreamEligibility.qmd, true);
  assert.equal(artifact.knowledgeUnits[0].downstreamEligibility.memoryPromotion, true);
});

test('explicit human note provenance requires a syntactically valid source receipt', () => {
  const { notesDir, filePath } = noteFixture();
  const body = 'A faithful user-derived note with a source receipt.';
  const valid = buildArtifact({
    filePath,
    notesDir,
    title: 'User-derived note',
    body,
    frontmatter: {
      content_origin: 'human',
      content_origin_basis: 'user_derived',
      human_evidence_eligible: true,
      content_origin_source: {
        capture_event_id: 'capture-1',
        actor: 'user',
        source_digest: 'a'.repeat(64),
        content_digest: 'b'.repeat(64),
      },
    },
    created: true,
  });
  assert.equal(valid.knowledgeUnits[0].content_origin, 'human');
  assert.equal(valid.knowledgeUnits[0].human_evidence_eligible, true);

  const invalid = buildArtifact({
    filePath,
    notesDir,
    title: 'Unproven note',
    body,
    frontmatter: {
      content_origin: 'human',
      content_origin_basis: 'user_derived',
      human_evidence_eligible: true,
    },
    created: true,
  });
  assert.equal(invalid.knowledgeUnits[0].content_origin, 'unknown');
  assert.equal(invalid.knowledgeUnits[0].human_evidence_eligible, false);
});
