'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ProjectRegistry,
  REGISTRY_CONTRACT,
  RECORD_CONTRACT,
  RECORD_CONTRACT_V2,
  STATUS_BY_KIND,
  cloneRecord,
  validateRecord,
} = require('../src/registry');

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-project-registry-'));
}

function makeRegistry() {
  return new ProjectRegistry({ stateDir: tempState(), now: () => '2026-08-09T00:00:00.000Z' });
}

function inferenceMetadata(overrides = {}) {
  return {
    candidateId: 'cand_0123456789abcdef0123456789abcdef',
    decisionId: 'dec_0123456789abcdef0123456789abcdef',
    disposition: 'established',
    suppressionKeys: ['suppress_legacy_name'],
    supersededBy: null,
    reasonCodes: ['policy-qualified'],
    ...overrides,
  };
}

test('canonical records expose a versioned project/outcome contract', () => {
  assert.equal(REGISTRY_CONTRACT, 'jarvos.projects-registry/v1');
  assert.equal(RECORD_CONTRACT, 'jarvos.project-record/v1');
  assert.equal(RECORD_CONTRACT_V2, 'jarvos.project-record/v2');
  assert.deepEqual(STATUS_BY_KIND.project, ['active', 'paused', 'archived']);
  assert.deepEqual(STATUS_BY_KIND.outcome, ['planned', 'active', 'complete', 'archived']);

  const result = validateRecord({
    id: 'prj_000001',
    kind: 'project',
    title: 'jarvOS',
    aliases: ['jarvos'],
    parentId: null,
    lifecycle: 'active',
    declaredPriority: 'unset',
    revision: 1,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.record.kind, 'project');
});

test('v1 records preserve their shape and reload unchanged', () => {
  const stateDir = tempState();
  const registry = new ProjectRegistry({ stateDir, now: () => '2026-08-09T00:00:00.000Z' });
  const created = registry.create({ title: 'Legacy project', aliases: ['legacy'] });
  const expectedKeys = [
    'contract', 'id', 'kind', 'title', 'aliases', 'parentId', 'lifecycle',
    'declaredPriority', 'revision', 'createdAt', 'updatedAt', 'links',
  ];

  assert.equal(created.record.contract, RECORD_CONTRACT);
  assert.deepEqual(Object.keys(created.record), expectedKeys);
  const generationBytes = fs.readFileSync(path.join(stateDir, 'generation-0000000001.json'), 'utf8');
  const reloaded = new ProjectRegistry({ stateDir, now: () => '2026-08-09T00:00:00.000Z' });
  assert.deepEqual(reloaded.get(created.record.id), created.record);
  assert.equal(fs.readFileSync(path.join(stateDir, 'generation-0000000001.json'), 'utf8'), generationBytes);
});

test('v2 inference metadata is accepted, versioned, and deeply cloned on create/update', () => {
  const registry = makeRegistry();
  const metadata = inferenceMetadata();
  const created = registry.create({ title: 'Inferred project', inference: metadata });
  assert.equal(created.record.contract, RECORD_CONTRACT_V2);
  assert.deepEqual(created.record.inference, metadata);

  const fromCreate = registry.get(created.record.id);
  fromCreate.inference.suppressionKeys.push('local-mutation');
  fromCreate.inference.reasonCodes[0] = 'local-mutation';
  assert.deepEqual(registry.get(created.record.id).inference, metadata);

  const updateMetadata = inferenceMetadata({ disposition: 'corrected', reasonCodes: ['owner-correction'] });
  const updated = registry.update(created.record.id, { inference: updateMetadata }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  });
  assert.equal(updated.record.contract, RECORD_CONTRACT_V2);
  assert.deepEqual(updated.record.inference, updateMetadata);
  const cloned = cloneRecord(updated.record);
  cloned.inference.suppressionKeys.push('clone-mutation');
  assert.deepEqual(updated.record.inference, updateMetadata);

  const reloaded = new ProjectRegistry({ stateDir: registry.stateDir, now: registry.now });
  assert.deepEqual(reloaded.get(updated.record.id), updated.record);
});

test('a v1 record can be promoted to v2 only with complete inference metadata', () => {
  const registry = makeRegistry();
  const created = registry.create({ title: 'Promotable project' });
  assert.equal(created.record.contract, RECORD_CONTRACT);

  assert.throws(() => registry.update(created.record.id, {
    inference: { candidateId: inferenceMetadata().candidateId },
  }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  }), /exact fields|inference/);

  const promoted = registry.update(created.record.id, { inference: inferenceMetadata() }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  });
  assert.equal(promoted.record.contract, RECORD_CONTRACT_V2);
  assert.deepEqual(promoted.record.inference, inferenceMetadata());
});

