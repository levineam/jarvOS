'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const {
  TRANSCRIPT_PACKET_SCHEMA,
  TRANSCRIPT_REQUEST_SCHEMA,
  TRANSCRIPT_STATUS,
  CassTranscriptAdapter,
  createTranscriptRequest,
  redactTranscriptText,
} = require('../src/lib/transcript-retrieval.js');

function ok(stdout, extra = {}) {
  return {
    ok: true,
    status: 0,
    signal: null,
    timedOut: false,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
    error: null,
    ...extra,
  };
}

function failed(error = 'command failed', extra = {}) {
  return {
    ok: false,
    status: 1,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: 'private stderr must not enter the packet',
    error,
    ...extra,
  };
}

function preflightRunner(calls, pack = () => ok({ results: [] })) {
  return (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    const subcommand = args.find((arg) => ['api-version', 'capabilities', 'pack', 'sessions'].includes(arg));
    if (subcommand === 'api-version') return ok({ version: '0.6.23', contract_version: 1 });
    if (subcommand === 'capabilities') {
      return ok({
        contract_version: 1,
        commands: ['pack', 'sessions'],
        modes: ['lexical'],
        sources: ['codex', 'claude'],
      });
    }
    if (subcommand === 'pack') return pack(command, args, options);
    return failed('unexpected command');
  };
}

function request(overrides = {}) {
  const result = createTranscriptRequest({
    query: 'deployment decision',
    connectors: ['codex', 'claude_code'],
    destinationClass: 'on_demand_agent',
    since: '2026-07-01T00:00:00.000Z',
    until: '2026-07-31T23:59:59.999Z',
    ...overrides,
  });
  assert.equal(result.valid, true, result.errors.join('; '));
  return result.request;
}

test('defines a versioned request contract and rejects unsafe modes', () => {
  const result = createTranscriptRequest({
    query: 'deployment decision',
    connectors: ['codex', 'claude_code'],
    destinationClass: 'nightly_synthesis',
    freshness: 'strict',
  });

  assert.equal(result.valid, true);
  assert.equal(result.request.schema, TRANSCRIPT_REQUEST_SCHEMA);
  assert.equal(result.request.mode, 'lexical');
  assert.equal(result.request.destinationClass, 'nightly_synthesis');
  assert.equal(result.request.maxTokens, 3000);

  for (const unsafe of [
    { remote: true },
    { mode: 'semantic' },
    { operation: 'refresh' },
    { operation: 'export' },
    { command: 'support-bundle' },
    { query: '--mode=semantic' },
  ]) {
    const rejected = createTranscriptRequest({ query: 'x', ...unsafe });
    assert.equal(rejected.valid, false, JSON.stringify(unsafe));
  }
});

test('preflight discovers documented CASS connector slugs and capabilities', () => {
  const calls = [];
  const adapter = new CassTranscriptAdapter({
    cassBin: 'cass',
    runner: preflightRunner(calls),
  });

  const result = adapter.preflight();
  assert.equal(result.ok, true);
  assert.equal(result.contractVersion, 1);
  assert.deepEqual(result.connectors.map((item) => item.id), ['codex', 'claude_code']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.args[0]), ['api-version', 'capabilities']);
});

test('keeps a configured data directory off CASS global introspection but supplies it to retrieval', () => {
  const calls = [];
  const dataDir = '/private/cass-data';
  const adapter = new CassTranscriptAdapter({
    cassBin: 'cass',
    dataDir,
    runner: preflightRunner(calls),
  });

  const preflight = adapter.preflight();
  assert.equal(preflight.ok, true);
  assert.deepEqual(calls.map((call) => call.args), [
    ['api-version', '--json'],
    ['capabilities', '--json'],
  ]);
  assert.deepEqual(adapter.buildArgs('pack', ['query', '--json']), [
    'pack', 'query', '--json', '--data-dir', dataDir,
  ]);
});

test('uses the documented CASS pack JSON flags without unsupported robot metadata', () => {
  const adapter = new CassTranscriptAdapter();
  const args = adapter.buildPackArgs(request(), 'codex');
  assert.equal(args.includes('--json'), true);
  assert.equal(args.includes('--robot-meta'), false);
});

