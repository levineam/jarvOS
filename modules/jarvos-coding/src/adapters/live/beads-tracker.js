'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run: defaultRun } = require('./run');
const { createFileOperationStore } = require('./file-operation-store');

const BEADS_TRACKER_SCHEMA_VERSION = 'jarvos-coding-live-beads-tracker/v1';
const DEFAULT_BEADS_VERSION = '0.2.19';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 512 * 1024;
const REQUIRED_CAPABILITIES = Object.freeze(['create', 'update', 'dependency', 'checkpoint']);
const CREATE_RECONCILE_LIMIT = 1001;

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function operationInputOf(input = {}) {
  const copy = { ...input };
  delete copy.operationId;
  delete copy.idempotencyKey;
  if (copy.workReference && plain(copy.workReference)) {
    copy.workReference = { ...copy.workReference };
    delete copy.workReference.operationId;
  }
  if (copy.workRef && plain(copy.workRef)) {
    copy.workRef = { ...copy.workRef };
    delete copy.workRef.operationId;
  }
  return canonicalize(copy);
}

function operationFingerprint(method, input) {
  return JSON.stringify({ method, input: operationInputOf(input) });
}

function operationExpectation(method, input = {}) {
  if (method === 'create') return { externalReference: String(input.externalReference || operationIdOf(input, method)) };
  const itemId = workIdOf(input, method);
  if (method === 'claim') return { itemId, status: 'in_progress' };
  if (method === 'transition') {
    const requested = requiredString(input.status, 'transition status').toLowerCase();
    return { itemId, status: ['done', 'closed'].includes(requested) ? 'closed' : requested };
  }
  if (method === 'dependency') return { itemId, dependencyId: requiredString(input.dependsOn || input.dependencyId, 'dependency id') };
  if (method === 'checkpoint') {
    const stage = requiredString(input.stage, 'checkpoint stage');
    const nextStep = requiredString(input.nextStep, 'checkpoint next step');
    return { itemId, stage, nextStep, marker: checkpointMarker(operationIdOf(input, method), stage, nextStep) };
  }
  return { itemId };
}

