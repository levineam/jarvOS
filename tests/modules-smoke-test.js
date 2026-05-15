#!/usr/bin/env node
/**
 * modules-smoke-test.js — proves the jarvOS modules load and produce valid output
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

// ── @jarvos/gbrain ──────────────────────────────────────────────────────────

console.log('\n→ @jarvos/gbrain');

try {
  const gb = require(path.join(ROOT, 'modules/jarvos-gbrain/src/index.js'));

  // slugify
  const slug = gb.slugify('JarVOS & GBrain: Integration');
  if (slug === 'jarvos-and-gbrain-integration') {
    ok('slugify returns stable GBrain slug');
  } else {
    bad('slugify', new Error(`Got: ${slug}`));
  }

  // resolveConfig defaults
  const cfg = gb.resolveConfig({
    vaultDir: '/tmp/jarvos-vault',
    brainDir: '/tmp/jarvos-brain',
    gbrainDir: '/tmp/jarvos-gbrain',
  });
  if (cfg.vaultDir === '/tmp/jarvos-vault' && cfg.brainDir === '/tmp/jarvos-brain') {
    ok('resolveConfig accepts portable overrides');
  } else {
    bad('resolveConfig', new Error(JSON.stringify(cfg)));
  }

  // createImportPlan with default empty manifest
  const plan = gb.createImportPlan();
  if (Array.isArray(plan.items) && Array.isArray(plan.warnings)) {
    ok('createImportPlan returns plan shape');
  } else {
    bad('createImportPlan', new Error(JSON.stringify(plan)));
  }

  // sync dry-run
  const sync = gb.syncBrain({ brainDir: '/tmp/jarvos-brain', gbrainDir: '/tmp/jarvos-gbrain' }, { dryRun: true });
  if (sync.ok && sync.sync.args.includes('--repo') && sync.embed.args.includes('--stale')) {
    ok('syncBrain dry-run returns planned commands');
  } else {
    bad('syncBrain dry-run', new Error(JSON.stringify(sync)));
  }

} catch (e) {
  bad('@jarvos/gbrain module load', e);
}

// ── @jarvos/agent-context ──────────────────────────────────────────────────

console.log('\n→ @jarvos/agent-context');

try {
  const ctx = require(path.join(ROOT, 'modules/jarvos-agent-context/src/index.js'));
  const mcp = require(path.join(ROOT, 'modules/jarvos-agent-context/scripts/jarvos-mcp.js'));

  const frontmatter = ctx.defaultFrontmatter({ project: 'smoke' });
  if (
    frontmatter.status === 'draft'
    && frontmatter.type === 'note'
    && frontmatter.project === 'smoke'
  ) {
    ok('defaultFrontmatter returns required note fields');
  } else {
    bad('defaultFrontmatter', new Error(JSON.stringify(frontmatter)));
  }

  const toolNames = mcp.TOOLS.map((tool) => tool.name);
  if (toolNames.includes('jarvos_recall') && toolNames.includes('jarvos_create_note')) {
    ok('jarvos MCP server exposes recall and note tools');
  } else {
    bad('jarvos MCP tools', new Error(JSON.stringify(toolNames)));
  }

} catch (e) {
  bad('@jarvos/agent-context module load', e);
}

// ── @jarvos/skills ──────────────────────────────────────────────────────────

console.log('\n→ @jarvos/skills');

try {
  const skills = require(path.join(ROOT, 'modules/jarvos-skills/src/index.js'));
  const validation = skills.validateBundle();
  const manifest = skills.getManifest();
  const names = skills.listSkills().map((skill) => skill.name);

  if (validation.ok && validation.skillCount === 4) {
    ok('validateBundle accepts default skill bundle');
  } else {
    bad('validateBundle', new Error(JSON.stringify(validation)));
  }

  if (
    names.includes('workflow-execution')
    && names.includes('rule-creation')
    && names.includes('context-management')
    && names.includes('cron-hygiene')
    && !manifest.defaultSkills.includes('qmd')
  ) {
    ok('default skills include OS bundle and exclude QMD');
  } else {
    bad('default skills', new Error(JSON.stringify({ names, defaultSkills: manifest.defaultSkills })));
  }

  const workflow = skills.getSkill('workflow-execution');
  if (
    workflow
    && workflow.name === 'workflow-execution'
    && typeof workflow.content === 'string'
    && workflow.content.includes('name: workflow-execution')
  ) {
    ok('getSkill returns packaged skill content');
  } else {
    bad('getSkill workflow-execution', new Error(JSON.stringify(workflow && workflow.name)));
  }
} catch (e) {
  bad('@jarvos/skills module load', e);
}

// ── @jarvos/runtime-kit ────────────────────────────────────────────────────

console.log('\n→ @jarvos/runtime-kit');

try {
  const runtimeKit = require(path.join(ROOT, 'modules/jarvos-runtime-kit/src/index.js'));
  const manifests = runtimeKit.listRuntimeManifests(ROOT);
  if (manifests.length >= 3) {
    ok('listRuntimeManifests finds checked-in runtime adapters');
  } else {
    bad('listRuntimeManifests', new Error(JSON.stringify(manifests)));
  }

  const checked = manifests.map((manifest) => runtimeKit.checkRuntime(manifest, { root: ROOT }));
  const failed = checked.filter((result) => !result.ok);
  if (failed.length === 0) {
    ok('checkRuntime passes checked-in runtime adapters');
  } else {
    bad('checkRuntime', new Error(JSON.stringify(failed)));
  }
} catch (e) {
  bad('@jarvos/runtime-kit module load', e);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed.\n`);
if (fail > 0) {
  process.exit(1);
}