test('retrieves bounded, cited evidence with deterministic de-duplication', () => {
  const calls = [];
  const adapter = new CassTranscriptAdapter({
    cassBin: 'cass',
    runner: preflightRunner(calls, (_command, args) => {
      const source = args[args.indexOf('--agent') + 1];
      if (source === 'codex') {
        return ok({
          results: [
            {
              source: 'codex',
              session_id: 'codex-session-1',
              timestamp: '2026-07-20T12:00:00.000Z',
              score: 0.95,
              citation: 'turn:12',
              snippet: 'Use a bounded transcript packet.',
            },
            {
              source: 'codex',
              session_id: 'codex-session-1',
              timestamp: '2026-07-20T12:00:00.000Z',
              score: 0.95,
              citation: 'turn:12',
              snippet: 'Use a bounded transcript packet.',
            },
          ],
        });
      }
      return ok({
        results: [{
          source: 'claude',
          session_id: 'claude-session-2',
          timestamp: '2026-07-21T12:00:00.000Z',
          score: 0.9,
          citation: 'turn:4',
          snippet: 'Keep the adapter optional.',
        }],
      });
    }),
  });

  const first = adapter.retrieve(request());
  const second = adapter.retrieve(request());
  assert.equal(first.schema, TRANSCRIPT_PACKET_SCHEMA);
  assert.equal(first.status, TRANSCRIPT_STATUS.EVIDENCE_FOUND);
  assert.equal(first.evidence.length, 2);
  assert.deepEqual(first.evidence.map((item) => item.id), second.evidence.map((item) => item.id));
  assert.equal(first.evidence.every((item) => item.untrustedContent === true), true);
  assert.equal(first.evidence.some((item) => Object.prototype.hasOwnProperty.call(item, 'path')), false);
  assert.equal(first.connectorOutcomes.find((item) => item.connector === 'codex').evidenceCount, 1);
  assert.equal(calls.filter((call) => call.args.includes('api-version')).length, 1);
});

test('normalizes the documented CASS pack evidence citation shape without exposing source paths', () => {
  const adapter = new CassTranscriptAdapter({
    sourceRoots: ['/safe/codex'],
    runner: preflightRunner([], () => ok({
      evidence: [{
        excerpt: 'A bounded, untrusted transcript excerpt.',
        rank: 1,
        citation: {
          agent: 'codex',
          conversation_id: 'codex-session-42',
          created_at_ms: Date.parse('2026-07-20T12:00:00.000Z'),
          source_path: '/safe/codex/sessions/session.jsonl',
          message_index: 7,
          line_start: 120,
          line_end: 124,
        },
      }],
    })),
  });

  const packet = adapter.retrieve(request({ connectors: ['codex'] }));
  assert.equal(packet.status, TRANSCRIPT_STATUS.EVIDENCE_FOUND);
  assert.equal(packet.evidence.length, 1);
  assert.equal(packet.evidence[0].connector, 'codex');
  assert.equal(packet.evidence[0].sessionId, 'codex-session-42');
  assert.equal(packet.evidence[0].observedAt, '2026-07-20T12:00:00.000Z');
  assert.equal(packet.evidence[0].citation, 'message:7');
  assert.equal(Object.prototype.hasOwnProperty.call(packet.evidence[0], 'path'), false);
});

