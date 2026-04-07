#!/usr/bin/env node
/**
 * modules-smoke-test.js — proves the three jarvOS modules load and produce valid output
 *
 * Run: node tests/modules-smoke-test.js
 */

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

function ok(label)  { console.log(`  ✓ ${label}`); pass++; }
function bad(label, err) { console.error(`  ✗ ${label}: ${err.message || err}`); fail++; }

// ── @jarvos/memory ──────────────────────────────────────────────────────────

console.log('\n→ @jarvos/memory');

try {
  const mem = require(path.join(ROOT, 'modules/jarvos-memory/src/index.js'));

  // getMemoryClasses
  const classes = mem.getMemoryClasses();
  if (Array.isArray(classes) && classes.includes('lesson') && classes.includes('fact')) {
    ok('getMemoryClasses returns expected values');
  } else {
    bad('getMemoryClasses', new Error(`Got: ${JSON.stringify(classes)}`));
  }

  // createMemoryRecord — valid
  const r = mem.createMemoryRecord({
    class: 'lesson',
    content: 'Prefer env-var path resolution over hardcoded home directories.',
    rationale: 'Enables portability across machines and CI.',
    confidence: 0.95,
  });
  if (!r.error && r.record && r.record.class === 'lesson' && r.record.id) {
    ok('createMemoryRecord returns valid lesson record');
  } else {
    bad('createMemoryRecord', new Error(r.error || JSON.stringify(r)));
  }

  // createMemoryRecord — unknown class
  const bad1 = mem.createMemoryRecord({ class: 'unknown', content: 'test' });
  if (bad1.error && !bad1.record) {
    ok('createMemoryRecord rejects unknown class');
  } else {
    bad('createMemoryRecord unknown class', new Error('Expected error, got: ' + JSON.stringify(bad1)));
  }

  // createMemoryRecord — empty content
  const bad2 = mem.createMemoryRecord({ class: 'fact', content: '' });
  if (bad2.error && !bad2.record) {
    ok('createMemoryRecord rejects empty content');
  } else {
    bad('createMemoryRecord empty content', new Error('Expected error'));
  }

  // validateMemoryRecord
  const { valid, errors } = mem.validateMemoryRecord(r.record);
  if (valid && errors.length === 0) {
    ok('validateMemoryRecord accepts valid record');
  } else {
    bad('validateMemoryRecord', new Error(errors.join('; ')));
  }

  // validateMemoryRecord — invalid
  const { valid: v2, errors: e2 } = mem.validateMemoryRecord({ class: 'fact' });
  if (!v2 && e2.length > 0) {
    ok('validateMemoryRecord rejects invalid record');
  } else {
    bad('validateMemoryRecord invalid', new Error('Expected errors'));
  }

} catch (e) {
  bad('@jarvos/memory module load', e);
}

// ── @jarvos/ontology ────────────────────────────────────────────────────────

console.log('\n→ @jarvos/ontology');

try {
  const onto = require(path.join(ROOT, 'modules/jarvos-ontology/src/index.js'));

  // LAYER_NAMES
  if (onto.LAYER_NAMES.includes('belief') && onto.LAYER_NAMES.includes('goal')) {
    ok('LAYER_NAMES contains expected layers');
  } else {
    bad('LAYER_NAMES', new Error(JSON.stringify(onto.LAYER_NAMES)));
  }

  // createLayer — belief
  const entry = onto.createLayer('belief', {
    statement: 'Reliable automation compounds faster than heroic one-off effort.',
    confidence: 0.9,
  });
  if (entry.layer === 'belief' && entry.id && entry.statement) {
    ok('createLayer creates valid belief entry');
  } else {
    bad('createLayer belief', new Error(JSON.stringify(entry)));
  }

  // validateEntry — valid
  const { valid, errors } = onto.validateEntry(entry);
  if (valid) {
    ok('validateEntry accepts valid belief');
  } else {
    bad('validateEntry', new Error(errors.join('; ')));
  }

  // validateEntry — invalid (prediction missing resolveBy)
  const pred = onto.createLayer('prediction', { statement: 'test', resolveBy: '2027-01-01' });
  const { valid: v2 } = onto.validateEntry(pred);
  if (v2) {
    ok('validateEntry accepts valid prediction');
  } else {
    bad('validateEntry valid prediction', new Error('Expected valid'));
  }

  // getLayerDef
  const def = onto.getLayerDef('goal');
  if (def && def.label && def.requiredFields.includes('targetDate')) {
    ok('getLayerDef returns correct goal definition');
  } else {
    bad('getLayerDef', new Error(JSON.stringify(def)));
  }

  // createLayer — unknown layer throws
  try {
    onto.createLayer('nonexistent', {});
    bad('createLayer unknown layer', new Error('Expected throw'));
  } catch (_) {
    ok('createLayer throws on unknown layer');
  }

} catch (e) {
  bad('@jarvos/ontology module load', e);
}

// ── @jarvos/secondbrain ─────────────────────────────────────────────────────

console.log('\n→ @jarvos/secondbrain');

try {
  // Override env to avoid needing real vault paths
  process.env.JARVOS_JOURNAL_DIR = '/tmp/jarvos-test/journal';
  process.env.JARVOS_NOTES_DIR   = '/tmp/jarvos-test/notes';

  const sb = require(path.join(ROOT, 'modules/jarvos-secondbrain/src/index.js'));

  // resolveJournalDir respects env
  const jDir = sb.resolveJournalDir();
  if (jDir === '/tmp/jarvos-test/journal') {
    ok('resolveJournalDir respects JARVOS_JOURNAL_DIR env');
  } else {
    bad('resolveJournalDir', new Error(`Got: ${jDir}`));
  }

  // createJournalEntry
  const entry = sb.createJournalEntry({
    date: '2026-03-27',
    title: 'Test entry',
    body: 'Testing jarvOS modules.',
    tags: ['test'],
  });
  if (entry.type === 'journal-entry' && entry.date === '2026-03-27' && entry.id) {
    ok('createJournalEntry returns valid entry');
  } else {
    bad('createJournalEntry', new Error(JSON.stringify(entry)));
  }

  // journalEntryPath
  const jPath = sb.journalEntryPath('2026-03-27');
  if (jPath.endsWith('2026-03-27.md')) {
    ok('journalEntryPath returns correct path');
  } else {
    bad('journalEntryPath', new Error(`Got: ${jPath}`));
  }

  // createNote
  const note = sb.createNote({ title: 'Architecture decisions', tags: ['arch'] });
  if (note.type === 'note' && note.title === 'Architecture decisions' && note.id) {
    ok('createNote returns valid note');
  } else {
    bad('createNote', new Error(JSON.stringify(note)));
  }

  // notePath sanitization
  const nPath = sb.notePath('Test: note/with special chars');
  if (!nPath.includes(':') && !nPath.includes('/Test:')) {
    ok('notePath sanitizes special characters');
  } else {
    bad('notePath', new Error(`Got: ${nPath}`));
  }

} catch (e) {
  bad('@jarvos/secondbrain module load', e);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed.\n`);
if (fail > 0) {
  process.exit(1);
}