function operationIdOf(input = {}, method = 'operation') {
  const explicit = input.operationId || input.idempotencyKey || input.workReference?.operationId || input.workRef?.operationId;
  if (explicit) return requiredString(explicit, `${method} operationId`);
  const itemId = input.itemId || input.workItemId || input.workReference?.itemId || input.workRef?.itemId
    || input.issueIdentifier || input.issue?.identifier || input.workReference?.id || input.workRef?.id;
  if (itemId && method !== 'create') {
    const canonical = JSON.stringify(operationInputOf(input));
    const digest = crypto.createHash('sha256').update(`${method}:${canonical}`).digest('hex').slice(0, 16);
    return `${method}:${requiredString(itemId, `${method} work item id`)}:${digest}`;
  }
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

function checkpointMarker(operationId, stage, nextStep) {
  return `[jarvos-checkpoint/v1] ${JSON.stringify({ operationId, stage, nextStep })}`;
}

function commandArgs(method, input, operationId) {
  if (method === 'create') {
    const args = ['create', '--title', requiredString(input.title, 'create title')];
    if (input.description) args.push('--description', String(input.description));
    if (input.priority !== undefined) args.push('--priority', String(input.priority));
    args.push('--external-ref', String(input.externalReference || operationId), '--json');
    return args;
  }
  const itemId = workIdOf(input, method);
  if (method === 'claim') return ['update', itemId, '--claim', '--json'];
  if (method === 'transition') {
    const status = requiredString(input.status, 'transition status').toLowerCase();
    if (['done', 'closed'].includes(status)) return ['close', itemId, '--reason', 'Completed by jarvOS work action', '--json'];
    if (status === 'open') return ['reopen', itemId, '--reason', 'Reopened by jarvOS work action', '--json'];
    return ['update', itemId, '--status', status, '--json'];
  }
  if (method === 'dependency') return ['dep', 'add', itemId, requiredString(input.dependsOn || input.dependencyId, 'dependency id'), '--json'];
  if (method === 'checkpoint') {
    const stage = requiredString(input.stage, 'checkpoint stage');
    const nextStep = requiredString(input.nextStep, 'checkpoint next step');
    return ['comments', 'add', itemId, '--message', checkpointMarker(operationId, stage, nextStep), '--json'];
  }
  if (method === 'show') return ['show', itemId, '--format', 'json'];
  throw new Error(`unsupported Beads operation: ${method}`);
}

function normalizedItem(value) {
  const candidate = Array.isArray(value) && value.length === 1
    ? value[0]
    : (plain(value?.item)
      ? value.item
      : (Array.isArray(value?.reopened) && value.reopened.length === 1 ? value.reopened[0] : value));
  if (!plain(candidate)) return candidate;
  return {
    ...candidate,
    ...(candidate.updatedAt || candidate.updated_at ? { updatedAt: candidate.updatedAt || candidate.updated_at } : {}),
    ...(candidate.externalRef || candidate.external_ref ? { externalRef: candidate.externalRef || candidate.external_ref } : {}),
  };
}

function hasItemRevision(value) {
  return plain(value) && Boolean(value.revision || value.version || value.updatedAt || value.updated_at);
}

function advertisedCapabilities(capabilities) {
  if (Array.isArray(capabilities.capabilities)) return new Set(capabilities.capabilities);
  const commands = new Set(Array.isArray(capabilities.commands)
    ? capabilities.commands.map((command) => plain(command) ? command.name : command).filter((name) => typeof name === 'string')
    : []);
  const advertised = new Set();
  if (commands.has('create')) advertised.add('create');
  if (['update', 'show', 'close', 'reopen'].every((command) => commands.has(command))) advertised.add('update');
  if (commands.has('dep')) advertised.add('dependency');
  if (commands.has('comments')) advertised.add('checkpoint');
  return advertised;
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
  // A host-selected state root upgrades the exact same operation contract to
  // durable storage.  No caller path is accepted by the action facade.
  const live = options.mode === 'live';
  const operationStore = options.operationStore || (options.operationStoreRoot
    ? createFileOperationStore({ root: options.operationStoreRoot, maxRecords: options.maxOperationRecords })
    : createMemoryOperationStore());
  if (live && (operationStore?.schemaVersion !== 'jarvos-coding-operation-store/v1'
    || operationStore?.storage !== 'file' || typeof operationStore?.root !== 'string')) {
    throw new Error('live Beads tracker requires a durable tracker operation ledger');
  }
  const actor = options.actor || 'jarvos-coding';
  const commandMap = options.commands || {};
  let preflight = null;
  const operationLocks = new Map();

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
    const reported = output(where).split(/\r?\n/, 1)[0];
    const resolved = canonicalRoot(reported);
    const beadsDirectory = canonicalRoot(path.join(workspaceRoot, '.beads'));
    const expected = beadsDirectory && fs.existsSync(beadsDirectory) ? beadsDirectory : workspaceRoot;
    if (where.status !== 0 || !resolved || resolved !== expected) {
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
      const advertised = advertisedCapabilities(capabilities);
      const missing = REQUIRED_CAPABILITIES.filter((capability) => !advertised.has(capability));
      if (missing.length && options.requireCapabilities !== false) throw new Error('Beads capability negotiation failed');
      preflight = { version, capabilities, schema, missing };
    }
    await verifyWorkspace();
    return preflight;
  }

  async function reconcile(operation) {
    if (typeof options.reconcile === 'function') return options.reconcile(operation);
    const expectation = operation.expectation || {};
    const args = operation.method === 'create'
      ? ['list', '--all', '--limit', String(CREATE_RECONCILE_LIMIT), '--format', 'json']
      : ['show', expectation.itemId, '--format', 'json'];
    const result = invoke(args);
    if (result.status === 0) {
      const parsed = parseJson(result.stdout);
      if (operation.method === 'create') {
        const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.issues) ? parsed.issues : null);
        if (!rows) return { state: 'indeterminate' };
        const matches = rows.filter((row) => matchesExpectation('create', row, expectation));
        if (matches.length === 1) return { state: 'committed', result: normalizedItem(matches[0]) };
        if (matches.length > 1 || rows.length >= CREATE_RECONCILE_LIMIT) return { state: 'indeterminate' };
        return { state: 'not-committed' };
      }
      const found = normalizedItem(parsed);
      if (found && matchesExpectation(operation.method, found, expectation)) return { state: 'committed', result: found };
      if (found) return { state: 'indeterminate', result: found };
    }
    if (result.status !== 0 && /not found|no matching/i.test(output(result))) return { state: 'not-committed' };
    return { state: 'indeterminate' };
  }

  function matchesExpectation(method, value, expectation) {
    if (method === 'create') {
      const found = normalizedItem(value);
      if (!plain(found)) return false;
      const externalReference = found.external_ref || found.externalRef || found.externalReference || found.external_reference;
      return typeof externalReference === 'string' && externalReference === expectation.externalReference;
    }
    const found = normalizedItem(value);
    if (!plain(found)) return false;
    if (method === 'claim' || method === 'transition') {
      return String(found.status || found.state || '').toLowerCase() === String(expectation.status).toLowerCase();
    }
    if (method === 'dependency') {
      const dependencies = Array.isArray(found.dependencies) ? found.dependencies : [];
      return dependencies.some((dependency) => String(plain(dependency)
        ? (dependency.id || dependency.identifier || dependency.itemId || dependency.dependsOn || dependency.dependencyId)
        : dependency) === expectation.dependencyId);
    }
    if (method === 'checkpoint') {
      const checkpoints = [
        ...(Array.isArray(found.checkpoints) ? found.checkpoints : []),
        ...(Array.isArray(found.history) ? found.history : []),
        ...(Array.isArray(found.events) ? found.events : []),
        ...(Array.isArray(found.comments) ? found.comments : []),
      ];
      return checkpoints.some((checkpoint) => plain(checkpoint)
        && (String(checkpoint.text || checkpoint.message || '') === expectation.marker
          || (String(checkpoint.stage || '') === expectation.stage
            && String(checkpoint.nextStep || checkpoint.next_step || '') === expectation.nextStep)));
    }
    return false;
  }

  async function mutateUnlocked(method, input = {}) {
    const operationId = operationIdOf(input, method);
    const fingerprint = operationFingerprint(method, input);
    const expectation = operationExpectation(method, input);
    const existing = await operationStore.read(operationId);
    if (existing && existing.fingerprint !== fingerprint) throw new Error('Beads operation identity conflict');
    if (existing?.state === 'committed' || existing?.state === 'failed') return existing;
    if (existing?.state === 'indeterminate' || existing?.state === 'prepared') {
      const resolved = await reconcile(existing);
      if (resolved.state === 'committed' || resolved.state === 'not-committed') {
        const record = { ...existing, state: resolved.state, result: resolved.result || null, reconciled: true };
        await operationStore.write(record);
        if (resolved.state === 'committed') return record;
      } else return { ...existing, status: 'indeterminate', retryable: false };
    }
    await ensureReady();
    // Build and validate argv before persisting the prepared record. Caller
    // input errors are not uncertain I/O and must not poison an idempotency
    // key with an execution-uncertain state.
    const args = mappedArgs(method, input, operationId);
    const prepared = { schemaVersion: BEADS_TRACKER_SCHEMA_VERSION, operationId, method, fingerprint, expectation, state: 'prepared', actor, workspaceRoot };
    await operationStore.write(prepared);
    let result;
    try {
      result = invoke(args);
    } catch (error) {
      const indeterminate = { ...prepared, state: 'indeterminate', status: 'indeterminate', retryable: false, errorCode: 'EXECUTION_UNCERTAIN' };
      await operationStore.write(indeterminate);
      return indeterminate;
    }
    if (result.error || result.status === null || /timed out|timeout|uncertain/i.test(output(result))) {
      const indeterminate = { ...prepared, state: 'indeterminate', status: 'indeterminate', retryable: false, errorCode: 'EXECUTION_UNCERTAIN' };
      await operationStore.write(indeterminate);
      return indeterminate;
    }
    if (result.status !== 0) {
      const failed = { ...prepared, state: 'failed', status: 'failed', retryable: false, errorCode: 'COMMAND_FAILED' };
      await operationStore.write(failed);
      return failed;
    }
    const parsedOutput = parseJson(result.stdout);
    let parsed = ['create', 'claim', 'transition'].includes(method) ? normalizedItem(parsedOutput) : parsedOutput;
    if (['claim', 'transition'].includes(method) && !hasItemRevision(parsed)) {
      const observed = invoke(['show', expectation.itemId, '--format', 'json']);
      parsed = observed.status === 0 ? normalizedItem(parseJson(observed.stdout)) : null;
      if (!hasItemRevision(parsed) || !matchesExpectation(method, parsed, expectation)) {
        const indeterminate = { ...prepared, state: 'indeterminate', status: 'indeterminate', retryable: false, errorCode: 'POSTCONDITION_UNCONFIRMED' };
        await operationStore.write(indeterminate);
        return indeterminate;
      }
    }
    // A create is only committed when the returned Beads item carries the
    // operation identity we will use to reconcile a timeout after I/O.  A
    // syntactically valid but unrelated JSON response must remain explicit
    // uncertainty rather than being linked to the wrong canonical work.
    if (method === 'create' && !matchesExpectation(method, parsed, expectation)) {
      const indeterminate = { ...prepared, state: 'indeterminate', status: 'indeterminate', retryable: false, errorCode: 'CREATE_REFERENCE_UNCONFIRMED' };
      await operationStore.write(indeterminate);
      return indeterminate;
    }
    const committed = { ...prepared, state: 'committed', status: 'committed', retryable: false, result: parsed || { output: output(result) } };
    await operationStore.write(committed);
    return committed;
  }

  async function mutate(method, input = {}) {
    const operationId = operationIdOf(input, method);
    const previous = operationLocks.get(operationId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    operationLocks.set(operationId, tail);
    try {
      await previous;
      return await mutateUnlocked(method, input);
    } finally {
      release();
      if (operationLocks.get(operationId) === tail) operationLocks.delete(operationId);
    }
  }

  return {
    schemaVersion: BEADS_TRACKER_SCHEMA_VERSION,
    authority: 'beads',
    workspaceRoot,
    operationStoreRoot: operationStore.root || null,
    operationStoreContract: operationStore.schemaVersion || null,
    operationStoreStorage: operationStore.storage || null,
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
    async showWorkItem(input = {}) {
      const itemId = workIdOf(input, 'show');
      await ensureReady();
      const result = invoke(mappedArgs('show', input, operationIdOf({ ...input, operationId: input.operationId || `show:${itemId}` }, 'show')));
      if (result.status !== 0) return { state: 'unavailable', status: 'unavailable', errorCode: 'READ_FAILED' };
      return { state: 'committed', status: 'available', result: normalizedItem(parseJson(result.stdout)) || null };
    },
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