test('accepts only verified CASS-redacted source labels, never arbitrary relative paths', () => {
  const row = {
    excerpt: 'A bounded, untrusted transcript excerpt.',
    citation: {
      agent: 'codex',
      conversation_id: 'codex-session-redacted',
      created_at_ms: Date.parse('2026-07-20T12:00:00.000Z'),
      source_path: '[REDACTED_PATH]/session.jsonl',
      message_index: 9,
      line_start: 90,
      verified: true,
    },
    redactions: [{ kind: 'private_path' }],
  };
  const adapter = new CassTranscriptAdapter({
    sourceRoots: ['/safe/codex'],
    runner: preflightRunner([], () => ok({ evidence: [row] })),
  });

  const accepted = adapter.retrieve(request({ connectors: ['codex'] }));
  assert.equal(accepted.status, TRANSCRIPT_STATUS.EVIDENCE_FOUND);
  assert.equal(accepted.evidence.length, 1);

  row.citation.verified = false;
  const denied = new CassTranscriptAdapter({
    sourceRoots: ['/safe/codex'],
    runner: preflightRunner([], () => ok({ evidence: [row] })),
  }).retrieve(request({ connectors: ['codex'] }));
  assert.equal(denied.evidence.length, 0);
  assert.match(denied.omissions.join(' '), /unverified_redacted_path/);
});

test('reports partial coverage when one source succeeds without hits and another fails', () => {
  const calls = [];
  const adapter = new CassTranscriptAdapter({
    runner: preflightRunner(calls, (_command, args) => {
      const source = args[args.indexOf('--agent') + 1];
      return source === 'codex' ? ok({ results: [] }) : failed('timed out', { timedOut: true });
    }),
  });

  const packet = adapter.retrieve(request());
  assert.equal(packet.status, TRANSCRIPT_STATUS.PARTIAL);
  assert.equal(packet.evidence.length, 0);
  assert.match(packet.warnings.join(' '), /claude_code|partial|failed|timeout/i);
  assert.equal(packet.rawDiagnostics, undefined);
});

test('omits stale and malformed evidence as unavailable or invalid provenance', () => {
  const calls = [];
  const adapter = new CassTranscriptAdapter({
    sourceRoots: ['/var/lib/cass/transcripts'],
    runner: preflightRunner(calls, () => ok({
      stale: true,
      results: [
        {
          source: 'codex',
          session_id: 'codex-session-stale',
          timestamp: '2026-07-20T12:00:00.000Z',
          snippet: 'stale result',
          path: '/var/lib/cass/transcripts/ok.jsonl',
        },
      ],
    })),
  });

  const packet = adapter.retrieve(request({ connectors: ['codex'], freshness: 'strict' }));
  assert.equal(packet.status, TRANSCRIPT_STATUS.UNAVAILABLE);
  assert.equal(packet.evidence.length, 0);
  assert.match(packet.omissions.join(' '), /stale/i);

  const malformed = new CassTranscriptAdapter({
    sourceRoots: ['/var/lib/cass/transcripts'],
    runner: preflightRunner([], () => ok({
      results: [
        { source: 'codex', session_id: '../forged', timestamp: '2099-01-01T00:00:00.000Z', snippet: 'bad' },
        { source: 'codex', session_id: 'valid', timestamp: '2026-07-20T12:00:00.000Z', snippet: 'bad path', path: '/tmp/outside.jsonl' },
      ],
    })),
  });
  const malformedPacket = malformed.retrieve(request({ connectors: ['codex'] }));
  assert.equal(malformedPacket.evidence.length, 0);
  assert.ok(malformedPacket.omissions.some((item) => /invalid_provenance/.test(item)));
});

test('uses fixed argv, no shell, minimal environment, and bounded output', () => {
  const calls = [];
  const adapter = new CassTranscriptAdapter({
    cassBin: '/opt/local/bin/cass',
    maxOutputBytes: 1024,
    runner: preflightRunner(calls, (_command, args, options) => {
      assert.equal(options.shell, false);
      assert.equal(options.maxOutputBytes, 1024);
      assert.equal(Object.prototype.hasOwnProperty.call(options.env, 'OPENAI_API_KEY'), false);
      assert.equal(args.includes('--refresh'), false);
      assert.equal(args.includes('--remote'), false);
      assert.equal(args.includes('--semantic'), false);
      assert.equal(args.includes('--export'), false);
      assert.equal(args.includes('deployment; touch /tmp/owned'), true);
      return ok({ results: [] });
    }),
  });
  const packet = adapter.retrieve(request({ query: 'deployment; touch /tmp/owned' }));
  assert.equal(packet.status, TRANSCRIPT_STATUS.NO_EVIDENCE);
  assert.equal(calls.every((call) => call.command === '/opt/local/bin/cass'), true);
  assert.equal(calls.every((call) => call.options.env.PATH), true);
  assert.equal(calls.some((call) => Object.keys(call.options.env).some((key) => /KEY|TOKEN|SECRET/i.test(key))), false);
});

