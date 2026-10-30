'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createInternalReceipt, hashUtf8, validateOperation, validateVaultRelativeMarkdownPath } = require('./vault-mutation-contract');
const { createVaultMutationLedger } = require('./vault-mutation-ledger');

const RESULT_STORE = '__jarvosVaultMutationResults';
// Obsidian CLI eval round-trips take ~1.5-2.5 s. The capability probe is one
// small round-trip. The dispatch/poll deadline must cover a staged program
// (several chunk calls plus the runner) and at least one poll, with headroom.
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const CAPABILITY_STATES = Object.freeze(['available', 'cli_missing', 'app_stopped', 'app_busy', 'app_unreachable', 'cli_disabled', 'cli_unsupported', 'wrong_vault', 'api_incompatible']);
// Fixed internal reason codes for a probe that answered without a usable
// capability object. Never echo probe or CLI text in their place.
const CAPABILITY_REASONS = Object.freeze(['capability_no_result', 'capability_malformed_result']);
function classifyCapabilityResult(inspected, vaultName, vaultId) {
  if (inspected === null || inspected === undefined) return { state: 'app_unreachable', reason: 'capability_no_result' };
  if (typeof inspected !== 'object' || Array.isArray(inspected)) return { state: 'app_unreachable', reason: 'capability_malformed_result' };
  if (inspected.hasVault !== true) return { state: 'api_incompatible' };
  return inspected.vaultName && inspected.vaultName !== vaultName ? { state: 'wrong_vault' } : { state: 'available', vaultId };
}