test('inference metadata has strict fields and Project Inference ID/type validation', () => {
  const invalid = [
    [{ extra: true }, /exact fields|unsupported/],
    [{ candidateId: 42 }, /candidateId/],
    [{ candidateId: 'cand_short' }, /candidateId/],
    [{ decisionId: 42 }, /decisionId/],
    [{ decisionId: 'dec_short' }, /decisionId/],
    [{ disposition: 'provisional' }, /disposition/],
    [{ disposition: 'quarantined' }, /disposition/],
    [{ suppressionKeys: 'suppress_legacy_name' }, /suppressionKeys/],
    [{ supersededBy: 'candidate-not-decision' }, /supersededBy/],
    [{ supersededBy: 'dec_fedcba9876543210fedcba9876543210' }, /only valid.*superseded/],
    [{ disposition: 'superseded' }, /requires supersededBy/],
    [{ reasonCodes: ['Policy-Qualified', 'policy-qualified'] }, /reasonCodes/],
  ];
  for (const [change, error] of invalid) {
    assert.throws(() => validateRecord({
      id: 'prj_000001',
      kind: 'project',
      title: 'Invalid inference',
      parentId: null,
      lifecycle: 'active',
      declaredPriority: 'unset',
      revision: 1,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      inference: { ...inferenceMetadata(), ...change },
    }), error);
  }
});

test('v2 inference metadata cannot be silently removed and supports explicit superseded lineage', () => {
  const registry = makeRegistry();
  const created = registry.create({ title: 'Superseded project', inference: inferenceMetadata() });

  assert.throws(() => registry.update(created.record.id, { inference: undefined }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  }), /cannot be removed|inference/);
  assert.throws(() => registry.update(created.record.id, { inference: null }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  }), /cannot be removed|inference/);

  const superseded = registry.update(created.record.id, {
    inference: inferenceMetadata({
      disposition: 'superseded',
      supersededBy: 'dec_fedcba9876543210fedcba9876543210',
      reasonCodes: ['superseded-by-correction'],
    }),
  }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  });
  assert.equal(superseded.record.inference.disposition, 'superseded');
  assert.equal(superseded.record.inference.supersededBy, 'dec_fedcba9876543210fedcba9876543210');
});