test('normalizes schema-tagged requests before retrieval and preserves bounded defaults', () => {
  const calls = [];
  const adapter = new CassTranscriptAdapter({
    runner: preflightRunner(calls),
  });

  const packet = adapter.retrieve({
    schema: TRANSCRIPT_REQUEST_SCHEMA,
    query: 'schema tagged request',
    connectors: ['codex'],
    destinationClass: 'on_demand_agent',
    freshness: 'strict',
    maxTokens: 999999,
    maxExcerptChars: 999999,
  });
  const packCall = calls.find((call) => call.args[0] === 'pack');
  assert.ok(packCall);
  assert.equal(packCall.args[packCall.args.indexOf('--max-tokens') + 1], '3000');
  assert.equal(packCall.args[packCall.args.indexOf('--max-evidence') + 1], '12');
  assert.equal(packCall.args[packCall.args.indexOf('--max-sessions') + 1], '6');
  assert.equal(packCall.args[packCall.args.indexOf('--max-excerpt-chars') + 1], '4000');
  assert.equal(packCall.args.includes('--freshness-policy'), true);
  assert.ok([TRANSCRIPT_STATUS.NO_EVIDENCE, TRANSCRIPT_STATUS.EVIDENCE_FOUND].includes(packet.status));
});

test('degrades safely on timeout and oversized output without leaking stderr or paths', () => {
  const timeoutAdapter = new CassTranscriptAdapter({
    runner: (command, args) => {
      if (args[0] === 'api-version') return ok({ version: '0.6.23', contract_version: 1 });
      if (args[0] === 'capabilities') return ok({ contract_version: 1, commands: ['pack'], modes: ['lexical'], sources: ['codex'] });
      return failed('private error /Users/example/private.jsonl', { timedOut: true, stderr: 'secret stderr' });
    },
  });
  const timeoutPacket = timeoutAdapter.retrieve(request({ connectors: ['codex'] }));
  assert.equal(timeoutPacket.status, TRANSCRIPT_STATUS.UNAVAILABLE);
  assert.equal(JSON.stringify(timeoutPacket).includes('private.jsonl'), false);
  assert.equal(JSON.stringify(timeoutPacket).includes('secret stderr'), false);

  const oversizedAdapter = new CassTranscriptAdapter({
    maxOutputBytes: 32,
    runner: (command, args) => {
      if (args[0] === 'api-version') return ok({ version: '0.6.23', contract_version: 1 });
      if (args[0] === 'capabilities') return ok({ contract_version: 1, commands: ['pack'], modes: ['lexical'], sources: ['codex'] });
      return ok('x'.repeat(1024));
    },
  });
  const oversizedPacket = oversizedAdapter.retrieve(request({ connectors: ['codex'] }));
  assert.equal(oversizedPacket.status, TRANSCRIPT_STATUS.UNAVAILABLE);
  assert.ok(oversizedPacket.omissions.some((item) => /output|oversize|malformed/i.test(item)));
});

test('redacts credential-shaped transcript text before it enters evidence', () => {
  const redacted = redactTranscriptText('Authorization: Bearer super-secret-token OPENAI_API_KEY=sk-12345678901234567890 GITHUB_TOKEN=ghp_12345678901234567890 CLIENT_SECRET=super-secret-value');
  assert.equal(redacted.allowed, true);
  assert.equal(redacted.text.includes('super-secret-token'), false);
  assert.equal(redacted.text.includes('sk-12345678901234567890'), false);
  assert.equal(redacted.text.includes('ghp_12345678901234567890'), false);
  assert.equal(redacted.text.includes('super-secret-value'), false);
  assert.equal(redacted.redacted, true);
});

