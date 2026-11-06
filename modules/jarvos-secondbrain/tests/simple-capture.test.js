'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSimpleCaptureEvent, simpleCapture } = require('../bridge/capture/src/simple-capture');
const { normalizeCaptureEvent } = require('../bridge/capture/src/universal-capture');
const { createAcknowledgedVaultMutationService } = require('./helpers/acknowledged-vault-mutation-service');
const base = { kind: 'idea', text: '  A test thought about tidal gardens  ', words: 'user', asked: 'explicit', source: 'codex' };

test('simple capture maps words and validates through the existing contract', () => {
  for (const words of ['user', 'assistant', 'mixed']) {
    const event = buildSimpleCaptureEvent({ ...base, words });
    const normalized = normalizeCaptureEvent(event, { requireDeclaration: true });
    assert.equal(event.text, base.text.trim());
    assert.equal(event.substantive, false);
    assert.equal(event.trigger, 'idea');
    assert.equal(event.frontmatter.capture_asked, 'explicit');
    assert.equal(normalized.content_origin, words === 'user' ? 'unknown' : words);
    assert.equal(normalized.content_origin_basis, { user: 'unknown', assistant: 'assistant_generated', mixed: 'mixed_composition' }[words]);
    assert.equal(normalized.human_evidence_eligible, false);
    if (words === 'user') assert.equal(event.content_origin_drafting, undefined);
    else assert.deepEqual(event.content_origin_drafting, [{ kind: words === 'assistant' ? 'assistant_draft' : 'assistant_edit', harness: 'codex', model: 'unknown', model_evidence: 'unknown' }]);
  }
  for (const model of ['test-model', 'unknown']) {
    const event = buildSimpleCaptureEvent({ ...base, words: 'assistant', model });
    assert.equal(normalizeCaptureEvent(event).content_origin_drafting[0].model_evidence, model === 'unknown' ? 'unknown' : 'declared');
  }
  for (const source of ['cli', 'mcp', 'Test harness']) {
    const normalized = normalizeCaptureEvent(buildSimpleCaptureEvent({ ...base, source }));
    assert.equal(normalized.source.label, source);
  }
  assert.equal(buildSimpleCaptureEvent({ ...base, asked: 'accepted_offer' }).frontmatter.capture_asked, 'accepted_offer');
});

test('simple capture rejects unsupported or missing declarations', () => {
  for (const kind of ['idea', 'journal']) assert.throws(() => buildSimpleCaptureEvent({ ...base, kind, title: 'Tidal gardens' }), /title is only used for notes/);
  for (const asked of [undefined, 'unasked', 'ambient']) assert.throws(() => buildSimpleCaptureEvent({ ...base, asked }), /save only when the user asked or accepted an offer/);
  for (const patch of [{ kind: 'project' }, { words: 'human' }, { text: '' }, { text: 3 }, { source: '' }, { date: '2026-02-30' }, { title: null, kind: 'note' }, { model: 5 }]) {
    assert.throws(() => buildSimpleCaptureEvent({ ...base, ...patch }));
  }
});

test('simple capture passes options and reports plain acknowledged or failed messages', () => {
  for (const kind of ['idea', 'journal', 'note']) {
    for (const date of [undefined, '2026-06-22']) {
      const result = { ok: true, note: { title: 'Tidal gardens' }, artifactReceipt: { artifacts: [
        { kind: 'note', vaultRelativePath: 'Notes/Tidal gardens.md', outcome: 'committed' },
        { kind: 'journal', vaultRelativePath: 'Journal/2026-06-22.md', outcome: 'committed' },
      ] } };
      const response = simpleCapture({ ...base, kind, date }, { marker: 1, capture(event, options) {
        assert.equal(event.trigger, kind);
        assert.deepEqual(options, { marker: 1 });
        return result;
      } });
      assert.equal(response.result, result);
      assert.equal(response.kind, kind);
      assert.equal(response.ok, true);
      const expected = kind === 'note'
        ? `Saved as the note "Tidal gardens", linked from ${date ? 'Notes for ' + date : "today's Notes"}.`
        : date ? `Saved to ${kind === 'idea' ? 'Ideas' : 'Journal'} for ${date}.` : `Saved to today's ${kind === 'idea' ? 'Ideas' : 'Journal'}.`;
      assert.equal(response.message, expected);
    }
  }
  const receipt = (...outcomes) => ({ ok: false, artifactReceipt: { artifacts: outcomes.map((outcome, i) => ({ kind: 'journal', vaultRelativePath: `Journal/2026-06-2${i}.md`, outcome })) } });
  for (const outcomes of [['saved_locally_sync_pending'], ['deferred'], ['committed', 'deferred']]) {
    const response = simpleCapture(base, { capture: () => receipt(...outcomes) });
    assert.equal(response.ok, false);
    assert.match(response.message, /^Not confirmed yet: .*Check whether it is there before saving it again\.$/);
  }
  for (const outcomes of [['deferred', 'failed'], ['saved_locally_sync_pending', 'failed']]) {
    const response = simpleCapture(base, { capture: () => receipt(...outcomes) });
    assert.match(response.message, /^Not confirmed yet: /);
  }
  for (const outcome of ['failed', 'conflict']) {
    const response = simpleCapture(base, { capture: () => receipt(outcome) });
    assert.equal(response.ok, false);
    assert.match(response.message, new RegExp(`^Not saved: .*${outcome}`));
  }
  assert.equal(simpleCapture(base, { capture: () => ({ ok: false, error: 'A test failure\nwith detail' }) }).message, 'Not saved: A test failure with detail');
});

