'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { CONTRACT, validateProjection, projectMeaning, invokeMeaning } = require('../src/ripeness-context');

function projection() {
  return {
    contract: CONTRACT, operation: 'context', status: 'ok', reason: 'limited_daily_measurement',
    scope: { id: 'a'.repeat(64), destination: 'd'.repeat(64), label: 'Authorized project context only' },
    analysis: { id: 'b'.repeat(64), state: 'current', evaluatedAt: '2026-09-08T01:00:00.000Z' },
    findings: [{ kind: 'inference', text: 'Two notes support a common question, not necessarily a task.', sourceRefs: ['source:' + 'c'.repeat(64)] }],
    coverage: [{ source: 'ripeness', state: 'current', asOf: '2026-09-08T01:00:00.000Z', reason: 'limited_daily_measurement' }],
    omissions: ['revision_coverage_incomplete'],
  };
}

test('versioned content projection is bounded and keeps inference distinct from evidence', () => {
  const input = projection();
  assert.equal(validateProjection(input), true);
  assert.deepEqual(projectMeaning(input), input);
  const large = projection();
  large.findings = Array.from({ length: 6 }, () => ({ ...input.findings[0], text: 'Evidence '.repeat(70) }));
  const output = projectMeaning(large, { maxChars: 2000 });
  assert.ok(JSON.stringify(output).length <= 2000);
  assert.deepEqual(output.coverage, input.coverage);
  assert.ok(output.omissions.includes('findings_truncated'));
});

test('rejects internal packets, unknown content, paths, diagnostics, and untraceable findings', () => {
  for (const mutate of [
    (v) => { v.rawArtifact = {}; }, (v) => { v.findings[0].promptText = 'private'; },
    (v) => { v.findings[0].text = 'Read /Users/example/private.md'; },
    (v) => { v.findings[0].text = '../../Vault/private.md'; },
    (v) => { v.findings[0].text = 'notes/private.md'; },
    (v) => { v.findings[0].text = 'D:\\notes\\private.md'; },
    (v) => { v.findings[0].text = 'authorization: secret'; },
    (v) => { v.findings[0].sourceRefs = []; }, (v) => { v.scope = null; },
    (v) => { v.coverage.push(v.coverage[0]); }, (v) => { delete v.reason; },
  ]) {
    const value = projection(); mutate(value);
    assert.equal(projectMeaning(value).reason, 'projection_invalid');
  }
});

test('caller input cannot acquire host authority or trigger a different operation', async () => {
  let reads = 0; let assessments = 0;
  const provider = { readContext: async () => { reads++; return projection(); }, assess: async () => { assessments++; } };
  for (const args of [{ provider: 'other' }, { root: '/tmp' }, { model: 'other' }, { requestedByAndrew: true }, { requestId: 'x' }, null, []]) {
    assert.equal((await invokeMeaning('assessment', args, provider)).reason, 'invalid_arguments');
  }
  assert.equal(assessments, 0);
  assert.equal((await invokeMeaning('context', {}, provider)).status, 'ok');
  assert.equal(reads, 1);
  assert.equal(assessments, 0);
  assert.equal((await invokeMeaning('context', {}, null)).reason, 'binding_unavailable');
  assert.equal((await invokeMeaning('invalid', {}, provider)).reason, 'invalid_operation');
  assert.equal(assessments, 0);
});

test('host errors and operation-confused results never export diagnostics', async () => {
  const result = await invokeMeaning('context', {}, { readContext() { throw new Error('/Users/private credential'); } });
  assert.equal(result.reason, 'provider_unavailable');
  assert.equal(JSON.stringify(result).includes('/Users'), false);
  assert.equal((await invokeMeaning('assessment', {}, { assess: async () => projection() })).reason, 'projection_invalid');
});

test('real MCP cancellation reaches the operation and waits for its terminal response', () => {
  const mcp = require.resolve('../scripts/jarvos-mcp');
  const contract = require.resolve('../src/ripeness-context');
  const script = `const m = require(${JSON.stringify(mcp)}); const p = require(${JSON.stringify(contract)});
  m.setMeaningProvider({ assess: ({signal}) => new Promise(resolve => signal.addEventListener('abort', () => {
    setTimeout(() => resolve({...p.unavailable('assessment', 'request_cancelled'), status:'cancelled'}), 15);
  }, {once:true})) });
  const task = m.handle({jsonrpc:'2.0', id:7, method:'tools/call', params:{name:'jarvos_active_assistant',arguments:{}}});
  setTimeout(()=>m.handle({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:7}}),5);
  task.then(()=>{});`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 7);
  assert.equal(JSON.parse(messages[0].result.content[0].text).status, 'cancelled');
});
