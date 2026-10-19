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

// ---- v2 assessment projection (synthetic fixtures only) ----
const { CONTRACT_V2, validateProjectionV2 } = require('../src/ripeness-context');

const REF_A = 'source:' + '1'.repeat(64); // andrew_verified
const REF_E = 'source:' + '2'.repeat(64); // external_verified
const REF_U = 'source:' + '3'.repeat(64); // unverified

function projectionV2() {
  return {
    contract: CONTRACT_V2, operation: 'assessment', status: 'ok', reason: 'limited_daily_measurement',
    scope: { id: 'a'.repeat(64), destination: 'd'.repeat(64), label: 'Authorized project context only' },
    analysis: { id: 'b'.repeat(64), state: 'current', evaluatedAt: '2026-09-08T01:00:00.000Z' },
    findings: [
      { kind: 'andrew_words', text: 'I keep postponing the planning review', sourceRefs: [REF_A] },
      { kind: 'observation', text: 'The project status shows the review step has not moved this month.', sourceRefs: [REF_E, REF_A] },
      { kind: 'inference', text: 'A smaller review format might be easier to start.', sourceRefs: [REF_U] },
      { kind: 'contribution', text: 'Would a fifteen-minute review on Fridays feel more doable?', sourceRefs: [REF_A] },
    ],
    coverage: [
      { source: 'ripeness', state: 'current', asOf: '2026-09-08T01:00:00.000Z', reason: 'limited_daily_measurement' },
      { source: 'journal', state: 'current', asOf: null, reason: 'synthetic_fixture' },
    ],
    omissions: ['attribution_unverified'],
    sources: [
      { ref: REF_A, label: 'Synthetic journal entry', sourceClass: 'journal', origin: 'andrew_verified', asOf: '2026-09-08T01:00:00.000Z', excerpt: 'I keep postponing the planning review and/or skipping it entirely.' },
      { ref: REF_E, label: 'Synthetic project status', sourceClass: 'projects', origin: 'external_verified', asOf: null, excerpt: null },
      { ref: REF_U, label: 'Synthetic unreviewed note', sourceClass: 'notes', origin: 'unverified', asOf: '2026-09-07T12:00:00.000Z', excerpt: 'A loose idea about a smaller weekly review.' },
    ],
  };
}

const LARGE_REFS = Array.from({ length: 8 }, (_, index) => 'source:' + String(index + 1).repeat(64));

function largeV2() {
  const value = projectionV2();
  const long = 'Steady review evidence. '.repeat(29);
  value.sources = LARGE_REFS.map((ref, index) => ({
    ref, label: `Synthetic source ${index + 1}`, sourceClass: 'notes', origin: 'external_verified',
    asOf: null, excerpt: 'Synthetic excerpt words. '.repeat(16),
  }));
  value.findings = [
    { kind: 'observation', text: long, sourceRefs: LARGE_REFS.slice(0, 3) },
    { kind: 'observation', text: long, sourceRefs: LARGE_REFS.slice(3, 5) },
    { kind: 'inference', text: long, sourceRefs: [LARGE_REFS[5]] },
    { kind: 'inference', text: long, sourceRefs: [LARGE_REFS[6]] },
    { kind: 'observation', text: long, sourceRefs: [LARGE_REFS[7]] },
    { kind: 'contribution', text: 'Would a shorter Friday review feel more doable?', sourceRefs: [LARGE_REFS[0]] },
  ];
  value.omissions = ['revision_coverage_incomplete'];
  return value;
}

function assertV2Invalid(value, label) {
  assert.equal(validateProjectionV2(value), false, label);
  assert.equal(projectMeaning(value, { operation: 'assessment' }).reason, 'projection_invalid', label);
}

test('version matrix: v1 context and assessment stay accepted, v2 is assessment-only', () => {
  assert.equal(CONTRACT, 'jarvos-meaning-projection/v1');
  assert.equal(CONTRACT_V2, 'jarvos-meaning-projection/v2');
  const v1Context = projection();
  assert.equal(validateProjection(v1Context), true);
  assert.deepEqual(projectMeaning(v1Context), v1Context);
  const v1Assessment = { ...projection(), operation: 'assessment' };
  assert.equal(validateProjection(v1Assessment), true);
  assert.deepEqual(projectMeaning(v1Assessment, { operation: 'assessment' }), v1Assessment);
  const v2 = projectionV2();
  assert.equal(validateProjectionV2(v2), true);
  assert.deepEqual(projectMeaning(v2, { operation: 'assessment' }), v2);
  // v2 is rejected on the context path and by the strict v1 validator.
  assert.equal(projectMeaning(v2).reason, 'projection_invalid');
  assert.equal(projectMeaning(v2, { operation: 'context', maxChars: 8000 }).reason, 'projection_invalid');
  assert.equal(validateProjection(v2), false);
  assert.equal(validateProjectionV2({ ...v2, operation: 'context' }), false);
  assert.equal(projectMeaning({ ...v2, operation: 'context' }).reason, 'projection_invalid');
  assert.equal(validateProjectionV2(v1Assessment), false);
  assert.equal(validateProjectionV2({ ...v1Assessment, contract: CONTRACT_V2 }), false);
  // Non-ok v2 results carry no findings and no sources.
  const abstained = { ...projectionV2(), status: 'abstained', reason: 'insufficient_signal', findings: [], sources: [] };
  assert.equal(validateProjectionV2(abstained), true);
});

