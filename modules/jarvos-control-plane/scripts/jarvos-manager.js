#!/usr/bin/env node
'use strict';

// The manager is deliberately a small application boundary, not a second
// scheduler or tracker.  Both the human CLI and agent MCP call this module so
// their authorization and lifecycle semantics cannot drift.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TERMINAL = new Set(['rejected', 'cancelled', 'satisfied', 'failed', 'unverifiable']);
const MUTATIONS = new Set(['request', 'approve', 'reject', 'pause', 'resume', 'cancel']);

function statePath(options = {}) {
  return path.resolve(options.statePath || process.env.JARVOS_CONTROL_PLANE_STATE_PATH
    || path.join(os.homedir(), '.jarvos', 'control-plane-state.json'));
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.requests)) throw new Error('invalid state schema');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, paused: false, requests: [], evidence: [] };
    throw new Error(`control-plane state is unreadable: ${error.message}`);
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function now() { return new Date().toISOString(); }
function redactRequest(request) {
  // Service options configure this in-process boundary; they are never part of
  // the public request envelope and must not be persisted or returned.
  const { authToken, token, service, ...safe } = request || {};
  return safe;
}

function authorized(provided, expected) {
  if (!expected || !provided) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createControlPlaneService(options = {}) {
  const file = statePath(options);
  const token = options.token || process.env.JARVOS_CONTROL_PLANE_TOKEN;
  const requireAuth = options.requireAuth !== false;

  function authenticate(input = {}) {
    if (!requireAuth) return;
    if (!authorized(input.authToken || input.token, token)) {
      const error = new Error('control-plane authentication failed');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
  }
  function load() { return readState(file); }
  function save(state) { writeState(file, state); }
  function getRequest(state, requestId) {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error(`request not found: ${requestId}`);
    return request;
  }
  function addEvidence(state, requestId, outcome, detail) {
    const evidence = { id: id('evidence'), requestId, outcome, detail: detail || null, observedAt: now() };
    state.evidence.push(evidence);
    return evidence;
  }
  function explainPolicy(input = {}) {
    const mutationClass = input.mutationClass || input.request?.mutationClass;
    if (!mutationClass) throw new Error('mutationClass is required');
    return {
      outcome: input.requireApproval === false ? 'allow' : 'require_approval',
      reason: input.requireApproval === false ? 'Explicit non-mutating policy override.' : 'Mutations require explicit approval before dispatch.',
      mutationClass,
      paused: load().paused,
    };
  }
  function request(input = {}) {
    const safe = redactRequest(input);
    for (const key of ['principal', 'actor', 'resource', 'mutationClass', 'desiredGeneration', 'commandSpec']) {
      if (!safe[key]) throw new Error(`${key} is required`);
    }
    const policy = explainPolicy(safe);
    const draft = { id: id('request'), ...safe, policy, status: policy.outcome === 'allow' ? 'approved' : 'approval_required', createdAt: now(), updatedAt: now() };
    if (safe.dryRun) return { ok: true, dryRun: true, request: draft, policy };
    const state = load();
    if (state.paused) throw new Error('control plane is paused');
    const conflict = state.requests.find((item) => !TERMINAL.has(item.status) && item.resource?.machineId === safe.resource.machineId && item.resource?.type === safe.resource.type && item.resource?.id === safe.resource.id && item.mutationClass === safe.mutationClass);
    if (conflict) return { ok: false, status: 'conflict', conflict: { requestId: conflict.id, status: conflict.status, reason: 'an active request owns this resource and mutation class' } };
    state.requests.push(draft);
    addEvidence(state, draft.id, draft.status, 'request accepted by shared application service');
    save(state);
    return { ok: true, request: draft, policy };
  }
  function execute(operation, input = {}) {
    authenticate(input);
    const clean = redactRequest(input);
    if (operation === 'list') return { ok: true, requests: load().requests };
    if (operation === 'inspect') { const state = load(); return { ok: true, request: getRequest(state, clean.requestId), evidence: state.evidence.filter((item) => item.requestId === clean.requestId) }; }
    if (operation === 'explain-policy') return { ok: true, policy: explainPolicy(clean) };
    if (operation === 'dry-run') return request({ ...clean, dryRun: true });
    if (operation === 'request') return request(clean);
    if (operation === 'approval-state') { const state = load(); const item = getRequest(state, clean.requestId); return { ok: true, requestId: item.id, status: item.status, policy: item.policy }; }
    if (operation === 'conflict-detail') { const state = load(); const item = getRequest(state, clean.requestId); const conflicts = state.requests.filter((candidate) => candidate.id !== item.id && !TERMINAL.has(candidate.status) && candidate.resource?.machineId === item.resource?.machineId && candidate.resource?.type === item.resource?.type && candidate.resource?.id === item.resource?.id && candidate.mutationClass === item.mutationClass); return { ok: true, request: item, conflicts }; }
    if (operation === 'evidence') { const state = load(); return { ok: true, evidence: state.evidence.filter((item) => item.requestId === clean.requestId) }; }
    if (!MUTATIONS.has(operation)) throw new Error(`unknown operation: ${operation}`);
    const state = load();
    if (operation === 'pause' || operation === 'resume') {
      state.paused = operation === 'pause'; save(state); return { ok: true, paused: state.paused };
    }
    const item = getRequest(state, clean.requestId);
    if (TERMINAL.has(item.status)) throw new Error(`cannot ${operation} terminal request: ${item.status}`);
    if (operation === 'approve') {
      if (item.status !== 'approval_required') throw new Error(`request is not awaiting approval: ${item.status}`);
      item.status = 'approved';
    } else if (operation === 'reject') item.status = 'rejected';
    else if (operation === 'cancel') item.status = 'cancelled';
    item.updatedAt = now();
    const evidence = addEvidence(state, item.id, item.status, `${operation} by authenticated principal`);
    save(state);
    return { ok: true, request: item, evidence };
  }
  return { execute, file };
}

function parseCli(argv) {
  const [operation = 'help', ...rest] = argv;
  const input = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    input[name] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return { operation, input };
}
function usage() { return 'Usage: jarvos-manager <list|inspect|explain-policy|dry-run|request|approval-state|approve|reject|pause|resume|cancel|conflict-detail|evidence> --auth-token <token> [--request-id <id>] [--input <json>]'; }
function main() {
  const { operation, input } = parseCli(process.argv.slice(2));
  if (operation === 'help' || input.help) { process.stdout.write(`${usage()}\n`); return; }
  if (input.input) Object.assign(input, JSON.parse(input.input));
  const result = createControlPlaneService().execute(operation, input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }

module.exports = { createControlPlaneService, statePath };
