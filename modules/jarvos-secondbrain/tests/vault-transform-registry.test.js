'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createJarvosVaultTransforms, createVaultTransformRegistry } = require('../src/vault-transform-registry');

function registry() {
  return createVaultTransformRegistry([{ name: 'append-line', version: 1, maxPayloadBytes: 64,
    validatePayload: (payload) => typeof payload?.line === 'string' && payload.line.startsWith('- '),
    normalizePayload: (payload) => ({ line: payload.line.trim() }),
    applyNode: (content, payload) => content.includes(payload.line) ? content : `${content}${content.endsWith('\n') ? '' : '\n'}${payload.line}\n`,
    invariant: (content, payload) => content.includes(payload.line),
  }]);
}

test('registered transform has bounded normalized replay payload and invariant', () => {
  const transforms = registry();
  const prepared = transforms.prepare({ transformName: 'append-line', transformVersion: 1, replayPayload: { line: ' - hello  ' } });
  assert.deepEqual(prepared.replayPayload, { line: '- hello' });
  assert.equal(transforms.applyNode('mobile edit\n', prepared), 'mobile edit\n- hello\n');
  assert.equal(transforms.isSatisfied('- hello\n', prepared), true);
});

test('invalid payload and unknown version quarantine without substituting code', () => {
  const transforms = registry();
  assert.equal(transforms.quarantine({ transformName: 'append-line', transformVersion: 2, replayPayload: { line: '- hello' } }).reason, 'unknown_transform_version');
  assert.equal(transforms.quarantine({ transformName: 'append-line', transformVersion: 1, replayPayload: { line: 'bad' } }).reason, 'invalid_replay_payload');
  assert.throws(() => transforms.prepare({ transformName: 'append-line', transformVersion: 2, replayPayload: { line: '- hello' } }), /unknown transform/i);
});

test('note and session invariants require an exact appended block, not a prose substring', () => {
  const transforms = createJarvosVaultTransforms();
  const initial = '---\njarvos_note_id: "note-1"\n---\n\n# Note\n\nthe next thing\n';
  for (const [transformName, replayPayload] of [
    ['note-append-body', { noteId: 'note-1', body: 'next' }],
    ['session-thread-append', { noteId: 'note-1', entry: 'next' }],
  ]) {
    const operation = { transformName, transformVersion: 1, replayPayload };
    assert.equal(transforms.isSatisfied(initial, operation), false, transformName);
    const updated = transforms.applyNode(initial, operation);
    assert.match(updated, /the next thing\n\nnext\n$/);
    assert.equal(transforms.isSatisfied(updated, operation), true, transformName);
  }
});

test('U4 authored-content transforms have deterministic Node behavior', () => {
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
      content: '---\njarvos_note_id: "stable-note-id"\nstatus: active\n---\n\n# Thread\n\nmobile checkpoint\n',
      operation: { transformName: 'session-thread-append', transformVersion: 1, replayPayload: { noteId: 'stable-note-id', entry: '## Agent checkpoint\n\nagent prose' } },
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
  const appended = transforms.applyNode(cases[1].content, cases[1].operation);
  assert.match(appended, /mobile prose/);
  assert.match(appended, /agent prose/);
  assert.match(appended, /jarvos_note_id: "stable-note-id"/);
  const thread = transforms.applyNode(cases[2].content, cases[2].operation);
  assert.match(thread, /mobile checkpoint/);
  assert.match(thread, /Agent checkpoint/);
  assert.equal((thread.match(/# Thread/g) || []).length, 1);
  const linked = transforms.applyNode(cases[4].content, cases[4].operation);
  assert.equal((linked.match(/\[\[Notes\/C\+\+ \(Draft\)\]\]/g) || []).length, 1);
  assert.equal(transforms.isSatisfied(linked, cases[4].operation), true);
});
