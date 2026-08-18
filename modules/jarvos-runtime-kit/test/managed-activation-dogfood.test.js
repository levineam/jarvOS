'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

const {
  MANAGED_ACTIVATION_RECEIPT_VERSION,
  MANAGED_ACTIVATION_PRODUCER_EVENTS,
  MANAGED_ACTIVATION_REASON_CODES,
  MANAGED_ACTIVATION_STATUS_VERSION,
  collectManagedActivationAttestation,
} = require('../src/index.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOGFOOD = path.join(ROOT, 'modules/jarvos-runtime-kit/scripts/dogfood-managed-activation.js');
const PREFLIGHT = path.join(ROOT, 'modules/jarvos-skills/scripts/live-preflight-checklist.js');
const NOW_MS = Date.parse('2026-08-16T12:00:00.000Z');
const SENTINEL_PATH = '/Users/andrew/.jarvos/private/state/session-abc123';
const SENTINEL_SESSION = 'session-abc-xyz-999';
const SENTINEL_PROCESS = 'pid-4242';
const SENTINEL_DIAG = 'raw hook output: SessionStart failed at /tmp/private';
const HARNESSES = ['claude', 'codex', 'hermes', 'openclaw'];

function writeOwnerFile(filePath, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  fs.writeFileSync(filePath, body, { encoding: 'utf8', mode });
  fs.chmodSync(filePath, mode);
}

function disposableRoot(prefix = 'jarvos-dogfood-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(root, 0o700);
  return root;
}

function tupleFiles(root) {
  const asset = path.join(root, 'asset.js');
  const entry = path.join(root, 'entrypoint.js');
  const config = path.join(root, 'config.json');
  writeOwnerFile(asset, 'asset-bytes-v1');
  writeOwnerFile(entry, 'entry-bytes-v1');
  writeOwnerFile(config, '{"bound":true,"v":1}');
  return { asset, entry, config };
}

function runDogfood(args, env = {}) {
  return spawnSync(process.execPath, [DOGFOOD, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      JARVOS_MANAGED_ACTIVATION_TEST_MODE: '1',
      JARVOS_MANAGED_ACTIVATION_NOW: String(NOW_MS),
      ...env,
    },
  });
}

function prepare(harness, ownerRoot, files, extra = [], env = {}) {
  return runDogfood([
    'prepare',
    '--harness', harness,
    '--owner-root', ownerRoot,
    '--generation', `gen-${harness}-1`,
    '--asset', files.asset,
    '--entrypoint', files.entry,
    '--config-binding', files.config,
    '--json',
    ...extra,
  ], {
    JARVOS_MANAGED_ACTIVATION_NOW: String(NOW_MS - 10 * 60 * 1000),
    ...env,
  });
}

function verify(harness, ownerRoot, runId, env = {}) {
  return runDogfood([
    'verify',
    '--harness', harness,
    '--owner-root', ownerRoot,
    '--run', runId,
    '--json',
  ], env);
}

function plantReceipt(ownerRoot, runId, receipt, name = 'receipt.json') {
  const target = path.join(ownerRoot, 'runs', runId, 'receipts', name);
  writeOwnerFile(target, `${JSON.stringify(receipt)}\n`);
  return target;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertNoRawReceiptFields(body) {
  const encoded = JSON.stringify(body);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'receipts'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'producedAt'), false);
  assert.equal(encoded.includes(SENTINEL_PATH), false);
  assert.equal(encoded.includes(SENTINEL_SESSION), false);
  assert.equal(encoded.includes(SENTINEL_PROCESS), false);
  assert.equal(encoded.includes(SENTINEL_DIAG), false);
}

function makeReceipt({ harness, correlation, tupleDigest, eventClass = 'session', producedAt = '2026-08-16T11:55:00.000Z' }) {
  return {
    schemaVersion: MANAGED_ACTIVATION_RECEIPT_VERSION,
    harness,
    correlation,
    eventClass,
    producer: 'test-fixture',
    producerEvent: MANAGED_ACTIVATION_PRODUCER_EVENTS[harness][eventClass],
    tupleDigest,
    producedAt,
  };
}

