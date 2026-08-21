'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const coverage = require('../scripts/lib/active-assistant-portfolio-coverage');

const VERSION = coverage.ACTIVE_ASSISTANT_PORTFOLIO_COVERAGE_VERSION;
const DIGEST = 'a'.repeat(64);

function packet({ generation = 42, records = [project('prj_000001'), project('prj_000002')], truncation = { truncated: false, sections: [] }, provenance = {} } = {}) {
  return {
    contract: 'jarvos.projects-context/v1',
    redactionClass: 'private',
    capability: { receiptId: 'cap_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', digest: DIGEST },
    canonical: { generation, records },
    truncation,
    ...provenance,
  };
}

function project(id) { return { id, kind: 'project' }; }
function outcome(id) { return { id, kind: 'outcome' }; }
function evaluate(value = {}) { return coverage.evaluatePortfolioCoverage({ registryGeneration: 42, activeProjectIds: ['prj_000002', 'prj_000001'], packet: packet(), ...value }); }

test('ready receipt enumerates every active project with deterministic public-safe digest', () => {
  const result = evaluate();
  assert.deepEqual(result, {
    contractVersion: VERSION,
    ready: true,
    reasonCodes: [],
    missingProjectIds: [],
    considered: [
      { projectId: 'prj_000001', state: 'enumerated', reasonCodes: [] },
      { projectId: 'prj_000002', state: 'enumerated', reasonCodes: [] },
    ],
    digest: result.digest,
  });
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('title'), false);
  assert.equal(JSON.stringify(result).includes('path'), false);
});

test('identical reordered caller and packet inputs retain the digest', () => {
  const left = evaluate();
  const right = coverage.evaluatePortfolioCoverage({
    registryGeneration: 42,
    activeProjectIds: ['prj_000001', 'prj_000002'],
    packet: packet({ records: [project('prj_000002'), outcome('out_000003'), project('prj_000001')] }),
  });
  assert.equal(left.digest, right.digest);
  assert.equal(right.ready, true);
});

test('missing active projects are a fail-closed incomplete enumeration', () => {
  const result = evaluate({ packet: packet({ records: [project('prj_000001')] }) });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasonCodes, ['portfolio_enumeration_incomplete']);
  assert.deepEqual(result.missingProjectIds, ['prj_000002']);
  assert.deepEqual(result.considered[1], { projectId: 'prj_000002', state: 'missing', reasonCodes: ['portfolio_enumeration_incomplete'] });
});

test('generation mismatch, canonical truncation, invalid or duplicate IDs, malformed packets, and missing provenance fail closed', () => {
  const cases = [
    [{ registryGeneration: 41 }, 'registry_generation_mismatch'],
    [{ packet: packet({ truncation: { truncated: true, sections: ['canonical.records'] } }) }, 'canonical_records_truncated'],
    [{ activeProjectIds: ['prj_000001', 'invalid'] }, 'invalid_active_project_ids'],
    [{ activeProjectIds: ['prj_000001', 'prj_000001'] }, 'duplicate_active_project_ids'],
    [{ packet: { nope: true } }, 'malformed_context_packet'],
    [{ packet: packet({ provenance: { capability: null } }) }, 'malformed_context_provenance'],
    [{ packet: { canonical: { generation: 42, records: [] }, truncation: { truncated: false, sections: [] } } }, 'missing_context_provenance'],
  ];
  for (const [input, reasonCode] of cases) {
    const result = evaluate(input);
    assert.equal(result.ready, false, reasonCode);
    assert.deepEqual(result.reasonCodes, [reasonCode]);
  }
});

test('provider and activity omissions do not invalidate otherwise complete canonical enumeration', () => {
  const result = evaluate({ packet: { ...packet(), omissions: ['provider:activity:omitted'], activity: [] } });
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasonCodes, []);
});
