'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CANONICAL_WRITERS,
  DECLARATION_MODES,
  JOURNAL_BULLET_TRANSFORMS,
  SUPPORTED_MATERIAL_JOURNAL_TRANSFORM,
  discoverCanonicalWriterModules,
  verifyJournalTransformInventory,
  verifyWriterInventory,
} = require('../bridge/provenance/src/content-origin-writers');
const { createJarvosVaultTransforms } = require('../src/vault-transform-registry');
const { CONTENT_ORIGIN_FIELDS, canonicalizeFrontmatter } = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');
const { applyRoutingPlan } = require('../bridge/routing/src/keyword-capture-router.js');
const { buildRoutingPlan, journalContentOriginForPlan } = require('../packages/jarvos-ambient/src/routing');
const { parseJournalEntry } = require('../bridge/provenance/src/content-origin-contract');
const { createAcknowledgedVaultMutationService } = require('./helpers/acknowledged-vault-mutation-service');

const TEST_DATE = '2026-01-02';

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-writer-conformance-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  return { root, notesDir, journalDir };
}

function withVaultEnv(vault, fn) {
  const prevNotes = process.env.VAULT_NOTES_DIR;
  const prevJournal = process.env.JOURNAL_DIR;
  process.env.VAULT_NOTES_DIR = vault.notesDir;
  process.env.JOURNAL_DIR = vault.journalDir;
  try {
    return fn({ mutationService: createAcknowledgedVaultMutationService(vault.root), vaultRoot: vault.root, journalDir: vault.journalDir });
  } finally {
    if (prevNotes === undefined) delete process.env.VAULT_NOTES_DIR;
    else process.env.VAULT_NOTES_DIR = prevNotes;
    if (prevJournal === undefined) delete process.env.JOURNAL_DIR;
    else process.env.JOURNAL_DIR = prevJournal;
  }
}

function journalEntryContaining(markdown, needle) {
  const lines = String(markdown).split('\n');
  const index = lines.findIndex((line) => line.trim().startsWith('- ') && line.includes(needle));
  assert.notEqual(index, -1, `journal bullet containing "${needle}" was not written`);
  return parseJournalEntry(lines, index);
}

test('every module that calls a durable write primitive is declared in the writer inventory', () => {
  const report = verifyWriterInventory();

  assert.deepEqual(report.undeclared, [], 'a new canonical writer must declare how it emits jarvos-content-origin/v1');
  assert.deepEqual(report.stale, [], 'the inventory names a module that no longer writes durable records');
  assert.deepEqual(report.kindMismatch, []);
  assert.deepEqual(report.invalidMode, []);
  assert.equal(report.ok, true);
  assert.equal(report.declared, report.discovered);
});

test('the inventory uses only the closed declaration vocabulary and stays non-empty', () => {
  assert.ok(CANONICAL_WRITERS.length >= 7);
  for (const writer of CANONICAL_WRITERS) {
    assert.ok(DECLARATION_MODES.includes(writer.declaration), `${writer.id} has an unknown declaration mode`);
    assert.ok(['note', 'journal', 'note+journal'].includes(writer.kind));
    assert.ok(writer.note.length > 0);
  }
  assert.equal(new Set(CANONICAL_WRITERS.map((writer) => writer.module)).size, CANONICAL_WRITERS.length);
});

test('discovery is declaration-free so an undeclared new writer fails the inventory', () => {
  const discovered = discoverCanonicalWriterModules();
  assert.ok(discovered.some((entry) => entry.module === 'packages/jarvos-secondbrain-notes/src/write-to-vault.js'));

  const declared = new Set(CANONICAL_WRITERS.map((writer) => writer.module));
  const simulatedNewWriter = 'bridge/routing/src/some-future-writer.js';
  assert.equal(declared.has(simulatedNewWriter), false);
});