test('keeps low requested budgets renderable and marks evidence dropped by the envelope budget as partial', () => {
  const normalized = createTranscriptRequest({ query: 'bounded', maxTokens: 64 });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.request.maxTokens, 512);

  const adapter = new CassTranscriptAdapter({
    runner: preflightRunner([], (_command, args) => {
      const source = args[args.indexOf('--agent') + 1];
      return ok({
        results: Array.from({ length: 20 }, (_, index) => ({
          source,
          session_id: `${source}-${index}`,
          timestamp: '2026-07-20T12:00:00.000Z',
          citation: `turn:${index}`,
          snippet: `GITHUB_TOKEN=ghp_12345678901234567890 ${'evidence '.repeat(500)}`,
        })),
      });
    }),
  });
  const packet = adapter.retrieve(request({ maxTokens: 64 }));
  assert.ok(packet.renderedTokenCount <= 512, `renderedTokenCount=${packet.renderedTokenCount}`);
  assert.equal(packet.status, TRANSCRIPT_STATUS.PARTIAL);
  assert.equal(packet.omissions.includes('aggregate_budget'), true);
});

test('counts the final renderedTokenCount field inside the aggregate budget', () => {
  const adapter = new CassTranscriptAdapter({
    runner: preflightRunner([], (_command, args) => {
      const source = args[args.indexOf('--agent') + 1];
      return ok({
        results: [{
          source,
          session_id: `${source}-0`,
          timestamp: '2026-07-20T12:00:00.000Z',
          citation: 'turn:0',
          snippet: 'x'.repeat(486),
        }],
      });
    }),
  });
  const packet = adapter.retrieve(request({
    connectors: ['codex', 'claude_code'],
    maxTokens: 512,
    maxEvidence: 2,
    maxSessions: 2,
    maxExcerptChars: 486,
  }));
  assert.ok(packet.renderedTokenCount <= 512, `renderedTokenCount=${packet.renderedTokenCount}`);
  assert.equal(packet.evidence.length, 2);
});

test('bounds invalid-request diagnostics without echoing oversized input', () => {
  const adapter = new CassTranscriptAdapter({ runner: preflightRunner([]) });
  const oversized = 'x'.repeat(20000);
  const packet = adapter.retrieve({
    query: 'bounded diagnostics',
    connectors: [oversized],
    operation: oversized,
  });
  const serialized = JSON.stringify(packet);
  assert.equal(packet.status, TRANSCRIPT_STATUS.UNAVAILABLE);
  assert.ok(serialized.length < 3000, `packet length=${serialized.length}`);
  assert.equal(serialized.includes(oversized), false);
  assert.equal(/\u0000|\u001f/.test(serialized), false);
});

test('keeps the rendered packet within the aggregate budget', () => {
  const adapter = new CassTranscriptAdapter({
    runner: preflightRunner([], (_command, args) => {
      const source = args[args.indexOf('--agent') + 1];
      return ok({
        results: Array.from({ length: 20 }, (_, index) => ({
          source,
          session_id: `${source}-${index}`,
          timestamp: '2026-07-20T12:00:00.000Z',
          score: 1 - (index / 100),
          citation: `turn:${index}`,
          snippet: 'bounded evidence '.repeat(500),
          path: '/var/lib/cass/transcripts/private.jsonl',
        })),
      });
    }),
  });
  const packet = adapter.retrieve(request({ maxTokens: 3000 }));
  assert.ok(packet.renderedTokenCount <= 3000, `renderedTokenCount=${packet.renderedTokenCount}`);
  assert.ok(packet.evidence.length > 0);
  assert.equal(JSON.stringify(packet).includes('/var/lib/cass/transcripts'), false);
  assert.equal(packet.truncated || packet.omissions.length > 0, true);
});

