'use strict';

// A separate process per invocation, real service/ledger/evaluator program,
// and an isolated filesystem-backed substitute for Obsidian's vault API.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { captureWithJarvos } = require('../../bridge/capture/src/universal-capture');
const { createConfiguredVaultMutationService } = require('../../src/vault-mutation-service');
const { createVaultStorageAdapter } = require('../../adapters/obsidian/src/vault-storage-adapter');

const pendingCallbacks = [];
// Explicit scheduling stands in for the other process's asynchronous vault API.
// A token poll observes pending before the next callback wave can complete.
function deferred(effect) {
  let fulfilled;
  let rejected;
  const chain = { then(fn) { fulfilled = fn; return chain; }, catch(fn) { rejected = fn; return chain; } };
  pendingCallbacks.push(() => {
    try { const value = effect(); if (fulfilled) fulfilled(value); }
    catch (error) { if (rejected) rejected(error); else throw error; }
  });
  return chain;
}
function flushCallbacks() {
  const wave = pendingCallbacks.splice(0);
  for (const callback of wave) callback();
}
function flushAllCallbacks() {
  while (pendingCallbacks.length) flushCallbacks();
}

const { root, capture, fault, reconcile = false } = JSON.parse(fs.readFileSync(0, 'utf8'));
const vaultRoot = path.join(root, 'vault');
const writes = [];
const absolute = (relative) => {
  const target = path.resolve(vaultRoot, relative);
  if (!target.startsWith(`${vaultRoot}${path.sep}`)) throw new Error('Fixture path escaped');
  return target;
};
const vault = {
  getFileByPath: (relative) => fs.existsSync(absolute(relative)) ? { path: relative } : null,
  read: (file) => deferred(() => fs.readFileSync(absolute(file.path), 'utf8')),
  create: (relative, content) => deferred(() => {
    fs.mkdirSync(path.dirname(absolute(relative)), { recursive: true });
    fs.writeFileSync(absolute(relative), content, { flag: 'wx' });
    writes.push(relative);
    return { path: relative };
  }),
  process: (file, transform) => deferred(() => {
    fs.writeFileSync(absolute(file.path), transform(fs.readFileSync(absolute(file.path), 'utf8')));
    writes.push(file.path);
    return file;
  }),
};
const context = vm.createContext({ app: { vault }, TextDecoder, Uint8Array,
  atob: (value) => Buffer.from(value, 'base64').toString('binary') });
let faultTriggered = false;
let pendingPolls = 0;
const service = createConfiguredVaultMutationService({ vaultRoot, vaultId: 'capture-fixture',
  proveObsidianAbsent: () => fault === 'offline_stopped',
  adapterOptions: {
    ledgerPath: path.join(root, 'ledger.json'), maxPollAttempts: 3, pollIntervalMs: 0,
    ...(fault === 'poll_deadline' ? { pollTimeoutMs: 1 } : {}),
    probe: () => ({ state: fault === 'offline_stopped' ? 'app_stopped' : fault === 'before_write' || (fault === 'after_note_before_journal' && writes.some((name) => name.startsWith('Notes/'))) ? 'app_busy' : 'available', vaultId: 'capture-fixture' }),
    evaluate: (code) => {
      const encoded = code.match(/atob\('([^']+)'\)/)?.[1];
      const input = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : null;
      const mutation = input && !input.inspectionToken;
      if (mutation && fault === 'before_backlink' && input.transformName === 'journal-section-line') {
        faultTriggered = true;
        throw new Error('simulated ambiguous dispatch with no effect');
      }
      const output = vm.runInContext(code, context);
      if (mutation && fault === 'poll_deadline') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      if (mutation && !faultTriggered && ((fault === 'after_note' && input.vaultRelativePath.startsWith('Notes/'))
        || (fault === 'after_backlink' && input.transformName === 'journal-section-line'))) {
        flushAllCallbacks();
        faultTriggered = true;
        throw new Error('simulated lost acknowledgement after effect');
      }
      const result = JSON.parse(output);
      if (!input && result?.status === 'pending') {
        pendingPolls += 1;
        if (fault !== 'poll_timeout') flushCallbacks();
      }
      return result;
    },
  },
});
const adapter = createVaultStorageAdapter({ mutationService: service, vaultRoot, journalDir: path.join(vaultRoot, 'Journal') });
const recovery = reconcile ? service.reconciler.drain({ limit: 20, timeMs: 2000 }) : null;
let result = null;
let error = null;
try { if (capture) result = captureWithJarvos(capture, { adapter }); } catch (caught) { error = caught.message; }
// A timed-out app operation may complete after the caller has already returned.
if (fault === 'poll_timeout' || fault === 'poll_deadline') flushAllCallbacks();
const notesDir = path.join(vaultRoot, 'Notes');
const notes = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter((name) => name.endsWith('.md'))
  .map((name) => ({ name, content: fs.readFileSync(path.join(notesDir, name), 'utf8') })) : [];
const journalPath = path.join(vaultRoot, 'Journal', '2030-02-03.md');
process.stdout.write(JSON.stringify({ result, error, recovery, writes, faultTriggered, pendingPolls, notes,
  journal: fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : null,
  ledger: service.adapter.ledger.read() }));