test('every registered vault transform is declared and material journal bullets use the marker transform', () => {
  const registry = createJarvosVaultTransforms();
  const report = verifyJournalTransformInventory(registry);

  assert.deepEqual(report.undeclared, [], 'a newly registered transform must declare its content-origin behavior');
  assert.deepEqual(report.stale, []);
  assert.equal(report.ok, true);
  assert.equal(report.supportedMaterialTransform, 'journal-section-line@2');

  const supported = JOURNAL_BULLET_TRANSFORMS.find((entry) => (
    entry.name === SUPPORTED_MATERIAL_JOURNAL_TRANSFORM.name
    && entry.version === SUPPORTED_MATERIAL_JOURNAL_TRANSFORM.version
  ));
  assert.equal(supported.declaration, 'journal_marker');

  // The marker transform refuses a payload without an origin declaration.
  assert.throws(() => registry.prepare({
    transformName: 'journal-section-line',
    transformVersion: 2,
    replayPayload: { heading: '## 💡 Ideas', line: '- undeclared' },
  }));
});

test('the canonical note frontmatter path always emits all five v1 fields', () => {
  const cases = [
    {},
    { author: 'andrew' },
    { content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
    { type: 'draft', project: '' },
  ];
  for (const incomingFrontmatter of cases) {
    const canonical = canonicalizeFrontmatter({ incomingFrontmatter, today: TEST_DATE });
    for (const field of CONTENT_ORIGIN_FIELDS) {
      if (field === 'content_origin_source') continue;
      assert.notEqual(canonical.frontmatter[field], undefined, `${field} missing for ${JSON.stringify(incomingFrontmatter)}`);
    }
    assert.equal(canonical.frontmatter.content_origin_schema, 'jarvos-content-origin/v1');
    assert.equal(typeof canonical.frontmatter.human_evidence_eligible, 'boolean');
  }
});

test('material journal bullets are marked; bare note backlink rows are not', () => {
  const ideaPlan = buildRoutingPlan({ text: 'I have an idea: ship a smaller status surface', date: TEST_DATE });
  assert.equal(ideaPlan.route, 'idea');
  assert.ok(journalContentOriginForPlan(ideaPlan));

  const backlinkOnly = { route: 'note', journalLine: '- [[Some Note]]', journalOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' } };
  assert.equal(journalContentOriginForPlan(backlinkOnly), null);

  const materialNoteRow = { ...backlinkOnly, journalLine: '- a captured sentence of prose' };
  assert.ok(journalContentOriginForPlan(materialNoteRow));
});

test('an assistant journal-route capture is not stored as an unmarked manual entry', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, (options) => {
    const result = applyRoutingPlan({
      trigger: 'journal',
      text: 'the release pipeline blocked on a stale attestation',
      date: TEST_DATE,
      content_origin: 'assistant',
      content_origin_basis: 'assistant_generated',
    }, options);

    assert.equal(result.plan.route, 'journal');
    const markdown = fs.readFileSync(path.join(vault.journalDir, `${TEST_DATE}.md`), 'utf8');
    const entry = journalEntryContaining(markdown, 'stale attestation');
    assert.equal(entry.origin.content_origin, 'assistant');
    assert.equal(entry.origin.human_evidence_eligible, false);
    assert.notEqual(entry.marker_line, null);
    // Before the marker existed this same bullet read as Andrew's own words.
    assert.notEqual(entry.origin.normalization_reason, 'unmarked_manual_entry');
  });
});

test('an unmarked human journal claim cannot be produced by a programmatic journal capture', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, (options) => {
    const result = applyRoutingPlan({
      trigger: 'journal',
      text: 'a forged human claim without any receipt',
      date: TEST_DATE,
      content_origin: 'human',
      content_origin_basis: 'verbatim_user',
    }, options);

    assert.equal(result.plan.route, 'journal');
    const markdown = fs.readFileSync(path.join(vault.journalDir, `${TEST_DATE}.md`), 'utf8');
    const entry = journalEntryContaining(markdown, 'forged human claim');
    assert.equal(entry.origin.content_origin, 'unknown');
    assert.equal(entry.origin.human_evidence_eligible, false);
  });
});
