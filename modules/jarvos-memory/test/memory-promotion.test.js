'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  reviewCandidate,
  reviewKnowledgeUnitCandidate,
  promoteCandidate,
  recallMemory,
  reflectOnMemory,
} = require('../src/lib/memory-promotion');
const { HindsightAdapter } = require('../src/lib/hindsight-adapter');
const { MEMORY_STAGES, MEMORY_PROMOTION_THRESHOLD } = require('../src/lib/memory-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-promotion-test-'));
  fs.mkdirSync(path.join(dir, 'memory', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'memory', 'lessons'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'memory', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# MEMORY\n\n', 'utf8');
  return dir;
}

function removeTempWorkspace(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Make a HindsightAdapter that always fails to ping (simulates Hindsight offline). */
function offlineAdapter() {
  return new HindsightAdapter({ apiUrl: 'http://localhost:19999', timeoutMs: 100 });
}

/** Minimal stub Hindsight server. */
function makeStubServer() {
  const retained = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200); res.end(JSON.stringify({ status: 'ok' })); return;
      }
      if (req.method === 'POST' && req.url === '/retain') {
        retained.push(parsed);
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }
      if (req.method === 'POST' && req.url === '/recall') {
        res.writeHead(200); res.end(JSON.stringify({ results: [{ text: 'recalled fact' }] })); return;
      }
      if (req.method === 'POST' && req.url === '/reflect') {
        res.writeHead(200); res.end(JSON.stringify({ text: 'reflected answer' })); return;
      }
      res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return { server, retained };
}

// ---------------------------------------------------------------------------
// reviewCandidate tests
// ---------------------------------------------------------------------------

describe('reviewCandidate()', () => {
  it('rejects events with no content', () => {
    const r = reviewCandidate({});
    assert.strictEqual(r.shouldPromote, false);
    assert.ok(r.reason.includes('no content'));
  });

  it('rejects events with no salienceClass or memoryClass', () => {
    const r = reviewCandidate({ text: 'something happened' });
    assert.strictEqual(r.shouldPromote, false);
  });

  it('rejects unmapped salienceClass', () => {
    const r = reviewCandidate({ text: 'test', salienceClass: 'nothing' });
    assert.strictEqual(r.shouldPromote, false);
  });

  it('rejects low-confidence events', () => {
    const r = reviewCandidate({
      text: 'Andrew uses dark mode',
      salienceClass: 'preference',
      confidence: 0.5,
    });
    assert.strictEqual(r.shouldPromote, false);
    assert.ok(r.reason.includes('below threshold'));
  });

  it('accepts events at or above the confidence threshold', () => {
    const r = reviewCandidate({
      text: 'Andrew uses dark mode',
      salienceClass: 'preference',
      confidence: MEMORY_PROMOTION_THRESHOLD,
    });
    assert.strictEqual(r.shouldPromote, true);
    assert.strictEqual(r.memoryClass, 'preference');
  });

  it('accepts events with no confidence score (threshold not applied)', () => {
    const r = reviewCandidate({ text: 'Use haiku for lightweight tasks', salienceClass: 'preference' });
    assert.strictEqual(r.shouldPromote, true);
  });

  it('accepts events with explicit memoryClass, bypassing salienceClass', () => {
    const r = reviewCandidate({ text: 'explicit decision', memoryClass: 'decision' });
    assert.strictEqual(r.shouldPromote, true);
    assert.strictEqual(r.memoryClass, 'decision');
  });

  it('rejects events with unknown explicit memoryClass', () => {
    const r = reviewCandidate({ text: 'test', memoryClass: 'unknown-class' });
    assert.strictEqual(r.shouldPromote, false);
  });

  it('maps decision salienceClass to decision memoryClass', () => {
    const r = reviewCandidate({ text: 'we decided to go with X', salienceClass: 'decision' });
    assert.strictEqual(r.memoryClass, 'decision');
  });

  it('maps belief_change to fact', () => {
    const r = reviewCandidate({ text: 'changed view on Y', salienceClass: 'belief_change' });
    assert.strictEqual(r.memoryClass, 'fact');
  });

  it('maps lesson salienceClass to lesson memoryClass', () => {
    const r = reviewCandidate({ text: 'learned that Z', salienceClass: 'lesson' });
    assert.strictEqual(r.memoryClass, 'lesson');
  });
});