test('async retrieval runs independent connector packs concurrently', async () => {
  let active = 0;
  let peak = 0;
  const adapter = new CassTranscriptAdapter({
    runner: () => { throw new Error('sync runner must not be used by retrieveAsync'); },
    asyncRunner: (_command, args) => new Promise((resolve) => {
      if (args[0] === 'api-version') {
        resolve(ok({ version: '0.6.23', contract_version: 1 }));
        return;
      }
      if (args[0] === 'capabilities') {
        resolve(ok({ contract_version: 1, commands: ['pack', 'sessions'], modes: ['lexical'], sources: ['codex', 'claude'] }));
        return;
      }
      active += 1;
      peak = Math.max(peak, active);
      const source = args[args.indexOf('--agent') + 1];
      setTimeout(() => {
        active -= 1;
        resolve(ok({ results: [{
          agent: source,
          session_id: `${source}-async`,
          timestamp: '2026-07-20T12:00:00.000Z',
          citation: 'turn:1',
          snippet: `${source} async evidence`,
        }] }));
      }, 10);
    }),
  });

  const packet = await adapter.retrieveAsync(request());
  assert.equal(peak, 2);
  assert.equal(packet.status, TRANSCRIPT_STATUS.EVIDENCE_FOUND);
  assert.equal(packet.evidence.length, 2);
});

test('async preflight is shared and keeps synchronous retrieval paths separate', async () => {
  let preflightCalls = 0;
  let syncCalls = 0;
  const adapter = new CassTranscriptAdapter({
    runner: () => {
      syncCalls += 1;
      throw new Error('sync runner should not be called');
    },
    asyncRunner: (_command, args) => {
      preflightCalls += 1;
      if (args[0] === 'api-version') return Promise.resolve(ok({ version: '0.6.23', contract_version: 1 }));
      if (args[0] === 'capabilities') return Promise.resolve(ok({ contract_version: 1, commands: ['pack'], modes: ['lexical'], sources: ['codex'] }));
      return Promise.resolve(ok({ results: [] }));
    },
  });
  const [first, second] = await Promise.all([
    adapter.retrieveAsync(request({ connectors: ['codex'] })),
    adapter.retrieveAsync(request({ connectors: ['codex'] })),
  ]);
  assert.equal(syncCalls, 0);
  assert.equal(preflightCalls, 4);
  assert.equal(first.status, TRANSCRIPT_STATUS.NO_EVIDENCE);
  assert.equal(second.status, TRANSCRIPT_STATUS.NO_EVIDENCE);
});

test('CLI returns the same normalized packet shape and stable usage errors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-cass-cli-'));
  const fakeCass = path.join(root, 'cass');
  const configDir = path.join(root, 'cass-config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(fakeCass, `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[0];
if (command === 'api-version') process.stdout.write(JSON.stringify({ version: '0.6.23', contract_version: 1 }));
else if (command === 'capabilities') process.stdout.write(JSON.stringify({ contract_version: 1, commands: ['pack'], modes: ['lexical'], connectors: ['codex'] }));
else if (command === 'pack' && process.env.XDG_CONFIG_HOME === ${JSON.stringify(configDir)}) process.stdout.write(JSON.stringify({ results: [{ agent: 'codex', session_id: 'cli-session', timestamp: '2026-07-20T12:00:00.000Z', citation: 'turn:1', snippet: 'CLI evidence' }] }));
else process.exit(1);
`, { mode: 0o700 });

  const cliPath = path.resolve(__dirname, '..', 'scripts', 'search-transcripts.js');
  const child = spawnSync(process.execPath, [cliPath, 'deployment decision', '--connector', 'codex', '--cass-bin', fakeCass, '--config-dir', configDir, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', HOME: root },
  });
  assert.equal(child.status, 0, child.stderr);
  const packet = JSON.parse(child.stdout);
  assert.equal(packet.schema, TRANSCRIPT_PACKET_SCHEMA);
  assert.equal(packet.status, TRANSCRIPT_STATUS.EVIDENCE_FOUND);
  assert.equal(packet.evidence[0].excerpt, 'CLI evidence');
  assert.equal(child.stderr, '');

  const invalid = spawnSync(process.execPath, [cliPath, '--remote', 'deployment decision'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', HOME: root },
  });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).status, TRANSCRIPT_STATUS.UNAVAILABLE);
  assert.equal(invalid.stdout.includes(fakeCass), false);
});
