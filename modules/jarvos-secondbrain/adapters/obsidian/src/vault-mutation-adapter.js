'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createInternalReceipt, hashUtf8, validateOperation, validateVaultRelativeMarkdownPath } = require('./vault-mutation-contract');
const { createVaultMutationLedger } = require('./vault-mutation-ledger');

const RESULT_STORE = '__jarvosVaultMutationResults';
const CAPABILITY_STATES = Object.freeze(['available', 'cli_missing', 'app_stopped', 'cli_disabled', 'cli_unsupported', 'wrong_vault', 'api_incompatible']);

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseEvalResult(output) { const match = [...String(output || '').matchAll(/^=>\s*(.+)$/gm)].at(-1); return match ? JSON.parse(match[1]) : null; }
function runObsidianEval(code, { vaultName, command = process.env.OBSIDIAN_CLI || 'obsidian', timeoutMs = 10_000, execute = execFileSync } = {}) {
  try { return parseEvalResult(execute(command, [`vault=${vaultName}`, 'eval', `code=${code}`], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (error) { const wrapped = new Error(String(error.stderr || error.stdout || error.message || 'Obsidian CLI failed')); wrapped.code = error.code; throw wrapped; }
}
function payload(operation) { return Buffer.from(JSON.stringify(operation), 'utf8').toString('base64'); }
// This program is fixed. Data enters solely through base64 JSON. The only
// transform implementation is this reviewed switch, never a caller global.
function mutationTransformProgram() {
  return `const p = input.replayPayload || {}; const hasNoteIdentity = (current, id) => { const match = current.match(/^---\\r?\\n[\\s\\S]*?^jarvos_note_id:\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s#]+))[\\s\\S]*?^---/m); return (match?.[1] || match?.[2] || match?.[3] || '') === id; }; const heading = raw => { const name = String(raw || '').trim().replace(/^##\\s*/, '').trim(); return name ? '## ' + (name === '🗂️ Notes Created' ? '📝 Notes' : name) : null; }; const range = (lines, h) => { const start = lines.findIndex(line => line.trim() === h); let end = lines.length; for (let i = start + 1; start !== -1 && i < lines.length; i += 1) { if (/^##\\s/.test(lines[i])) { end = i; break; } } return { start, end }; }; const escape = value => String(value).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); const linkRe = target => new RegExp('^\\\\s*-\\\\s*\\\\[\\\\[' + escape(target) + '(?:\\\\|[^\\\\]]+)?\\\\]\\\\]\\\\s*$'); const transform = (() => { if (input.transformName === 'append-line' && input.transformVersion === 1 && typeof p.line === 'string' && p.line.trim().startsWith('- ')) { const line = p.line.trim(); return { apply: current => current.includes(line) ? current : current + (current.endsWith('\\n') ? '' : '\\n') + line + '\\n', invariant: current => current.includes(line) }; } if (input.transformName === 'note-append-body' && input.transformVersion === 1 && typeof p.noteId === 'string' && typeof p.body === 'string') { const id = p.noteId.trim(); const body = p.body.trim(); return { apply: current => { if (!hasNoteIdentity(current, id) || current.includes(body)) return current; return current.trimEnd() + '\\n\\n' + body + '\\n'; }, invariant: current => hasNoteIdentity(current, id) && current.includes(body) }; } if (input.transformName === 'session-thread-append' && input.transformVersion === 1 && typeof p.noteId === 'string' && typeof p.entry === 'string') { const id = p.noteId.trim(); const entry = p.entry.trim(); return { apply: current => { if (!hasNoteIdentity(current, id) || !entry || current.includes(entry)) return current; return current.trimEnd() + '\\n\\n' + entry + '\\n'; }, invariant: current => hasNoteIdentity(current, id) && current.includes(entry) }; } if (input.transformName === 'journal-section-line' && input.transformVersion === 1 && typeof p.heading === 'string' && typeof p.line === 'string') { const h = heading(p.heading); const line = p.line.trim(); return { apply: current => { if (!h || !line.startsWith('- ')) return current; const lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) { const trimmed = String(current).trimEnd(); return trimmed + (trimmed ? '\\n\\n' : '') + h + '\\n' + line + '\\n'; } const section = lines.slice(r.start + 1, r.end); if (section.some(entry => entry.trim() === line)) return current; const kept = section.filter(entry => entry.trim() !== '-' && entry.trim() !== ''); kept.push(line); return [...lines.slice(0, r.start + 1), ...kept, '', ...lines.slice(r.end)].join('\\n'); }, invariant: current => { const lines = String(current).split('\\n'); const r = range(lines, h); return r.start !== -1 && lines.slice(r.start + 1, r.end).some(entry => entry.trim() === line); } }; } if (input.transformName === 'journal-backlink' && input.transformVersion === 1 && typeof p.linkTarget === 'string') { const h = heading(p.section || '📝 Notes'); const target = p.linkTarget.trim(); const re = linkRe(target); const line = '- [[' + target + ']]'; return { apply: current => { if (!h || !target) return current; let lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) { const cleaned = lines.filter(entry => !re.test(entry)).join('\\n').trimEnd(); return cleaned + (cleaned ? '\\n\\n' : '') + h + '\\n' + line + '\\n'; } const before = lines.slice(0, r.start + 1).filter(entry => !re.test(entry)); const section = lines.slice(r.start + 1, r.end); const after = lines.slice(r.end).filter(entry => !re.test(entry)); const had = section.some(entry => re.test(entry)); return [...before, line, ...section.filter(entry => !re.test(entry) && (had || entry.trim() !== '-')), ...after].join('\\n'); }, invariant: current => { const lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) return false; return lines.slice(r.start + 1, r.end).filter(entry => re.test(entry)).length === 1 && lines.filter(entry => re.test(entry)).length === 1; } }; } return null; })();`;
}

function invariantTransformProgram() {
  return `const p = input.replayPayload || {}; const hasNoteIdentity = (current, id) => { const match = current.match(/^---\\r?\\n[\\s\\S]*?^jarvos_note_id:\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s#]+))[\\s\\S]*?^---/m); return (match?.[1] || match?.[2] || match?.[3] || '') === id; }; const heading = raw => { const name = String(raw || '').trim().replace(/^##\\s*/, '').trim(); return name ? '## ' + (name === '🗂️ Notes Created' ? '📝 Notes' : name) : null; }; const range = (lines, h) => { const start = lines.findIndex(line => line.trim() === h); let end = lines.length; for (let i = start + 1; start !== -1 && i < lines.length; i += 1) { if (/^##\\s/.test(lines[i])) { end = i; break; } } return { start, end }; }; const escape = value => String(value).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); const linkRe = target => new RegExp('^\\\\s*-\\\\s*\\\\[\\\\[' + escape(target) + '(?:\\\\|[^\\\\]]+)?\\\\]\\\\]\\\\s*$'); const transform = (() => { if (input.transformName === 'append-line' && input.transformVersion === 1 && typeof p.line === 'string') { const line = p.line.trim(); return current => current.includes(line); } if (input.transformName === 'note-append-body' && input.transformVersion === 1 && typeof p.noteId === 'string' && typeof p.body === 'string') { const id = p.noteId.trim(); const body = p.body.trim(); return current => hasNoteIdentity(current, id) && current.includes(body); } if (input.transformName === 'session-thread-append' && input.transformVersion === 1 && typeof p.noteId === 'string' && typeof p.entry === 'string') { const id = p.noteId.trim(); const entry = p.entry.trim(); return current => hasNoteIdentity(current, id) && current.includes(entry); } if (input.transformName === 'journal-section-line' && input.transformVersion === 1 && typeof p.heading === 'string' && typeof p.line === 'string') { const h = heading(p.heading); const line = p.line.trim(); return current => { const lines = String(current).split('\\n'); const r = range(lines, h); return Boolean(h && r.start !== -1 && lines.slice(r.start + 1, r.end).some(entry => entry.trim() === line)); }; } if (input.transformName === 'journal-backlink' && input.transformVersion === 1 && typeof p.linkTarget === 'string') { const h = heading(p.section || '📝 Notes'); const re = linkRe(p.linkTarget.trim()); return current => { const lines = String(current).split('\\n'); const r = range(lines, h); return Boolean(h && r.start !== -1 && lines.slice(r.start + 1, r.end).filter(entry => re.test(entry)).length === 1 && lines.filter(entry => re.test(entry)).length === 1); }; } return null; })();`;
}

function buildObsidianMutationProgram(operation) {
  const encoded = payload(operation);
  return `(() => { const input = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), c => c.charCodeAt(0)))); const store = globalThis.${RESULT_STORE} ||= {}; const token = input.operationId; store[token] = { status: 'pending' }; ${mutationTransformProgram()} if (!globalThis.app?.vault?.read || !app.vault.getFileByPath) { store[token] = { status: 'error', errorClass: 'api_incompatible' }; return JSON.stringify({ queued: true, token }); } const finish = (file) => app.vault.read(file).then((readback) => { const exact = input.operationKind === 'create' || input.operationKind === 'replace' ? readback === input.content : transform?.invariant(readback) === true; store[token] = { status: exact ? 'done' : 'error', invariant: exact, errorClass: exact ? undefined : 'readback_mismatch' }; }).catch((e) => { store[token] = { status: 'error', errorClass: 'readback_failed', error: String(e?.message || e) }; }); const existing = app.vault.getFileByPath(input.vaultRelativePath); if (input.operationKind === 'create') { if (existing) finish(existing); else app.vault.create(input.vaultRelativePath, input.content).then(finish).catch((e) => { const raced = app.vault.getFileByPath(input.vaultRelativePath); if (raced) finish(raced); else store[token] = { status: 'error', errorClass: 'create_failed', error: String(e?.message || e) }; }); } else if (input.operationKind === 'transform') { if (!existing || !transform) store[token] = { status: 'error', errorClass: 'api_incompatible' }; else app.vault.process(existing, current => transform.apply(current)).then(() => finish(existing)).catch((e) => { store[token] = { status: 'error', errorClass: 'process_failed', error: String(e?.message || e) }; }); } else if (input.operationKind === 'replace') { if (!existing) store[token] = { status: 'error', errorClass: 'missing_target' }; else app.vault.process(existing, current => current === input.expectedContent ? input.content : current).then(() => finish(existing)).catch((e) => { store[token] = { status: 'error', errorClass: 'replace_failed', error: String(e?.message || e) }; }); } else store[token] = { status: 'error', errorClass: 'invalid_operation' }; return JSON.stringify({ queued: true, token }); })()`;
}
// Read-only companion to the mutation program.  Node-visible disk bytes are
// intentionally not consulted: acknowledgement belongs to Obsidian's vault.
function buildObsidianInvariantProgram(operation, inspectionToken, inspectionNonce) {
  const encoded = payload({ ...operation, inspectionToken, inspectionNonce });
  return `(() => { const input = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), c => c.charCodeAt(0)))); const store = globalThis.${RESULT_STORE} ||= {}; const token = input.inspectionToken; const publish = value => { if (store[token]?.nonce === input.inspectionNonce) store[token] = { ...value, nonce: input.inspectionNonce }; }; store[token] = { status: 'pending', nonce: input.inspectionNonce }; ${invariantTransformProgram()} if (!globalThis.app?.vault?.read || !app.vault.getFileByPath) { publish({ status: 'unavailable' }); return JSON.stringify({ queued: true, token }); } const file = app.vault.getFileByPath(input.vaultRelativePath); if (!file) { publish({ status: 'missing' }); return JSON.stringify({ queued: true, token }); } app.vault.read(file).then(content => { const satisfied = input.operationKind === 'create' || input.operationKind === 'replace' ? content === input.content : transform?.(content) === true; publish({ status: satisfied ? 'satisfied' : 'unsatisfied', invariant: satisfied === true }); }).catch(() => { publish({ status: 'unavailable' }); }); return JSON.stringify({ queued: true, token }); })()`;
}
function tokenProgram(operationId) { return `JSON.stringify(globalThis.${RESULT_STORE}?.[${JSON.stringify(operationId)}] || null)`; }
function cleanupProgram(operationId) { return `delete globalThis.${RESULT_STORE}?.[${JSON.stringify(operationId)}]; JSON.stringify(true)`; }

function createVaultMutationAdapter({ vaultRoot, vaultId, vaultName = path.basename(vaultRoot || ''), ledger, ledgerPath, transforms, evaluate, maxPollAttempts = 40, pollIntervalMs = 50, pollTimeoutMs = 2_500, probe, ownerId = crypto.randomUUID(), opportunisticDrain } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be absolute');
  if (typeof vaultId !== 'string' || !vaultId) throw new Error('vaultId is required');
  // Keep operational intent outside authored vault content. Hosts normally supply
  // ledgerPath; this deterministic default avoids ever creating hidden vault files.
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const defaultLedgerPath = path.join(stateHome, 'jarvos', 'vault-mutations', `${hashUtf8(`${vaultId}\0${vaultRoot}`)}.json`);
  const mutationLedger = ledger || createVaultMutationLedger({ filePath: ledgerPath || defaultLedgerPath });
  const run = evaluate || ((code, timeoutMs = pollTimeoutMs) => runObsidianEval(code, { vaultName, timeoutMs }));
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
      const inspectionNonce = crypto.randomUUID();
      const deadline = Date.now() + pollTimeoutMs;
      const queued = run(buildObsidianInvariantProgram(operation, inspectionToken, inspectionNonce), Math.max(1, deadline - Date.now()));
      if (!queued?.queued || queued.token !== inspectionToken) return { status: 'unavailable' };
      let result = null;
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        result = run(tokenProgram(inspectionToken), remaining);
        if (['satisfied', 'unsatisfied', 'missing', 'unavailable'].includes(result?.status)) break;
        if (attempt + 1 < maxPollAttempts) sleepSync(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      }
      if (['satisfied', 'unsatisfied', 'missing', 'unavailable'].includes(result?.status)) { try { run(cleanupProgram(inspectionToken), Math.max(1, deadline - Date.now())); } catch {} return { status: result.status, ...(typeof result.invariant === 'boolean' ? { invariant: result.invariant } : {}) }; }
      try { run(cleanupProgram(inspectionToken), Math.max(1, deadline - Date.now())); } catch {}
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
      const deadline = Date.now() + pollTimeoutMs;
      const queued = run(buildObsidianMutationProgram(operation), Math.max(1, deadline - Date.now()));
      if (!queued?.queued || queued.token !== operation.operationId) throw new Error('invalid queued acknowledgement');
      let result = null;
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        result = run(tokenProgram(operation.operationId), remaining);
        if (result?.status === 'done' || result?.status === 'error') break;
        if (attempt + 1 < maxPollAttempts) sleepSync(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      }
      if (result?.status === 'done' && result.invariant === true) {
        mutationLedger.transition(operation.operationId, 'acknowledged', { ownerId, fence: claim.fence, evidence: { acknowledgedBy: 'app.vault.read' } });
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