// ---------------------------------------------------------------------------
// promoteCandidate tests
// ---------------------------------------------------------------------------

describe('promoteCandidate() — rejected events', () => {
  it('returns REJECTED stage for events that fail reviewCandidate', () => {
    const result = promoteCandidate({ text: 'test', salienceClass: 'nothing' });
    assert.strictEqual(result.stage, MEMORY_STAGES.REJECTED);
  });

  it('returns no error field for rejected events (rejection is normal flow)', () => {
    const result = promoteCandidate({});
    assert.strictEqual(result.stage, MEMORY_STAGES.REJECTED);
    assert.strictEqual(result.error, null);
  });
});

describe('promoteCandidate() — local-first file promotion', () => {
  let workspace;

  before(() => {
    workspace = makeTempWorkspace();
    process.env.CLAWD_DIR = workspace;
  });

  after(() => {
    delete process.env.CLAWD_DIR;
    removeTempWorkspace(workspace);
  });

  it('promotes a preference event to MEMORY.md', () => {
    const result = promoteCandidate({
      text: 'Andrew prefers concise output',
      salienceClass: 'preference',
    });

    assert.strictEqual(result.stage, MEMORY_STAGES.PROMOTED);
    assert.strictEqual(result.memoryClass, 'preference');
    assert.ok(result.record);
    assert.strictEqual(result.written, true);
    assert.ok(result.path);

    const registry = fs.readFileSync(path.join(workspace, 'MEMORY.md'), 'utf8');
    assert.ok(registry.includes('Andrew prefers concise output'));
  });

  it('promotes a decision event to decisions directory', () => {
    const result = promoteCandidate({
      text: 'Decided to use local file memory as the default path',
      salienceClass: 'decision',
      rationale: 'OpenClaw diary plus local file records covers the intended flow',
      source: 'SUP-596',
    });

    assert.strictEqual(result.stage, MEMORY_STAGES.PROMOTED);
    assert.strictEqual(result.memoryClass, 'decision');
    assert.ok(result.path);
    assert.ok(result.path.includes('decisions'));
    assert.ok(fs.existsSync(result.path));
  });

  it('promotes a lesson event to lessons directory', () => {
    const result = promoteCandidate({
      text: 'Mocked tests passed but prod migration failed, always use real DB in tests',
      salienceClass: 'lesson',
    });

    assert.strictEqual(result.stage, MEMORY_STAGES.PROMOTED);
    assert.strictEqual(result.memoryClass, 'lesson');
    assert.ok(result.path && result.path.includes('lessons'));
  });

  it('promotes a fact via explicit memoryClass', () => {
    const result = promoteCandidate({
      text: 'The primary dev port is 3100',
      memoryClass: 'fact',
    });

    assert.strictEqual(result.stage, MEMORY_STAGES.PROMOTED);
    assert.strictEqual(result.memoryClass, 'fact');
  });

  it('returns an error when createMemoryRecord rejects a duplicate', () => {
    promoteCandidate({
      text: 'Andrew prefers concise output',
      salienceClass: 'preference',
    });

    const duplicate = promoteCandidate({
      text: 'Andrew prefers concise output',
      salienceClass: 'preference',
    });

    assert.strictEqual(duplicate.stage, MEMORY_STAGES.REJECTED);
    assert.ok(duplicate.error);
    assert.strictEqual(duplicate.reason, 'createMemoryRecord failed');
  });
});