test('simple capture integrates all three kinds through temporary acknowledged vault storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-simple-capture-'));
  const notes = path.join(root, 'Notes');
  const journal = path.join(root, 'Journal');
  fs.mkdirSync(notes); fs.mkdirSync(journal);
  const overrides = { JARVOS_VAULT_DIR: root, JARVOS_NOTES_DIR: notes, VAULT_NOTES_DIR: notes, JARVOS_JOURNAL_DIR: journal, JOURNAL_DIR: journal, JARVOS_KNOWLEDGE_DIR: path.join(root, '.jarvos/knowledge'), XDG_STATE_HOME: path.join(root, '.state') };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const options = { vaultRoot: root, journalDir: journal, mutationService: createAcknowledgedVaultMutationService(root) };
    const capture = (kind, extra = {}) => simpleCapture({ ...base, kind, date: '2026-06-22', ...extra }, options);
    const idea = capture('idea');
    assert.equal(idea.ok, true, idea.message);
    assert.deepEqual(fs.readdirSync(notes), []);
    let content = fs.readFileSync(path.join(journal, '2026-06-22.md'), 'utf8');
    assert.match(content, /## 💡 Ideas\n- A test thought about tidal gardens/);
    assert.equal(content.split('- A test thought about tidal gardens').length - 1, 1);
    const entry = capture('journal', { text: 'A test journal about lunar orchards' });
    assert.equal(entry.ok, true, entry.message);
    content = fs.readFileSync(path.join(journal, '2026-06-22.md'), 'utf8');
    assert.match(content, /## 📓 Journal\n- A test journal about lunar orchards/);
    const note = capture('note', { title: 'Tidal gardens', words: 'assistant', model: 'test-model' });
    assert.equal(note.ok, true, note.message);
    assert.equal(fs.existsSync(note.result.note.path), true);
    content = fs.readFileSync(path.join(journal, '2026-06-22.md'), 'utf8');
    assert.match(content, /## 📝 Notes\n- \[\[Tidal gardens\]\]/);
    assert.equal(content.split('[[Tidal gardens]]').length - 1, 1);
    assert.equal(fs.readdirSync(notes).filter((name) => name.endsWith('.md')).length, 1);
    assert.match(fs.readFileSync(note.result.note.path, 'utf8'), /capture_asked: explicit/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('conflicting leading commands cannot override the requested capture kind', () => {
  for (const [kind, text] of [['idea', 'Note: A test thought about tidal gardens'], ['note', 'Idea: A test thought about tidal gardens'], ['journal', 'Note: A test thought about tidal gardens']]) {
    assert.throws(() => simpleCapture({ ...base, kind, text }, { capture: () => assert.fail('must reject before capture') }), /remove that prefix or use kind/);
  }
});

test('a saved note whose journal link failed is reported as saved, not as a failure', () => {
  const response = simpleCapture({ ...base, kind: 'note', title: 'Tidal gardens' }, { capture: () => ({
    ok: false,
    note: { title: 'Tidal gardens' },
    artifactReceipt: { artifacts: [
      { kind: 'note', vaultRelativePath: 'Notes/Tidal gardens.md', outcome: 'committed' },
      { kind: 'journal', vaultRelativePath: 'Journal/2026-06-22.md', outcome: 'failed' },
    ] },
  }) });
  assert.equal(response.ok, false);
  assert.match(response.message, /^Saved the note "Tidal gardens", but its link from today's Notes is not confirmed .*Do not save the note again\.$/);
});

test('an explicit kind keeps the words exactly as given', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-simple-verbatim-'));
  const notes = path.join(root, 'Notes');
  const journal = path.join(root, 'Journal');
  fs.mkdirSync(notes); fs.mkdirSync(journal);
  const overrides = { JARVOS_VAULT_DIR: root, JARVOS_NOTES_DIR: notes, VAULT_NOTES_DIR: notes, JARVOS_JOURNAL_DIR: journal, JOURNAL_DIR: journal, JARVOS_KNOWLEDGE_DIR: path.join(root, '.jarvos/knowledge'), XDG_STATE_HOME: path.join(root, '.state') };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const options = { vaultRoot: root, journalDir: journal, mutationService: createAcknowledgedVaultMutationService(root) };
    for (const kind of ['journal', 'idea']) {
      const text = `I have an idea about a test ${kind} on lunar orchards.`;
      const response = simpleCapture({ ...base, kind, text, date: '2026-06-22' }, options);
      assert.equal(response.ok, true, response.message);
      assert.match(fs.readFileSync(path.join(journal, '2026-06-22.md'), 'utf8'), new RegExp(`- ${text.replace(/\./g, '\\.')}`));
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('formatted text is refused for Ideas and Journal with a pointer to notes, before anything is written', () => {
  for (const kind of ['idea', 'journal']) {
    for (const text of ['Today I finished:\n- A test review\n- A test plan', '## A test heading', 'A test\ttab']) {
      assert.throws(() => simpleCapture({ ...base, kind, text }, { capture: () => assert.fail('must reject before capture') }), /save it with kind "note"/);
    }
  }
  assert.doesNotThrow(() => buildSimpleCaptureEvent({ ...base, kind: 'note', title: 'Test list', text: 'Today I finished:\n- A test review' }));
  assert.doesNotThrow(() => buildSimpleCaptureEvent({ ...base, kind: 'journal', text: 'A test first paragraph.\n\nA test second paragraph.' }));
});

test('a saved note is not described as linked when no journal link was acknowledged', () => {
  const response = simpleCapture({ ...base, kind: 'note', title: 'Tidal gardens' }, { capture: () => ({
    ok: true,
    note: { title: 'Tidal gardens' },
    artifactReceipt: { artifacts: [{ kind: 'note', vaultRelativePath: 'Notes/Tidal gardens.md', outcome: 'committed' }] },
  }) });
  assert.equal(response.message, 'Saved as the note "Tidal gardens".');
});

test('a matching command prefix does not let invalid text past the bullet check', () => {
  for (const [kind, text] of [['journal', 'Journal: ## A test heading'], ['idea', 'Idea: - A test item'], ['journal', 'Journal:   ']]) {
    assert.throws(() => simpleCapture({ ...base, kind, text }, { capture: () => assert.fail('must reject before capture') }));
  }
});

test('the router never adds a backlink for a note whose write failed', () => {
  const { artifactFromMutationResult } = require('../src/artifact-receipt');
  let journalCalls = 0;
  const adapter = {
    writeNote: () => ({ written: false, title: 'Tidal gardens', artifactReceipt: { schemaVersion: 'jarvos.artifact-receipt.v1', artifacts: [artifactFromMutationResult({ kind: 'note', vaultRelativePath: 'Notes/Tidal gardens.md', outcome: 'failed' })] } }),
    appendLineToJournalSection: () => { journalCalls += 1; return { ok: true }; },
    ensureJournal: () => { journalCalls += 1; return { ok: true }; },
  };
  const response = simpleCapture({ ...base, kind: 'note', title: 'Tidal gardens', date: '2026-06-22' }, { adapter });
  assert.equal(response.ok, false);
  assert.equal(journalCalls, 0);
  assert.match(response.message, /^Not saved: /);
});

test('title and model must be single lines', () => {
  assert.throws(() => buildSimpleCaptureEvent({ ...base, kind: 'note', title: 'A test\ntitle' }), /single line/);
  assert.throws(() => buildSimpleCaptureEvent({ ...base, model: 'test\rmodel' }), /single line/);
});
