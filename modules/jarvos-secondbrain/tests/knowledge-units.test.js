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
