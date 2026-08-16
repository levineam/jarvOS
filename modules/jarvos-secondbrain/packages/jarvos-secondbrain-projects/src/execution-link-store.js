'use strict';

// Projects owns this sidecar only to pin canonical meaning to a Beads tuple;
// it never mirrors or mutates Beads lifecycle state.
const fs = require('node:fs');
const path = require('node:path');
const { validateExecutionReference } = require('./provider-contracts');
const EXECUTION_LINK_STORE_CONTRACT = 'jarvos.projects-execution-link-store/v1';

function keyOf(reference) { return `${reference.workspaceId}:${reference.itemId}`; }
function createMemoryExecutionLinkStore() {
  const records = new Map();
  return {
    async read(workspaceId, itemId) { return records.get(`${workspaceId}:${itemId}`) || null; },
    async write(reference, expectedRevision = null) {
      const link = validateExecutionReference(reference).reference; const key = keyOf(link); const current = records.get(key) || null;
      if (current && (current.canonical.id !== link.canonical.id || current.canonical.revision !== link.canonical.revision)) throw new Error('execution link canonical conflict');
      if (expectedRevision !== null && (!current || current.itemRevision !== String(expectedRevision))) throw new Error('execution link compare-and-swap conflict');
      records.set(key, link); return link;
    },
  };
}
function createFileExecutionLinkStore(options = {}) {
  const root = path.resolve(String(options.root || ''));
  if (!path.isAbsolute(root) || root === path.parse(root).root) throw new Error('protected execution link root is required');
  const memory = createMemoryExecutionLinkStore();
  const file = (workspaceId, itemId) => path.join(root, `${Buffer.from(`${workspaceId}:${itemId}`).toString('base64url')}.json`);
  return {
    async read(workspaceId, itemId) { const target = file(workspaceId, itemId); if (!fs.existsSync(target)) return null; let value; try { value = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { throw new Error('execution link record is invalid'); } return memory.write(value).then(() => value); },
    async write(reference, expectedRevision = null) { const link = validateExecutionReference(reference).reference; const current = await this.read(link.workspaceId, link.itemId); if (current && (current.canonical.id !== link.canonical.id || current.canonical.revision !== link.canonical.revision)) throw new Error('execution link canonical conflict'); if (expectedRevision !== null && (!current || current.itemRevision !== String(expectedRevision))) throw new Error('execution link compare-and-swap conflict'); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); const temporary = `${file(link.workspaceId, link.itemId)}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(link)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file(link.workspaceId, link.itemId)); return link; },
    contract: EXECUTION_LINK_STORE_CONTRACT,
  };
}
module.exports = { EXECUTION_LINK_STORE_CONTRACT, createMemoryExecutionLinkStore, createFileExecutionLinkStore };
