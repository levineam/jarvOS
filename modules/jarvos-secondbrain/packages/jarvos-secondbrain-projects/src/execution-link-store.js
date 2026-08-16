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
    async list() { return [...records.values()]; },
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
  const file = (workspaceId, itemId) => path.join(root, `${Buffer.from(`${workspaceId}:${itemId}`).toString('base64url')}.json`);
  const lockPath = path.join(root, '.execution-links.lock');
  const readRaw = (workspaceId, itemId) => {
    const target = file(workspaceId, itemId);
    let value;
    try { value = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('execution link record is invalid');
    }
    return validateExecutionReference(value).reference;
  };
  const withLock = (fn) => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(root, 0o700); } catch { /* best effort on non-POSIX hosts */ }
    let fd = null;
    const deadline = Date.now() + 3000;
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; }
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('execution link store is busy');
        let stale = false;
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          stale = !Number.isInteger(lock.pid) || (Date.now() - Number(lock.createdAt || 0) > 30_000);
          if (!stale && lock.pid !== process.pid) {
            try { process.kill(lock.pid, 0); } catch (probeError) { stale = probeError.code === 'ESRCH'; }
          }
        } catch { stale = true; }
        if (stale) { try { fs.unlinkSync(lockPath); } catch {} }
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return fn(); } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  };
  return {
    async read(workspaceId, itemId) { return readRaw(workspaceId, itemId); },
    async list() {
      const records = [];
      let names;
      try { names = fs.readdirSync(root); }
      catch (error) { if (error.code === 'ENOENT') return records; throw error; }
      for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        try {
          const target = path.join(root, name);
          const stat = fs.lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid');
          records.push(validateExecutionReference(JSON.parse(fs.readFileSync(target, 'utf8'))).reference);
        } catch { throw new Error('execution link record is invalid'); }
      }
      return records;
    },
    async write(reference, expectedRevision = null) {
      const link = validateExecutionReference(reference).reference;
      return withLock(() => {
        const current = readRaw(link.workspaceId, link.itemId);
        if (current && (current.canonical.id !== link.canonical.id || current.canonical.revision !== link.canonical.revision)) throw new Error('execution link canonical conflict');
        if (expectedRevision !== null && (!current || current.itemRevision !== String(expectedRevision))) throw new Error('execution link compare-and-swap conflict');
        const temporary = `${file(link.workspaceId, link.itemId)}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(link)}\n`, { mode: 0o600 });
        try { fs.chmodSync(temporary, 0o600); } catch { /* best effort on non-POSIX hosts */ }
        fs.renameSync(temporary, file(link.workspaceId, link.itemId));
        return link;
      });
    },
    contract: EXECUTION_LINK_STORE_CONTRACT,
  };
}
module.exports = { EXECUTION_LINK_STORE_CONTRACT, createMemoryExecutionLinkStore, createFileExecutionLinkStore };
