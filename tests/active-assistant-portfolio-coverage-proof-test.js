'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const coverage = require('../scripts/lib/active-assistant-portfolio-coverage');

const DIGEST = 'a'.repeat(64);

function project(id, lifecycle = 'active') { return { id, kind: 'project', lifecycle }; }
function outcome(id) { return { id, kind: 'outcome' }; }

function proof({ generation = 42, records = [project('prj_000001'), project('prj_000002')], complete = true, provenance = {} } = {}) {
  return {
    contract: 'jarvos.projects-portfolio-proof/v1',
    query: {},
    generation,
    capturedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    capability: { receiptId: 'cap_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', digest: DIGEST },
    hostBindingDigests: {},
    records,
    complete,
    counts: {
      records: records.length,
      projects: records.filter((record) => record.kind === 'project').length,
      outcomes: records.filter((record) => record.kind === 'outcome').length,
    },
    recordsDigest: DIGEST,
    proofDigest: DIGEST,
    signature: 'sig',
    ...provenance,
  };
}

function evaluate(overrides = {}) {
  return coverage.evaluatePortfolioProofCoverage({
    registryGeneration: 42,
    activeProjectIds: ['prj_000002', 'prj_000001'],
    proof: proof(),
    ...overrides,
  });
}

test('a ready receipt requires the active set to exactly match the complete proof roster', () => {
  const result = evaluate();
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasonCodes, []);
  assert.deepEqual(result.considered, [
    { projectId: 'prj_000001', state: 'enumerated', reasonCodes: [] },
    { projectId: 'prj_000002', state: 'enumerated', reasonCodes: [] },
  ]);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test('an active project missing from the proof is a fail-closed mismatch', () => {
  const result = evaluate({ activeProjectIds: ['prj_000001', 'prj_000002', 'prj_000003'] });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasonCodes, ['portfolio_active_set_mismatch']);
  assert.deepEqual(result.missingProjectIds, ['prj_000003']);
});

test('a project present in the proof but not declared active is also a fail-closed mismatch', () => {
  const result = evaluate({ activeProjectIds: ['prj_000001'] });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasonCodes, ['portfolio_active_set_mismatch']);
});

test('an incomplete proof never yields a ready receipt regardless of active set', () => {
  const result = evaluate({ proof: proof({ complete: false }) });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasonCodes, ['portfolio_proof_incomplete']);
});

test('outcomes in the proof do not count toward the active project set', () => {
  const result = evaluate({
    activeProjectIds: ['prj_000001', 'prj_000002'],
    proof: proof({ records: [project('prj_000001'), project('prj_000002'), outcome('out_000003')] }),
  });
  assert.equal(result.ready, true);
});

test('a complete proof correctly including paused and archived projects alongside the active set is ready', () => {
  const result = evaluate({
    activeProjectIds: ['prj_000001', 'prj_000002'],
    proof: proof({ records: [project('prj_000001'), project('prj_000002'), project('prj_000003', 'paused'), project('prj_000004', 'archived')] }),
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasonCodes, []);
});

test('a supplied active ID whose proof record is paused/archived is a distinct fail-closed mismatch from a missing ID', () => {
  const result = evaluate({
    activeProjectIds: ['prj_000001', 'prj_000002', 'prj_000003'],
    proof: proof({ records: [project('prj_000001'), project('prj_000002'), project('prj_000003', 'paused')] }),
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasonCodes, ['portfolio_active_set_mismatch']);
  assert.deepEqual(result.missingProjectIds, []);
  assert.deepEqual(result.considered, [
    { projectId: 'prj_000001', state: 'enumerated', reasonCodes: [] },
    { projectId: 'prj_000002', state: 'enumerated', reasonCodes: [] },
    { projectId: 'prj_000003', state: 'inactive', reasonCodes: ['portfolio_active_set_mismatch'] },
  ]);
});

test('a paused/archived project not declared active does not count as an extra active project', () => {
  const result = evaluate({
    activeProjectIds: ['prj_000001', 'prj_000002'],
    proof: proof({ records: [project('prj_000001'), project('prj_000002'), project('prj_000003', 'archived')] }),
  });
  assert.equal(result.ready, true);
});

test('an active project present in the proof but not declared active is still a fail-closed extra mismatch even with paused records present', () => {
  const result = evaluate({
    activeProjectIds: ['prj_000001'],
    proof: proof({ records: [project('prj_000001'), project('prj_000002'), project('prj_000003', 'paused')] }),
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasonCodes, ['portfolio_active_set_mismatch']);
});

test('generation mismatch, malformed provenance, and invalid active IDs fail closed', () => {
  const cases = [
    [{ registryGeneration: 41 }, 'registry_generation_mismatch'],
    [{ activeProjectIds: ['prj_000001', 'invalid'] }, 'invalid_active_project_ids'],
    [{ activeProjectIds: ['prj_000001', 'prj_000001'] }, 'duplicate_active_project_ids'],
    [{ proof: { nope: true } }, 'missing_portfolio_proof_provenance'],
    [{ proof: proof({ provenance: { capability: null } }) }, 'malformed_portfolio_proof_provenance'],
    [{ proof: proof({ provenance: { recordsDigest: 'not-a-digest' } }) }, 'malformed_portfolio_proof_provenance'],
    [{ proof: proof({ provenance: { signature: '' } }) }, 'malformed_portfolio_proof_provenance'],
    [{ proof: proof({ records: [project('prj_000001'), project('prj_000001')] }) }, 'duplicate_proof_record_ids'],
    [{ proof: proof({ records: [{ id: 'prj_000001', kind: 'outcome' }] }) }, 'invalid_proof_record_ids'],
  ];
  for (const [override, reasonCode] of cases) {
    const result = evaluate(override);
    assert.equal(result.ready, false, reasonCode);
    assert.deepEqual(result.reasonCodes, [reasonCode]);
  }
});

test('evaluatePortfolioCoverage remains untouched by the proof-only evaluator', () => {
  assert.equal(typeof coverage.evaluatePortfolioCoverage, 'function');
  assert.notEqual(coverage.evaluatePortfolioCoverage, coverage.evaluatePortfolioProofCoverage);
});