test('dogfood prepare+verify activates all four fixture harness receipt paths and redacts outward JSON', () => {
  for (const harness of HARNESSES) {
    const ownerRoot = disposableRoot(`jarvos-df-${harness}-`);
    const files = tupleFiles(ownerRoot);
    try {
      const prep = prepare(harness, ownerRoot, files);
      assert.equal(prep.status, 0, prep.stderr || prep.stdout);
      const prepared = JSON.parse(prep.stdout);
      assert.equal(prepared.ok, true);
      assert.equal(prepared.harness, harness);
      assert.equal(prepared.phase, 'prepare');
      assert.ok(prepared.run);
      assert.ok(prepared.correlation);
      assert.match(prepared.tupleDigest, /^[a-f0-9]{64}$/);
      assertNoRawReceiptFields(prepared);
      assert.equal(JSON.stringify(prepared).includes(ownerRoot), false);
      assert.equal(JSON.stringify(prepared).includes(files.asset), false);

      const attestation = collectManagedActivationAttestation({
        harness,
        generation: `gen-${harness}-1`,
        assetPaths: [files.asset],
        entrypointPath: files.entry,
        configBindingPath: files.config,
      });
      assert.equal(attestation.ok, true);

      if (harness === 'hermes' || harness === 'openclaw') {
        plantReceipt(ownerRoot, prepared.run, makeReceipt({
          harness,
          correlation: prepared.correlation,
          tupleDigest: attestation.tupleDigest,
          eventClass: 'session',
          producedAt: '2026-08-16T11:54:00.000Z',
        }), 'session.json');
        plantReceipt(ownerRoot, prepared.run, makeReceipt({
          harness,
          correlation: prepared.correlation,
          tupleDigest: attestation.tupleDigest,
          eventClass: 'turn',
          producedAt: '2026-08-16T11:55:00.000Z',
        }), 'turn.json');
      } else {
        plantReceipt(ownerRoot, prepared.run, makeReceipt({
          harness,
          correlation: prepared.correlation,
          tupleDigest: attestation.tupleDigest,
          eventClass: 'session',
        }));
      }

      const verified = verify(harness, ownerRoot, prepared.run);
      assert.equal(verified.status, 0, verified.stderr || verified.stdout);
      const body = JSON.parse(verified.stdout);
      assert.equal(body.ok, true);
      assert.equal(body.phase, 'verify');
      assert.equal(body.status.state, 'rolled_back');
      assert.equal(body.status.harness, harness);
      assert.equal(body.status.schemaVersion, MANAGED_ACTIVATION_STATUS_VERSION);
      assert.ok(body.status.reasons.includes('rolled_back'));
      assert.ok(body.status.reasons.includes('generation_invalidated'));
      assert.equal(body.dogfood.outcome, 'passed');
      assert.equal(body.rollback.status, 'completed');
      assertNoRawReceiptFields(body);
      assert.equal(JSON.stringify(body).includes(ownerRoot), false);
      assert.equal(JSON.stringify(body).includes(SENTINEL_PATH), false);

      // Successful verify consumes raw challenge/receipt material.
      assert.equal(fs.existsSync(path.join(ownerRoot, 'runs', prepared.run, 'challenge.json')), false);
      assert.equal(fs.existsSync(path.join(ownerRoot, 'runs', prepared.run, 'receipts')), false);
    } finally {
      fs.rmSync(ownerRoot, { recursive: true, force: true });
    }
  }
});