test('invokeMeaning returns v2 for host-bound assessment and rejects v2 on the context tool', async () => {
  let reads = 0; let assessments = 0;
  const provider = {
    readContext: async () => { reads++; return projectionV2(); },
    assess: async () => { assessments++; return projectionV2(); },
  };
  assert.deepEqual(await invokeMeaning('assessment', {}, provider), projectionV2());
  assert.equal((await invokeMeaning('context', {}, provider)).reason, 'projection_invalid');
  assert.equal((await invokeMeaning('context', { maxChars: 8000 }, provider)).reason, 'projection_invalid');
  // Model arguments remain empty for assessment; context keeps its 8000 ceiling.
  assert.equal((await invokeMeaning('assessment', { maxChars: 12000 }, provider)).reason, 'invalid_arguments');
  assert.equal((await invokeMeaning('context', { maxChars: 12000 }, provider)).reason, 'invalid_arguments');
  assert.equal(reads, 2);
  assert.equal(assessments, 1);
  const legacy = { ...projection(), operation: 'assessment' };
  assert.deepEqual(await invokeMeaning('assessment', {}, { assess: async () => ({ ...legacy }) }), legacy);
  // Default v2 budget is 12000, above the v1/context 8000 bound.
  const large = largeV2();
  const size = JSON.stringify(large).length;
  assert.ok(size > 8000 && size <= 12000, `fixture size ${size}`);
  assert.equal(validateProjectionV2(large), true);
  assert.deepEqual(await invokeMeaning('assessment', {}, { assess: async () => largeV2() }), large);
  assert.equal((await invokeMeaning('context', {}, { readContext: async () => largeV2() })).reason, 'projection_invalid');
});

test('v2 truncation keeps contribution, coverage and omissions and prunes uncited sources', () => {
  const input = largeV2();
  assert.deepEqual(projectMeaning(input, { operation: 'assessment', maxChars: 20000 }), input);
  const output = projectMeaning(largeV2(), { operation: 'assessment', maxChars: 4000 });
  assert.equal(output.status, 'ok');
  assert.ok(JSON.stringify(output).length <= 4000);
  assert.equal(validateProjectionV2(output), true);
  assert.equal(output.findings.some((finding) => finding.kind === 'inference'), false);
  assert.deepEqual(output.findings.filter((finding) => finding.kind === 'contribution'), [input.findings[5]]);
  for (const finding of output.findings) assert.ok(input.findings.some((original) => JSON.stringify(original) === JSON.stringify(finding)));
  assert.deepEqual(output.coverage, input.coverage);
  for (const reason of [...input.omissions, 'findings_truncated', 'sources_truncated']) assert.ok(output.omissions.includes(reason), reason);
  const cited = new Set(output.findings.flatMap((finding) => finding.sourceRefs));
  assert.deepEqual(output.sources.map((source) => source.ref).sort(), [...cited].sort());
  for (const ref of [LARGE_REFS[5], LARGE_REFS[6]]) assert.equal(output.sources.some((source) => source.ref === ref), false);
  for (const source of output.sources) assert.deepEqual(source, input.sources.find((original) => original.ref === source.ref));

  // A contribution that cannot fit is reported honestly, never replaced.
  const crowded = largeV2();
  crowded.findings = [{ ...crowded.findings[5], sourceRefs: LARGE_REFS }];
  assert.equal(validateProjectionV2(crowded), true);
  const over = projectMeaning(crowded, { operation: 'assessment', maxChars: 2000 });
  assert.equal(over.status, 'unavailable');
  assert.equal(over.reason, 'projection_over_budget');
  assert.equal(JSON.stringify(over).includes('Synthetic excerpt'), false);

  // An unsafe claim that truncation would drop still invalidates the envelope.
  const hidden = largeV2();
  hidden.findings[3].text = 'Draft kept at /Users/example/plan.md for later.';
  assert.equal(projectMeaning(hidden, { operation: 'assessment', maxChars: 4000 }).reason, 'projection_invalid');
});

