'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ONTOLOGY_PACKET_VERSION,
  createFixtureOntologyProvider,
  createOntologyProvider,
} = require('../src/provider.cjs');

function withTempDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ontology-provider-'));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeLayer(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), body, 'utf8');
}

test('default provider renders a bounded ontology packet from split markdown', () => {
  withTempDir((dir) => {
    writeLayer(dir, '1-higher-order.md', '# Higher\n\n## HO — Meaning\nReliable automation compounds.');
    writeLayer(dir, '2-beliefs.md', '## B1 — Useful tools\n- **Status:** Active\n- **Source:** fixture');
    writeLayer(dir, '4-core-self.md', '### Mission\nBuild useful personal AI systems.');
    writeLayer(dir, '5-goals.md', '## G1 — Ship public jarvOS\n- `serves` → CORE');

    const provider = createOntologyProvider({ ontologyDir: dir, maxChars: 900 });
    const packet = provider.renderAgentPacket();

    assert.equal(packet.ok, true);
    assert.equal(packet.version, ONTOLOGY_PACKET_VERSION);
    assert.match(packet.markdown, /jarvOS Ontology Context/);
    assert.match(packet.markdown, /hierarchy-of-meaning/);
    assert.ok(packet.sections.length >= 4);
    assert.ok(packet.anchors.some((anchor) => anchor.id === 'B1'));
    assert.ok(packet.markdown.length <= 900);
    assert.equal(packet.sources.some((source) => String(source.source).includes('/')), false);
  });
});

test('default provider reports typed source errors without private absolute paths', () => {
  withTempDir((dir) => {
    const missing = path.join(dir, 'missing');
    const provider = createOntologyProvider({ ontologyDir: missing });
    const validation = provider.validateSource();
    const packet = provider.renderAgentPacket();

    assert.equal(validation.ok, false);
    assert.equal(validation.errors[0].code, 'source_missing');
    assert.doesNotMatch(validation.errors[0].message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(packet.ok, false);
    assert.match(packet.markdown, /jarvOS Ontology Context/);
  });
});

test('provider contract supports alternate fixture implementations', () => {
  const provider = createFixtureOntologyProvider({
    sourceUpdatedAt: '2026-06-25T00:00:00.000Z',
    sections: [
      {
        id: 'meaning',
        title: 'Meaning',
        summary: 'The user values source-backed useful systems.',
        anchors: [{ id: 'M1', label: 'Useful systems', type: 'value', source: 'fixture' }],
      },
    ],
  });

  const packet = provider.renderAgentPacket({ maxChars: 1000 });

  assert.equal(packet.ok, true);
  assert.equal(packet.sourceKind, 'fixture');
  assert.equal(packet.anchors[0].id, 'M1');
  assert.match(packet.markdown, /Useful systems/);
});

test('oversized ontology packets are deterministically budgeted', () => {
  withTempDir((dir) => {
    writeLayer(dir, '2-beliefs.md', `## B1 — Long belief\n${'Long line. '.repeat(1000)}`);

    const packet = createOntologyProvider({ ontologyDir: dir }).renderAgentPacket({ maxChars: 500 });

    assert.equal(packet.budget.truncated, true);
    assert.ok(packet.budget.originalChars > 500);
    assert.ok(packet.markdown.length <= 500);
    assert.match(packet.markdown, /trimmed to 500 characters/);
  });
});

test('proposeUpdate returns a review candidate instead of mutating ontology', () => {
  const provider = createOntologyProvider();
  const proposed = provider.proposeUpdate({
    signalType: 'belief',
    proposedTarget: 'beliefs',
    confidence: 0.72,
    source: { type: 'CaptureEvent', id: 'cap_123' },
    content: 'The user values boring reliability.',
  });

  assert.equal(proposed.status, 'candidate-required');
  assert.equal(proposed.candidate.type, 'ontology-candidate');
  assert.equal(proposed.candidate.proposed_target, 'beliefs');
  assert.equal(proposed.candidate.source.id, 'cap_123');
});
