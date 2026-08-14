'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { planCatalogReconciliation, applyCatalogReconciliation } = require('./reconciliation');
const { admitOverlaySkill } = require('./overlay-authoring');

const READS = new Set(['plan', 'status']);
const MUTATIONS = new Set(['share', 'refresh', 'apply', 'repair', 'enable', 'disable', 'rename']);
const HUMAN_ONLY = new Set(['share', 'refresh', 'enable', 'disable', 'rename']);
function write(file, value) { const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`; fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
function load(file) { if (!fs.existsSync(file)) return { version: 1, generation: 0, enabled: false, enrolled: [], acceptedGeneration: null }; return JSON.parse(fs.readFileSync(file, 'utf8')); }
function lock(root) { const file = path.join(root, '.shared-skill.lock'); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); try { const fd = fs.openSync(file, 'wx', 0o600); return () => { fs.closeSync(fd); try { fs.unlinkSync(file); } catch {} }; } catch { throw new Error('shared skill mutation is already running'); } }

function createSharedSkillManager({ stateRoot, scheduler = null } = {}) {
  if (!stateRoot) throw new Error('stateRoot is required');
  const stateFile = path.join(path.resolve(stateRoot), 'shared-skills-state.json');
  function assertAllowed(operation, principal) {
    if (!READS.has(operation) && !MUTATIONS.has(operation)) throw new Error('shared skill operation is unsupported');
    if (READS.has(operation)) return;
    if (!principal?.capabilities?.includes('skills.mutate')) throw new Error('shared skill mutation is not authorized');
    if (HUMAN_ONLY.has(operation) && principal.kind !== 'human') throw new Error(`${operation} requires explicit human authorization`);
    if (principal.kind === 'scheduler' && !['apply', 'repair'].includes(operation)) throw new Error('scheduler may invoke only reconciliation');
  }
  function execute({ operation, principal, catalog, publicSourceRoot, localSourceRoot, harnesses, rename, overlayPath, skillPath, id } = {}) {
    assertAllowed(operation, principal);
    const mutation = MUTATIONS.has(operation); const unlock = mutation ? lock(path.dirname(stateFile)) : null;
    try {
    const state = load(stateFile);
    const enrolledHarnesses = (harnesses || []).filter((h) => state.enrolled.includes(h.id));
    const plan = catalog ? planCatalogReconciliation({ catalog: catalog.catalog || catalog, publicSourceRoot, localSourceRoot, harnesses: enrolledHarnesses, controlRoot: path.join(path.dirname(stateFile), 'reconciliation') }) : null;
    if (READS.has(operation)) return { operation, state: redact(state), plan: redactPlan(plan) };
    if (operation === 'share' || operation === 'refresh') return { operation, ...admitOverlaySkill({ overlayPath, skillPath, id, allowedHarnesses: (state.enrolled && state.enrolled.length ? state.enrolled : ['codex']), refresh: operation === 'refresh' }) };
      if (operation === 'enable') {
        const enrollment = (harnesses || []).map((h) => h.id);
        const registration = scheduler?.register ? scheduler.register({ id: 'jarvos-shared-skills', operation: 'repair' }) : { status: 'scheduler_unsupported' };
        if (registration.status !== 'registered') return { operation, status: registration.status, state: redact(state) };
        state.enabled = true; state.enrolled = enrollment; state.acceptedGeneration = plan?.catalogDigest || null; state.generation += 1; write(stateFile, state); return { operation, status: 'enabled', registration, state: redact(state) };
      }
      if (operation === 'disable') { state.enabled = false; state.generation += 1; scheduler?.remove?.('jarvos-shared-skills'); write(stateFile, state); return { operation, status: 'disabled', state: redact(state) }; }
      if (operation === 'rename') { if (!rename || !/^[a-z][a-z0-9-]{0,63}$/.test(rename)) throw new Error('rename requires a safe requested name'); return { operation, status: 'requires_free_name_proof', requestedName: rename }; }
      if (!state.enabled && operation !== 'share' && operation !== 'refresh') return { operation, status: 'disabled', state: redact(state) };
      if (!plan) throw new Error('catalog is required for reconciliation');
      const result = applyCatalogReconciliation(plan); state.generation += 1; state.lastCatalogDigest = plan.catalogDigest; write(stateFile, state); return { operation, status: 'applied', result: redact(result), state: redact(state) };
    } finally { if (unlock) unlock(); }
  }
  return { execute };
}
function redact(state) { return { generation: state.generation, enabled: state.enabled, enrolled: state.enrolled, acceptedGeneration: state.acceptedGeneration || null, lastCatalogDigest: state.lastCatalogDigest || null }; }
function redactPlan(plan) { return plan ? { catalogDigest: plan.catalogDigest, pairs: plan.pairs.map((p) => ({ id: p.id, harness: p.harness, effectiveName: p.effectiveName, status: p.status, action: p.action })) } : null; }
module.exports = { createSharedSkillManager };