test('v2 quotes are verbatim verified Andrew excerpts and unverified claims are disclosed', () => {
  for (const [label, mutate] of [
    ['paraphrased quote', (v) => { v.findings[0].text = 'I keep delaying the planning review'; }],
    ['quote from external source', (v) => { v.findings[0].sourceRefs = [REF_E]; }],
    ['quote with two sources', (v) => { v.findings[0].sourceRefs = [REF_A, REF_E]; }],
    ['quote without excerpt', (v) => { v.sources[0].excerpt = null; }],
    ['quote source not andrew verified', (v) => { v.sources[0].origin = 'unverified'; }],
    ['quote source ai generated', (v) => { v.sources[0].origin = 'ai_generated'; }],
    ['observation from unverified source', (v) => { v.findings[1].sourceRefs = [REF_U]; v.findings[2].sourceRefs = [REF_E]; }],
    ['observation mixing unverified', (v) => { v.findings[1].sourceRefs = [REF_E, REF_U]; }],
    ['undisclosed unverified inference', (v) => { v.omissions = []; }],
    ['undisclosed unverified contribution', (v) => {
      v.omissions = []; v.findings[2].sourceRefs = [REF_E]; v.findings[3].sourceRefs = [REF_U];
    }],
    ['two contributions', (v) => { v.findings.push({ ...v.findings[3], text: 'Would a written checklist help?' }); }],
    ['unknown kind', (v) => { v.findings[2].kind = 'belief'; }],
    ['unknown origin', (v) => { v.sources[2].origin = 'self_reported'; }],
  ]) {
    const value = projectionV2(); mutate(value);
    assertV2Invalid(value, label);
  }
  // Disclosure is only needed when no verified source is cited.
  const verifiedInference = projectionV2();
  verifiedInference.omissions = [];
  verifiedInference.findings[2].sourceRefs = [REF_E, REF_U];
  assert.equal(validateProjectionV2(verifiedInference), true);

  // An unsafe non-quoted excerpt is withheld with an omission.
  const withheld = projectionV2();
  withheld.sources[2].excerpt = 'Draft kept at /Users/example/plan.md for later.';
  assert.equal(validateProjectionV2(withheld), false);
  const output = projectMeaning(withheld, { operation: 'assessment' });
  assert.equal(output.status, 'ok');
  assert.equal(output.sources[2].excerpt, null);
  assert.ok(output.omissions.includes('excerpt_withheld'));
  assert.ok(output.omissions.includes('attribution_unverified'));
  assert.deepEqual(output.findings, withheld.findings);
  assert.equal(validateProjectionV2(output), true);
  assert.equal(JSON.stringify(output).includes('/Users'), false);

  // A quoted excerpt can never be withheld: the projection fails closed.
  const quotedUnsafe = projectionV2();
  quotedUnsafe.sources[0].excerpt = 'I keep postponing the planning review; see ../private/plan.md';
  assertV2Invalid(quotedUnsafe, 'unsafe quoted excerpt');
});

test('v2 source references are unique, resolvable, cited and closed', () => {
  const extra = { ref: 'source:' + '5'.repeat(64), label: 'Synthetic extra', sourceClass: 'notes', origin: 'unverified', asOf: null, excerpt: null };
  for (const [label, mutate] of [
    ['unresolved ref', (v) => { v.findings[2].sourceRefs = ['source:' + '9'.repeat(64)]; }],
    ['malformed ref', (v) => { v.findings[2].sourceRefs = ['source:ABC']; }],
    ['non-string ref', (v) => { v.findings[2].sourceRefs = [['source:' + '3'.repeat(64)]]; }],
    ['duplicate ref in finding', (v) => { v.findings[1].sourceRefs = [REF_E, REF_E, REF_A]; }],
    ['duplicate source entry', (v) => { v.sources.push({ ...v.sources[0] }); }],
    ['duplicate source id with other label', (v) => { v.sources.push({ ...v.sources[1], label: 'Synthetic twin' }); }],
    ['uncited source', (v) => { v.sources.push(extra); }],
    ['empty sourceRefs', (v) => { v.findings[2].sourceRefs = []; }],
    ['unknown source key', (v) => { v.sources[1].path = 'x'; }],
    ['missing source key', (v) => { delete v.sources[1].asOf; }],
    ['unknown finding key', (v) => { v.findings[2].confidence = 'high'; }],
    ['unknown envelope key', (v) => { v.rawArtifact = {}; }],
    ['missing sources', (v) => { delete v.sources; }],
    ['too many sources', (v) => {
      for (let index = 0; index < 6; index++) {
        const ref = 'source:' + 'e'.repeat(63) + index;
        v.sources.push({ ...extra, ref }); v.findings[2].sourceRefs.push(ref);
      }
    }],
    ['too many findings', (v) => { while (v.findings.length < 7) v.findings.push({ ...v.findings[2] }); }],
    ['long finding text', (v) => { v.findings[2].text = 'a'.repeat(701); }],
    ['long label', (v) => { v.sources[1].label = 'Label '.repeat(21).slice(0, 121); }],
    ['long excerpt', (v) => { v.sources[2].excerpt = 'Word '.repeat(81).slice(0, 401); }],
    ['unknown source class', (v) => { v.sources[1].sourceClass = 'email'; }],
    ['non-ISO asOf', (v) => { v.sources[1].asOf = '2026-09-08'; }],
    ['findings without ok status', (v) => { v.status = 'abstained'; }],
    ['findings without scope', (v) => { v.scope = null; }],
    ['findings without analysis', (v) => { v.analysis = null; }],
    ['bad omission code', (v) => { v.omissions.push('Not A Code'); }],
    ['duplicate coverage', (v) => { v.coverage.push(v.coverage[0]); }],
  ]) {
    const value = projectionV2(); mutate(value);
    assertV2Invalid(value, label);
  }
});