test('registry receipts retain legacy shape and carry validated inference claims only when supplied', () => {
  const registry = makeRegistry();
  const legacy = registry.create({ title: 'Legacy receipt' });
  assert.deepEqual(Object.keys(legacy.receipt), [
    'id', 'operation', 'recordId', 'actor', 'session', 'generation', 'observedAt',
  ]);
  const legacyUpdated = registry.update(legacy.record.id, { title: 'Legacy receipt updated' }, {
    expectedGeneration: legacy.generation,
    expectedRevision: legacy.record.revision,
  });
  assert.deepEqual(Object.keys(legacyUpdated.receipt), [
    'id', 'operation', 'recordId', 'actor', 'session', 'generation', 'observedAt',
  ]);

  const metadata = inferenceMetadata();
  const withClaims = registry.create({ title: 'Inferred receipt', inference: metadata }, {
    expectedGeneration: legacyUpdated.generation,
    actor: 'inference',
    session: 'session-1',
    decisionId: metadata.decisionId,
    reasonCodes: metadata.reasonCodes,
  });
  assert.deepEqual(Object.keys(withClaims.receipt), [
    'id', 'operation', 'recordId', 'actor', 'session', 'generation', 'observedAt', 'decisionId', 'reasonCodes',
  ]);
  assert.equal(withClaims.receipt.decisionId, metadata.decisionId);
  assert.deepEqual(withClaims.receipt.reasonCodes, metadata.reasonCodes);

  const updatedWithClaims = registry.update(withClaims.record.id, { title: 'Inferred receipt updated' }, {
    expectedGeneration: withClaims.generation,
    expectedRevision: withClaims.record.revision,
    decisionId: metadata.decisionId,
    reasonCodes: metadata.reasonCodes,
  });
  assert.deepEqual(Object.keys(updatedWithClaims.receipt), [
    'id', 'operation', 'recordId', 'actor', 'session', 'generation', 'observedAt', 'decisionId', 'reasonCodes',
  ]);

  assert.throws(() => registry.create({ title: 'Forged receipt' }, {
    expectedGeneration: updatedWithClaims.generation,
    decisionId: metadata.decisionId,
  }), /inference metadata|receipt/);
  assert.throws(() => registry.create({ title: 'Invalid receipt', inference: metadata }, {
    expectedGeneration: updatedWithClaims.generation,
    decisionId: 'not-a-decision',
  }), /decisionId/);
  assert.throws(() => registry.update(withClaims.record.id, { title: 'Mismatch' }, {
    expectedGeneration: updatedWithClaims.generation,
    expectedRevision: updatedWithClaims.record.revision,
    decisionId: 'dec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }), /decisionId|inference/);
});

test('registry creates a project and an outcome with stable breadcrumb identity', () => {
  const registry = makeRegistry();
  const project = registry.create({ title: 'jarvOS', declaredPriority: 'high' });
  const outcome = registry.create({
    kind: 'outcome',
    title: 'v1.0.0 release',
    parentId: project.record.id,
  }, { expectedGeneration: project.generation });

  assert.match(project.record.id, /^prj_/);
  assert.match(outcome.record.id, /^out_/);
  assert.equal(registry.breadcrumb(outcome.record.id), 'jarvOS › v1.0.0 release');
  assert.equal(registry.get(outcome.record.id).parentId, project.record.id);
});

test('outcomes are leaves and lifecycle/status combinations are closed', () => {
  const registry = makeRegistry();
  const project = registry.create({ title: 'jarvOS' });

  assert.throws(() => registry.create({
    kind: 'outcome', title: 'orphan', lifecycle: 'planned',
  }, { expectedGeneration: project.generation }), /outcome requires a project parent/);

  const outcome = registry.create({
    kind: 'outcome', title: 'release', parentId: project.record.id,
  }, { expectedGeneration: project.generation });

  assert.throws(() => registry.create({
    kind: 'project', title: 'nested', parentId: outcome.record.id,
  }, { expectedGeneration: outcome.generation }), /parent must be a project/);

  assert.throws(() => registry.update(outcome.record.id, {
    lifecycle: 'paused',
  }, { expectedGeneration: outcome.generation, expectedRevision: outcome.record.revision }), /invalid lifecycle/);

  assert.throws(() => registry.update(project.record.id, {
    parentId: project.record.id,
  }, { expectedGeneration: outcome.generation, expectedRevision: project.record.revision }), /hierarchy contains a cycle/);
});

test('priority inheritance reports declared, effective, and source values', () => {
  const registry = makeRegistry();
  const project = registry.create({ title: 'jarvOS', declaredPriority: 'high' });
  const inherited = registry.create({
    kind: 'outcome', title: 'release', parentId: project.record.id,
  }, { expectedGeneration: project.generation });

  assert.deepEqual(registry.priority(inherited.record.id), {
    declared: 'unset',
    effective: 'high',
    source: 'inherited',
    sourceRecordId: project.record.id,
    sourceKind: 'project',
  });

  const overridden = registry.update(inherited.record.id, {
    declaredPriority: 'low',
  }, { expectedGeneration: inherited.generation, expectedRevision: inherited.record.revision });
  assert.deepEqual(registry.priority(overridden.record.id), {
    declared: 'low',
    effective: 'low',
    source: 'explicit',
    sourceRecordId: overridden.record.id,
    sourceKind: 'outcome',
  });
});

test('duplicate aliases resolve ambiguously instead of guessing', () => {
  const registry = makeRegistry();
  const first = registry.create({ title: 'jarvOS', aliases: ['the system'] });
  const second = registry.create({ title: 'Other project', aliases: ['the system'] }, {
    expectedGeneration: first.generation,
  });

  assert.deepEqual(registry.resolve('the system'), {
    status: 'ambiguous',
    candidates: [first.record.id, second.record.id],
  });
  assert.deepEqual(registry.resolve('missing'), { status: 'not-found' });
});

test('stale graph generations cannot overwrite newer mutations', () => {
  const stateDir = tempState();
  const first = new ProjectRegistry({ stateDir });
  const second = new ProjectRegistry({ stateDir });
  const created = first.create({ title: 'jarvOS' });

  second.reload();
  const firstUpdate = first.update(created.record.id, { title: 'jarvOS core' }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  });

  assert.throws(() => second.update(created.record.id, { title: 'wrong writer' }, {
    expectedGeneration: created.generation,
    expectedRevision: created.record.revision,
  }), /stale registry generation/);
  assert.equal(firstUpdate.record.title, 'jarvOS core');
  assert.equal(new ProjectRegistry({ stateDir }).get(created.record.id).title, 'jarvOS core');
});

test('transaction commits multiple record mutations as one registry generation', () => {
  const registry = makeRegistry();
  const parent = registry.create({ title: 'Parent' });
  const child = registry.create({ title: 'Child', parentId: parent.record.id }, { expectedGeneration: parent.generation });

  const committed = registry.mutate((transaction) => {
    const updatedParent = transaction.update(parent.record.id, { title: 'Renamed parent' }, {
      expectedRevision: parent.record.revision,
    });
    const updatedChild = transaction.update(child.record.id, { title: 'Renamed child' }, {
      expectedRevision: child.record.revision,
    });
    return { recordId: updatedParent.id, updatedIds: [updatedParent.id, updatedChild.id] };
  }, {
    expectedGeneration: child.generation,
    operation: 'reconcile',
    actor: 'project-inference',
    session: 'project-inference',
    recordId: parent.record.id,
  });

  assert.equal(committed.generation, child.generation + 1);
  assert.deepEqual(committed.result.updatedIds.sort(), [parent.record.id, child.record.id].sort());
  assert.equal(committed.record.title, 'Renamed parent');
  assert.equal(registry.get(parent.record.id).revision, 2);
  assert.equal(registry.get(child.record.id).revision, 2);
  assert.equal(registry.list().length, 2);
});

test('independent registry processes serialize allocation without sharing an ID', async () => {
  const stateDir = tempState();
  const registryPath = require.resolve('../src/registry');
  const goPath = path.join(stateDir, '.go');
  const readyPaths = [path.join(stateDir, '.ready-a'), path.join(stateDir, '.ready-b')];
  const childScript = [
    "const fs = require('node:fs');",
    "const { ProjectRegistry } = require(process.argv[1]);",
    "const [stateDir, readyPath, goPath, title] = process.argv.slice(2);",
    "const registry = new ProjectRegistry({ stateDir });",
    "fs.writeFileSync(readyPath, String(process.pid), { mode: 0o600 });",
    "const deadline = Date.now() + 5000;",
    "while (!fs.existsSync(goPath)) { if (Date.now() >= deadline) process.exit(2); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }",
    "try { const result = registry.create({ title }); process.stdout.write(JSON.stringify({ ok: true, id: result.record.id })); }",
    "catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }",
  ].join('\n');
  const children = ['first process', 'second process'].map((title, index) => spawn(process.execPath, [
    '-e', childScript, registryPath, stateDir, readyPaths[index], goPath, title,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const output = children.map(() => '');
  const errors = children.map(() => '');
  children.forEach((child, index) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output[index] += chunk; });
    child.stderr.on('data', (chunk) => { errors[index] += chunk; });
  });
  const readyDeadline = Date.now() + 5000;
  while (!readyPaths.every((readyPath) => fs.existsSync(readyPath))) {
    if (Date.now() >= readyDeadline) {
      children.forEach((child) => child.kill());
      throw new Error(`registry concurrency children did not become ready: ${errors.join(' ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(goPath, 'go\n', { mode: 0o600 });
  const exits = await Promise.all(children.map((child) => new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))));
  assert.deepEqual(exits.map((exit) => exit.code), [0, 0]);
  const results = output.map((value) => JSON.parse(value));
  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  assert.notEqual(results[0].id, results[1].id);
  const finalRegistry = new ProjectRegistry({ stateDir });
  assert.equal(finalRegistry.generation, 2);
  assert.deepEqual(finalRegistry.list().map((record) => record.id).sort(), ['prj_000001', 'prj_000002']);
});

test('stale-lock takeover never removes a replacement owner lock', () => {
  const stateDir = tempState();
  const lockPath = path.join(stateDir, '.registry.lock');
  const stale = JSON.stringify({ pid: 999999999, createdAt: 0, token: 'stale-owner' });
  const replacement = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'replacement-owner' });
  fs.writeFileSync(lockPath, stale, { mode: 0o600 });

  const originalRenameSync = fs.renameSync;
  const originalWait = Atomics.wait;
  let injected = false;
  try {
    fs.renameSync = function replaceBeforeTakeover(from, to) {
      if (!injected && from === lockPath && String(to).includes('.stale.')) {
        injected = true;
        fs.writeFileSync(lockPath, replacement, { mode: 0o600 });
      }
      return originalRenameSync.call(fs, from, to);
    };
    Atomics.wait = function stopAfterRestore() {
      throw new Error('stop-after-lock-restore');
    };
    const registry = new ProjectRegistry({ stateDir });
    assert.throws(() => registry.create({ title: 'must not acquire' }), /stop-after-lock-restore/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), replacement);
  } finally {
    fs.renameSync = originalRenameSync;
    Atomics.wait = originalWait;
  }
});

test('incomplete generation files are ignored while the committed generation remains readable', () => {
  const stateDir = tempState();
  const registry = new ProjectRegistry({ stateDir });
  const created = registry.create({ title: 'jarvOS' });
  fs.writeFileSync(path.join(stateDir, 'generation-9999999999.json.tmp-crash'), '{"broken":true}', 'utf8');

  const recovered = new ProjectRegistry({ stateDir });
  assert.equal(recovered.get(created.record.id).title, 'jarvOS');
  assert.equal(recovered.integrity().ok, true);
});
