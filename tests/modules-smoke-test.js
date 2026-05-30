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

  const notePlan = sb.buildRoutingPlan({ text: 'make a note about module smoke capture' });
  const flaggedPlan = sb.buildRoutingPlan({ text: 'remember this module smoke capture' });
  if (
    notePlan.route === 'note' &&
    flaggedPlan.route === 'flagged' &&
    sb.SKILL_CONTRACTS &&
    sb.SKILL_CONTRACTS['note-creation']
  ) {
    ok('capture routing contracts are exported');
  } else {
    bad('capture routing contracts', new Error(JSON.stringify({ notePlan, flaggedPlan })));
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
  if (
    toolNames.includes('jarvos_recall')
    && toolNames.includes('jarvos_synthesize')
    && toolNames.includes('jarvos_create_note')
  ) {
    ok('jarvos MCP server exposes recall, synthesis, and note tools');
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

  const obsidianPack = skills.loadPack('obsidian-default');
  const obsidianPlan = skills.buildInstallPlan({
    pack: obsidianPack,
    commandsPresent: {
      obsidian: false,
      defuddle: false,
    },
  });
  if (
    skills.listPacks().includes('obsidian-default')
    && obsidianPack.boundary.foundationRequired === false
    && obsidianPack.boundary.contentContractOwner === '@jarvos/secondbrain'
    && obsidianPlan.status === 'needs-optional-tools'
    && obsidianPlan.missingCommands.includes('obsidian')
    && obsidianPlan.missingCommands.includes('defuddle')
  ) {
    ok('obsidian-default pack is packaged with optional-tool doctor plan');
  } else {
    bad('obsidian-default pack', new Error(JSON.stringify({
      packs: skills.listPacks(),
      boundary: obsidianPack.boundary,
      status: obsidianPlan.status,
      missingCommands: obsidianPlan.missingCommands,
    })));
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

// ── @jarvos/agentify (activity log) ─────────────────────────────────────────

console.log('\n→ @jarvos/agentify (activity log)');

try {
  const agentify = require(path.join(ROOT, 'modules/jarvos-agentify/src/index.js'));
  const os  = require('os');
  const fs  = require('fs');
  const fsp = require('fs').promises;

  // ── Schema: listEventTypes ──────────────────────────────────────────────────
  const types = agentify.listEventTypes();
  if (
    Array.isArray(types)
    && types.includes('agent.loop.started')
    && types.includes('plan.proposed')
    && types.includes('content.published')
    && types.includes('metric.measured')
  ) {
    ok('listEventTypes returns expected taxonomy');
  } else {
    bad('listEventTypes', new Error(JSON.stringify(types)));
  }

  // ── Schema: listEventTypesByGroup ───────────────────────────────────────────
  const agentTypes = agentify.listEventTypesByGroup('agent');
  if (agentTypes.includes('agent.loop.started') && agentTypes.includes('agent.loop.completed')) {
    ok('listEventTypesByGroup returns agent group types');
  } else {
    bad('listEventTypesByGroup', new Error(JSON.stringify(agentTypes)));
  }

  // ── Schema: getEventTypeDef ─────────────────────────────────────────────────
  const def = agentify.getEventTypeDef('plan.proposed');
  if (def && def.group === 'plan' && Array.isArray(def.payloadFields)) {
    ok('getEventTypeDef returns plan.proposed definition');
  } else {
    bad('getEventTypeDef', new Error(JSON.stringify(def)));
  }

  // ── Schema: validateEvent — valid ───────────────────────────────────────────
  const { valid: v1, errors: e1 } = agentify.validateEvent({
    tenant_id:   'aaf',
    type:        'agent.loop.started',
    occurred_at: '2026-05-29T10:00:00.000Z',
    source:      'jarvos-agentify',
  });
  if (v1 && e1.length === 0) {
    ok('validateEvent accepts valid event');
  } else {
    bad('validateEvent valid', new Error(e1.join('; ')));
  }

  // ── Schema: validateEvent — missing tenant_id ───────────────────────────────
  const { valid: v2, errors: e2 } = agentify.validateEvent({
    type: 'agent.loop.started',
    occurred_at: '2026-05-29T10:00:00.000Z',
    source: 'test',
  });
  if (!v2 && e2.some((e) => e.includes('tenant_id'))) {
    ok('validateEvent rejects missing tenant_id');
  } else {
    bad('validateEvent missing tenant_id', new Error('Expected error'));
  }

  // ── Schema: validateEvent — unknown type ────────────────────────────────────
  const { valid: v3, errors: e3 } = agentify.validateEvent({
    tenant_id:   'aaf',
    type:        'not.a.type',
    occurred_at: '2026-05-29T10:00:00.000Z',
    source:      'test',
  });
  if (!v3 && e3.some((e) => e.includes('Unknown event type'))) {
    ok('validateEvent rejects unknown event type');
  } else {
    bad('validateEvent unknown type', new Error('Expected error'));
  }

  // ── ActivityLog: write + read + watermark ───────────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-agentify-test-'));
  const log = agentify.createActivityLog({ storeDir: tmpDir });

  const { event: e, error: writeErr } = log.write('aaf', 'agent.loop.started', {
    loop_id: 'loop-001',
    trigger: 'cron',
  }, { source: 'smoke-test' });

  if (!writeErr && e && e.tenant_id === 'aaf' && e.seq === 1 && e.id && e.schema) {
    ok('write() appends event with tenant_id, seq=1, id, schema');
  } else {
    bad('write() first event', new Error(writeErr || JSON.stringify(e)));
  }

  // second write — different type, same tenant
  const { event: e2w, error: w2err } = log.write('aaf', 'plan.proposed', {
    plan_id: 'plan-001',
    summary: 'Review last 24h and propose next actions.',
  }, { source: 'smoke-test' });

  if (!w2err && e2w && e2w.seq === 2 && e2w.type === 'plan.proposed') {
    ok('write() second event gets seq=2');
  } else {
    bad('write() second event', new Error(w2err || JSON.stringify(e2w)));
  }

  // watermark
  const { seq: wm, error: wmErr } = log.watermark('aaf');
  if (!wmErr && wm === 2) {
    ok('watermark() returns seq=2 after two writes');
  } else {
    bad('watermark()', new Error(wmErr || `seq=${wm}`));
  }

  // read all (after=0)
  const { events: all, cursor: cur1 } = log.read('aaf', { after: 0 });
  if (all.length === 2 && cur1 === 2 && all[0].type === 'agent.loop.started') {
    ok('read() returns all events with cursor=2');
  } else {
    bad('read() all events', new Error(JSON.stringify({ length: all.length, cur1 })));
  }

  // read with watermark (after=1 returns only the second event)
  const { events: incremental, cursor: cur2 } = log.read('aaf', { after: 1 });
  if (incremental.length === 1 && incremental[0].seq === 2 && cur2 === 2) {
    ok('read() incremental after watermark=1 returns one event');
  } else {
    bad('read() incremental', new Error(JSON.stringify({ length: incremental.length, cur2 })));
  }

  // read with type filter
  const { events: filtered } = log.read('aaf', { after: 0, types: ['plan.proposed'] });
  if (filtered.length === 1 && filtered[0].type === 'plan.proposed') {
    ok('read() type filter returns only matching events');
  } else {
    bad('read() type filter', new Error(JSON.stringify(filtered)));
  }

  // read with wildcard type filter
  const { events: wildcardFiltered } = log.read('aaf', { after: 0, types: ['agent.*'] });
  if (wildcardFiltered.length >= 1 && wildcardFiltered.every((ev) => ev.type.startsWith('agent.'))) {
    ok('read() wildcard type filter supports group matching');
  } else {
    bad('read() wildcard type filter', new Error(JSON.stringify(wildcardFiltered)));
  }

  // read from empty / non-existent tenant
  const { events: none, error: noneErr } = log.read('no-such-tenant', { after: 0 });
  if (!noneErr && none.length === 0) {
    ok('read() on non-existent tenant returns empty array without error');
  } else {
    bad('read() non-existent tenant', new Error(noneErr || `length=${none.length}`));
  }

  // multi-tenant isolation
  log.write('jarvos', 'system.checkpoint', { status: 'ok' }, { source: 'smoke-test' });
  const { seq: jarvosSeq } = log.watermark('jarvos');
  const { seq: aafSeq }    = log.watermark('aaf');
  if (jarvosSeq === 1 && aafSeq === 2) {
    ok('multi-tenant isolation: separate watermarks per tenant');
  } else {
    bad('multi-tenant isolation', new Error(`jarvosSeq=${jarvosSeq} aafSeq=${aafSeq}`));
  }

  // ── ActivityLog: subscription (manual poll) ─────────────────────────────────
  const received = [];
  const sub = log.subscribe('aaf', (events) => received.push(...events), {
    pollIntervalMs: 0,  // manual-poll mode for testing
    after: 2,
  });

  // write a third event
  log.write('aaf', 'agent.loop.completed', {
    loop_id: 'loop-001',
    duration_ms: 1200,
    outcome: 'ok',
  }, { source: 'smoke-test' });

  // manually poll
  sub._poll();
  sub.stop();

  if (received.length === 1 && received[0].type === 'agent.loop.completed') {
    ok('subscribe() delivers new events after manual poll');
  } else {
    bad('subscribe() manual poll', new Error(JSON.stringify(received)));
  }

  // write validation: unknown type is rejected
  const { event: badEv, error: badEvErr } = log.write('aaf', 'not.a.real.type', {});
  if (badEv === null && badEvErr && badEvErr.includes('validation failed')) {
    ok('write() rejects unknown event type');
  } else {
    bad('write() unknown type rejection', new Error(badEvErr || 'Expected error'));
  }

  // write validation: missing required payload field is rejected
  const { event: badPayload, error: badPayloadErr } = log.write('aaf', 'agent.loop.completed', {
    loop_id: 'loop-002',
  });
  if (badPayload === null && badPayloadErr && badPayloadErr.includes('payload field')) {
    ok('write() rejects events missing required payload fields');
  } else {
    bad('write() required payload field validation', new Error(badPayloadErr || JSON.stringify(badPayload)));
  }

  // tenant IDs are filesystem path segments: traversal must be rejected
  const { event: traversalEv, error: traversalErr } = log.write('../escape', 'system.checkpoint', { status: 'bad' });
  const escapedPath = path.join(tmpDir, 'escape', 'activity.jsonl');
  if (traversalEv === null && traversalErr && traversalErr.includes('tenant_id') && !fs.existsSync(escapedPath)) {
    ok('write() rejects tenant_id path traversal');
  } else {
    bad('write() tenant traversal rejection', new Error(JSON.stringify({ traversalEv, traversalErr, escapedExists: fs.existsSync(escapedPath) })));
  }

  // failed appends must not advance the persisted watermark
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-agentify-fail-'));
  const failStoreDir = path.join(failDir, 'activity-log');
  const originalAppendFileSync = fs.appendFileSync;
  fs.appendFileSync = function patchedAppendFileSync(filePath, ...args) {
    if (String(filePath).endsWith(path.join('fail-append', 'activity.jsonl'))) {
      throw new Error('simulated append failure');
    }
    return originalAppendFileSync.call(this, filePath, ...args);
  };
  try {
    const failed = agentify.store.appendEvent(failStoreDir, 'fail-append', {
      schema: agentify.SCHEMA_VERSION,
      id: 'fail-1',
      tenant_id: 'fail-append',
      type: 'system.checkpoint',
      occurred_at: new Date().toISOString(),
      recorded_at: new Date().toISOString(),
      source: 'smoke-test',
      payload: {},
    });
    const { seq: failedSeq } = agentify.store.getWatermark(failStoreDir, 'fail-append');
    if (failed.event === null && failed.error && failedSeq === 0) {
      ok('appendEvent() failed append leaves watermark unchanged');
    } else {
      bad('appendEvent() failed append watermark', new Error(JSON.stringify({ failed, failedSeq })));
    }
  } finally {
    fs.appendFileSync = originalAppendFileSync;
    fs.rmSync(failDir, { recursive: true, force: true });
  }

  // cleanup tmp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });

} catch (e) {
  bad('@jarvos/agentify module load', e);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed.\n`);
if (fail > 0) {
  process.exit(1);
}
