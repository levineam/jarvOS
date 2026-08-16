'use strict';

const crypto = require('node:crypto');

const WORK_ACTION_CONTRACT = 'jarvos.work-action/v1';

function text(value, field) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`); return value.trim(); }
function itemFrom(result, fallback) { const item = result?.result?.item || result?.result || {}; return { itemId: text(item.id || item.identifier || fallback, 'Beads item id'), revision: String(item.revision || item.version || item.updatedAt || 'unknown'), status: String(item.status || item.state || 'open') }; }
function canonicalOf(value) {
  if (!value || typeof value !== 'object' || !['project', 'outcome'].includes(value.kind) || !/^(prj|out)_\d{6,}$/.test(value.id) || !Number.isInteger(value.revision) || value.revision < 1) throw new TypeError('exact canonical reference is required');
  return { contract: 'jarvos.canonical-reference/v1', kind: value.kind, id: value.id, revision: value.revision, breadcrumb: text(value.breadcrumb, 'canonical breadcrumb') };
}
function requireAndrew(actor) { if (actor?.kind !== 'human' || String(actor.id || '').toLowerCase() !== 'andrew') throw new Error('human-attested completion requires Andrew'); }
function sameCanonical(left, right) {
  return left?.kind === right?.kind
    && left?.id === right?.id
    && Number(left?.revision) === Number(right?.revision)
    && left?.breadcrumb === right?.breadcrumb;
}
function createMemoryExecutionLinkStore() {
  const links = new Map();
  return {
    async read(workspaceId, itemId) {
      const key = itemId === undefined ? workspaceId : `${workspaceId}:${itemId}`;
      return links.get(key) || null;
    },
    async write(link, expectedItemRevision = null) {
      const key = `${link.workspaceId}:${link.itemId}`;
      const prior = links.get(key);
      if (prior && (prior.canonical.id !== link.canonical.id || prior.canonical.revision !== link.canonical.revision)) {
        throw new Error('execution link canonical conflict');
      }
      if (expectedItemRevision !== null && (!prior || prior.itemRevision !== String(expectedItemRevision))) {
        throw new Error('execution link compare-and-swap conflict');
      }
      links.set(key, link);
      return link;
    },
    async list() { return [...links.values()]; },
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function actionFingerprint(action, input) {
  const copy = { ...input };
  delete copy.operationId;
  delete copy.idempotencyKey;
  return crypto.createHash('sha256').update(JSON.stringify(stable({ action, input: copy }))).digest('hex');
}

function metadataResult(result) {
  return {
    contract: WORK_ACTION_CONTRACT,
    ok: result?.ok === true,
    status: result?.status || result?.state || 'unavailable',
    operationId: result?.operationId || null,
    workReference: result?.workReference || null,
    executionLink: result?.executionLink || null,
  };
}

function workspaceIdentity(value) {
  const raw = text(value, 'workspace identity');
  if (raw.includes('/') || raw.includes('\\') || raw.includes('\0')) throw new TypeError('workspace identity must be opaque');
  return raw;
}

function createBeadsWorkActionService(options = {}) {
  const tracker = options.tracker;
  if (!tracker || typeof tracker.createWorkItem !== 'function') throw new TypeError('Beads tracker is required');
  const links = options.executionLinks || createMemoryExecutionLinkStore();
  const operationStore = options.operationStore || null;
  const derivedWorkspaceId = `ws_${crypto.createHash('sha256').update(String(tracker.workspaceRoot || '')).digest('hex').slice(0, 24)}`;
  const workspaceId = workspaceIdentity(options.workspaceId || derivedWorkspaceId);
  const approved = new Set(options.approvedWorkspaceIds || [workspaceId]);
  if (!approved.has(workspaceId) && !approved.has(tracker.workspaceRoot)) throw new Error('Beads workspace is not approved');
  // This callback is deliberately captured when the host constructs the service.
  // Tool arguments never supply a capability, approval, or coding-run fence.
  const authorizeMutation = options.authorizeMutation;
  const resolveEvidenceReceipt = options.resolveEvidenceReceipt;
  const resolveCompletionReceipt = options.resolveCompletionReceipt;
  const registeredEvidenceProducers = new Set(options.registeredEvidenceProducers || []);
  const requireMutationAuthorization = async (action, input, canonical) => {
    if (typeof authorizeMutation !== 'function') throw new Error('host mutation authorization is required');
    const receipt = await authorizeMutation({
      action,
      workspaceId,
      operationId: input.operationId,
      itemId: input.itemId || null,
      canonical,
    });
    if (!receipt || receipt.contract !== 'jarvos.work-action-authorization/v1' || receipt.authorized !== true) throw new Error('host mutation authorization is required');
    if (!['approval', 'coding-run'].includes(receipt.authority)) throw new Error('host mutation authorization is invalid');
    if (receipt.workspaceId !== workspaceId || receipt.operationId !== input.operationId) throw new Error('host mutation authorization is not bound to this operation');
    if (receipt.itemId !== (input.itemId || null) || !sameCanonical(receipt.canonical, canonical)) throw new Error('host mutation authorization is not bound to this work item');
    const actions = Array.isArray(receipt.actions) ? receipt.actions : [];
    if (!actions.includes(action)) throw new Error('host mutation authorization does not permit this action');
    if (receipt.authority === 'coding-run' && (!Number.isInteger(receipt.fence) || receipt.fence < 1)) throw new Error('bound coding-run fence is required');
  };
  const validateVerifiedReceipt = (receipt, input, current) => {
    if (!receipt || receipt.contract !== 'jarvos.work-action-evidence-receipt/v1' || receipt.immutable !== true) throw new Error('host evidence receipt is required');
    if (!['execution-verified', 'domain-verified'].includes(receipt.kind)) throw new Error('host evidence receipt is invalid');
    if (receipt.operationId !== input.operationId || receipt.itemId !== input.itemId || !sameCanonical(receipt.canonical, current.canonical)) throw new Error('host evidence receipt is not bound to this work item');
    if (typeof receipt.producer !== 'string' || !registeredEvidenceProducers.has(receipt.producer)) throw new Error('host evidence receipt producer is not registered');
  };
  const validateCompletionEvidence = async (input, current) => {
    if (input.evidence?.kind === 'human-attested') {
      requireAndrew(input.actor);
      return;
    }
    const receiptId = text(input.evidenceReceiptId, 'host evidence receipt id');
    if (typeof resolveEvidenceReceipt !== 'function') throw new Error('host evidence receipt is required');
    const receipt = await resolveEvidenceReceipt(receiptId);
    validateVerifiedReceipt(receipt, input, current);
  };
  const references = new Map();
  const readLink = async (itemId) => {
    if (typeof links.read !== 'function') return null;
    const byTuple = await links.read(workspaceId, itemId);
    return byTuple || (await links.read(`${workspaceId}:${itemId}`)) || null;
  };
  const link = async (item, canonical) => {
    const prior = await readLink(item.itemId);
    if (prior && (prior.canonical.id !== canonical.id || prior.canonical.revision !== canonical.revision)) throw new Error('execution link conflict');
    const reference = { contract: 'jarvos.execution-reference/v1', authority: 'beads', provider: 'beads', workspaceId, itemId: item.itemId, itemRevision: item.revision, status: item.status, canonical, capturedAt: new Date().toISOString(), sourceRevision: String(item.sourceRevision || item.revision) };
    const result = await links.write(reference, prior?.itemRevision || null);
    references.set(item.itemId, result);
    return result;
  };
  const replay = async (action, input) => {
    const operationId = text(input.operationId, 'operationId');
    if (!operationStore) return null;
    const fingerprint = actionFingerprint(action, input);
    const existing = await operationStore.read(operationId);
    if (!existing) return { operationId, fingerprint, state: 'new' };
    if (existing.fingerprint !== fingerprint) throw new Error('work-action operation identity conflict');
    if (existing.state === 'committed') return existing.result || metadataResult(existing);
    if (existing.state === 'indeterminate') return { contract: WORK_ACTION_CONTRACT, ok: false, status: 'indeterminate', operationId, retryable: false };
    return existing;
  };
  const record = async (action, input, result, state = 'committed') => {
    if (!operationStore) return result;
    await operationStore.write({ operationId: input.operationId, fingerprint: actionFingerprint(action, input), action, state, result: metadataResult(result) });
    return result;
  };
  const mutate = async (action, method, input, status, preflight = null) => {
    text(input.operationId, 'operationId');
    const itemId = text(input.itemId, 'itemId');
    const current = references.get(itemId) || await readLink(itemId);
    if (!current) throw new Error('exact canonical execution link is required');
    if (input.expectedRevision !== undefined && String(input.expectedRevision) !== String(current.itemRevision)) throw new Error('stale expected work-item revision');
    await requireMutationAuthorization(action, input, current.canonical);
    if (preflight) await preflight(current);
    const prior = await replay(action, input);
    if (prior && prior.state !== 'new') return prior;
    const result = method === 'claim' ? await tracker.claimIssue({ ...input, itemId }) : await tracker.transition({ ...input, itemId, status });
    if (result.state === 'indeterminate') return record(action, input, { contract: WORK_ACTION_CONTRACT, ok: false, status: 'indeterminate', operationId: input.operationId, retryable: false }, 'indeterminate');
    const item = itemFrom(result, itemId); const executionLink = await link(item, current.canonical);
    return record(action, input, { contract: WORK_ACTION_CONTRACT, ok: result.state === 'committed', status: item.status, operationId: input.operationId, workReference: { authority: 'beads', itemId, revision: item.revision }, executionLink });
  };
  return {
    contract: WORK_ACTION_CONTRACT, authority: 'beads',
    async create(input = {}) {
      const canonical = canonicalOf(input.canonical); text(input.operationId, 'operationId');
      await requireMutationAuthorization('create', input, canonical);
      const prior = await replay('create', input); if (prior && prior.state !== 'new') return prior;
      const result = await tracker.createWorkItem(input);
      if (result.state === 'indeterminate') return record('create', input, { contract: WORK_ACTION_CONTRACT, ok: false, status: 'indeterminate', operationId: input.operationId, retryable: false }, 'indeterminate');
      const item = itemFrom(result); const executionLink = await link(item, canonical);
      return record('create', input, { contract: WORK_ACTION_CONTRACT, ok: result.state === 'committed', status: item.status, operationId: input.operationId, workReference: { authority: 'beads', itemId: item.itemId, revision: item.revision }, executionLink });
    },
    async claim(input = {}) { return mutate('claim', 'claim', input, 'in_progress'); },
    async transition(input = {}) { return mutate('transition', 'transition', input, text(input.status, 'transition status')); },
    async completeWithEvidence(input = {}) { return mutate('complete', 'transition', input, 'done', (current) => validateCompletionEvidence(input, current)); },
    async completeFromHost(input = {}) {
      return mutate('complete', 'transition', input, 'done', async (current) => {
        if (typeof resolveCompletionReceipt !== 'function') throw new Error('host completion receipt is required');
        const receipt = await resolveCompletionReceipt({ operationId: input.operationId, itemId: input.itemId, workspaceId });
        validateVerifiedReceipt(receipt, input, current);
      });
    },
    async reopen(input = {}) { return mutate('reopen', 'transition', input, 'open'); },
    async show(input = {}) {
      const itemId = text(input.itemId, 'itemId');
      const linkRecord = references.get(itemId) || await readLink(itemId);
      if (!linkRecord) return { contract: WORK_ACTION_CONTRACT, ok: false, status: 'unavailable' };
      if (typeof tracker.showWorkItem !== 'function') return { contract: WORK_ACTION_CONTRACT, ok: true, status: linkRecord.status, workReference: { authority: 'beads', itemId, revision: linkRecord.itemRevision }, executionLink: linkRecord };
      const observed = await tracker.showWorkItem({ itemId });
      if (observed.state !== 'committed') return { contract: WORK_ACTION_CONTRACT, ok: false, status: 'unavailable', workReference: { authority: 'beads', itemId, revision: linkRecord.itemRevision }, executionLink: linkRecord };
      const item = itemFrom(observed, itemId);
      return { contract: WORK_ACTION_CONTRACT, ok: true, status: item.status, workReference: { authority: 'beads', itemId, revision: item.revision }, executionLink: linkRecord };
    },
    async list() { const values = links.list ? await links.list() : []; return { contract: WORK_ACTION_CONTRACT, ok: true, items: values.filter((entry) => entry.workspaceId === workspaceId) }; },
  };
}
module.exports = { WORK_ACTION_CONTRACT, createBeadsWorkActionService, createMemoryExecutionLinkStore };
