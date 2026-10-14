'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./config');
const { planCatalogReconciliation, applyCatalogReconciliation } = require('./reconciliation');
const { admitOverlaySkill } = require('./overlay-authoring');
const { catalogDigest } = require('./catalog');

const READS = new Set(['plan', 'status']);
const MUTATIONS = new Set(['share', 'refresh', 'apply', 'repair', 'enable', 'disable', 'rename']);
const HUMAN_ONLY = new Set(['share', 'refresh', 'enable', 'disable', 'rename']);
function load(file) { if (!fs.existsSync(file)) return { version: 1, generation: 0, enabled: false, enrolled: [], acceptedGeneration: null }; return JSON.parse(fs.readFileSync(file, 'utf8')); }
function lock(root) { const file = path.join(root, '.shared-skill.lock'); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); try { const fd = fs.openSync(file, 'wx', 0o600); return () => { fs.closeSync(fd); try { fs.unlinkSync(file); } catch {} }; } catch { throw new Error('shared skill mutation is already running'); } }

function isCleanPlan(plan) {
  const currentAliases = fs.existsSync(plan.aliasFile)
    ? JSON.parse(fs.readFileSync(plan.aliasFile, 'utf8')).aliases || {}
    : {};
  return !plan.pairs.some((pair) => pair.action === 'install' || pair.action === 'retire')
    && JSON.stringify(currentAliases) === JSON.stringify(plan.aliases);
}

function reviewedBinding({ catalog, publicSourceRoot, localSourceRoot, harnesses }) {
  function identity(value) {
    if (!value) return null;
    const root = path.resolve(value); const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (stat.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('reviewed skill root must be canonical, owned and non-writable by others');
    }
    return { path: fs.realpathSync(root), dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid };
  }
  return catalogDigest({ catalog, publicSourceRoot: identity(publicSourceRoot), localSourceRoot: identity(localSourceRoot),
    harnesses: (harnesses || []).map((h) => ({ ...h, root: identity(h.root) })).sort((a, b) => a.id.localeCompare(b.id)) });
}

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
    const effectiveCatalog = catalog?.catalog || catalog;
    const reconciliation = operation === 'apply' || operation === 'repair';
    if (reconciliation && !state.enabled) return { operation, status: 'disabled', state: redact(state) };
    const binding = effectiveCatalog && (reconciliation || operation === 'enable')
      ? reviewedBinding({ catalog: effectiveCatalog, publicSourceRoot, localSourceRoot, harnesses }) : null;
    if (reconciliation && (!state.acceptedBinding || binding !== state.acceptedBinding)) throw new Error('reconciliation requires the human-reviewed catalog and enrolled roots');
    const enrolledHarnesses = operation === 'enable' ? harnesses : (harnesses || []).filter((h) => state.enrolled.includes(h.id));
    const digest = effectiveCatalog ? catalogDigest(effectiveCatalog) : null;
    const plan = effectiveCatalog ? planCatalogReconciliation({ catalog: effectiveCatalog, catalogDigest: digest, publicSourceRoot, localSourceRoot, harnesses: enrolledHarnesses, controlRoot: path.join(path.dirname(stateFile), 'reconciliation'), readOnly: !reconciliation }) : null;
    if (READS.has(operation)) return { operation, state: redact(state), plan: redactPlan(plan) };
    if (operation === 'share' || operation === 'refresh') {
      if (!state.enrolled?.length) throw new Error('overlay admission requires at least one enrolled harness');
      return { operation, ...admitOverlaySkill({ overlayPath, skillPath, id, allowedHarnesses: state.enrolled, refresh: operation === 'refresh' }) };
    }
      if (operation === 'enable') {
        const enrollment = (harnesses || []).map((h) => h.id);
        const registration = scheduler?.register ? scheduler.register({ id: 'jarvos-shared-skills', operation: 'repair' }) : { status: 'scheduler_unsupported' };
        if (registration.status !== 'registered') return { operation, status: registration.status, state: redact(state) };
        state.enabled = true; state.enrolled = enrollment; state.acceptedGeneration = digest; state.acceptedBinding = binding; state.generation += 1; atomicWriteJson(stateFile, state); return { operation, status: 'enabled', registration, state: redact(state) };
      }
      if (operation === 'disable') { state.enabled = false; state.generation += 1; scheduler?.remove?.('jarvos-shared-skills'); atomicWriteJson(stateFile, state); return { operation, status: 'disabled', state: redact(state) }; }
      if (operation === 'rename') { if (!rename || !/^[a-z][a-z0-9-]{0,63}$/.test(rename)) throw new Error('rename requires a safe requested name'); return { operation, status: 'requires_free_name_proof', requestedName: rename }; }
      if (!state.enabled && operation !== 'share' && operation !== 'refresh') return { operation, status: 'disabled', state: redact(state) };
      if (!plan) throw new Error('catalog is required for reconciliation');
      if (isCleanPlan(plan)) return { operation, status: 'noop', state: redact(state) };
      const result = applyCatalogReconciliation(plan);
      state.generation += 1; state.lastCatalogDigest = plan.catalogDigest; atomicWriteJson(stateFile, state); return { operation, status: result.applied.some((item) => item.applied) ? 'applied' : 'preserved', result: redactApply(result), state: redact(state) };
    } finally { if (unlock) unlock(); }
  }
  return { execute };
}
function redact(state) { return { generation: state.generation, enabled: state.enabled, enrolled: state.enrolled, acceptedGeneration: state.acceptedGeneration || null, lastCatalogDigest: state.lastCatalogDigest || null }; }
function redactApply(result) { return { ok: result.ok === true, aliasRevision: result.aliasRevision, notices: result.notices || [], applied: (result.applied || []).map(({ id, harness, effectiveName, status, applied }) => ({ id, harness, effectiveName, status, applied: applied === true })) }; }
function redactPlan(plan) { return plan ? { catalogDigest: plan.catalogDigest, pairs: plan.pairs.map((p) => ({ id: p.id, harness: p.harness, effectiveName: p.effectiveName, status: p.status, action: p.action })) } : null; }
module.exports = { createSharedSkillManager };
