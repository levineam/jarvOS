'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const test = require('node:test');
const { computeBundleTree, createSharedSkillManager } = require('../src');
test('shared manager exposes redacted reads and protects mutations and scheduler scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-shared-manager-')); fs.chmodSync(root, 0o700);
  try {
    const manager = createSharedSkillManager({ stateRoot: root, scheduler: { register: () => ({ status: 'registered', jobId: 'jarvos-shared-skills', nextRun: 'later' }), remove: () => ({ status: 'removed' }) } });
    assert.equal(manager.execute({ operation: 'status', principal: { kind: 'agent' } }).state.enabled, false);
    assert.throws(() => manager.execute({ operation: 'apply', principal: { kind: 'agent', capabilities: [] } }), /not authorized/);
    assert.throws(() => manager.execute({ operation: 'enable', principal: { kind: 'scheduler', capabilities: ['skills.mutate'] } }), /explicit human/);
    const enabled = manager.execute({ operation: 'enable', principal: { kind: 'human', capabilities: ['skills.mutate'] }, harnesses: [{ id: 'codex' }] });
    assert.equal(enabled.status, 'enabled'); assert.deepEqual(enabled.state.enrolled, ['codex']);
    assert.throws(() => manager.execute({ operation: 'disable', principal: { kind: 'agent', capabilities: ['skills.mutate'] } }), /explicit human/);
    const disabled = manager.execute({ operation: 'disable', principal: { kind: 'human', capabilities: ['skills.mutate'] } });
    assert.equal(disabled.status, 'disabled');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('share and refresh write only an explicit local overlay preview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-overlay-manager-')); fs.chmodSync(root, 0o700);
  try {
    const skill = path.join(root, 'private'); fs.mkdirSync(skill, { mode: 0o700 }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: local\n---\n', { mode: 0o600 });
    const manager = createSharedSkillManager({ stateRoot: root, scheduler: { register: () => ({ status: 'registered' }) } }); const principal = { kind: 'human', capabilities: ['skills.mutate'] };
    manager.execute({ operation: 'enable', principal, harnesses: [{ id: 'codex' }] });
    const overlay = path.join(root, 'overlay.json'); const result = manager.execute({ operation: 'share', principal, overlayPath: overlay, skillPath: skill, id: 'local-skill' });
    assert.equal(result.status, 'preview_required'); assert.equal(JSON.parse(fs.readFileSync(overlay, 'utf8')).entries[0].id, 'local-skill');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('private overlay admission requires an explicit enrolled harness', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-overlay-unenrolled-')); fs.chmodSync(root, 0o700);
  try {
    const skill = path.join(root, 'private'); fs.mkdirSync(skill, { mode: 0o700 }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: local\n---\n', { mode: 0o600 });
    const manager = createSharedSkillManager({ stateRoot: root }); const principal = { kind: 'human', capabilities: ['skills.mutate'] };
    assert.throws(() => manager.execute({ operation: 'share', principal, overlayPath: path.join(root, 'overlay.json'), skillPath: skill, id: 'local-skill' }), /requires at least one enrolled harness/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repeated clean repair is a redacted no-op without changing manager state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-clean-manager-'));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-clean-source-'));
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-clean-harness-'));
  for (const dir of [root, sourceRoot, harnessRoot]) fs.chmodSync(dir, 0o700);
  try {
    const skillRoot = path.join(sourceRoot, 'clean-skill'); fs.mkdirSync(skillRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: clean-skill\n---\n', { mode: 0o600 });
    const tree = computeBundleTree(skillRoot, { allowlist: ['SKILL.md'] });
    const catalog = { entries: [{ id: 'clean-skill', allowedHarnesses: ['codex'], bundle: { root: 'clean-skill', allowlist: ['SKILL.md'], treeDigest: tree.treeDigest } }] };
    const principal = { kind: 'human', capabilities: ['skills.mutate'] };
    const manager = createSharedSkillManager({ stateRoot: root, scheduler: { register: () => ({ status: 'registered' }) } });
    manager.execute({ operation: 'enable', principal, harnesses: [{ id: 'codex', root: harnessRoot }] });
    const applied = manager.execute({ operation: 'apply', principal, catalog, publicSourceRoot: sourceRoot, harnesses: [{ id: 'codex', root: harnessRoot }] });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.result.applied, [{ id: 'clean-skill', harness: 'codex', effectiveName: 'clean-skill', status: 'missing', applied: true }]);
    const stateFile = path.join(root, 'shared-skills-state.json'); const before = fs.readFileSync(stateFile, 'utf8');
    const repaired = manager.execute({ operation: 'repair', principal, catalog, publicSourceRoot: sourceRoot, harnesses: [{ id: 'codex', root: harnessRoot }] });
    assert.deepEqual(repaired, { operation: 'repair', status: 'noop', state: { generation: 2, enabled: true, enrolled: ['codex'], acceptedGeneration: null, lastCatalogDigest: applied.state.lastCatalogDigest } });
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(root, 'reconciliation', 'shared-skill-reconcile.journal.json')), false);
  } finally {
    for (const dir of [root, sourceRoot, harnessRoot]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