test('v2 content rejects paths, credentials, control characters and internal packets', () => {
  const readable = 'Planning and/or review happens on 10/19 each cycle.';
  const ok = projectionV2(); ok.findings[2].text = readable; ok.sources[1].label = 'Plan and/or review';
  assert.equal(validateProjectionV2(ok), true);
  // v1 keeps its conservative no-slash rule.
  const v1 = projection(); v1.findings[0].text = readable;
  assert.equal(validateProjection(v1), false);
  for (const bad of [
    '/Users/example/private.md', 'Read /home/example/plan', 'see ./private/plan.md', 'see ../../Vault/plan',
    'notes/private.md', 'notes/private/plan', 'C:\\Users\\example', 'C:/Users/example', '\\\\server\\share\\plan',
    'file:plan.md', 'file:///tmp/example', '~/vault/plan', 'https://example.invalid/plan',
    // Synthetic negative inputs are assembled from fragments so this source
    // carries no literal credential-shaped marker (runtime strings unchanged).
    'author' + 'ization: synthetic', 'Bea' + 'rer ' + 'abcdefghijklmnopqrstuvwxyz123456', 'tok' + 'en=synthetic-value',
    'pass' + 'word: synthetic', '-'.repeat(5) + 'BEG' + 'IN PRIV' + 'ATE KEY' + '-'.repeat(5), 'sk-' + 'a'.repeat(24), 'gh' + 'p_' + 'x'.repeat(36),
    'ey' + 'Jabcdefgh.' + 'ey' + 'Jabcdefgh.signature', 'A'.repeat(48), 'f'.repeat(40),
    'line\u0000break', 'tab\there', 'line\nbreak', 'bidi\u202eoverride', 'zero\u200bwidth',
    'rawArtifact dump', 'promptText follows', 'sourceRegistry entry', 'synthesisPacket body',
    'TypeError: synthetic failure', 'at run (internal.js:10:5)', 'stack trace attached', ' ',
  ]) {
    for (const [label, mutate] of [
      ['finding', (v) => { v.findings[2].text = bad; }],
      ['contribution', (v) => { v.findings[3].text = bad; }],
      ['label', (v) => { v.sources[1].label = bad; }],
    ]) {
      const value = projectionV2(); mutate(value);
      assertV2Invalid(value, `${label}: ${JSON.stringify(bad)}`);
    }
  }
});

test('v2 rejects every invisible and separator code point while the module source stays ASCII', () => {
  // Characters are built from numeric code points so this test file also
  // stays pure ASCII.
  const rejected = [
    0x0000, 0x001f, 0x007f, 0x0085, 0x009f, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029,
    0x202a, 0x202c, 0x202e, 0x2060, 0x2062, 0x2064, 0x2066, 0x2068, 0x2069, 0xfeff,
  ];
  for (const code of rejected) {
    const value = projectionV2();
    value.findings[2].text = 'Synthetic' + String.fromCharCode(code) + 'claim text';
    assertV2Invalid(value, `code point ${code.toString(16)}`);
  }
  // Visible non-ASCII punctuation remains readable.
  const visible = projectionV2();
  visible.findings[2].text = 'A smaller review ' + String.fromCharCode(0x2014) + ' maybe ' + String.fromCharCode(0x201c) + 'lighter' + String.fromCharCode(0x201d) + '.';
  assert.equal(validateProjectionV2(visible), true);
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/ripeness-context'), 'utf8');
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    assert.ok(code === 0x0a || (code >= 0x20 && code < 0x7f), `non-ASCII or control at offset ${index}`);
  }
});
