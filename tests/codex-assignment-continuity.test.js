'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const SESSION = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const continuity = require('../runtimes/codex/assignment-continuity');
const { readNativeTurn, projectedFrames, MAX_TRANSPORT_BYTES } = require('../runtimes/codex/native-turn-reader');

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-assignment-')));
  const command = path.join(root, 'native');
  const requestFile = path.join(root, 'requests');
  const payloadFile = path.join(root, 'request-payloads');
  fs.writeFileSync(command, `#!${process.execPath}
const fs=require('node:fs'), readline=require('node:readline');
const data=JSON.parse(fs.readFileSync(process.env.FIXTURE,'utf8'));
let turnPage=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requestFile)},m.method+'\\n');
 fs.appendFileSync(${JSON.stringify(payloadFile)},JSON.stringify(m)+'\\n');
 const reply=result=>{
  const wire=JSON.stringify({id:m.id,result})+'\\n', marker='"VIRTUAL_OUTPUT"', at=wire.indexOf(marker);
  if(at<0)return process.stdout.write(wire);
  process.stdout.write(wire.slice(0,at)+'"');
  let remaining=data.largeBytes;
  const pump=()=>{
   while(remaining>0){const size=Math.min(remaining,16384);remaining-=size;if(!process.stdout.write('x'.repeat(size)))return process.stdout.once('drain',pump);}
   process.stdout.write('"'+wire.slice(at+marker.length));
  };pump();
 };
 if(data.hang)return;
 if(data.error){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601}})+'\\n');return;}
 if(m.method==='initialize')reply({});
 else if(m.method==='thread/turns/list'){
  const n=turnPage++;
  reply({data:data.turnPages?(data.turnPages[n]||data.turnPages.at(-1)):[{id:data.turnId||${JSON.stringify(TURN)},startedAt:1700000000,status:'interrupted'}],
   nextCursor:Object.hasOwn(data,'turnCursor')?data.turnCursor:(data.turnPages&&n+1<data.turnPages.length?String(n+1):null)});
 }
 else if(m.method==='thread/items/list'){
   const n=m.params.cursor?Number(m.params.cursor):0;
   if(data.pagedItems)reply({data:data.pagedItems.slice(n,n+m.params.limit),nextCursor:n+m.params.limit<data.pagedItems.length?String(n+m.params.limit):null});
   else reply({data:data.pages?data.pages[n]:data.items,nextCursor:data.loop?'same':(data.pages&&n+1<data.pages.length?String(n+1):null)});
 }else if(m.method!=='initialized')process.exit(9);
});
`, { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root, CODEX_THREAD_ID: SESSION,
    JARVOS_CODEX_NATIVE_COMMAND: command, FIXTURE: path.join(root, 'fixture.json') };
  fs.writeFileSync(env.FIXTURE, JSON.stringify({ items: [] }));
  return { root, env, requestFile, payloadFile, set(data) { fs.writeFileSync(env.FIXTURE, JSON.stringify(data)); },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const input = { hook_event_name: 'PreCompact', trigger: 'auto', session_id: SESSION, turn_id: TURN };
const compact = { hook_event_name: 'SessionStart', source: 'compact', session_id: SESSION };
const entry = (item) => ({ turnId: TURN, item });
const peer = (id, body) => entry({ id, type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread',
  output: `<codex_delegation>\n<source_thread_id>${SOURCE}</source_thread_id>\n<input>${body}</input>\n</codex_delegation>` });
const assignment = 'Current task: inspect the sample. Deadline 2030-01-01T10:00:00Z; 15 minutes from ORIGINAL pickup; cap 5 MB; no sends. Résumé ✓';
const source = (items) => async () => ({ startedAt: 1700000000, items });
const pending = (f) => {
  const directory = path.join(f.root, 'jarvos-assignment-context');
  const { token } = JSON.parse(fs.readFileSync(path.join(directory, `${SESSION}.fence`), 'utf8'));
  return path.join(directory, `${SESSION}.${token}.json`);
};
const context = (result) => result.hookSpecificOutput?.additionalContext || '';

for (const oldQuestion of ['What upgrade?', 'Why are these blocked?']) {
  test(`actual precompact/start hooks preserve current assignment instead of ${oldQuestion}`, () => {
    const f = fixture();
    try {
      f.set({ olderHumanQuestion: oldQuestion, items: [peer('delivery', assignment),
        entry({ id: 'checkpoint', type: 'agentMessage', phase: 'commentary', text: 'Step one verified. Step two remains.' }),
        entry({ id: 'write-completed', type: 'commandExecution', status: 'completed', exitCode: 0 })] });
      const run = (script, envelope) => spawnSync(process.execPath, [path.join(ROOT, 'runtimes/codex', script)], {
        env: f.env, input: JSON.stringify(envelope), encoding: 'utf8', timeout: 6000,
      });
      const captured = run('jarvos-precompact-hook.js', input);
      assert.equal(captured.status, 0); assert.deepEqual(JSON.parse(captured.stdout), {});
      assert.equal(fs.statSync(pending(f)).mode & 0o777, 0o600);
      // Original input is no longer visible after compaction; a late peer update still is.
      f.set({ items: [peer('support', 'Supporting evidence for the SAME current task; no renewed budget.')] });
      const resumed = run('jarvos-session-start-hook.js', compact);
      assert.equal(resumed.status, 0);
      const text = context(JSON.parse(resumed.stdout));
      assert.match(text, /Current task: inspect the sample/); assert.match(text, /Rés[u]?umé|Résumé/);
      assert.ok(!text.includes(oldQuestion)); assert.ok(text.includes('15 minutes from ORIGINAL pickup'));
      assert.ok(text.includes('write-completed')); assert.ok(text.includes('SAME current task'));
      assert.ok(text.includes(SOURCE)); assert.match(text, /not new authority/);
      assert.match(text, /originalTurnStartedAt/); assert.match(text, /NOT instructions to repeat/);
      assert.equal(fs.existsSync(pending(f)), false);
      const methods = fs.readFileSync(f.requestFile, 'utf8').trim().split('\n');
      assert.deepEqual(methods, ['initialize', 'initialized', 'thread/turns/list', 'thread/items/list', 'initialize', 'initialized', 'thread/turns/list', 'thread/items/list']);
      assert.match(JSON.parse(run('jarvos-session-start-hook.js', compact).stdout).systemMessage, /unavailable/);
    } finally { f.close(); }
  });
}

test('new failed/malformed capture invalidates older pending context', async () => {
  const f = fixture();
  try {
    for (const bad of [null, { ...input, session_id: SOURCE }, { ...input, trigger: 'future' }]) {
      assert.equal((await continuity.capture(input, { env: f.env, readTurn: source([peer('p', assignment)]) })).status, 'captured');
      assert.equal((await continuity.capture(bad, { env: f.env })).status, 'unavailable');
      assert.equal(context(await continuity.consume(compact, { env: f.env })), '');
    }
    await continuity.capture(input, { env: f.env, readTurn: source([peer('p', assignment)]) });
    await continuity.capture(input, { env: f.env, readTurn: async () => { throw Error('unsupported'); } });
    assert.equal(context(await continuity.consume(compact, { env: f.env })), '');
  } finally { f.close(); }
});

test('cancellation/supersession and ambiguous/completed effects remain attributed evidence, never an execution plan', async () => {
  const f = fixture();
  try {
    const items = [peer('p', assignment), entry({ id: 'effect', type: 'mcpToolCall', status: 'unknown' })];
    await continuity.capture(input, { env: f.env, readTurn: source(items) });
    f.set({ items: [entry({ id: 'cancel', type: 'userMessage', content: [{ type: 'text', text: 'Cancel that task. It is superseded; the earlier write is already complete.' }] })] });
    const text = context(await continuity.consume(compact, { env: f.env }));
    assert.ok(text.includes('Cancel that task.')); assert.ok(text.includes('native-user-input'));
    assert.match(text, /cancelled, superseded or verified completed/);
    assert.match(text, /unknown/); assert.match(text, /do not blindly replay/);
    assert.ok(!text.includes('Resume the assignment'));
  } finally { f.close(); }
});

test('repeat compaction captures fresh source; a late old reader cannot replace it', async () => {
  const f = fixture(); let release;
  try {
    const older = continuity.capture(input, { env: f.env, readTurn: () => new Promise((resolve) => { release = resolve; }) });
    await continuity.capture(input, { env: f.env, readTurn: source([peer('new', 'Current task B, unchanged original caps')]) });
    release({ startedAt: 1700000000, items: [peer('old', 'Task A')] });
    assert.equal((await older).status, 'unavailable');
    assert.match(context(await continuity.consume(compact, { env: f.env })), /Current task B/);
    await continuity.capture(input, { env: f.env, readTurn: source([peer('next', assignment)]) });
    assert.ok(context(await continuity.consume(compact, { env: f.env })).includes(assignment));
  } finally { f.close(); }
});

test('a child capture cannot invalidate its root session capture', async () => {
  const f = fixture();
  try {
    await continuity.capture(input, { env: f.env, readTurn: source([peer('root', assignment)]) });
    assert.equal((await continuity.capture({ ...input, agent_id: 'child' }, { env: f.env })).status, 'unavailable');
    assert.ok(context(await continuity.consume(compact, { env: f.env })).includes(assignment));
  } finally { f.close(); }
});

test('an older process paused at final publication cannot clobber a newer capture', async () => {
  const f = fixture(); let older;
  const ready = path.join(f.root, 'ready'); const release = path.join(f.root, 'release');
  try {
    f.set({ items: [peer('old', 'Task A')] });
    const preload = path.join(f.root, 'pause-publication.cjs');
    fs.writeFileSync(preload, `const fs=require('node:fs'), rename=fs.renameSync;
fs.renameSync=function(from,to){
 let record;try{record=JSON.parse(fs.readFileSync(from,'utf8'));}catch{}
 if(record?.state==='ready'){
  fs.writeFileSync(${JSON.stringify(ready)},'ready');
  const deadline=Date.now()+5000;
  while(!fs.existsSync(${JSON.stringify(release)})){
   if(Date.now()>deadline)throw Error('publication test timeout');
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  }
 }
 return rename.apply(fs,arguments);
};`);
    const hook = path.join(ROOT, 'runtimes/codex/jarvos-precompact-hook.js');
    older = spawn(process.execPath, ['--require', preload, hook], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(older, 'close'); let output = '';
    older.stdout.setEncoding('utf8'); older.stdout.on('data', (data) => { output += data; });
    older.stdin.end(JSON.stringify(input));
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) throw Error('older process never reached publication');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    f.set({ items: [peer('new', 'Current task B')] });
    const newer = spawnSync(process.execPath, [hook], { env: f.env, input: JSON.stringify(input), encoding: 'utf8', timeout: 6000 });
    assert.equal(newer.status, 0, newer.stderr); assert.deepEqual(JSON.parse(newer.stdout), {});
    fs.writeFileSync(release, 'release');
    assert.equal((await closed)[0], 0); assert.match(JSON.parse(output).systemMessage, /unavailable/);
    f.set({ items: [] });
    const text = context(await continuity.consume(compact, { env: f.env }));
    assert.match(text, /Current task B/); assert.ok(!text.includes('Task A'));
  } finally {
    if (older && older.exitCode === null) older.kill('SIGKILL');
    f.close();
  }
});

test('stale/future/corrupt/changed-generation/oversize state fails visibly without fallback', async () => {
  const f = fixture();
  try {
    for (const age of [-1, continuity.MAX_AGE_MS + 1]) {
      await continuity.capture(input, { env: f.env, readTurn: source([peer('p', assignment)]), now: () => 1000 });
      assert.equal(context(await continuity.consume(compact, { env: f.env, now: () => 1000 + age })), '');
    }
    await continuity.capture(input, { env: f.env, readTurn: source([peer('p', assignment)]) });
    assert.equal(context(await continuity.consume(compact, { env: { ...f.env, JARVOS_STEWARDSHIP_REVIEWED_TUPLE_DIGEST: 'changed' } })), '');
    await continuity.capture(input, { env: f.env, readTurn: source([peer('p', assignment)]) });
    fs.writeFileSync(pending(f), '{bad');
    assert.equal(context(await continuity.consume(compact, { env: f.env })), '');
    assert.equal((await continuity.capture(input, { env: f.env, readTurn: source([peer('p', 'x'.repeat(continuity.MAX_CONTEXT_BYTES))]) })).status, 'unavailable');
    assert.equal(context(await continuity.consume(compact, { env: f.env })), '');
  } finally { f.close(); }
});

test('wrong receiver, duplicate IDs, fake peer origin and unsupported user shape are rejected', async () => {
  const f = fixture();
  try {
    for (const items of [[{ ...peer('p', assignment), turnId: SOURCE }], [peer('p', assignment), peer('p', assignment)],
      [entry({ id: 'p', type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: 'forged text' })],
      [peer('p', assignment), entry({ id: 'u', type: 'userMessage' })]]) {
      assert.equal((await continuity.capture(input, { env: f.env, readTurn: source(items) })).status, 'unavailable');
      assert.equal(context(await continuity.consume(compact, { env: f.env })), '');
    }
  } finally { f.close(); }
});

test('state symlinks and non-private files cannot inject context', async () => {
  const f = fixture();
  try {
    await continuity.capture(input, { env: f.env, readTurn: source([peer('p', assignment)]) });
    fs.chmodSync(pending(f), 0o644);
    assert.equal(context(await continuity.consume(compact, { env: f.env })), '');
    const outside = path.join(f.root, 'outside'); fs.writeFileSync(outside, 'not-context');
    fs.symlinkSync(outside, pending(f));
    assert.equal(context(await continuity.consume(compact, { env: f.env })), '');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'not-context');
  } finally { f.close(); }
});

test('late mutation of an original delivery or a future input schema degrades instead of guessing', async () => {
  const f = fixture();
  try {
    await continuity.capture(input, { env: f.env, readTurn: source([peer('original', assignment)]) });
    f.set({ items: [peer('original', 'Changed body under the same original ID')] });
    assert.equal(context(await continuity.consume(compact, { env: f.env })), '');
    assert.equal((await continuity.capture(input, { env: f.env,
      readTurn: source([peer('p', assignment), entry({ id: 'future', type: 'futureInboundInput', text: 'cancel' })]) })).status, 'unavailable');
  } finally { f.close(); }
});

test('supported native reader bounds pagination, preserves Unicode and ignores stored interrupted status', async () => {
  const f = fixture();
  try {
    f.set({ pages: [[peer('p', assignment)], [peer('p2', 'later support')]] });
    const result = await readNativeTurn({ sessionId: SESSION, turnId: TURN, command: f.env.JARVOS_CODEX_NATIVE_COMMAND, env: f.env });
    assert.equal(result.items.length, 2); assert.equal(result.startedAt, 1700000000);
    assert.ok(result.items[0].item.output.includes('Résumé ✓'));
    for (const data of [{ turnId: SOURCE }, { error: true }, { loop: true, items: [] }, { items: [{ ...peer('p', assignment), turnId: SOURCE }] },
      { pages: Array.from({ length: 9 }, () => []) }, { items: [peer('huge', 'x'.repeat(300000))] }]) {
      f.set(data);
      await assert.rejects(readNativeTurn({ sessionId: SESSION, turnId: TURN, command: f.env.JARVOS_CODEX_NATIVE_COMMAND, env: f.env }));
    }
  } finally { f.close(); }
});

test('reader finds only the supplied turn on a later metadata page and keeps its original start', async () => {
  const f = fixture();
  try {
    f.set({ turnPages: [[{ id: SOURCE, startedAt: 1800000000, status: 'completed' }],
      [{ id: TURN, startedAt: 1700000000, status: 'interrupted' }]], items: [peer('p', assignment)] });
    const result = await readNativeTurn({ sessionId: SESSION, turnId: TURN, command: f.env.JARVOS_CODEX_NATIVE_COMMAND, env: f.env });
    assert.equal(result.startedAt, 1700000000); assert.equal(result.items.length, 1);
    const requests = fs.readFileSync(f.payloadFile, 'utf8').trim().split('\n').map(JSON.parse);
    const metadata = requests.filter((message) => message.method === 'thread/turns/list');
    assert.equal(metadata.length, 2); assert.equal(metadata[1].params.cursor, '1');
    assert.ok(metadata.every((message) => message.params.itemsView === 'notLoaded'));
    assert.deepEqual(requests.filter((message) => message.method === 'thread/items/list').map((message) => message.params.turnId), [TURN]);
  } finally { f.close(); }
});

test('metadata lookup rejects absent targets, malformed identities/cursors, repeats and exhausted pages before any item read', async () => {
  const f = fixture();
  try {
    for (const data of [
      { turnPages: [[{ id: SOURCE, startedAt: 1800000000 }]] },
      { turnPages: [[{ id: 'not-a-native-turn', startedAt: 1800000000 }]] },
      { turnPages: [[{ id: SOURCE }, { id: SOURCE }]] },
      { turnPages: [[{ id: SOURCE }], [{ id: SOURCE }]] },
      { turnPages: [[]], turnCursor: 0 },
      { turnPages: [[]], turnCursor: '' },
      { turnPages: [[], []], turnCursor: 'same' },
      { turnPages: [[{ id: TURN }]] },
      { turnPages: Array.from({ length: 9 }, () => []) },
    ]) {
      f.set({ ...data, items: [peer('must-not-read', assignment)] });
      fs.writeFileSync(f.payloadFile, '');
      await assert.rejects(readNativeTurn({ sessionId: SESSION, turnId: TURN, command: f.env.JARVOS_CODEX_NATIVE_COMMAND, env: f.env }), /turn-identity|invalid-cursor|turn-page-limit/);
      const requests = fs.readFileSync(f.payloadFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(!requests.some((message) => message.method === 'thread/items/list'));
      assert.ok(requests.filter((message) => message.method === 'thread/turns/list').length <= 8);
    }
  } finally { f.close(); }
});

test('bounded item batches preserve every receipt and late cancellation beyond 200 records', async () => {
  const f = fixture();
  try {
    const items = Array.from({ length: 250 }, (_, index) => entry({ id: `effect-${index}`, type: 'mcpToolCall', status: 'completed', result: { ignored: 'tool body' } }));
    items.push(peer('late-assignment', assignment), entry({ id: 'late-cancel', type: 'userMessage', content: 'Cancel this task; no more effects.' }));
    f.set({ pagedItems: items });
    const result = await readNativeTurn({ sessionId: SESSION, turnId: TURN, command: f.env.JARVOS_CODEX_NATIVE_COMMAND, env: f.env });
    const projection = continuity.projectItems(result.items, TURN);
    assert.equal(result.items.length, 252); assert.equal(projection.effects.length, 250);
    assert.equal(projection.inputs[1].content, 'Cancel this task; no more effects.');
    assert.ok(projection.inputs[0].body.includes(assignment));
    const reads = fs.readFileSync(f.payloadFile, 'utf8').trim().split('\n').map(JSON.parse).filter((message) => message.method === 'thread/items/list');
    assert.equal(reads.length, 3); assert.ok(reads.every((message) => message.params.limit === 100 && message.params.turnId === TURN));
  } finally { f.close(); }
});

test('complete context above 24 KB preserves original caps, late cancellation and every effect within 64 KiB', async () => {
  const f = fixture();
  try {
    const original = [peer('original', assignment), ...Array.from({ length: 200 }, (_, index) =>
      entry({ id: `effect-${index}`, type: 'mcpToolCall', status: 'completed', result: { discarded: 'body' } }))];
    f.set({ pagedItems: original });
    assert.equal((await continuity.capture(input, { env: f.env })).status, 'captured');
    assert.ok(fs.statSync(pending(f)).size > 24000);
    f.set({ pagedItems: [...original,
      entry({ id: 'late-cancel', type: 'userMessage', content: 'Cancel the original task; its budget is not renewed.' }),
      entry({ id: 'late-effect', type: 'commandExecution', status: 'completed', exitCode: 0 })] });
    const text = context(await continuity.consume(compact, { env: f.env }));
    assert.ok(Buffer.byteLength(text) > 24000); assert.ok(Buffer.byteLength(text) < 64 * 1024);
    assert.ok(text.includes(assignment)); assert.ok(text.includes('Cancel the original task; its budget is not renewed.'));
    const projection = JSON.parse(text.split('\n').at(-1));
    assert.equal(projection.effects.length, 201);
    assert.deepEqual(new Set(projection.effects.map((effect) => effect.id)),
      new Set([...Array.from({ length: 200 }, (_, index) => `effect-${index}`), 'late-effect']));
    assert.equal(projection.originalTurnStartedAt, 1700000000);
    assert.ok(projection.effects.every((effect) => /^[a-f0-9]{64}$/.test(effect.sourceWireDigest)));
    assert.equal(fs.existsSync(pending(f)), false);
    assert.equal((await continuity.capture(input, { env: f.env, readTurn: source([peer('oversize', 'x'.repeat(64 * 1024))]) })).status, 'unavailable');
    await continuity.capture(input, { env: f.env, readTurn: source([peer('small', assignment)]) });
    assert.equal(context(await continuity.consume(compact, { env: f.env,
      readTurn: source([entry({ id: 'oversize-late', type: 'userMessage', content: 'x'.repeat(64 * 1024) })]) })), '');
  } finally { f.close(); }
});

test('reader projects large irrelevant bodies at transport boundary and retains late authority and effect evidence', async () => {
  const f = fixture();
  try {
    const large = entry({ output: 'VIRTUAL_OUTPUT', id: 'large-effect', type: 'functionCallOutput', namespace: 'other', name: 'read' });
    const cancellation = entry({ id: 'late-cancel', type: 'userMessage', content: [{ type: 'text', text: 'Cancel the task; no further sends. ✓' }] });
    f.set({ largeBytes: 2 * 1024 * 1024, pages: [[large], [peer('original', assignment)], [cancellation,
      entry({ id: 'late-completed', type: 'commandExecution', status: 'completed', exitCode: 0 })]] });
    assert.equal((await continuity.capture(input, { env: f.env })).status, 'captured');
    const text = context(await continuity.consume(compact, { env: f.env }));
    assert.ok(text.includes(assignment)); assert.ok(text.includes('Cancel the task; no further sends. ✓'));
    assert.ok(text.includes('large-effect')); assert.ok(text.includes('late-completed'));
    assert.ok(!text.includes('VIRTUAL_OUTPUT')); assert.ok(!text.includes('x'.repeat(1000)));
    assert.ok(Buffer.byteLength(text) < continuity.MAX_CONTEXT_BYTES);
    const projection = JSON.parse(text.split('\n').at(-1));
    const hash = createHash('sha256');
    hash.update('{"output":"');
    for (let n = 0; n < 128; n++) hash.update('x'.repeat(16384));
    hash.update('","id":"large-effect","type":"functionCallOutput","namespace":"other","name":"read"}');
    const receipt = projection.effects.find((item) => item.id === 'large-effect');
    assert.equal(receipt.sourceWireDigest, hash.digest('hex'));
    assert.equal(receipt.sourceDigest, undefined);
  } finally { f.close(); }
});

test('streamed projection validates discarded nested bodies and escapes across every character boundary', () => {
  const ignored = entry({ id: 'ignored', type: 'mcpToolCall', status: 'completed',
    result: { data: Array.from({ length: 7000 }, () => ({ nested: ['quote"', '\\', 'résumé ✓', '\n'] })) } });
  const authority = peer('late', 'Original deadline and cap; "quote", \\ path, résumé ✓');
  const message = { id: 2, result: { data: [ignored, authority], nextCursor: null } };
  let result;
  const parse = projectedFrames((value) => { result = value; });
  const wire = JSON.stringify(message) + '\n';
  for (const char of wire) parse(char);
  assert.equal(result.result.data[0].item.result, undefined);
  assert.equal(result.result.data[1].item.output, authority.item.output);
  for (const bad of [
    '{"id":2,"result":{"data":[{"turnId":"x","item":{"id":"e","type":"mcpToolCall","result":"bad\\q"}}]}}\n',
    '{"id":2,"result":{"data":[{"turnId":"x","item":{"id":"e","type":"mcpToolCall","result":[1,]}}]}}\n',
    '{"id":2,"result":{"data":[],"data":[]}}\n',
    '{"id":2,"result":{"data":[]}}garbage\n',
    '{"id":2,"result":{"data":[]},}\n',
    '{"id":2,"result":{"data":[]}\u00a0}\n',
    '{"id":2,"result":{"data":[]}\n',
    '{"id":2,"result":{"data":[{"item":{"id":"e","type":"mcpToolCall","result":' + '['.repeat(65),
  ]) assert.throws(() => projectedFrames(() => assert.fail('malformed frame accepted'))(bad), /native-reader/);
});

test('finite raw transport traversal fails closed even for discardable output', () => {
  const parse = projectedFrames(() => assert.fail('incomplete oversize frame accepted'));
  const prefix = '{"id":2,"result":{"data":[{"item":{"id":"e","type":"mcpToolCall","output":"';
  const chunk = 'x'.repeat(16384);
  parse(prefix);
  for (let bytes = prefix.length; bytes + chunk.length <= MAX_TRANSPORT_BYTES; bytes += chunk.length) parse(chunk);
  assert.throws(() => parse(chunk), /transport-limit/);
});

test('native reader timeout is bounded and has no model/dispatch fallback', async () => {
  const f = fixture();
  try {
    f.set({ hang: true });
    const start = Date.now();
    await assert.rejects(readNativeTurn({ sessionId: SESSION, turnId: TURN, command: f.env.JARVOS_CODEX_NATIVE_COMMAND, env: f.env }), /timeout/);
    assert.ok(Date.now() - start < 4500);
    assert.deepEqual(fs.readFileSync(f.requestFile, 'utf8').trim().split('\n'), ['initialize']);
  } finally { f.close(); }
});

test('setup opts into both owned hooks with bounded full context and preserves unrelated hooks on rollback', () => {
  const f = fixture();
  try {
    const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const config = path.join(f.root, 'config.toml');
    const original = '[hooks]\nSessionStart = [{matcher="startup", hooks=[{type="command",command="user-start"}]}]\nPreCompact = [{hooks=[{type="command",command="user-precompact"}]}]\n';
    fs.writeFileSync(config, original);
    const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, HOME: path.join(f.root, 'home'), CODEX_CONFIG: config,
      JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_CODEX_PROVIDER_MODE: 'disabled' };
    const setup = (extra = {}) => spawnSync('/bin/bash', [path.join(ROOT, 'runtimes/codex/setup.sh')], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
    const enabled = setup(); assert.equal(enabled.status, 0, enabled.stderr);
    const configured = fs.readFileSync(config, 'utf8');
    assert.match(configured, /startup\|resume\|compact/); assert.match(configured, /additionalContextLimit = 0/);
    assert.match(configured, /jarvos-precompact-hook/); assert.match(configured, /user-precompact/);
    assert.match(configured, /JARVOS_CODEX_NATIVE_COMMAND/);
    assert.equal(setup().status, 0); assert.equal(fs.readFileSync(config, 'utf8'), configured);
    fs.unlinkSync(f.env.JARVOS_CODEX_NATIVE_COMMAND);
    const rolledBack = setup({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' }); assert.equal(rolledBack.status, 0, rolledBack.stderr);
    const restored = fs.readFileSync(config, 'utf8');
    assert.match(restored, /user-start/); assert.match(restored, /user-precompact/);
    assert.doesNotMatch(restored, /jarvos-precompact-hook|JARVOS_CODEX_NATIVE_COMMAND|jarvos-session-start-hook/);
  } finally { f.close(); }
});

test('compact owning hook never hydrates/registers ordinary startup', () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-continuity-')));
  try {
    const marker = path.join(temp, 'startup-called');
    const preload = path.join(temp, 'preload.js');
    fs.writeFileSync(preload, `require.cache[${JSON.stringify(path.join(ROOT, 'modules/jarvos-agent-context/src/index.js'))}] = {exports:{hydrate:async()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'called');return {markdown:'ordinary startup'};}}};`);
    const child = spawnSync(process.execPath, ['--require', preload, path.join(ROOT, 'runtimes/codex/jarvos-session-start-hook.js')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: SESSION }),
      env: { PATH: '/usr/bin:/bin', HOME: temp, CODEX_HOME: temp, CODEX_THREAD_ID: SESSION }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 0);
    assert.equal(fs.existsSync(marker), false, 'compact must bypass startup hydration');
    assert.match(JSON.parse(child.stdout).systemMessage, /continuity unavailable/i);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
