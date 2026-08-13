'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run: defaultRun } = require('./run');

const BEADS_TRACKER_SCHEMA_VERSION = 'jarvos-coding-live-beads-tracker/v1';
const DEFAULT_BEADS_VERSION = '0.2.19';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 512 * 1024;
const REQUIRED_CAPABILITIES = Object.freeze(['create', 'update', 'dependency', 'checkpoint']);

function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Beads ${field} is required`);
  return value.trim();
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '')); } catch { return null; }
}

function output(result) {
  return String(result?.stdout || result?.stderr || '').trim();
}

function operationIdOf(input = {}, method = 'operation') {
  const explicit = input.operationId || input.idempotencyKey || input.workReference?.operationId || input.workRef?.operationId;
  if (explicit) return requiredString(explicit, `${method} operationId`);
  const itemId = input.itemId || input.workItemId || input.workReference?.itemId || input.workRef?.itemId
    || input.issueIdentifier || input.issue?.identifier || input.workReference?.id || input.workRef?.id;
  if (itemId && method !== 'create') return `${method}:${requiredString(itemId, `${method} work item id`)}`;
  throw new Error(`Beads ${method} operationId is required`);
}

function workIdOf(input = {}, method = 'operation') {
  return requiredString(
    input.itemId || input.workItemId || input.workReference?.itemId || input.workRef?.itemId
      || input.issueIdentifier || input.issue?.identifier || input.workReference?.id || input.workRef?.id,
    `${method} work item id`,
  );
}

function normalizeVersion(value) {
  const match = String(value || '').match(/(?:^|\s|v)(\d+\.\d+\.\d+)(?:\s|$)/i);
  return match ? match[1] : null;
}

function canonicalRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateWorkspace(workspaceRoot, approvedRoots) {
  const workspace = canonicalRoot(workspaceRoot);
  if (!workspace) throw new Error('Beads workspace must be an absolute path');
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('Beads workspace is unavailable');
  const roots = (Array.isArray(approvedRoots) ? approvedRoots : [workspaceRoot]).map(canonicalRoot).filter(Boolean);
  if (!roots.some((root) => isInside(root, workspace))) throw new Error('Beads workspace is not approved');
  return workspace;
}

function commandArgs(method, input, operationId) {
  const format = ['--format', 'json'];
  if (method === 'create') {
    const args = ['create', '--title', requiredString(input.title, 'create title')];
    if (input.description) args.push('--description', String(input.description));
    if (input.priority !== undefined) args.push('--priority', String(input.priority));
    args.push('--external-ref', operationId, ...format);
    return args;
  }
  const itemId = workIdOf(input, method);
  if (method === 'claim') return ['update', itemId, '--status', 'in_progress', '--operation-id', operationId, ...format];
  if (method === 'transition') return ['update', itemId, '--status', requiredString(input.status, 'transition status'), '--operation-id', operationId, ...format];
  if (method === 'dependency') return ['dep', 'add', itemId, requiredString(input.dependsOn || input.dependencyId, 'dependency id'), '--operation-id', operationId, ...format];
  if (method === 'checkpoint') return ['checkpoint', itemId, '--stage', requiredString(input.stage, 'checkpoint stage'), '--next-step', requiredString(input.nextStep, 'checkpoint next step'), '--operation-id', operationId, ...format];
  if (method === 'show') return ['show', itemId, ...format];
  throw new Error(`unsupported Beads operation: ${method}`);
}

function createMemoryOperationStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async read(operationId) { return values.get(operationId) || null; },
    async write(record) { values.set(record.operationId, record); return record; },
  };
}

function createLiveBeadsTracker(options = {}) {
  const run = options.run || defaultRun;
  const executable = options.executable || options.command || 'br';
  const expectedVersion = options.expectedVersion || DEFAULT_BEADS_VERSION;
  const workspaceRoot = validateWorkspace(options.workspaceRoot || process.cwd(), options.approvedRoots);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxBuffer = Number(options.maxBuffer || DEFAULT_MAX_BUFFER);
  const operationStore = options.operationStore || createMemoryOperationStore();
  const actor = options.actor || 'jarvos-coding';
  const commandMap = options.commands || {};
  let preflight = null;

  function invoke(args, extra = {}) {
    return run(executable, args, {
      cwd: workspaceRoot,
      timeoutMs,
      maxBuffer,
      allowFail: true,
      shell: false,
      env: options.env,
      ...extra,
    });
  }

  function mappedArgs(method, input, operationId) {
    if (typeof commandMap[method] === 'function') return commandMap[method](input, operationId);
    return commandArgs(method, input, operationId);
  }

  async function verifyWorkspace() {
    const where = invoke(['where'], { timeoutMs: Math.min(timeoutMs, 10_000) });
    const resolved = canonicalRoot(output(where));
    if (where.status !== 0 || !resolved || resolved !== workspaceRoot) {
      throw new Error('Beads workspace verification failed');
    }
    return resolved;
  }

  async function ensureReady() {
    if (!preflight) {
      const versionResult = invoke(['--version']);
      const version = normalizeVersion(output(versionResult));
      if (versionResult.status !== 0 || version !== expectedVersion) throw new Error('Beads version is unsupported');
      const capabilitiesResult = invoke(['capabilities', '--format', 'json']);
      const schemaResult = invoke(['schema', 'all', '--format', 'json']);
      const capabilities = parseJson(capabilitiesResult.stdout);
      const schema = parseJson(schemaResult.stdout);
      if (capabilitiesResult.status !== 0 || schemaResult.status !== 0 || !plain(capabilities) || !plain(schema)) {
        throw new Error('Beads capability negotiation failed');
      }
      const advertised = new Set(Array.isArray(capabilities.capabilities) ? capabilities.capabilities : Object.keys(capabilities));
      const missing = REQUIRED_CAPABILITIES.filter((capability) => !advertised.has(capability));
      if (missing.length && options.requireCapabilities !== false) throw new Error('Beads capability negotiation failed');
      preflight = { version, capabilities, schema, missing };
    }
    await verifyWorkspace();
    return preflight;
  }

  async function reconcile(operation) {
    if (typeof options.reconcile === 'function') return options.reconcile(operation);
    const result = invoke(['show', '--external-ref', operation.operationId, '--format', 'json']);
    if (result.status === 0) {
      const found = parseJson(result.stdout);
      if (found) return { state: 'committed', result: found };
    }
    if (result.status !== 0 && /not found|no matching/i.test(output(result))) return { state: 'not-committed' };
    return { state: 'indeterminate' };
  }

  async function mutate(method, input = {}) {
    const operationId = operationIdOf(input, method);
    const fingerprint = JSON.stringify({ method, input: { ...input, operationId: undefined, idempotencyKey: undefined } });
    const existing = await operationStore.read(operationId);
    if (existing && existing.fingerprint !== fingerprint) throw new Error('Beads operation identity conflict');
    if (existing?.state === 'committed' || existing?.state === 'failed') return existing;
    if (existing?.state === 'indeterminate') {
      const resolved = await reconcile(existing);
      if (resolved.state === 'committed' || resolved.state === 'not-committed') {
        const record = { ...existing, state: resolved.state, result: resolved.result || null, reconciled: true };
        await operationStore.write(record);
        if (resolved.state === 'committed') return record;
      } else return { ...existing, status: 'indeterminate', retryable: false };
    }
    await ensureReady();
    const prepared = { schemaVersion: BEADS_TRACKER_SCHEMA_VERSION, operationId, method, fingerprint, state: 'prepared', actor, workspaceRoot };
    await operationStore.write(prepared);
    let result;
    try {
      result = invoke(mappedArgs(method, input, operationId));
    } catch (error) {
      const indeterminate = { ...prepared, state: 'indeterminate', status: 'indeterminate', retryable: false, errorCode: 'EXECUTION_UNCERTAIN' };
      await operationStore.write(indeterminate);
      return indeterminate;
    }
    if (result.status !== 0) {
      const failed = { ...prepared, state: 'failed', status: 'failed', retryable: false, errorCode: 'COMMAND_FAILED' };
      await operationStore.write(failed);
      return failed;
    }
    const committed = { ...prepared, state: 'committed', status: 'committed', retryable: false, result: parseJson(result.stdout) || { output: output(result) } };
    await operationStore.write(committed);
    return committed;
  }

  return {
    schemaVersion: BEADS_TRACKER_SCHEMA_VERSION,
    authority: 'beads',
    workspaceRoot,
    async preflight() { return ensureReady(); },
    async createWorkItem(input = {}) { return mutate('create', input); },
    async claimIssue(input = {}) {
      const operationId = operationIdOf(input, 'claim');
      const result = await mutate('claim', { ...input, operationId });
      return { ...result, status: result.state === 'committed' ? 'claimed' : result.status || result.state, ok: result.state === 'committed', workReference: { authority: 'beads', itemId: workIdOf(input, 'claim'), operationId } };
    },
    async transition(input = {}) { return mutate('transition', input); },
    async addDependency(input = {}) { return mutate('dependency', input); },
    async writeCheckpoint(input = {}) { return mutate('checkpoint', input); },
    async verifyAndClose(input = {}) {
      const pullRequest = input.pullRequest || {};
      const merged = input.merged === true || pullRequest.merged === true || String(pullRequest.state || pullRequest.status || '').toLowerCase() === 'merged';
      if (!merged) return { schemaVersion: BEADS_TRACKER_SCHEMA_VERSION, status: 'deferred', reason: 'pull request not merged', ok: true };
      const operationId = operationIdOf(input, 'close');
      const result = await mutate('transition', { ...input, status: 'done', operationId });
      return { ...result, status: result.state === 'committed' ? 'closed' : result.status || result.state, ok: result.state === 'committed' };
    },
    async reconcile(operation) { return reconcile(operation); },
  };
}

module.exports = {
  BEADS_TRACKER_SCHEMA_VERSION,
  DEFAULT_BEADS_VERSION,
  REQUIRED_CAPABILITIES,
  createLiveBeadsTracker,
  createMemoryOperationStore,
};