describe('knowledgeUnit promotion gates', () => {
  let workspace;

  before(() => {
    workspace = makeTempWorkspace();
    process.env.CLAWD_DIR = workspace;
  });

  after(() => {
    delete process.env.CLAWD_DIR;
    removeTempWorkspace(workspace);
  });

  function knowledgeUnit(overrides = {}) {
    return {
      id: 'ku_test',
      kind: 'claim',
      text: 'Generated wiki pages are rebuildable from source notes.',
      source: {
        type: 'note',
        path: 'Notes/Generated Wiki.md',
      },
      confidence: 0.8,
      evidence: [{
        type: 'note',
        sourcePath: 'Notes/Generated Wiki.md',
        quote: 'Generated wiki pages are rebuildable from source notes.',
        bodySha256: 'abc123',
      }],
      privacyDecision: {
        tier: 'local-private',
        excludedFromPromotion: false,
      },
      downstreamEligibility: {
        memoryPromotion: true,
      },
      ...overrides,
    };
  }

  it('accepts cited eligible knowledge units', () => {
    const review = reviewKnowledgeUnitCandidate({
      knowledgeUnit: knowledgeUnit(),
    });

    assert.equal(review.shouldPromote, true);
    assert.equal(review.memoryClass, 'fact');
  });

  it('rejects uncited knowledge units', () => {
    const review = reviewCandidate({
      knowledgeUnit: knowledgeUnit({ evidence: [] }),
    });

    assert.equal(review.shouldPromote, false);
    assert.match(review.reason, /requires source evidence/);
  });

  it('rejects sensitive knowledge units', () => {
    const review = reviewCandidate({
      knowledgeUnit: knowledgeUnit({
        privacyDecision: {
          tier: 'sensitive',
          excludedFromPromotion: true,
        },
      }),
    });

    assert.equal(review.shouldPromote, false);
    assert.match(review.reason, /privacy tier 'sensitive'/);
  });

  it('rejects raw transcript promotion', () => {
    const review = reviewCandidate({
      text: 'Raw transcript line',
      memoryClass: 'fact',
      source: { type: 'transcript' },
    });

    assert.equal(review.shouldPromote, false);
    assert.match(review.reason, /raw transcript/);
  });

  it('rejects raw source-backed CaptureEvent v2 events before knowledge-unit promotion', () => {
    const review = reviewCandidate({
      schemaVersion: '2.0',
      text: 'Raw session line should not enter durable memory directly.',
      memoryClass: 'fact',
      source: {
        tool: 'codex',
        sessionId: 'codex-session-1',
      },
    });

    assert.equal(review.shouldPromote, false);
    assert.match(review.reason, /source-backed captures/);
  });

  it('rejects knowledge units when event text differs from the cited unit text', () => {
    const review = reviewCandidate({
      text: 'Unverified wrapper text.',
      knowledgeUnit: knowledgeUnit({
        text: 'Verified cited unit text.',
        evidence: [{ sourcePath: 'Notes/Unit.md', quote: 'Verified cited unit text.' }],
      }),
    });

    assert.equal(review.shouldPromote, false);
    assert.match(review.reason, /must match knowledgeUnit\.text/);
  });

  it('rejects knowledge units that opt out of memory promotion', () => {
    const review = reviewCandidate({
      knowledgeUnit: knowledgeUnit({
        downstreamEligibility: {
          memoryPromotion: false,
        },
      }),
    });

    assert.equal(review.shouldPromote, false);
    assert.match(review.reason, /memoryPromotion is false/);
  });

  it('promotes cited knowledge units through the local file path', () => {
    const result = promoteCandidate({
      knowledgeUnit: knowledgeUnit({
        kind: 'preference',
        text: 'Andrew prefers concise engineering updates.',
      }),
    });

    assert.equal(result.stage, 'promoted');
    assert.equal(result.memoryClass, 'preference');
    assert.equal(result.record.content, 'Andrew prefers concise engineering updates.');
  });
});

// ---------------------------------------------------------------------------
// recallMemory / reflectOnMemory tests
// ---------------------------------------------------------------------------

describe('recallMemory() — Hindsight offline', () => {
  it('returns empty results when Hindsight unavailable', async () => {
    const result = await recallMemory('test query', offlineAdapter());
    assert.deepStrictEqual(result.results, []);
    assert.strictEqual(result.hindsightOk, false);
    assert.ok(result.error);
  });
});

describe('reflectOnMemory() — Hindsight offline', () => {
  it('returns null text when Hindsight unavailable', async () => {
    const result = await reflectOnMemory('test query', offlineAdapter());
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.hindsightOk, false);
  });
});

describe('recallMemory() + reflectOnMemory() — stub server', () => {
  let server;
  let port;
  let adapter;

  before(async () => {
    const stub = makeStubServer();
    server = stub.server;
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
    adapter = new HindsightAdapter({ apiUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('recallMemory returns results from Hindsight', async () => {
    const result = await recallMemory('output style', adapter);
    assert.strictEqual(result.hindsightOk, true);
    assert.ok(result.results.length >= 1);
    assert.ok(result.results[0].length > 0);
  });

  it('reflectOnMemory returns synthesized text', async () => {
    const result = await reflectOnMemory('how should I format output?', adapter);
    assert.strictEqual(result.hindsightOk, true);
    assert.ok(typeof result.text === 'string' && result.text.length > 0);
  });
});