// Operator diagnostics for a failed dispatch. The raw exception can carry the
// whole eval program (note content, base64), absolute home or vault paths and
// credentials, so only a scrubbed, bounded rendering is ever persisted or
// returned. errorClass stays the machine-readable field; this is human context.
const ERROR_MESSAGE_MAX_CHARS = 300;
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function sanitizeErrorMessage(raw, { vaultRoot, maxChars = ERROR_MESSAGE_MAX_CHARS } = {}) {
  let text = typeof raw === 'string' ? raw : (typeof raw?.message === 'string' ? raw.message : '');
  if (!text) return undefined;
  // The CLI echoes its argv on failure, and `code=` is the full eval program.
  text = text.replace(/\bcode=[\s\S]*/, 'code=<redacted>').replace(/[\0-\x08\x0b-\x1f\x7f]/g, ' ');
  const roots = new Set();
  for (const candidate of [vaultRoot, (() => { try { return vaultRoot && fs.realpathSync(vaultRoot); } catch { return null; } })()]) {
    if (typeof candidate === 'string' && path.isAbsolute(candidate) && candidate.length > 1) roots.add(candidate.replace(/[\\/]+$/, ''));
  }
  for (const root of [...roots].sort((a, b) => b.length - a.length)) text = text.replace(new RegExp(`${escapeRegExp(root)}(?=$|[\\\\/\\s'"\`:;,)\\]}])`, 'g'), '<vault>');
  const home = os.homedir();
  if (home && home.length > 1) text = text.split(home).join('~');
  text = text
    .replace(/(:\/\/)[^\s/@]+@/g, '$1<redacted>@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, '$1 <redacted>')
    // Fail safe: once a credential-like key is followed by ':' or '=', drop the rest
    // of the message. Quoted, escape-quoted or nested-escaped values cannot be
    // bounded reliably, so no part of any value (or anything after it) is kept.
    .replace(/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|credential|cookie|authorization)[A-Za-z0-9_.-]*)(?:\\*["'])?\s*[:=][\s\S]*$/i, '$1=<redacted>')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{12,}/g, '<redacted>')
    // Absolute paths that survived are outside the vault: keep no location.
    .replace(/(?:~|[A-Za-z]:\\)[^\s'"`<>|;,()\[\]{}]*|(?<![\w<>:.\/~-])(?:\/[^\s\/'"`<>|:;,()\[\]{}]+){2,}/g, '<path>')
    .replace(/[A-Za-z0-9+\/_-]{32,}={0,2}/g, '<redacted>')
    .replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseEvalResult(output) { const match = [...String(output || '').matchAll(/^=>\s*(.+)$/gm)].at(-1); return match ? JSON.parse(match[1]) : null; }
// Obsidian CLI 1.14 exits 0 with no output at all, and without running the
// code, for eval payloads above roughly 8 KB: about half of 10 KB calls and
// every 14 KB call are dropped. The fixed programs below are 9-20 KB, so larger
// programs are staged in the app in bounded chunks and run by one small call.
// A genuine undefined result prints "(no output)", so an empty response is a
// transport drop and is replayed within the caller's deadline. Replays are
// safe: chunk writes are indexed, and each program is idempotent against the
// app's current content.
const EVAL_STAGE = '__jarvosEvalStage';
const EVAL_CHUNK_BYTES = 6_000;
const EMPTY_EVAL_RETRIES = 4;
// Each CLI call launches a full Electron process, and a launch can die within
// about a second (non-zero exit or a signal). Such a call is relaunched twice
// more with a short backoff, inside the caller's deadline. Timeouts, a missing
// CLI and any slow failure are never relaunched. A replay is safe for the same
// reason empty responses are: every program is idempotent against the app's
// current content (create reads back an existing file, replace only swaps the
// expected content, transforms check before applying, delete of an absent file
// is done) and the staged runner deletes its stage before evaluating.
const FAST_LAUNCH_FAILURE_MS = 5_000;
const LAUNCH_RETRY_BACKOFF_MS = Object.freeze([1_000, 2_000]);
function isFastLaunchFailure(error, elapsedMs) {
  if (error.code !== undefined || elapsedMs > FAST_LAUNCH_FAILURE_MS) return false;
  return typeof error.status === 'number' ? error.status !== 0 : Boolean(error.signal);
}
// Read-only and cheap: `pgrep -x` exits 1 when the app is not running. Any
// other outcome is "unknown" and simply omitted from the evidence.
function obsidianAppRunning() {
  try { execFileSync('pgrep', ['-x', 'Obsidian'], { timeout: 1_000, stdio: 'ignore' }); return true; }
  catch (error) { return error?.status === 1 ? false : undefined; }
}
function evalOnce(code, { vaultName, command, deadline, execute, emptyRetries, retryBackoffMs, stats, isAppRunning }) {
  let launchRetries = 0;
  for (let attempt = 0; ; attempt += 1) {
    let output;
    for (;;) {
      const startedAt = Date.now();
      try { output = execute(command, [`vault=${vaultName}`, 'eval', `code=${code}`], { encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), stdio: ['ignore', 'pipe', 'pipe'] }); break; }
      catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const backoff = retryBackoffMs[launchRetries];
        if (backoff !== undefined && isFastLaunchFailure(error, elapsedMs) && Date.now() + backoff < deadline) {
          launchRetries += 1;
          if (stats) stats.retries += 1;
          sleepSync(backoff);
          continue;
        }
        const wrapped = new Error(String(error.stderr || error.stdout || error.message || 'Obsidian CLI failed'));
        wrapped.code = error.code;
        let obsidianRunning;
        try { obsidianRunning = isAppRunning(); } catch { /* diagnostics only */ }
        wrapped.diagnostics = { exitStatus: error.status ?? null, signal: error.signal ?? null, elapsedMs, attempts: launchRetries + 1, stderr: String(error.stderr || ''), obsidianRunning };
        throw wrapped;
      }
    }
    if (String(output || '').trim() || attempt >= emptyRetries || Date.now() >= deadline) return parseEvalResult(output);
  }
}
function runObsidianEval(code, { vaultName, command = process.env.OBSIDIAN_CLI || 'obsidian', timeoutMs = 10_000, execute = execFileSync, emptyRetries = EMPTY_EVAL_RETRIES, chunkBytes = EVAL_CHUNK_BYTES, retryBackoffMs = LAUNCH_RETRY_BACKOFF_MS, stats, isAppRunning = obsidianAppRunning } = {}) {
  const options = { vaultName, command, deadline: Date.now() + timeoutMs, execute, emptyRetries, retryBackoffMs, stats, isAppRunning };
  if (Buffer.byteLength(code, 'utf8') <= chunkBytes) return evalOnce(code, options);
  const encoded = Buffer.from(code, 'utf8').toString('base64');
  const parts = encoded.match(new RegExp(`.{1,${chunkBytes}}`, 'g'));
  const stageId = JSON.stringify(crypto.randomUUID());
  try {
    parts.forEach((part, index) => {
      const staged = evalOnce(`((globalThis.${EVAL_STAGE} ||= {})[${stageId}] ||= [])[${index}] = '${part}'; JSON.stringify(${index})`, options);
      if (staged !== index) throw new Error(`Obsidian CLI did not stage eval chunk ${index + 1} of ${parts.length}`);
    });
  } catch (error) {
    // The program never ran, so callers may treat this as retryable rather
    // than ambiguous. Drop any chunks that did arrive.
    try { evalOnce(`delete globalThis.${EVAL_STAGE}?.[${stageId}]; JSON.stringify(true)`, { ...options, deadline: Math.max(options.deadline, Date.now() + 2_500), emptyRetries: 1 }); } catch { /* best effort */ }
    const notStaged = new Error(error.message);
    notStaged.code = 'EVAL_NOT_STAGED';
    notStaged.diagnostics = error.diagnostics;
    throw notStaged;
  }
  const runner = `(() => { const stage = globalThis.${EVAL_STAGE} || {}; const parts = stage[${stageId}]; delete stage[${stageId}]; if (!Array.isArray(parts) || parts.length !== ${parts.length} || parts.join('').length !== ${encoded.length}) throw new Error('staged eval is incomplete'); return (0, eval)(new TextDecoder().decode(Uint8Array.from(atob(parts.join('')), c => c.charCodeAt(0)))); })()`;
  // The runner deletes the stage before evaluating, so it is sent once per
  // attempt and never blindly replayed: a surviving stage proves the runner did
  // not run and may be resent, while a missing stage means it ran and only the
  // response was lost, which callers recover by polling the result token.
  // Probes get a small floor past the caller's deadline so they can finish.
  const probeOptions = () => ({ ...options, deadline: Math.max(options.deadline, Date.now() + 2_500), emptyRetries: 1 });
  const stageSurvived = (drop) => {
    try { return evalOnce(`(() => { const stage = globalThis.${EVAL_STAGE}; const kept = Boolean(stage?.[${stageId}]); if (kept && ${drop}) delete stage[${stageId}]; return JSON.stringify(kept); })()`, probeOptions()) === true; }
    catch { return false; }
  };
  for (let attempt = 0; ; attempt += 1) {
    const result = evalOnce(runner, { ...options, emptyRetries: 0 });
    if (result !== null) return result;
    const last = attempt >= emptyRetries || Date.now() >= options.deadline;
    if (!stageSurvived(last)) return null;
    if (last) {
      const notRun = new Error('Obsidian CLI did not run the staged eval');
      notRun.code = 'EVAL_NOT_STAGED';
      throw notRun;
    }
  }
}
function payload(operation) { return Buffer.from(JSON.stringify(operation), 'utf8').toString('base64'); }
// This program is fixed. Data enters solely through base64 JSON. The only
// transform implementation is this reviewed switch, never a caller global.
function rawMutationTransformProgram() {
  return `const p = input.replayPayload || {}; const hasNoteIdentity = (current, id) => { const match = current.match(/^---\\r?\\n[\\s\\S]*?^jarvos_note_id:\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s#]+))[\\s\\S]*?^---/m); return (match?.[1] || match?.[2] || match?.[3] || '') === id; }; const heading = raw => { const name = String(raw || '').trim().replace(/^##\\s*/, '').trim(); return name ? '## ' + (name === '🗂️ Notes Created' ? '📝 Notes' : name) : null; }; const range = (lines, h) => { const start = lines.findIndex(line => line.trim() === h); let end = lines.length; for (let i = start + 1; start !== -1 && i < lines.length; i += 1) { if (/^##\\s/.test(lines[i])) { end = i; break; } } return { start, end }; }; const escape = value => String(value).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); const linkRe = target => new RegExp('^\\\\s*-\\\\s*\\\\[\\\\[' + escape(target) + '(?:\\\\|[^\\\\]]+)?\\\\]\\\\]\\\\s*$'); const transform = (() => { if (input.transformName === 'append-line' && input.transformVersion === 1 && typeof p.line === 'string' && p.line.trim().startsWith('- ')) { const line = p.line.trim(); return { apply: current => current.includes(line) ? current : current + (current.endsWith('\\n') ? '' : '\\n') + line + '\\n', invariant: current => current.includes(line) }; } if (input.transformName === 'note-append-body' && input.transformVersion === 1 && typeof p.noteId === 'string' && typeof p.body === 'string') { const id = p.noteId.trim(); const body = p.body.trim(); return { apply: current => { if (!hasNoteIdentity(current, id) || current.includes(body)) return current; return current.trimEnd() + '\\n\\n' + body + '\\n'; }, invariant: current => hasNoteIdentity(current, id) && current.includes(body) }; } if (input.transformName === 'session-thread-append' && input.transformVersion === 1 && typeof p.noteId === 'string' && typeof p.entry === 'string') { const id = p.noteId.trim(); const entry = p.entry.trim(); return { apply: current => { if (!hasNoteIdentity(current, id) || !entry || current.includes(entry)) return current; return current.trimEnd() + '\\n\\n' + entry + '\\n'; }, invariant: current => hasNoteIdentity(current, id) && current.includes(entry) }; } if (input.transformName === 'journal-section-line' && input.transformVersion === 1 && typeof p.heading === 'string' && typeof p.line === 'string') { const h = heading(p.heading); const line = p.line.trim(); return { apply: current => { if (!h || !line.startsWith('- ')) return current; const lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) { const trimmed = String(current).trimEnd(); return trimmed + (trimmed ? '\\n\\n' : '') + h + '\\n' + line + '\\n'; } const section = lines.slice(r.start + 1, r.end); if (section.some(entry => entry.trim() === line)) return current; const kept = section.filter(entry => entry.trim() !== '-' && entry.trim() !== ''); kept.push(line); return [...lines.slice(0, r.start + 1), ...kept, '', ...lines.slice(r.end)].join('\\n'); }, invariant: current => { const lines = String(current).split('\\n'); const r = range(lines, h); return r.start !== -1 && lines.slice(r.start + 1, r.end).some(entry => entry.trim() === line); } }; } if (input.transformName === 'journal-backlink' && input.transformVersion === 1 && typeof p.linkTarget === 'string') { const h = heading(p.section || '📝 Notes'); const target = p.linkTarget.trim(); const re = linkRe(target); const line = '- [[' + target + ']]'; return { apply: current => { if (!h || !target) return current; let lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) { const cleaned = lines.filter(entry => !re.test(entry)).join('\\n').trimEnd(); return cleaned + (cleaned ? '\\n\\n' : '') + h + '\\n' + line + '\\n'; } const before = lines.slice(0, r.start + 1).filter(entry => !re.test(entry)); const section = lines.slice(r.start + 1, r.end); const after = lines.slice(r.end).filter(entry => !re.test(entry)); const had = section.some(entry => re.test(entry)); return [...before, line, ...section.filter(entry => !re.test(entry) && (had || entry.trim() !== '-')), ...after].join('\\n'); }, invariant: current => { const lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) return false; return lines.slice(r.start + 1, r.end).filter(entry => re.test(entry)).length === 1 && lines.filter(entry => re.test(entry)).length === 1; } }; } return null; })();`;
}

function rawInvariantTransformProgram() {
  return `const p = input.replayPayload || {}; const hasNoteIdentity = (current, id) => { const match = current.match(/^---\\r?\\n[\\s\\S]*?^jarvos_note_id:\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s#]+))[\\s\\S]*?^---/m); return (match?.[1] || match?.[2] || match?.[3] || '') === id; }; const heading = raw => { const name = String(raw || '').trim().replace(/^##\\s*/, '').trim(); return name ? '## ' + (name === '🗂️ Notes Created' ? '📝 Notes' : name) : null; }; const range = (lines, h) => { const start = lines.findIndex(line => line.trim() === h); let end = lines.length; for (let i = start + 1; start !== -1 && i < lines.length; i += 1) { if (/^##\\s/.test(lines[i])) { end = i; break; } } return { start, end }; }; const escape = value => String(value).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); const linkRe = target => new RegExp('^\\\\s*-\\\\s*\\\\[\\\\[' + escape(target) + '(?:\\\\|[^\\\\]]+)?\\\\]\\\\]\\\\s*$'); const transform = (() => { if (input.transformName === 'append-line' && input.transformVersion === 1 && typeof p.line === 'string') { const line = p.line.trim(); return current => current.includes(line); } if (input.transformName === 'note-append-body' && input.transformVersion === 1 && typeof p.noteId === 'string' && typeof p.body === 'string') { const id = p.noteId.trim(); const body = p.body.trim(); return current => hasNoteIdentity(current, id) && current.includes(body); } if (input.transformName === 'session-thread-append' && input.transformVersion === 1 && typeof p.noteId === 'string' && typeof p.entry === 'string') { const id = p.noteId.trim(); const entry = p.entry.trim(); return current => hasNoteIdentity(current, id) && current.includes(entry); } if (input.transformName === 'journal-section-line' && input.transformVersion === 1 && typeof p.heading === 'string' && typeof p.line === 'string') { const h = heading(p.heading); const line = p.line.trim(); return current => { const lines = String(current).split('\\n'); const r = range(lines, h); return Boolean(h && r.start !== -1 && lines.slice(r.start + 1, r.end).some(entry => entry.trim() === line)); }; } if (input.transformName === 'journal-backlink' && input.transformVersion === 1 && typeof p.linkTarget === 'string') { const h = heading(p.section || '📝 Notes'); const re = linkRe(p.linkTarget.trim()); return current => { const lines = String(current).split('\\n'); const r = range(lines, h); return Boolean(h && r.start !== -1 && lines.slice(r.start + 1, r.end).filter(entry => re.test(entry)).length === 1 && lines.filter(entry => re.test(entry)).length === 1); }; } return null; })();`;
}

function journalOriginTransformHelpersProgram() {
  return "const markerPayload = origin => { const o = origin || {}; const json = JSON.stringify({ schema_version: 'jarvos-content-origin/v1', content_origin: o.content_origin, content_origin_basis: o.content_origin_basis, clean_text_digest: o.clean_text_digest, human_evidence_eligible: o.human_evidence_eligible === true && o.content_origin === 'human', ...(o.source_ref ? { source_ref: String(o.source_ref) } : {}), ...(o.user_source && typeof o.user_source === 'object' ? { user_source: { capture_event_id: o.user_source.capture_event_id, actor: o.user_source.actor, source_digest: o.user_source.source_digest, content_digest: o.clean_text_digest || o.user_source.content_digest } } : {}) }); const encoded = btoa(unescape(encodeURIComponent(json))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, ''); return '<!-- jarvos-content-origin/v1 ' + encoded + ' -->'; }; const cleanMarker = value => String(value || '').replace(/<!--\\s*jarvos-content-origin\\/[^>]*-->\\s*/gi, '').trim(); const markerObject = value => { const match = String(value || '').match(/^<!--\\s*jarvos-content-origin\\/v1\\s+([^\\s>]+)\\s*-->$/); if (!match) return null; try { const token = match[1]; const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((token.length + 3) % 4); const decoded = token.startsWith('%7B') || token.startsWith('%7b') ? decodeURIComponent(token) : new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0))); return JSON.parse(decoded); } catch (_) { return null; } }; const sha256 = value => /^[a-f0-9]{64}$/.test(String(value || '')); const verifiedHumanMarker = value => { const marker = markerObject(value); const receipt = marker && marker.user_source; return Boolean(marker && marker.schema_version === 'jarvos-content-origin/v1' && marker.content_origin === 'human' && (marker.content_origin_basis === 'verbatim_user' || marker.content_origin_basis === 'user_derived') && marker.human_evidence_eligible === true && sha256(marker.clean_text_digest) && receipt && receipt.actor === 'user' && typeof receipt.capture_event_id === 'string' && receipt.capture_event_id.trim() && sha256(receipt.source_digest) && receipt.content_digest === marker.clean_text_digest && marker.source_ref === receipt.capture_event_id); }; const sameVerifiedHumanOrigin = (left, right) => { const a = markerObject(left); const b = markerObject(right); return Boolean(verifiedHumanMarker(left) && verifiedHumanMarker(right) && a.content_origin === b.content_origin && a.content_origin_basis === b.content_origin_basis && a.human_evidence_eligible === b.human_evidence_eligible); }; const cleanLine = value => { const clean = cleanMarker(value); return clean.startsWith('- ') ? clean : '- ' + clean.replace(/^[-\\s]+/, ''); }; ";
}

function journalOriginMutationBranchProgram() {
  return "if (input.transformName === 'journal-section-line' && input.transformVersion === 2 && typeof p.heading === 'string' && typeof p.line === 'string' && p.contentOrigin) { const h = heading(p.heading); const line = cleanLine(p.line); const marker = markerPayload(p.contentOrigin); return { apply: current => { if (!h || !line.startsWith('- ')) return current; const lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) { const trimmed = String(current).trimEnd(); return trimmed + (trimmed ? '\\n\\n' : '') + h + '\\n' + line + '\\n' + marker + '\\n'; } let match = -1; for (let i = r.start + 1; i < r.end; i += 1) { if (lines[i].trim().startsWith('- ') && cleanMarker(lines[i]) === line) { match = i; break; } } if (match !== -1) { const firstMarker = String(lines[match + 1] || '').trim(); if (!firstMarker.startsWith('<!-- jarvos-content-origin/')) return current; if (sameVerifiedHumanOrigin(firstMarker, marker)) return current; if (verifiedHumanMarker(firstMarker) && !verifiedHumanMarker(marker)) return current; let markerEnd = match + 1; while (markerEnd < r.end && String(lines[markerEnd] || '').trim().startsWith('<!-- jarvos-content-origin/')) markerEnd += 1; if (markerEnd === match + 2 && firstMarker === marker) return current; lines.splice(match + 1, markerEnd - match - 1, marker); return lines.join('\\n'); } const section = lines.slice(r.start + 1, r.end).filter(entry => entry.trim() !== '-' && entry.trim() !== ''); section.push(line, marker); return [...lines.slice(0, r.start + 1), ...section, '', ...lines.slice(r.end)].join('\\n'); }, invariant: current => { const lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) return false; for (let i = r.start + 1; i < r.end; i += 1) { if (lines[i].trim() === line) { const firstMarker = String(lines[i + 1] || '').trim(); if (!firstMarker.startsWith('<!-- jarvos-content-origin/')) return true; if (firstMarker === marker || sameVerifiedHumanOrigin(firstMarker, marker)) return true; } } return false; } }; } ";
}

function journalOriginInvariantBranchProgram() {
  return "if (input.transformName === 'journal-section-line' && input.transformVersion === 2 && typeof p.heading === 'string' && typeof p.line === 'string' && p.contentOrigin) { const h = heading(p.heading); const line = cleanLine(p.line); const marker = markerPayload(p.contentOrigin); return current => { const lines = String(current).split('\\n'); const r = range(lines, h); if (r.start === -1) return false; for (let i = r.start + 1; i < r.end; i += 1) { if (lines[i].trim() === line) { const firstMarker = String(lines[i + 1] || '').trim(); if (!firstMarker.startsWith('<!-- jarvos-content-origin/')) return true; if (firstMarker === marker || sameVerifiedHumanOrigin(firstMarker, marker)) return true; } } return false; }; } ";
}

function exactBlockTransformProgram(program) {
  const helper = "const hasBlock = (current, block) => { const expected = String(block || '').trim(); return Boolean(expected && ('\\n\\n' + String(current).trim() + '\\n\\n').includes('\\n\\n' + expected + '\\n\\n')); }; ";
  return program
    .replace('const heading = raw =>', `${helper}const heading = raw =>`)
    .replaceAll('current.includes(body)', 'hasBlock(current, body)')
    .replaceAll('current.includes(entry)', 'hasBlock(current, entry)');
}
function mutationTransformProgram() {
  const program = rawMutationTransformProgram()
    .replace('const transform = (() => {', `${journalOriginTransformHelpersProgram()}const transform = (() => {${journalOriginMutationBranchProgram()}`);
  return exactBlockTransformProgram(program);
}
function invariantTransformProgram() {
  const program = rawInvariantTransformProgram()
    .replace('const transform = (() => {', `${journalOriginTransformHelpersProgram()}const transform = (() => {${journalOriginInvariantBranchProgram()}`);
  return exactBlockTransformProgram(program);
}

function buildObsidianDeleteProgram(operation) {
  const encoded = payload(operation);
  return `(() => { const input = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), c => c.charCodeAt(0)))); const store = globalThis.${RESULT_STORE} ||= {}; const token = input.operationId; store[token] = { status: 'pending' }; if (!globalThis.app?.vault?.read || !app.vault.getFileByPath || !app.vault.delete) { store[token] = { status: 'error', errorClass: 'api_incompatible' }; return JSON.stringify({ queued: true, token }); } const existing = app.vault.getFileByPath(input.vaultRelativePath); if (!existing) { store[token] = { status: 'done', invariant: true }; return JSON.stringify({ queued: true, token }); } app.vault.read(existing).then(current => { if (current !== input.expectedContent) { store[token] = { status: 'error', invariant: false, errorClass: 'delete_conflict' }; return; } app.vault.delete(existing).then(() => { const absent = !app.vault.getFileByPath(input.vaultRelativePath); store[token] = { status: absent ? 'done' : 'error', invariant: absent, errorClass: absent ? undefined : 'delete_readback_mismatch' }; }).catch(e => { store[token] = { status: 'error', errorClass: 'delete_failed', error: String(e?.message || e) }; }); }).catch(e => { store[token] = { status: 'error', errorClass: 'readback_failed', error: String(e?.message || e) }; }); return JSON.stringify({ queued: true, token }); })()`;
}

function buildObsidianMutationProgram(operation) {
  if (operation.operationKind === 'delete') return buildObsidianDeleteProgram(operation);
  const encoded = payload(operation);
  return `(() => { const input = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), c => c.charCodeAt(0)))); const store = globalThis.${RESULT_STORE} ||= {}; const token = input.operationId; store[token] = { status: 'pending' }; ${mutationTransformProgram()} if (!globalThis.app?.vault?.read || !app.vault.getFileByPath) { store[token] = { status: 'error', errorClass: 'api_incompatible' }; return JSON.stringify({ queued: true, token }); } const finish = (file) => app.vault.read(file).then((readback) => { const exact = input.operationKind === 'create' || input.operationKind === 'replace' ? readback === input.content : transform?.invariant(readback) === true; store[token] = { status: exact ? 'done' : 'error', invariant: exact, errorClass: exact ? undefined : 'readback_mismatch' }; }).catch((e) => { store[token] = { status: 'error', errorClass: 'readback_failed', error: String(e?.message || e) }; }); const existing = app.vault.getFileByPath(input.vaultRelativePath); if (input.operationKind === 'create') { if (existing) finish(existing); else app.vault.create(input.vaultRelativePath, input.content).then(finish).catch((e) => { const raced = app.vault.getFileByPath(input.vaultRelativePath); if (raced) finish(raced); else store[token] = { status: 'error', errorClass: 'create_failed', error: String(e?.message || e) }; }); } else if (input.operationKind === 'transform') { if (!existing || !transform) store[token] = { status: 'error', errorClass: 'api_incompatible' }; else app.vault.process(existing, current => transform.apply(current)).then(() => finish(existing)).catch((e) => { store[token] = { status: 'error', errorClass: 'process_failed', error: String(e?.message || e) }; }); } else if (input.operationKind === 'replace') { if (!existing) store[token] = { status: 'error', errorClass: 'missing_target' }; else app.vault.process(existing, current => current === input.expectedContent ? input.content : current).then(() => finish(existing)).catch((e) => { store[token] = { status: 'error', errorClass: 'replace_failed', error: String(e?.message || e) }; }); } else store[token] = { status: 'error', errorClass: 'invalid_operation' }; return JSON.stringify({ queued: true, token }); })()`;
}
// Read-only companion to the mutation program.  Node-visible disk bytes are
// intentionally not consulted: acknowledgement belongs to Obsidian's vault.
function buildObsidianInvariantProgram(operation, inspectionToken, inspectionNonce) {
  const encoded = payload({ ...operation, inspectionToken, inspectionNonce });
  return `(() => { const input = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'), c => c.charCodeAt(0)))); const store = globalThis.${RESULT_STORE} ||= {}; const token = input.inspectionToken; const publish = value => { if (store[token]?.nonce === input.inspectionNonce) store[token] = { ...value, nonce: input.inspectionNonce }; }; store[token] = { status: 'pending', nonce: input.inspectionNonce }; ${invariantTransformProgram()} if (!globalThis.app?.vault?.read || !app.vault.getFileByPath) { publish({ status: 'unavailable' }); return JSON.stringify({ queued: true, token }); } const file = app.vault.getFileByPath(input.vaultRelativePath); if (!file) { const deleted = input.operationKind === 'delete'; publish({ status: deleted ? 'satisfied' : 'missing', invariant: deleted }); return JSON.stringify({ queued: true, token }); } app.vault.read(file).then(content => { const satisfied = input.operationKind === 'delete' ? false : input.operationKind === 'create' || input.operationKind === 'replace' ? content === input.content : transform?.(content) === true; publish({ status: satisfied ? 'satisfied' : 'unsatisfied', invariant: satisfied === true }); }).catch(() => { publish({ status: 'unavailable' }); }); return JSON.stringify({ queued: true, token }); })()`;
}
function tokenProgram(operationId) { return `JSON.stringify(globalThis.${RESULT_STORE}?.[${JSON.stringify(operationId)}] || null)`; }
function cleanupProgram(operationId) { return `delete globalThis.${RESULT_STORE}?.[${JSON.stringify(operationId)}]; JSON.stringify(true)`; }

function createVaultMutationAdapter({ vaultRoot, vaultId, vaultName = path.basename(vaultRoot || ''), ledger, ledgerPath, transforms, evaluate, maxPollAttempts = 40, pollIntervalMs = 50, pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS, probe, ownerId = crypto.randomUUID(), opportunisticDrain, allowDeleteOperation } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be absolute');
  if (typeof vaultId !== 'string' || !vaultId) throw new Error('vaultId is required');
  // Keep operational intent outside authored vault content. Hosts normally supply
  // ledgerPath; this deterministic default avoids ever creating hidden vault files.
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const defaultLedgerPath = path.join(stateHome, 'jarvos', 'vault-mutations', `${hashUtf8(`${vaultId}\0${vaultRoot}`)}.json`);
  const mutationLedger = ledger || createVaultMutationLedger({ filePath: ledgerPath || defaultLedgerPath });
  const ledgerView = Object.freeze({
    active: () => mutationLedger.active(),
    get: (operationId) => mutationLedger.get(operationId),
    read: () => mutationLedger.read(),
    filePath: mutationLedger.filePath,
  });
  // Counts CLI relaunches since the last reset, so a write that needed one can be recorded.
  const dispatchStats = { retries: 0 };
  const run = evaluate || ((code, timeoutMs = pollTimeoutMs) => runObsidianEval(code, { vaultName, timeoutMs, stats: dispatchStats }));
  const deleteAllowed = (operation) => operation.operationKind !== 'delete' || (typeof allowDeleteOperation === 'function' && allowDeleteOperation(operation) === true);
  let draining = false;
  function capability() { if (probe) return probe(); try { const inspected = run(`JSON.stringify({ vaultName: app?.vault?.getName?.(), hasVault: Boolean(app?.vault?.create && app?.vault?.process && app?.vault?.read) })`, probeTimeoutMs); return classifyCapabilityResult(inspected, vaultName, vaultId); } catch (error) { const message = String(error.message || ''); if (error.code === 'ENOENT') return { state: 'cli_missing' }; if (error.code === 'ETIMEDOUT' || /timed?\s*out|busy|temporar/i.test(message)) return { state: 'app_busy' }; if (/disabled/i.test(message)) return { state: 'cli_disabled' }; if (/unsupported|unknown command|eval/i.test(message)) return { state: 'cli_unsupported' }; if (/not running|no running|connection refused|failed to connect/i.test(message)) return { state: 'app_stopped' }; return { state: 'app_unreachable' }; } }
  function inspectInvariant(input) {
    const operation = validateOperation(input);
    if (operation.vaultId !== vaultId) return { status: 'unavailable' };
    if (!deleteAllowed(operation)) return { status: 'unavailable' };
    const check = capability();
    if (!check || check.state !== 'available' || (check.vaultId && check.vaultId !== vaultId)) return { status: 'unavailable' };
    if (operation.operationKind === 'transform' && (!transforms || transforms.quarantine(operation))) return { status: 'unavailable' };
    try {
      const inspectionToken = `${operation.operationId}:inspect:${crypto.randomUUID()}`;
      const inspectionNonce = crypto.randomUUID();
      const deadline = Date.now() + pollTimeoutMs;
      const queued = run(buildObsidianInvariantProgram(operation, inspectionToken, inspectionNonce), Math.max(1, deadline - Date.now()));
      // A successful CLI eval may omit stdout even though it started the read.
      // Only a missing receipt may fall through; an explicit bad receipt cannot.
      if (queued !== null && (queued?.queued !== true || queued.token !== inspectionToken)) return { status: 'unavailable' };
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
  // Read-only existence check against the app's own vault index: the same source
  // acknowledgement uses, never Node-visible disk bytes (a file only on disk is
  // not yet registered with Obsidian). It is bound to the configured vault name
  // and never throws: anything but a clean yes/no answer is `unavailable`.
  function inspectFileExists(vaultRelativePath) {
    try {
      const relativePath = validateVaultRelativeMarkdownPath(vaultRelativePath);
      if (probe) { const check = probe(); if (!check || check.state !== 'available' || (check.vaultId && check.vaultId !== vaultId)) return { status: 'unavailable' }; }
      const inspected = run(`JSON.stringify({ vaultName: app?.vault?.getName?.(), hasVault: Boolean(app?.vault?.getFileByPath), exists: Boolean(app?.vault?.getFileByPath?.(${JSON.stringify(relativePath)})) })`, probeTimeoutMs);
      if (classifyCapabilityResult(inspected, vaultName, vaultId).state !== 'available' || typeof inspected.exists !== 'boolean') return { status: 'unavailable' };
      return { status: inspected.exists ? 'present' : 'absent' };
    } catch { return { status: 'unavailable' }; }
  }
  function failureEvidence(errorClass, cause) {
    const errorMessage = sanitizeErrorMessage(cause, { vaultRoot });
    const diagnostics = cause?.diagnostics;
    const stderr = diagnostics ? sanitizeErrorMessage(diagnostics.stderr, { vaultRoot }) : undefined;
    return {
      errorClass,
      ...(errorMessage ? { errorMessage } : {}),
      ...(diagnostics ? {
        exitStatus: Number.isInteger(diagnostics.exitStatus) ? diagnostics.exitStatus : null,
        signal: typeof diagnostics.signal === 'string' ? diagnostics.signal : null,
        elapsedMs: diagnostics.elapsedMs,
        attempts: diagnostics.attempts,
        ...(stderr ? { stderr } : {}),
        ...(typeof diagnostics.obsidianRunning === 'boolean' ? { obsidianRunning: diagnostics.obsidianRunning } : {}),
      } : {}),
    };
  }
  function execute(input, { excludeOperationId } = {}) {
    const operation = validateOperation(input);
    if (operation.vaultId !== vaultId) return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'wrong_vault' });
    if (!deleteAllowed(operation)) return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'unacknowledged' });
    validateVaultRelativeMarkdownPath(operation.vaultRelativePath);
    mutationLedger.ensure(operation);
    const check = capability();
    if (!check || !CAPABILITY_STATES.includes(check.state) || check.state !== 'available' || (check.vaultId && check.vaultId !== vaultId)) {
      // Only allowlisted state and reason codes leave the probe; an unknown
      // state is an unreachable transport, never an echoed probe string.
      const obsidian = check?.state === 'available' ? 'wrong_vault' : (CAPABILITY_STATES.includes(check?.state) ? check.state : 'app_unreachable');
      const capabilityReason = CAPABILITY_REASONS.includes(check?.reason) ? check.reason : undefined;
      return createInternalReceipt({ operation, status: 'unavailable', lifecycleState: 'planned', persistence: 'durable', obsidian, adapterEvidence: capabilityReason ? { capabilityReason } : undefined });
    }
    // A successful connection is a bounded opportunity, never an unbounded
    // startup writer. The host supplies the reconciler to avoid a module cycle.
    // Exclude the just-persisted foreground intent: a drain must not recursively
    // re-dispatch it before this invocation establishes its terminal state.
    if (!draining && typeof opportunisticDrain === 'function') { try { draining = true; opportunisticDrain({ limit: 2, timeMs: 100, excludeOperationId: excludeOperationId || operation.operationId }); } catch { /* the foreground mutation remains authoritative */ } finally { draining = false; } }
    if (operation.operationKind === 'transform' && (!transforms || transforms.quarantine(operation))) return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'api_incompatible' });
    if (operation.operationKind === 'create' && typeof operation.content !== 'string') return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'unacknowledged' });
    if (operation.operationKind === 'replace' && (typeof operation.content !== 'string' || typeof operation.expectedContent !== 'string' || !operation.expectedHash || hashUtf8(operation.expectedContent) !== operation.expectedHash)) return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'planned', persistence: 'durable', obsidian: 'unacknowledged' });
    const claim = mutationLedger.claim(operation, ownerId);
    if (!claim.granted && claim.reason === 'already_acknowledged') {
      const inspection = inspectInvariant(operation);
      if (inspection.status === 'satisfied' && inspection.invariant === true) return createInternalReceipt({ operation, status: 'already_satisfied', lifecycleState: 'acknowledged', persistence: 'durable', obsidian: 'acknowledged' });
      return createInternalReceipt({ operation, status: inspection.status === 'unavailable' ? 'unavailable' : 'conflict', lifecycleState: 'blocked', persistence: 'durable', obsidian: 'unacknowledged', adapterEvidence: { reason: 'acknowledged_record_invariant_not_current' } });
    }
    if (!claim.granted) return createInternalReceipt({ operation, status: 'blocked', lifecycleState: 'blocked', persistence: 'durable', obsidian: 'unacknowledged', adapterEvidence: { reason: claim.reason } });
    try {
      dispatchStats.retries = 0;
      const deadline = Date.now() + pollTimeoutMs;
      const queued = run(buildObsidianMutationProgram(operation), Math.max(1, deadline - Date.now()));
      if (queued !== null && (queued?.queued !== true || queued.token !== operation.operationId)) throw new Error('invalid queued acknowledgement');
      let result = null;
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        result = run(tokenProgram(operation.operationId), remaining);
        if (result?.status === 'done' || result?.status === 'error') break;
        if (attempt + 1 < maxPollAttempts) sleepSync(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
      }
      if (result?.status === 'done' && result.invariant === true) {
        mutationLedger.transition(operation.operationId, 'acknowledged', { ownerId, fence: claim.fence, evidence: { acknowledgedBy: 'app.vault.read', ...(dispatchStats.retries ? { attempts: dispatchStats.retries + 1 } : {}) } });
        try { run(cleanupProgram(operation.operationId)); } catch { /* acknowledgement is already durable */ }
        return createInternalReceipt({ operation, status: 'committed', persistence: 'durable', obsidian: 'acknowledged' });
      }
      if (result?.status === 'error' || result?.status === 'done') { const failure = failureEvidence(result.errorClass || 'readback_mismatch', result.error); mutationLedger.transition(operation.operationId, 'conflict', { ownerId, fence: claim.fence, evidence: failure }); try { run(cleanupProgram(operation.operationId)); } catch {} return createInternalReceipt({ operation, status: 'failed', lifecycleState: 'conflict', persistence: 'durable', obsidian: 'unacknowledged', adapterEvidence: failure }); }
      mutationLedger.transition(operation.operationId, 'unknown_after_dispatch', { ownerId, fence: claim.fence });
      return createInternalReceipt({ operation, status: 'unknown_after_dispatch', persistence: 'durable', obsidian: 'unacknowledged' });
    } catch (error) {
      if (error.code === 'EVAL_NOT_STAGED') {
        // The mutation program never reached the app; keep it retryable.
        const failure = failureEvidence('eval_not_staged', error);
        mutationLedger.transition(operation.operationId, 'planned', { ownerId, fence: claim.fence, evidence: failure });
        return createInternalReceipt({ operation, status: 'unavailable', lifecycleState: 'planned', persistence: 'durable', obsidian: 'unacknowledged', adapterEvidence: failure });
      }
      const failure = failureEvidence(error.code === 'ENOENT' ? 'cli_missing' : 'dispatch_failed', error);
      mutationLedger.transition(operation.operationId, 'unknown_after_dispatch', { ownerId, fence: claim.fence, evidence: failure });
      return createInternalReceipt({ operation, status: 'unknown_after_dispatch', persistence: 'durable', obsidian: 'unacknowledged', adapterEvidence: failure });
    }
  }
  function submit(input) {
    const record = mutationLedger.planNext(input);
    return execute(record.operation);
  }
  function acknowledgeIfSatisfied(input) {
    const operation = validateOperation(input);
    const inspection = inspectInvariant(operation);
    if (inspection.status !== 'satisfied' || inspection.invariant !== true) return false;
    mutationLedger.ensure(operation);
    const claim = mutationLedger.claim(operation, ownerId, { allowAmbiguousRetry: true });
    if (!claim.granted) return claim.reason === 'already_acknowledged';
    mutationLedger.transition(operation.operationId, 'acknowledged', {
      ownerId,
      fence: claim.fence,
      evidence: { acknowledgedBy: 'app.vault.read' },
    });
    return true;
  }
  let publicAdapter;
  function createReconciler(options = {}) {
    const { createVaultMutationReconciler } = require('./vault-mutation-reconciler');
    return createVaultMutationReconciler({ ...options, adapter: publicAdapter, ledger: mutationLedger, vaultRoot, vaultId, transforms });
  }
  publicAdapter = Object.freeze({ acknowledgeIfSatisfied, capability, createReconciler, execute, inspectFileExists, inspectInvariant, ledger: ledgerView, submit });
  return publicAdapter;
}
module.exports = { CAPABILITY_REASONS, CAPABILITY_STATES, ERROR_MESSAGE_MAX_CHARS, RESULT_STORE, sanitizeErrorMessage, buildObsidianInvariantProgram, buildObsidianMutationProgram, createVaultMutationAdapter, runObsidianEval };
