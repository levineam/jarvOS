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

  // ── Schema: validateEvent — unsafe tenant_id ───────────────────────────────
  const { valid: v2b, errors: e2b } = agentify.validateEvent({
    tenant_id: '../aaf',
    type: 'agent.loop.started',
    occurred_at: '2026-05-29T10:00:00.000Z',
    source: 'test',
  });
  if (!v2b && e2b.some((e) => e.includes('safe path segment'))) {
    ok('validateEvent rejects unsafe tenant_id path segments');
  } else {
    bad('validateEvent unsafe tenant_id', new Error('Expected safe path segment error'));
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

  const storeRoot = path.join(tmpDir, 'activity-log');
  const staleTenantDir = path.join(storeRoot, 'stale-lock');
  fs.mkdirSync(staleTenantDir, { recursive: true });
  const staleLockPath = path.join(staleTenantDir, '.activity.lock');
  fs.writeFileSync(staleLockPath, JSON.stringify({ pid: 0 }), 'utf8');
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(staleLockPath, staleTime, staleTime);
  const { event: staleLockEvent, error: staleLockErr } = log.write('stale-lock', 'system.checkpoint', {
    status: 'ok',
  }, { source: 'smoke-test' });
  if (!staleLockErr && staleLockEvent && staleLockEvent.seq === 1) {
    ok('write() recovers from stale tenant lock file');
  } else {
    bad('write() stale tenant lock recovery', new Error(staleLockErr || JSON.stringify(staleLockEvent)));
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

  // read from empty / non-existent tenant
  const { events: none, error: noneErr } = log.read('no-such-tenant', { after: 0 });
  if (!noneErr && none.length === 0) {
    ok('read() on non-existent tenant returns empty array without error');
  } else {
    bad('read() non-existent tenant', new Error(noneErr || `length=${none.length}`));
  }

  const { event: escapedTenantEvent, error: escapedTenantErr } = log.write('../escape', 'agent.loop.started', {
    loop_id: 'bad',
    trigger: 'test',
  }, { source: 'smoke-test' });
  if (escapedTenantEvent === null && escapedTenantErr && escapedTenantErr.includes('safe path segment')) {
    ok('write() rejects unsafe tenant_id before filesystem access');
  } else {
    bad('write() unsafe tenant_id', new Error(escapedTenantErr || 'Expected tenant_id rejection'));
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

  const invalidSub = log.subscribe('../escape', null, {
    pollIntervalMs: 0,
    after: 0,
  });
  try {
    invalidSub._poll();
    invalidSub.stop();
    ok('subscribe() handles read errors without an explicit error listener');
  } catch (err) {
    invalidSub.stop();
    bad('subscribe() default error listener', err);
  }

  // write validation: unknown type is rejected
  const { event: badEv, error: badEvErr } = log.write('aaf', 'not.a.real.type', {});
  if (badEv === null && badEvErr && badEvErr.includes('validation failed')) {
    ok('write() rejects unknown event type');
  } else {
    bad('write() unknown type rejection', new Error(badEvErr || 'Expected error'));
  }

  // cleanup tmp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });

} catch (e) {
  bad('@jarvos/agentify module load', e);
}

// ── @jarvos/agentify (channel-context tools) ─────────────────────────────────

console.log('\n→ @jarvos/agentify (channel-context tools, SUP-2197)');

try {
  const agentify = require(path.join(ROOT, 'modules/jarvos-agentify/src/index.js'));

  // ── Tool exports are present ───────────────────────────────────────────────
  if (typeof agentify.getChannelContextTool === 'object' &&
      agentify.getChannelContextTool !== null) {
    ok('getChannelContextTool is exported from root module');
  } else {
    bad('getChannelContextTool export', new Error('Expected object'));
  }

  if (typeof agentify.getThreadMessagesTool === 'object' &&
      agentify.getThreadMessagesTool !== null) {
    ok('getThreadMessagesTool is exported from root module');
  } else {
    bad('getThreadMessagesTool export', new Error('Expected object'));
  }

  if (Array.isArray(agentify.CHANNEL_CONTEXT_TOOLS) &&
      agentify.CHANNEL_CONTEXT_TOOLS.length === 2) {
    ok('CHANNEL_CONTEXT_TOOLS array contains 2 tools');
  } else {
    bad('CHANNEL_CONTEXT_TOOLS', new Error(`Expected array of 2, got: ${JSON.stringify(agentify.CHANNEL_CONTEXT_TOOLS)}`));
  }

  // ── Tool names and MCP shape ───────────────────────────────────────────────
  const cct = agentify.getChannelContextTool;
  if (cct.name === 'get_channel_context' &&
      typeof cct.description === 'string' &&
      typeof cct.execute === 'function' &&
      cct.input_schema.required.includes('tenant_id') &&
      cct.input_schema.required.includes('channel_id')) {
    ok('get_channel_context has correct MCP shape');
  } else {
    bad('get_channel_context shape', new Error(JSON.stringify(cct)));
  }

  const tmt = agentify.getThreadMessagesTool;
  if (tmt.name === 'get_thread_messages' &&
      typeof tmt.description === 'string' &&
      typeof tmt.execute === 'function' &&
      tmt.input_schema.required.includes('thread_id')) {
    ok('get_thread_messages has correct MCP shape');
  } else {
    bad('get_thread_messages shape', new Error(JSON.stringify(tmt)));
  }

  // ── buildChannelContext and renderContextMarkdown ──────────────────────────
  if (typeof agentify.buildChannelContext === 'function') {
    ok('buildChannelContext is exported');
  } else {
    bad('buildChannelContext export', new Error('Expected function'));
  }

  if (typeof agentify.renderContextMarkdown === 'function') {
    ok('renderContextMarkdown is exported');
  } else {
    bad('renderContextMarkdown export', new Error('Expected function'));
  }

  // ── renderContextMarkdown output ───────────────────────────────────────────
  const ctx = {
    tenantId:       'aaf',
    channelId:      '1234567890',
    fetchedAt:      '2026-05-29T12:00:00.000Z',
    windowHours:    24,
    afterSeq:       0,
    messages:       [{ author: 'andrew', ts: '2026-05-29T11:00:00Z', content: 'AAF channel active.', embeds: [], thread: null }],
    threads:        [{ id: '999', name: 'Planning', messageCount: 3 }],
    activityEvents: [{ type: 'agent.loop.started', seq: 1, source: 'smoke-test', occurred_at: '2026-05-29T10:00:00Z' }],
    linkedResources: [{ type: 'note', path: 'Notes/AAF Plan v3.md' }],
    partial: false,
    errors: [],
  };

  const md = agentify.renderContextMarkdown(ctx);
  if (
    md.includes('## Channel Context — aaf') &&
    md.includes('AAF channel active.') &&
    md.includes('Planning') &&
    md.includes('agent.loop.started') &&
    md.includes('Notes/AAF Plan v3.md')
  ) {
    ok('renderContextMarkdown produces correct markdown sections');
  } else {
    bad('renderContextMarkdown output', new Error('Missing expected sections in:\n' + md));
  }

  const partialMd = agentify.renderContextMarkdown({
    ...ctx,
    partial: true,
    errors: [{ source: 'messages', message: 'DISCORD_BOT_TOKEN is required' }],
  });
  if (partialMd.includes('Context Fetch Errors') && partialMd.includes('messages: DISCORD_BOT_TOKEN is required')) {
    ok('renderContextMarkdown surfaces partial fetch errors');
  } else {
    bad('renderContextMarkdown partial errors', new Error(partialMd));
  }

  // ── sub-path export: ./channel-context ────────────────────────────────────
  const ccModule = require(path.join(ROOT, 'modules/jarvos-agentify/src/lib/channel-context.js'));
  if (ccModule.ALL_TOOLS && ccModule.ALL_TOOLS.length === 2) {
    ok('./channel-context sub-path exports ALL_TOOLS');
  } else {
    bad('./channel-context sub-path', new Error('Expected ALL_TOOLS array of 2'));
  }

  // ── sub-path export: ./discord-api ────────────────────────────────────────
  const daModule = require(path.join(ROOT, 'modules/jarvos-agentify/src/lib/discord-api.js'));
  if (typeof daModule.normaliseMessage === 'function') {
    ok('./discord-api sub-path exports normaliseMessage');
  } else {
    bad('./discord-api sub-path', new Error('Expected normaliseMessage function'));
  }

  // ── normaliseMessage correctness ──────────────────────────────────────────
  const raw = {
    id: '111',
    timestamp: '2026-05-29T12:00:00.000Z',
    author: { username: 'andrew' },
    content: 'Hello AAF.',
    embeds: [{ title: 'Plan', description: 'Do the thing.' }],
    thread: { id: '222', name: 'AAF planning' },
  };
  const nm = daModule.normaliseMessage(raw);
  if (nm.id === '111' && nm.author === 'andrew' && nm.content === 'Hello AAF.' &&
      nm.embeds.length === 1 && nm.thread.name === 'AAF planning') {
    ok('normaliseMessage returns correct compact shape');
  } else {
    bad('normaliseMessage', new Error(JSON.stringify(nm)));
  }

} catch (e) {
  bad('@jarvos/agentify channel-context load', e);
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed.\n`);
if (fail > 0) {
  process.exit(1);
}
