'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createJarvosVaultTransforms, createVaultTransformRegistry } = require('../src/vault-transform-registry');

function registry() {
  return createVaultTransformRegistry([{ name: 'append-line', version: 1, maxPayloadBytes: 64,
    validatePayload: (payload) => typeof payload?.line === 'string' && payload.line.startsWith('- '),
    normalizePayload: (payload) => ({ line: payload.line.trim() }),
    applyNode: (content, payload) => content.includes(payload.line) ? content : `${content}${content.endsWith('\n') ? '' : '\n'}${payload.line}\n`,
    applyObsidian: (content, payload) => content.includes(payload.line) ? content : `${content}${content.endsWith('\n') ? '' : '\n'}${payload.line}\n`,
    invariant: (content, payload) => content.includes(payload.line),
  }]);
}

test('registered transform has bounded normalized replay payload and Node/Obsidian parity', () => {
  const transforms = registry();
  const prepared = transforms.prepare({ transformName: 'append-line', transformVersion: 1, replayPayload: { line: ' - hello  ' } });
  assert.deepEqual(prepared.replayPayload, { line: '- hello' });
  assert.equal(transforms.applyNode('mobile edit\n', prepared), transforms.applyObsidian('mobile edit\n', prepared));
  assert.equal(transforms.isSatisfied('- hello\n', prepared), true);
  assert.doesNotThrow(() => transforms.assertConformance([{ content: 'mobile edit\n', operation: prepared }, { content: '- hello\n', operation: prepared }]));
});

test('invalid payload and unknown version quarantine without substituting code', () => {
  const transforms = registry();
  assert.equal(transforms.quarantine({ transformName: 'append-line', transformVersion: 2, replayPayload: { line: '- hello' } }).reason, 'unknown_transform_version');
  assert.equal(transforms.quarantine({ transformName: 'append-line', transformVersion: 1, replayPayload: { line: 'bad' } }).reason, 'invalid_replay_payload');
  assert.throws(() => transforms.prepare({ transformName: 'append-line', transformVersion: 2, replayPayload: { line: '- hello' } }), /unknown transform/i);
});

test('U4 authored-content transforms have deterministic Node and Obsidian conformance', () => {
  const transforms = createJarvosVaultTransforms();
  const cases = [
    {
      content: '## 📝 Notes\n-\n',
      operation: { transformName: 'append-line', transformVersion: 1, replayPayload: { line: '- [[Notes/One]]' } },
    },
    {
      content: '---\njarvos_note_id: "stable-note-id"\nstatus: active\n---\n\n# Existing\n\nmobile prose\n',
      operation: { transformName: 'note-append-body', transformVersion: 1, replayPayload: { noteId: 'stable-note-id', body: '# Existing\n\nagent prose' } },
    },
    {
      content: '## 💡 Ideas\n-\n\n## Scratch\n- mobile prose\n',
      operation: { transformName: 'journal-section-line', transformVersion: 1, replayPayload: { heading: '## 💡 Ideas', line: '- New idea' } },
    },
    {
      content: '## 📝 Notes\n- [[Notes/C++ (Draft)]]\n\n## Scratch\n- [[Notes/C++ (Draft)]]\n- mobile prose\n',
      operation: { transformName: 'journal-backlink', transformVersion: 1, replayPayload: { linkTarget: 'Notes/C++ (Draft)', section: '📝 Notes', noteId: 'stable-note-id' } },
    },
  ];
  transforms.assertConformance(cases);
  const appended = transforms.applyNode(cases[1].content, cases[1].operation);
  assert.match(appended, /mobile prose/);
  assert.match(appended, /agent prose/);
  assert.match(appended, /jarvos_note_id: "stable-note-id"/);
  const linked = transforms.applyNode(cases[3].content, cases[3].operation);
  assert.equal((linked.match(/\[\[Notes\/C\+\+ \(Draft\)\]\]/g) || []).length, 1);
  assert.equal(transforms.isSatisfied(linked, cases[3].operation), true);
});
