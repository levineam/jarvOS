'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  loadCompoundEngineeringProviderManifest,
  validateCompoundEngineeringProviderManifest,
} = require('../src/providers/compound-engineering');
const {
  WORKFLOW_PROVIDER_CONTRACT_VERSION,
  buildWorkflowProviderRequest,
  projectPublicWorkflowProviderReceipt,
  validateWorkflowProviderReceipt,
  validateWorkflowProviderRequest,
} = require('../src/providers/workflow-provider');

const ROOT = require('node:path').resolve(__dirname, '..', '..', '..');
const MANIFEST_PATH = require('node:path').join(ROOT, 'modules/jarvos-coding/providers/compound-engineering.json');

function provider(manifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    pinDigest: manifest.source.contentDigest,
    harness: 'codex',
    adapterVersion: 'codex-ce-adapter.v1',
  };
}

function baseInput(manifest, overrides = {}) {
  return {
    operation: 'plan',
    workRunId: 'run_SUP-5000_01',
    operationNonce: 'nonce-01',
    idempotencyKey: 'idem-01',
    provider: provider(manifest),
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5000',
    input: { kind: 'bounded-plan-input', digest: 'b'.repeat(64) },
    ...overrides,
  };
}

function planReceipt(manifest, overrides = {}) {
  return {
    version: 'jarvos-workflow-provider-receipt/v1',
    operation: 'plan',
    status: 'succeeded',
    workRunId: 'run_SUP-5000_01',
    operationNonce: 'nonce-01',
    idempotencyKey: 'idem-01',
    provider: provider(manifest),
    artifact: {
      kind: 'plan',
      reference: 'artifact:plan123456',
      path: '/private/jarvos/artifacts/plan.md',
      digest: 'a'.repeat(64),
    },
    planRevisionDigest: 'a'.repeat(64),
    acceptedPlanDigest: null,
    publicLabel: 'Compound Engineering plan',
    diagnostics: [],
    ...overrides,
  };
}

test('the approved Compound Engineering manifest has one immutable pin and an explicit harness matrix', () => {
  const loaded = loadCompoundEngineeringProviderManifest(MANIFEST_PATH, { root: ROOT });
  const result = validateCompoundEngineeringProviderManifest(loaded.manifest);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(loaded.manifest.schemaVersion, 'jarvos-managed-workflow-provider/v1');
  assert.equal(loaded.manifest.source.revision, 'e36ddb8cbd4dd902d3b6ddd96165a783b0ac4711');
  assert.equal(loaded.manifest.harnesses.codex.status, 'unsupported');
  assert.equal(loaded.manifest.harnesses.hermes.status, 'unsupported');
});

test('provider requests validate against the approved pin and operation-specific plan binding', () => {
  const manifest = loadCompoundEngineeringProviderManifest(MANIFEST_PATH, { root: ROOT }).manifest;
  const request = buildWorkflowProviderRequest(baseInput(manifest));
  assert.equal(request.ok, true, request.errors?.join('\n'));
  assert.equal(request.request.version, WORKFLOW_PROVIDER_CONTRACT_VERSION);
  assert.equal(validateWorkflowProviderRequest(request.request, { manifest }).ok, true);

  const work = buildWorkflowProviderRequest(baseInput(manifest, {
    operation: 'work',
    acceptedPlanDigest: 'a'.repeat(64),
  }));
  assert.equal(work.ok, true, work.errors?.join('\n'));
  assert.equal(validateWorkflowProviderRequest(work.request, { manifest }).ok, true);

  const changedPin = validateWorkflowProviderRequest({
    ...request.request,
    provider: { ...request.request.provider, pinDigest: 'c'.repeat(64) },
  }, { manifest });
  assert.equal(changedPin.ok, false);
  assert.match(changedPin.errors.join('\n'), /pinDigest/);
});

test('plan receipts bind candidate artifacts before acceptance and preserve the canonical work run', () => {
  const manifest = loadCompoundEngineeringProviderManifest(MANIFEST_PATH, { root: ROOT }).manifest;
  const request = buildWorkflowProviderRequest(baseInput(manifest)).request;
  const receipt = planReceipt(manifest);
  const result = validateWorkflowProviderReceipt(receipt, { manifest, request });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(result.receipt.workRunId, request.workRunId);
  assert.equal(result.receipt.planRevisionDigest, receipt.artifact.digest);
});

test('work receipts require the accepted plan revision and reject replay or authority-shaped fields', () => {
  const manifest = loadCompoundEngineeringProviderManifest(MANIFEST_PATH, { root: ROOT }).manifest;
  const request = buildWorkflowProviderRequest(baseInput(manifest, {
    operation: 'work',
    acceptedPlanDigest: 'a'.repeat(64),
  })).request;
  const valid = planReceipt(manifest, {
    operation: 'work',
    artifact: { kind: 'work', reference: 'artifact:work123456', path: '/private/jarvos/artifacts/work.json', digest: 'd'.repeat(64) },
    planRevisionDigest: null,
    acceptedPlanDigest: 'a'.repeat(64),
  });
  assert.equal(validateWorkflowProviderReceipt(valid, { manifest, request }).ok, true);

  const replay = validateWorkflowProviderReceipt({ ...valid, operationNonce: 'nonce-other' }, { manifest, request });
  assert.equal(replay.ok, false);
  assert.match(replay.errors.join('\n'), /operationNonce/);

  const forged = validateWorkflowProviderReceipt({ ...valid, branch: 'main' }, { manifest, request });
  assert.equal(forged.ok, false);
  assert.match(forged.errors.join('\n'), /unknown field|authority/);

  const changedPlan = validateWorkflowProviderReceipt({ ...valid, acceptedPlanDigest: 'e'.repeat(64) }, { manifest, request });
  assert.equal(changedPlan.ok, false);
  assert.match(changedPlan.errors.join('\n'), /acceptedPlanDigest/);
});

test('public provider projection hides local paths, idempotency material, and private diagnostics', () => {
  const manifest = loadCompoundEngineeringProviderManifest(MANIFEST_PATH, { root: ROOT }).manifest;
  const request = buildWorkflowProviderRequest(baseInput(manifest)).request;
  const receipt = planReceipt(manifest, {
    diagnostics: ['provider completed; local path /private/jarvos/artifacts/plan.md and token=secret-value were redacted'],
  });
  const validation = validateWorkflowProviderReceipt(receipt, { manifest, request });
  assert.equal(validation.ok, true, validation.errors?.join('\n'));
  const projection = projectPublicWorkflowProviderReceipt(validation.receipt);
  assert.equal(projection.ok, true, projection.errors?.join('\n'));
  assert.equal(projection.projection.artifact.path, undefined);
  assert.equal(projection.projection.idempotencyKey, undefined);
  assert.equal(projection.projection.artifact.reference, 'artifact:plan123456');
  assert.doesNotMatch(JSON.stringify(projection.projection), /private\/jarvos|secret-value/);
});

test('invalid provider manifest references, moving refs, and unsupported operations fail closed', () => {
  const manifest = loadCompoundEngineeringProviderManifest(MANIFEST_PATH, { root: ROOT }).manifest;
  const moving = validateCompoundEngineeringProviderManifest({
    ...manifest,
    source: { ...manifest.source, revision: 'main' },
  });
  assert.equal(moving.ok, false);
  assert.match(moving.errors.join('\n'), /revision/);

  const unsupported = validateCompoundEngineeringProviderManifest({
    ...manifest,
    operations: ['plan', 'work', 'delete'],
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.errors.join('\n'), /operations/);
});
