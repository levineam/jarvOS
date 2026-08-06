'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createInternalReceipt, hashUtf8, validateOperation, validateVaultRelativeMarkdownPath } = require('./vault-mutation-contract');
const { createVaultMutationLedger } = require('./vault-mutation-ledger');

const RESULT_STORE = '__jarvosVaultMutationResults';
const CAPABILITY_STATES = Object.freeze(['available', 'cli_missing', 'app_stopped', 'cli_disabled', 'cli_unsupported', 'wrong_vault', 'api_incompatible']);

function parseEvalResult(output) { const match = [...String(output || '').matchAll(/^=>\s*(.+)$/gm)].at(-1); return match ? JSON.parse(match[1]) : null; }
function runObsidianEval(code, { vaultName, command = process.env.OBSIDIAN_CLI || 'obsidian', timeoutMs = 10_000, execute = execFileSync } = {}) {
  try { return parseEvalResult(execute(command, [`vault=${vaultName}`, 'eval', `code=${code}`], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (error) { const wrapped = new Error(String(error.stderr || error.stdout || error.message || 'Obsidian CLI failed')); wrapped.code = error.code; throw wrapped; }
}
function payload(operation) { return Buffer.from(JSON.stringify(operation), 'utf8').toString('base64'); }
// This program is fixed. Data enters solely through base64 JSON. The only
// transform implementation is this reviewed switch, never a caller global.
function buildObsidianMutationProgram(operation) {
  const encoded = payload(operation);
  return `(() => { const input = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), c => c.charCodeAt(0)))); const store = globalThis.${RESULT_STORE} ||= {}; const token = input.operationId; store[token] = { status: 'pending' }; const transform = (() => { if (input.transformName === 'append-line' && input.transformVersion === 1 && typeof input.replayPayload?.line === 'string' && input.replayPayload.line.startsWith('- ')) { const line = input.replayPayload.line.trim(); return { apply: current => current.includes(line) ? current : current + (current.endsWith('\\n') ? '' : '\\n') + line + '\\n', invariant: current => current.includes(line) }; } return null; })(); if (!globalThis.app?.vault?.read || !app.vault.getFileByPath) { store[token] = { status: 'error', errorClass: 'api_incompatible' }; return JSON.stringify({ queued: true, token }); } const finish = (file) => app.vault.read(file).then((readback) => { const exact = input.operationKind === 'create' || input.operationKind === 'replace' ? readback === input.content : transform?.invariant(readback) === true; store[token] = { status: exact ? 'done' : 'error', invariant: exact, readback: exact ? readback : undefined, errorClass: exact ? undefined : 'readback_mismatch' }; }).catch((e) => { store[token] = { status: 'error', errorClass: 'readback_failed', error: String(e?.message || e) }; }); const existing = app.vault.getFileByPath(input.vaultRelativePath); if (input.operationKind === 'create') { if (existing) finish(existing); else app.vault.create(input.vaultRelativePath, input.content).then(finish).catch((e) => { const raced = app.vault.getFileByPath(input.vaultRelativePath); if (raced) finish(raced); else store[token] = { status: 'error', errorClass: 'create_failed', error: String(e?.message || e) }; }); } else if (input.operationKind === 'transform') { if (!existing || !transform) store[token] = { status: 'error', errorClass: 'api_incompatible' }; else app.vault.process(existing, current => transform.apply(current)).then(() => finish(existing)).catch((e) => { store[token] = { status: 'error', errorClass: 'process_failed', error: String(e?.message || e) }; }); } else if (input.operationKind === 'replace') { if (!existing) store[token] = { status: 'error', errorClass: 'missing_target' }; else app.vault.process(existing, current => current === input.expectedContent ? input.content : current).then(() => finish(existing)).catch((e) => { store[token] = { status: 'error', errorClass: 'replace_failed', error: String(e?.message || e) }; }); } else store[token] = { status: 'error', errorClass: 'invalid_operation' }; return JSON.stringify({ queued: true, token }); })()`;
}
// Read-only companion to the mutation program.  Node-visible disk bytes are
// intentionally not consulted: acknowledgement belongs to Obsidian's vault.
function buildObsidianInvariantProgram(operation, inspectionToken) {
  const encoded = payload({ ...operation, inspectionToken });
  return `(() => { const input = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), c => c.charCodeAt(0)))); const store = globalThis.${RESULT_STORE} ||= {}; const token = input.inspectionToken; store[token] = { status: 'pending' }; const transform = (() => { if (input.transformName === 'append-line' && input.transformVersion === 1 && typeof input.replayPayload?.line === 'string' && input.replayPayload.line.startsWith('- ')) { const line = input.replayPayload.line.trim(); return current => current.includes(line); } return null; })(); if (!globalThis.app?.vault?.read || !app.vault.getFileByPath) { store[token] = { status: 'unavailable' }; return JSON.stringify({ queued: true, token }); } const file = app.vault.getFileByPath(input.vaultRelativePath); if (!file) { store[token] = { status: 'missing' }; return JSON.stringify({ queued: true, token }); } app.vault.read(file).then(content => { const satisfied = input.operationKind === 'create' || input.operationKind === 'replace' ? content === input.content : transform?.(content) === true; store[token] = { status: satisfied ? 'satisfied' : 'unsatisfied', invariant: satisfied === true }; }).catch(() => { store[token] = { status: 'unavailable' }; }); return JSON.stringify({ queued: true, token }); })()`;
}
function tokenProgram(operationId) { return `JSON.stringify(globalThis.${RESULT_STORE}?.[${JSON.stringify(operationId)}] || null)`; }
function cleanupProgram(operationId) { return `delete globalThis.${RESULT_STORE}?.[${JSON.stringify(operationId)}]; JSON.stringify(true)`; }

function createVaultMutationAdapter({ vaultRoot, vaultId, vaultName = path.basename(vaultRoot || ''), ledger, ledgerPath, transforms, evaluate, maxPollAttempts = 40, probe, ownerId = crypto.randomUUID(), opportunisticDrain } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be absolute');
  if (typeof vaultId !== 'string' || !vaultId) throw new Error('vaultId is required');
  // Keep operational intent outside authored vault content. Hosts normally supply
  // ledgerPath; this deterministic default avoids ever creating hidden vault files.
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const defaultLedgerPath = path.join(stateHome, 'jarvos', 'vault-mutations', `${hashUtf8(`${vaultId}\0${vaultRoot}`)}.json`);
  const mutationLedger = ledger || createVaultMutationLedger({ filePath: ledgerPath || defaultLedgerPath });
  const run = evaluate || ((code) => runObsidianEval(code, { vaultName }));
  let draining = false;
  function capability() { if (probe) return probe(); try { const inspected = run(`JSON.stringify({ vaultName: app?.vault?.getName?.(), hasVault: Boolean(app?.vault?.create && app?.vault?.process && app?.vault?.read) })`); if (!inspected?.hasVault) return { state: 'api_incompatible' }; return inspected.vaultName && inspected.vaultName !== vaultName ? { state: 'wrong_vault' } : { state: 'available', vaultId }; } catch (error) { const message = String(error.message || ''); if (error.code === 'ENOENT') return { state: 'cli_missing' }; if (/disabled/i.test(message)) return { state: 'cli_disabled' }; if (/unsupported|unknown command|eval/i.test(message)) return { state: 'cli_unsupported' }; return { state: 'app_stopped' }; } }
  function inspectInvariant(input) {
    const operation = validateOperation(input);
    if (operation.vaultId !== vaultId) return { status: 'unavailable' };
    const check = capability();
    if (!check || check.state !== 'available' || (check.vaultId && check.vaultId !== vaultId)) return { status: 'unavailable' };
    if (operation.operationKind === 'transform' && (!transforms || transforms.quarantine(operation))) return { status: 'unavailable' };
    try {
      const inspectionToken = `${operation.operationId}:inspect:${crypto.randomUUID()}`;
      const queued = run(buildObsidianInvariantProgram(operation, inspectionToken));
      if (!queued?.queued || queued.token !== inspectionToken) return { status: 'unavailable' };
      let result = null;
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        result = run(tokenProgram(inspectionToken));
        if (['satisfied', 'unsatisfied', 'missing', 'unavailable'].includes(result?.status)) break;
      }
      if (['satisfied', 'unsatisfied', 'missing', 'unavailable'].includes(result?.status)) { try { run(cleanupProgram(inspectionToken)); } catch {} return result; }
      return { status: 'unavailable' };
    } catch { return { status: 'unavailable' }; }
  }
  function execute(input, { excludeOperationId } = {}) {
    const operation = validateOperation(input);
    if (operation.vaultId !== vaultId) return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'wrong_vault' });
    validateVaultRelativeMarkdownPath(operation.vaultRelativePath);
    mutationLedger.ensure(operation);
    const check = capability();
    if (!check || !CAPABILITY_STATES.includes(check.state) || check.state !== 'available' || (check.vaultId && check.vaultId !== vaultId)) return createInternalReceipt({ operation, status: 'unavailable', lifecycleState: 'planned', persistence: 'durable', obsidian: check?.state === 'available' ? 'wrong_vault' : (check?.state || 'api_incompatible') });
    // A successful connection is a bounded opportunity, never an unbounded
    // startup writer. The host supplies the reconciler to avoid a module cycle.
    // Exclude the just-persisted foreground intent: a drain must not recursively
    // re-dispatch it before this invocation establishes its terminal state.
    if (!draining && typeof opportunisticDrain === 'function') { try { draining = true; opportunisticDrain({ limit: 2, timeMs: 100, excludeOperationId: excludeOperationId || operation.operationId }); } catch { /* the foreground mutation remains authoritative */ } finally { draining = false; } }
    if (operation.operationKind === 'transform' && (!transforms || transforms.quarantine(operation))) return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'api_incompatible' });
    if (operation.operationKind === 'create' && typeof operation.content !== 'string') return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'unacknowledged' });
    if (operation.operationKind === 'replace' && (typeof operation.content !== 'string' || typeof operation.expectedContent !== 'string' || !operation.expectedHash || hashUtf8(operation.expectedContent) !== operation.expectedHash)) return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'unacknowledged' });
    const claim = mutationLedger.claim(operation, ownerId);
    if (!claim.granted && claim.reason === 'already_acknowledged') return createInternalReceipt({ operation, status: 'already_satisfied', lifecycleState: 'acknowledged', persistence: 'durable', obsidian: 'acknowledged' });
    if (!claim.granted) return createInternalReceipt({ operation, status: 'blocked', lifecycleState: 'blocked', persistence: 'durable', obsidian: 'unacknowledged', adapterEvidence: { reason: claim.reason } });
    try {
      const queued = run(buildObsidianMutationProgram(operation));
      if (!queued?.queued || queued.token !== operation.operationId) throw new Error('invalid queued acknowledgement');
      let result = null;
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) { result = run(tokenProgram(operation.operationId)); if (result?.status === 'done' || result?.status === 'error') break; }
      if (result?.status === 'done' && result.invariant === true) {
        mutationLedger.transition(operation.operationId, 'acknowledged', { ownerId, fence: claim.fence, evidence: { acknowledgedBy: 'app.vault.read', readbackHash: result.readback ? hashUtf8(result.readback) : undefined } });
        try { run(cleanupProgram(operation.operationId)); } catch { /* acknowledgement is already durable */ }
        return createInternalReceipt({ operation, status: 'committed', persistence: 'durable', obsidian: 'acknowledged' });
      }
      if (result?.status === 'error' || result?.status === 'done') { mutationLedger.transition(operation.operationId, 'conflict', { ownerId, fence: claim.fence, evidence: { errorClass: result.errorClass || 'readback_mismatch' } }); try { run(cleanupProgram(operation.operationId)); } catch {} return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'conflict', persistence: 'durable', obsidian: 'unacknowledged' }); }
      mutationLedger.transition(operation.operationId, 'unknown_after_dispatch', { ownerId, fence: claim.fence });
      return createInternalReceipt({ operation, status: 'unknown_after_dispatch', persistence: 'durable', obsidian: 'unacknowledged' });
    } catch (error) {
      mutationLedger.transition(operation.operationId, 'unknown_after_dispatch', { ownerId, fence: claim.fence, evidence: { errorClass: error.code === 'ENOENT' ? 'cli_missing' : 'dispatch_failed' } });
      return createInternalReceipt({ operation, status: 'unknown_after_dispatch', persistence: 'durable', obsidian: 'unacknowledged' });
    }
  }
  return Object.freeze({ capability, execute, inspectInvariant, ledger: mutationLedger });
}
module.exports = { CAPABILITY_STATES, RESULT_STORE, buildObsidianInvariantProgram, buildObsidianMutationProgram, createVaultMutationAdapter, runObsidianEval };
