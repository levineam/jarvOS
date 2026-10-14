'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { computeBundleTree, createSharedSkillManager } = require('../src');

test('repair binds the reviewed catalog bytes, payload and enrolled destination identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-reviewed-manager-'));
  fs.chmodSync(root, 0o700);
  const source = path.join(root, 'source'); const destination = path.join(root, 'destination');
  for (const dir of [source, destination]) fs.mkdirSync(dir, { mode: 0o700 });
  const skill = path.join(source, 'bound'); fs.mkdirSync(skill, { mode: 0o700 });
  const body = '---\nname: bound\n---\nReviewed body\n';
  fs.writeFileSync(path.join(skill, 'SKILL.md'), body, { mode: 0o600 });
  const catalog = { digest: 'a'.repeat(64), entries: [{ id: 'bound', allowedHarnesses: ['codex'], bundle: { root: 'bound', allowlist: ['SKILL.md'], treeDigest: computeBundleTree(skill, { allowlist: ['SKILL.md'] }).treeDigest } }] };
  const principal = { kind: 'human', capabilities: ['skills.mutate'] };
  const scheduler = { kind: 'scheduler', capabilities: ['skills.mutate'] };
  const options = { catalog, publicSourceRoot: source, harnesses: [{ id: 'codex', root: destination }] };
  const manager = createSharedSkillManager({ stateRoot: path.join(root, 'state'), scheduler: { register: () => ({ status: 'registered' }) } });
  try {
    manager.execute({ operation: 'enable', principal, harnesses: options.harnesses });
    assert.throws(() => manager.execute({ operation: 'repair', principal: scheduler, ...options }), /human-reviewed/);
    assert.equal(fs.existsSync(path.join(destination, 'bound')), false);
    manager.execute({ operation: 'enable', principal, ...options });
    assert.equal(manager.execute({ operation: 'repair', principal: scheduler, ...options }).status, 'applied');
    const stateFile = path.join(root, 'state', 'shared-skills-state.json');
    const state = fs.readFileSync(stateFile, 'utf8'); const installed = fs.readFileSync(path.join(destination, 'bound', 'SKILL.md'), 'utf8');
    for (const operation of ['apply', 'repair']) {
      const substituted = structuredClone(catalog); substituted.entries[0].allowedHarnesses.push('hermes');
      assert.throws(() => manager.execute({ operation, principal: scheduler, ...options, catalog: substituted }), /human-reviewed/);
      const redirect = path.join(root, 'redirect');
      assert.throws(() => manager.execute({ operation, principal: scheduler, ...options, harnesses: [{ id: 'codex', root: redirect }] }), /ENOENT/);
      assert.equal(fs.existsSync(redirect), false);
    }
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'Changed after review', { mode: 0o600 });
    assert.throws(() => manager.execute({ operation: 'repair', principal: scheduler, ...options }), /digest/);
    const changedCatalog = structuredClone(catalog); changedCatalog.entries[0].bundle.treeDigest = computeBundleTree(skill, { allowlist: ['SKILL.md'] }).treeDigest;
    assert.throws(() => manager.execute({ operation: 'repair', principal: scheduler, ...options, catalog: changedCatalog }), /human-reviewed/);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), state);
    assert.equal(fs.readFileSync(path.join(destination, 'bound', 'SKILL.md'), 'utf8'), installed);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), body, { mode: 0o600 });
    assert.equal(manager.execute({ operation: 'repair', principal: scheduler, ...options }).status, 'noop');
    const moved = path.join(root, 'moved'); fs.renameSync(destination, moved); fs.mkdirSync(destination, { mode: 0o700 });
    assert.throws(() => manager.execute({ operation: 'repair', principal: scheduler, ...options }), /human-reviewed/);
    assert.deepEqual(fs.readdirSync(destination), []);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), state);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