test('production verification rejects test-fixture receipt provenance', () => {
  const ownerRoot = disposableRoot('jarvos-df-provenance-');
  const files = tupleFiles(ownerRoot);
  try {
    const prepared = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const attestation = collectManagedActivationAttestation({
      harness: 'codex', generation: 'gen-codex-1', assetPaths: [files.asset],
      entrypointPath: files.entry, configBindingPath: files.config,
    });
    plantReceipt(ownerRoot, prepared.run, makeReceipt({
      harness: 'codex', correlation: prepared.correlation, tupleDigest: attestation.tupleDigest,
    }));
    const rejected = verify('codex', ownerRoot, prepared.run, {
      JARVOS_MANAGED_ACTIVATION_TEST_MODE: '',
      JARVOS_MANAGED_ACTIVATION_NOW: '',
    });
    assert.notEqual(rejected.status, 0);
    const body = JSON.parse(rejected.stdout);
    assert.equal(body.ok, false);
    // Production verification may reject this fixed-date fixture as expired
    // before it reaches provenance validation; either outcome must remain
    // non-activating.
    assert.ok(['receipt_invalid', 'expired'].includes(body.error));
    // Host configuration may classify the same fail-closed result as
    // unconfigured; the safety invariant is that it never becomes active.
    assert.notEqual(body.status.state, 'active');
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('one malformed receipt makes the complete evidence set fail closed', () => {
  const ownerRoot = disposableRoot('jarvos-df-invalid-set-');
  const files = tupleFiles(ownerRoot);
  try {
    const prepared = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const attestation = collectManagedActivationAttestation({
      harness: 'codex', generation: 'gen-codex-1', assetPaths: [files.asset],
      entrypointPath: files.entry, configBindingPath: files.config,
    });
    plantReceipt(ownerRoot, prepared.run, makeReceipt({
      harness: 'codex', correlation: prepared.correlation, tupleDigest: attestation.tupleDigest,
    }), 'valid.json');
    plantReceipt(ownerRoot, prepared.run, { schemaVersion: MANAGED_ACTIVATION_RECEIPT_VERSION }, 'invalid.json');
    const result = verify('codex', ownerRoot, prepared.run);
    assert.notEqual(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error, 'receipt_invalid');
    assert.equal(body.status.state, 'degraded');
    assert.equal(fs.existsSync(path.join(ownerRoot, 'runs', prepared.run, 'challenge.json')), true);
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('overlapping challenges coexist and one challenge cannot consume another', () => {
  const ownerRoot = disposableRoot('jarvos-df-overlap-');
  const files = tupleFiles(ownerRoot);
  try {
    const first = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const second = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    assert.notEqual(first.run, second.run);
    assert.notEqual(first.correlation, second.correlation);

    const attestation = collectManagedActivationAttestation({
      harness: 'codex',
      generation: 'gen-codex-1',
      assetPaths: [files.asset],
      entrypointPath: files.entry,
      configBindingPath: files.config,
    });
    plantReceipt(ownerRoot, first.run, makeReceipt({
      harness: 'codex',
      correlation: first.correlation,
      tupleDigest: attestation.tupleDigest,
    }));
    plantReceipt(ownerRoot, second.run, makeReceipt({
      harness: 'codex',
      correlation: second.correlation,
      tupleDigest: attestation.tupleDigest,
      producedAt: '2026-08-16T11:56:00.000Z',
    }));

    const firstVerify = JSON.parse(verify('codex', ownerRoot, first.run).stdout);
    assert.equal(firstVerify.status.state, 'rolled_back');
    assert.equal(firstVerify.ok, true);

    // Second challenge remains independently verifiable.
    const secondVerify = JSON.parse(verify('codex', ownerRoot, second.run).stdout);
    assert.equal(secondVerify.status.state, 'rolled_back');
    assert.equal(secondVerify.ok, true);
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('no-receipt pending keeps challenge for retry and never activates', () => {
  const ownerRoot = disposableRoot('jarvos-df-pending-');
  const files = tupleFiles(ownerRoot);
  try {
    const prepared = JSON.parse(prepare('claude', ownerRoot, files).stdout);
    const verified = verify('claude', ownerRoot, prepared.run);
    assert.notEqual(verified.status, 0);
    const body = JSON.parse(verified.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.status.state, 'awaiting_live_proof');
    assert.ok(body.status.reasons.includes('no_live_receipt'));
    assert.equal(body.dogfood.outcome, 'pending');
    assert.equal(fs.existsSync(path.join(ownerRoot, 'runs', prepared.run, 'challenge.json')), true);
    assertNoRawReceiptFields(body);
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('dual-receipt order is required for hermes and openclaw; out-of-order never activates', () => {
  for (const harness of ['hermes', 'openclaw']) {
    const ownerRoot = disposableRoot(`jarvos-df-order-${harness}-`);
    const files = tupleFiles(ownerRoot);
    try {
      const prepared = JSON.parse(prepare(harness, ownerRoot, files).stdout);
      const attestation = collectManagedActivationAttestation({
        harness,
        generation: `gen-${harness}-1`,
        assetPaths: [files.asset],
        entrypointPath: files.entry,
        configBindingPath: files.config,
      });
      plantReceipt(ownerRoot, prepared.run, makeReceipt({
        harness,
        correlation: prepared.correlation,
        tupleDigest: attestation.tupleDigest,
        eventClass: 'turn',
        producedAt: '2026-08-16T11:54:00.000Z',
      }), 'turn-first.json');
      plantReceipt(ownerRoot, prepared.run, makeReceipt({
        harness,
        correlation: prepared.correlation,
        tupleDigest: attestation.tupleDigest,
        eventClass: 'session',
        producedAt: '2026-08-16T11:55:00.000Z',
      }), 'session-second.json');
      const body = JSON.parse(verify(harness, ownerRoot, prepared.run).stdout);
      assert.notEqual(body.status.state, 'active');
      assert.ok(
        body.status.reasons.includes('sequence_out_of_order')
        || body.status.reasons.includes('sequence_incomplete')
        || body.status.state === 'degraded'
        || body.status.state === 'awaiting_live_proof',
      );
    } finally {
      fs.rmSync(ownerRoot, { recursive: true, force: true });
    }
  }
});

test('stale mismatch replay pre-baseline and future evidence never activate', () => {
  const ownerRoot = disposableRoot('jarvos-df-bad-receipt-');
  const files = tupleFiles(ownerRoot);
  try {
    const prepared = JSON.parse(prepare('codex', ownerRoot, files, [], {
      JARVOS_MANAGED_ACTIVATION_NOW: String(Date.parse('2026-08-16T10:30:00.000Z')),
    }).stdout);
    const attestation = collectManagedActivationAttestation({
      harness: 'codex',
      generation: 'gen-codex-1',
      assetPaths: [files.asset],
      entrypointPath: files.entry,
      configBindingPath: files.config,
    });
    const cases = [
      {
        name: 'stale',
        receipt: makeReceipt({
          harness: 'codex',
          correlation: prepared.correlation,
          tupleDigest: attestation.tupleDigest,
          producedAt: '2026-08-16T11:00:00.000Z',
        }),
        reason: 'receipt_stale',
      },
      {
        name: 'future',
        receipt: makeReceipt({
          harness: 'codex',
          correlation: prepared.correlation,
          tupleDigest: attestation.tupleDigest,
          producedAt: '2026-08-16T12:01:00.000Z',
        }),
        reason: 'receipt_future',
      },
      {
        name: 'mismatch',
        receipt: makeReceipt({
          harness: 'codex',
          correlation: 'other-challenge',
          tupleDigest: attestation.tupleDigest,
        }),
        reason: 'challenge_mismatch',
      },
      {
        name: 'tuple-mismatch',
        receipt: makeReceipt({
          harness: 'codex',
          correlation: prepared.correlation,
          tupleDigest: 'f'.repeat(64),
        }),
        reason: 'selected_tuple_mismatch',
      },
    ];

    for (const entry of cases) {
      const runRoot = path.join(ownerRoot, 'runs', prepared.run, 'receipts');
      fs.rmSync(runRoot, { recursive: true, force: true });
      plantReceipt(ownerRoot, prepared.run, entry.receipt, `${entry.name}.json`);
      const body = JSON.parse(verify('codex', ownerRoot, prepared.run).stdout);
      assert.notEqual(body.status.state, 'active', entry.name);
      assert.ok(body.status.reasons.includes(entry.reason), `${entry.name}: ${body.status.reasons.join(',')}`);
      assert.equal(body.dogfood.outcome === 'failed' || body.dogfood.outcome === 'pending', true);
    }

    // Replay: plant a valid receipt, verify once (consume), then re-verify with same identity via retained state.
    fs.rmSync(path.join(ownerRoot, 'runs', prepared.run, 'receipts'), { recursive: true, force: true });
    const replayPrep = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const good = makeReceipt({
      harness: 'codex',
      correlation: replayPrep.correlation,
      tupleDigest: attestation.tupleDigest,
    });
    plantReceipt(ownerRoot, replayPrep.run, good, 'good.json');
    plantReceipt(ownerRoot, replayPrep.run, { ...good }, 'good-dup.json');
    const replayBody = JSON.parse(verify('codex', ownerRoot, replayPrep.run).stdout);
    // Duplicate identity is treated as replay; active only if evaluator accepts one unique identity.
    // With two identical identities the second is replay and first can still activate.
    assert.notEqual(replayBody.status.state, 'active');
    assert.ok(replayBody.status.reasons.includes('receipt_replay'));

    // Pre-baseline: rewrite challenge baseline after planting an older receipt via a fresh prepare + clock.
    const pre = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    // Directly mutate baseline into the future relative to receipt by planting receipt then adjusting challenge.
    plantReceipt(ownerRoot, pre.run, makeReceipt({
      harness: 'codex',
      correlation: pre.correlation,
      tupleDigest: attestation.tupleDigest,
      producedAt: '2026-08-16T11:55:00.000Z',
    }));
    const challengePath = path.join(ownerRoot, 'runs', pre.run, 'challenge.json');
    const challenge = readJson(challengePath);
    challenge.baselineAt = '2026-08-16T11:56:00.000Z';
    writeOwnerFile(challengePath, `${JSON.stringify(challenge, null, 2)}\n`);
    const preBody = JSON.parse(verify('codex', ownerRoot, pre.run).stdout);
    assert.notEqual(preBody.status.state, 'active');
    assert.ok(preBody.status.reasons.includes('receipt_before_baseline'));
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('prepare rejects relative paths, broad roots, symlinks, special files, unsafe modes, and ambiguous existing runs', () => {
  const ownerRoot = disposableRoot('jarvos-df-reject-');
  const files = tupleFiles(ownerRoot);
  try {
    const relativeRoot = runDogfood([
      'prepare', '--harness', 'codex', '--owner-root', 'relative-root',
      '--generation', 'gen-1', '--asset', files.asset, '--entrypoint', files.entry,
      '--config-binding', files.config, '--json',
    ]);
    assert.notEqual(relativeRoot.status, 0);

    const broad = runDogfood([
      'prepare', '--harness', 'codex', '--owner-root', os.tmpdir(),
      '--generation', 'gen-1', '--asset', files.asset, '--entrypoint', files.entry,
      '--config-binding', files.config, '--json',
    ]);
    assert.notEqual(broad.status, 0);

    const home = runDogfood([
      'prepare', '--harness', 'codex', '--owner-root', os.homedir(),
      '--generation', 'gen-1', '--asset', files.asset, '--entrypoint', files.entry,
      '--config-binding', files.config, '--json',
    ]);
    assert.notEqual(home.status, 0);

    const linkRoot = path.join(ownerRoot, 'link-root');
    const realChild = path.join(ownerRoot, 'real-child');
    fs.mkdirSync(realChild, { mode: 0o700 });
    fs.chmodSync(realChild, 0o700);
    fs.symlinkSync(realChild, linkRoot);
    const symlinkRoot = runDogfood([
      'prepare', '--harness', 'codex', '--owner-root', linkRoot,
      '--generation', 'gen-1', '--asset', files.asset, '--entrypoint', files.entry,
      '--config-binding', files.config, '--json',
    ]);
    assert.notEqual(symlinkRoot.status, 0);

    const linkAsset = path.join(ownerRoot, 'link-asset.js');
    fs.symlinkSync(files.asset, linkAsset);
    const symlinkAsset = prepare('codex', ownerRoot, { ...files, asset: linkAsset });
    assert.notEqual(symlinkAsset.status, 0);

    const unsafe = path.join(ownerRoot, 'unsafe.js');
    writeOwnerFile(unsafe, 'x', 0o666);
    const unsafeMode = prepare('codex', ownerRoot, { ...files, asset: unsafe });
    assert.notEqual(unsafeMode.status, 0);

    const worldRoot = path.join(ownerRoot, 'world-root');
    fs.mkdirSync(worldRoot, { mode: 0o777 });
    fs.chmodSync(worldRoot, 0o777);
    const world = runDogfood([
      'prepare', '--harness', 'codex', '--owner-root', worldRoot,
      '--generation', 'gen-1', '--asset', files.asset, '--entrypoint', files.entry,
      '--config-binding', files.config, '--json',
    ]);
    assert.notEqual(world.status, 0);

    // Existing ambiguous run: create a run id directory with unexpected content then force same id if supported.
    // prepare always creates random ids, so ambiguous means an existing challenge file with corrupt/unreadable state
    // under a requested collision path is rejected on verify, and prepare refuses non-owner-only roots.
    const prepared = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    writeOwnerFile(path.join(ownerRoot, 'runs', prepared.run, 'challenge.json'), '{not-json');
    const ambiguous = verify('codex', ownerRoot, prepared.run);
    assert.notEqual(ambiguous.status, 0);
    const ambBody = JSON.parse(ambiguous.stdout);
    assert.equal(ambBody.ok, false);
    assertNoRawReceiptFields(ambBody);
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('owner modes are 0700/0600 for dogfood state and verify refuses world-readable challenge material', () => {
  const ownerRoot = disposableRoot('jarvos-df-modes-');
  const files = tupleFiles(ownerRoot);
  try {
    const prepared = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const challengePath = path.join(ownerRoot, 'runs', prepared.run, 'challenge.json');
    const runDir = path.join(ownerRoot, 'runs', prepared.run);
    assert.equal(fs.statSync(ownerRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(runDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(challengePath).mode & 0o777, 0o600);

    fs.chmodSync(challengePath, 0o644);
    const refused = verify('codex', ownerRoot, prepared.run);
    assert.notEqual(refused.status, 0);
    const body = JSON.parse(refused.stdout);
    assert.equal(body.ok, false);
    assertNoRawReceiptFields(body);
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('24-hour raw expiry removes challenge material while 30-day redacted retention is bounded', () => {
  const ownerRoot = disposableRoot('jarvos-df-expiry-');
  const files = tupleFiles(ownerRoot);
  try {
    const prepared = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const challengePath = path.join(ownerRoot, 'runs', prepared.run, 'challenge.json');
    const challenge = readJson(challengePath);
    const old = Date.parse('2026-07-01T12:00:00.000Z');
    challenge.createdAt = new Date(old).toISOString();
    challenge.baselineAt = new Date(old).toISOString();
    challenge.rawExpiresAt = new Date(old + 24 * 3600 * 1000).toISOString();
    writeOwnerFile(challengePath, `${JSON.stringify(challenge, null, 2)}\n`);

    // Plant a redacted state older than 30 days and a fresher one.
    const redactedDir = path.join(ownerRoot, 'redacted');
    fs.mkdirSync(redactedDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(redactedDir, 0o700);
    writeOwnerFile(path.join(redactedDir, `${prepared.run}.json`), `${JSON.stringify({
      schemaVersion: 'jarvos-managed-activation-dogfood-redacted/v1',
      run: prepared.run,
      harness: 'codex',
      state: 'awaiting_live_proof',
      reasons: ['no_live_receipt'],
      evaluatedAt: new Date(old).toISOString(),
      retainedUntil: new Date(old + 30 * 24 * 3600 * 1000).toISOString(),
    }, null, 2)}\n`);

    const expired = verify('codex', ownerRoot, prepared.run);
    assert.notEqual(expired.status, 0);
    const body = JSON.parse(expired.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.dogfood.outcome, 'expired');
    assert.equal(body.error, 'expired');
    assert.equal(body.status.state, 'unconfigured');
    assert.ok(body.status.reasons.includes('invalid_evidence'));
    assert.equal(fs.existsSync(challengePath), false);
    assert.equal(fs.existsSync(path.join(redactedDir, `${prepared.run}.json`)), false);
    assertNoRawReceiptFields(body);
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('exact-owned rollback succeeds when digests match and refuses when modified', () => {
  const ownerRoot = disposableRoot('jarvos-df-rollback-');
  const files = tupleFiles(ownerRoot);
  try {
    // Success path: active verify rolls back created files.
    const prepared = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const attestation = collectManagedActivationAttestation({
      harness: 'codex',
      generation: 'gen-codex-1',
      assetPaths: [files.asset],
      entrypointPath: files.entry,
      configBindingPath: files.config,
    });
    plantReceipt(ownerRoot, prepared.run, makeReceipt({
      harness: 'codex',
      correlation: prepared.correlation,
      tupleDigest: attestation.tupleDigest,
    }));
    const okBody = JSON.parse(verify('codex', ownerRoot, prepared.run).stdout);
    assert.equal(okBody.rollback.status, 'completed');
    assert.equal(fs.existsSync(path.join(ownerRoot, 'runs', prepared.run, 'challenge.json')), false);

    // Refusal path: modify a created file before verify completes rollback inventory.
    const prepared2 = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const inventoryPath = path.join(ownerRoot, 'runs', prepared2.run, 'created-files.json');
    assert.equal(fs.existsSync(inventoryPath), true);
    // Tamper with a tracked file (challenge) so digest no longer matches inventory.
    const challengePath = path.join(ownerRoot, 'runs', prepared2.run, 'challenge.json');
    const challenge = readJson(challengePath);
    challenge.tampered = true;
    writeOwnerFile(challengePath, `${JSON.stringify(challenge, null, 2)}\n`);
    plantReceipt(ownerRoot, prepared2.run, makeReceipt({
      harness: 'codex',
      correlation: prepared2.correlation,
      tupleDigest: attestation.tupleDigest,
      producedAt: '2026-08-16T11:57:00.000Z',
    }));
    const receiptPath = path.join(ownerRoot, 'runs', prepared2.run, 'receipts', 'receipt.json');
    const beforeRefusal = new Map([challengePath, inventoryPath, receiptPath].map((filePath) => [
      filePath,
      fs.readFileSync(filePath),
    ]));
    const refused = JSON.parse(verify('codex', ownerRoot, prepared2.run).stdout);
    // Even if evaluation reaches active, rollback must refuse overwrite of modified material.
    assert.ok(
      refused.rollback?.status === 'rollback_pending'
      || refused.status?.state === 'rollback_pending'
      || refused.dogfood?.outcome === 'rollback_pending',
    );
    // Challenge must not be forcibly overwritten/deleted when inventory no longer matches.
    assert.equal(fs.existsSync(challengePath), true);
    for (const [filePath, bytes] of beforeRefusal) {
      assert.equal(fs.existsSync(filePath), true, filePath);
      assert.deepEqual(fs.readFileSync(filePath), bytes, filePath);
    }
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('terminal redacted-state failure never returns a passed dogfood result', () => {
  const ownerRoot = disposableRoot('jarvos-df-final-write-');
  const files = tupleFiles(ownerRoot);
  try {
    const prepared = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const attestation = collectManagedActivationAttestation({
      harness: 'codex', generation: 'gen-codex-1', assetPaths: [files.asset],
      entrypointPath: files.entry, configBindingPath: files.config,
    });
    plantReceipt(ownerRoot, prepared.run, makeReceipt({
      harness: 'codex', correlation: prepared.correlation, tupleDigest: attestation.tupleDigest,
    }));
    const result = verify('codex', ownerRoot, prepared.run, {
      JARVOS_MANAGED_ACTIVATION_FAIL_FINAL_STATE_WRITE: '1',
    });
    assert.notEqual(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'write_failed');
    assert.equal(body.dogfood.outcome, 'rollback_pending');
    assert.equal(body.status.state, 'rollback_pending');
    const retained = readJson(path.join(ownerRoot, 'redacted', `${prepared.run}.json`));
    assert.equal(retained.state, 'rollback_pending');
    assert.equal(retained.dogfoodOutcome, 'rollback_pending');
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('dogfood never mutates host profile paths outside the disposable owner root', () => {
  const ownerRoot = disposableRoot('jarvos-df-host-');
  const hostProbe = path.join(os.homedir(), '.jarvos-dogfood-host-probe-should-not-exist');
  const files = tupleFiles(ownerRoot);
  try {
    fs.rmSync(hostProbe, { force: true });
    const prepared = JSON.parse(prepare('codex', ownerRoot, files).stdout);
    const attestation = collectManagedActivationAttestation({
      harness: 'codex',
      generation: 'gen-codex-1',
      assetPaths: [files.asset],
      entrypointPath: files.entry,
      configBindingPath: files.config,
    });
    plantReceipt(ownerRoot, prepared.run, makeReceipt({
      harness: 'codex',
      correlation: prepared.correlation,
      tupleDigest: attestation.tupleDigest,
    }));
    const body = JSON.parse(verify('codex', ownerRoot, prepared.run).stdout);
    assert.equal(body.status.state, 'rolled_back');
    assert.equal(fs.existsSync(hostProbe), false);
    // Only owner-root should gain dogfood state; home profile roots stay untouched.
    for (const profile of ['.codex', '.claude', '.hermes', '.openclaw']) {
      // Existence of profile dirs is fine; dogfood must not write a managed-activation marker there.
      const marker = path.join(os.homedir(), profile, 'jarvos-managed-activation-dogfood.json');
      assert.equal(fs.existsSync(marker), false);
    }
  } finally {
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  }
});

test('hooks and plugins remain fail-open lifecycle bridges without activation authority', () => {
  const sources = [
    'runtimes/codex/jarvos-session-start-hook.js',
    'runtimes/codex/jarvos-session-turn-hook.js',
    'runtimes/claude/jarvos-session-start-hook.js',
    'runtimes/claude/jarvos-session-turn-hook.js',
    'runtimes/hermes/jarvos-pre-llm-hook.js',
    'runtimes/openclaw/jarvos-next-turn-plugin.js',
  ];
  for (const relative of sources) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.equal(source.includes('evaluateManagedActivation'), false, relative);
    assert.equal(source.includes('dogfood-managed-activation'), false, relative);
    assert.equal(source.includes('activation-status'), false, relative);
    assert.match(source, /fail open|process\.exit\(0\)|return \{\}|: \{\}|writeJson\(\{\}\)/i);
  }

  // Hermes/OpenClaw stay bounded to turn bridge only.
  const hermes = fs.readFileSync(path.join(ROOT, 'runtimes/hermes/jarvos-pre-llm-hook.js'), 'utf8');
  assert.match(hermes, /nextTurnInput/);
  assert.equal(hermes.includes('startOrResume'), false);
  const openclaw = fs.readFileSync(path.join(ROOT, 'runtimes/openclaw/jarvos-next-turn-plugin.js'), 'utf8');
  assert.match(openclaw, /nextTurnInput/);
  assert.equal(openclaw.includes('evaluateManagedActivation'), false);

  // Fail-open smoke: broken bridge env must not crash hooks.
  for (const runtime of ['claude', 'codex']) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        JARVOS_STEWARDSHIP_BRIDGE_COMMAND: '',
        HOME: path.join(os.tmpdir(), 'jarvos-hook-home-missing'),
      },
      input: runtime === 'claude'
        ? JSON.stringify({ session_id: '66666666-7777-4888-8999-aaaaaaaaaaaa' })
        : JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: '019fbf11-8aca-79c0-981e-15abcd2392f4' }),
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout || '{}'), {});
  }
});

test('skill preflight remains non-activating and surfaces redacted activation status as informational', () => {
  const result = spawnSync(process.execPath, [PREFLIGHT, '--json'], {
    cwd: path.join(ROOT, 'modules/jarvos-skills'),
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.activating, false);
  assert.equal(report.readOnly, true);
  const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
  assert.equal(byId['live-harness-gates'].status, 'off');
  assert.ok(byId['runtime-activation'], 'runtime-activation item required');
  assert.ok(['pass', 'info', 'pending', 'pending_owner'].includes(byId['runtime-activation'].status));
  assert.ok(Array.isArray(byId['runtime-activation'].evidence?.statuses));
  for (const status of byId['runtime-activation'].evidence.statuses) {
    assert.equal(status.schemaVersion, MANAGED_ACTIVATION_STATUS_VERSION);
    assert.ok(HARNESSES.includes(status.harness));
    assert.ok(typeof status.state === 'string');
    for (const reason of status.reasons || []) {
      assert.ok(MANAGED_ACTIVATION_REASON_CODES.has(reason), reason);
    }
    assertNoRawReceiptFields(status);
  }
  assert.equal(report.activating, false);
  assert.equal(JSON.stringify(report).includes('--allow-writes'), false);
});
