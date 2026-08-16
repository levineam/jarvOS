'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  CANONICAL_HARNESS_IDS,
  LIVE_PROOF_FORWARD_SKEW_SECONDS,
  LIVE_PROOF_FRESHNESS_SECONDS,
  MANAGED_ACTIVATION_CONTRACT_VERSION,
  MANAGED_ACTIVATION_REASON_CODES,
  MANAGED_ACTIVATION_RECEIPT_EVENT_CLASSES,
  MANAGED_ACTIVATION_RECEIPT_VERSION,
  MANAGED_ACTIVATION_STATES,
  buildSelectedTuple,
  collectManagedActivationAttestation,
  computeTupleDigest,
  evaluateManagedActivation,
  loadOwnerEvidence,
  normalizeHarnessId,
  toPublicActivationStatus,
  validateManagedActivationContract,
  validateManagedActivationReceipt,
} = require('../src/index.js');

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);
const GENERATION = 'public-runtime-gen-1';
const CORRELATION = 'challenge-codex-run-001';
const SENTINEL_PATH = '/Users/andrew/.jarvos/private/state/session-abc123';
const SENTINEL_SESSION = 'session-abc-xyz-999';
const SENTINEL_PROCESS = 'pid-4242';
const SENTINEL_DIAG = 'raw hook output: SessionStart failed at /tmp/private';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeOwnerFile(filePath, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  fs.writeFileSync(filePath, body, { encoding: 'utf8', mode });
  fs.chmodSync(filePath, mode);
}

function fixtureRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-managed-activation-')));
  fs.chmodSync(root, 0o700);
  return root;
}

function validContract(overrides = {}) {
  return {
    version: MANAGED_ACTIVATION_CONTRACT_VERSION,
    harness: 'codex',
    executionOwner: 'native-hooks',
    backgroundProcess: {
      owner: 'none',
      jarvosStartsProcess: false,
    },
    preparation: {
      requiresExactSetup: true,
      requiresSelectedTuple: true,
    },
    liveProof: {
      qualifyingEventClasses: ['session', 'turn'],
      freshnessSeconds: LIVE_PROOF_FRESHNESS_SECONDS,
      forwardSkewSeconds: LIVE_PROOF_FORWARD_SKEW_SECONDS,
    },
    health: {
      mayActivate: false,
      mayExplainDegradation: true,
    },
    rollback: {
      ownership: 'exact-owned',
      invalidatesGeneration: true,
      refuseModified: true,
    },
    ...overrides,
  };
}

function dualContract(harness) {
  return validContract({
    harness,
    executionOwner: 'harness-process',
    backgroundProcess: { owner: 'harness', jarvosStartsProcess: false },
    liveProof: {
      requiredSequence: ['session', 'turn'],
      freshnessSeconds: LIVE_PROOF_FRESHNESS_SECONDS,
      forwardSkewSeconds: LIVE_PROOF_FORWARD_SKEW_SECONDS,
    },
  });
}

function selectedTuple(overrides = {}) {
  return buildSelectedTuple({
    harness: 'codex',
    generation: GENERATION,
    assetDigest: DIGEST_A,
    entrypointDigest: DIGEST_B,
    configBindingDigest: DIGEST_C,
    ...overrides,
  });
}

function receipt(overrides = {}) {
  const { tuple: tupleOverrides, ...receiptOverrides } = overrides;
  const tuple = selectedTuple(tupleOverrides || {});
  return {
    schemaVersion: MANAGED_ACTIVATION_RECEIPT_VERSION,
    harness: 'codex',
    correlation: CORRELATION,
    eventClass: 'session',
    tupleDigest: tuple.tupleDigest,
    producedAt: '2026-08-16T11:55:00.000Z',
    ...receiptOverrides,
  };
}

function baselineEvidence(overrides = {}) {
  const tuple = selectedTuple(overrides.tuple || {});
  return {
    configured: true,
    prepared: true,
    attestation: {
      ok: true,
      harness: tuple.harness,
      generation: tuple.generation,
      assetDigest: tuple.assetDigest,
      entrypointDigest: tuple.entrypointDigest,
      configBindingDigest: tuple.configBindingDigest,
      tupleDigest: tuple.tupleDigest,
    },
    challenges: [{
      correlation: CORRELATION,
      harness: 'codex',
      baselineAt: '2026-08-16T11:50:00.000Z',
    }],
    receipts: [receipt({ tupleDigest: tuple.tupleDigest })],
    health: { available: false },
    rollback: { status: 'none' },
    ...overrides,
  };
}

test('exports a closed contract surface for managed activation', () => {
  assert.equal(MANAGED_ACTIVATION_CONTRACT_VERSION, 'jarvos-managed-activation/v1');
  assert.equal(MANAGED_ACTIVATION_RECEIPT_VERSION, 'jarvos-managed-activation-receipt/v1');
  assert.equal(LIVE_PROOF_FRESHNESS_SECONDS, 900);
  assert.equal(LIVE_PROOF_FORWARD_SKEW_SECONDS, 30);
  assert.deepEqual([...CANONICAL_HARNESS_IDS].sort(), ['claude', 'codex', 'hermes', 'openclaw']);
  assert.deepEqual([...MANAGED_ACTIVATION_RECEIPT_EVENT_CLASSES].sort(), ['session', 'turn']);
  for (const state of [
    'unconfigured', 'prepared', 'awaiting_live_proof', 'active', 'degraded', 'rollback_pending', 'rolled_back',
  ]) {
    assert.ok(MANAGED_ACTIVATION_STATES.has(state), state);
  }
  assert.ok(MANAGED_ACTIVATION_REASON_CODES.has('selected_tuple_mismatch'));
});

test('normalizeHarnessId accepts claude-code only as an alias', () => {
  assert.equal(normalizeHarnessId('claude-code'), 'claude');
  assert.equal(normalizeHarnessId('claude'), 'claude');
  assert.equal(normalizeHarnessId('codex'), 'codex');
  assert.equal(normalizeHarnessId('unknown'), null);
  assert.equal(normalizeHarnessId(''), null);
});

test('validateManagedActivationContract accepts a strict declaration and rejects unsafe fields', () => {
  const ok = validateManagedActivationContract(validContract());
  assert.equal(ok.ok, true, ok.errors.join('\n'));

  const starts = validateManagedActivationContract(validContract({
    backgroundProcess: { owner: 'none', jarvosStartsProcess: true },
  }));
  assert.equal(starts.ok, false);
  assert.match(starts.errors.join('\n'), /jarvosStartsProcess/);

  const unknownHarness = validateManagedActivationContract(validContract({ harness: 'windsurf' }));
  assert.equal(unknownHarness.ok, false);

  const unknownField = validateManagedActivationContract({ ...validContract(), privatePath: '/tmp/x' });
  assert.equal(unknownField.ok, false);

  const badVersion = validateManagedActivationContract(validContract({ version: 'v0' }));
  assert.equal(badVersion.ok, false);

  const alias = validateManagedActivationContract(validContract({ harness: 'claude-code' }));
  assert.equal(alias.ok, true, alias.errors.join('\n'));
  assert.equal(alias.value.harness, 'claude');
});

test('tuple digests are deterministic and include all five binding fields', () => {
  const left = selectedTuple();
  const right = selectedTuple();
  assert.equal(left.tupleDigest, right.tupleDigest);
  assert.match(left.tupleDigest, /^[a-f0-9]{64}$/);
  const drifted = selectedTuple({ assetDigest: DIGEST_D });
  assert.notEqual(left.tupleDigest, drifted.tupleDigest);
  assert.equal(computeTupleDigest(left), left.tupleDigest);
});

test('validateManagedActivationReceipt enforces schema, classes, and normalized harness', () => {
  const ok = validateManagedActivationReceipt(receipt());
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.equal(ok.value.harness, 'codex');

  const alias = validateManagedActivationReceipt(receipt({ harness: 'claude-code' }));
  assert.equal(alias.ok, true, alias.errors.join('\n'));
  assert.equal(alias.value.harness, 'claude');

  const badClass = validateManagedActivationReceipt(receipt({ eventClass: 'SessionStart' }));
  assert.equal(badClass.ok, false);

  const badVersion = validateManagedActivationReceipt(receipt({ schemaVersion: 'other' }));
  assert.equal(badVersion.ok, false);

  const unknownField = validateManagedActivationReceipt({ ...receipt(), sessionId: SENTINEL_SESSION });
  assert.equal(unknownField.ok, false);
});

test('happy path reaches active only with a fresh causal matching receipt', () => {
  const result = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence(),
    now: NOW,
  });
  assert.equal(result.ok, true, (result.errors || []).join('\n'));
  assert.equal(result.state, 'active');
  assert.ok(result.reasons.includes('live_proof_fresh'));
  const publicStatus = toPublicActivationStatus(result);
  assert.equal(publicStatus.state, 'active');
  assert.equal(publicStatus.harness, 'codex');
  assert.equal(publicStatus.generationDigest, selectedTuple().tupleDigest);
});

test('each non-active state is reachable with fixed precedence', () => {
  const cases = [
    {
      name: 'unconfigured',
      evidence: baselineEvidence({ configured: false, prepared: false, attestation: { ok: false }, receipts: [], challenges: [] }),
      state: 'unconfigured',
    },
    {
      name: 'prepared',
      evidence: baselineEvidence({
        prepared: true,
        attestation: { ok: false, reasonCode: 'attestation_unavailable' },
        receipts: [],
        challenges: [],
      }),
      state: 'prepared',
    },
    {
      name: 'awaiting_live_proof',
      evidence: baselineEvidence({ receipts: [], challenges: [{ correlation: CORRELATION, harness: 'codex', baselineAt: '2026-08-16T11:50:00.000Z' }] }),
      state: 'awaiting_live_proof',
    },
    {
      name: 'degraded stale',
      evidence: baselineEvidence({
        receipts: [receipt({ producedAt: '2026-08-16T11:00:00.000Z' })],
      }),
      state: 'degraded',
    },
    {
      name: 'rollback_pending',
      evidence: baselineEvidence({
        rollback: { status: 'requested' },
      }),
      state: 'rollback_pending',
    },
    {
      name: 'rolled_back',
      evidence: baselineEvidence({
        rollback: { status: 'completed', invalidatedGeneration: GENERATION },
        receipts: [],
      }),
      state: 'rolled_back',
    },
  ];

  for (const entry of cases) {
    const result = evaluateManagedActivation({
      contract: validContract(),
      evidence: entry.evidence,
      now: NOW,
    });
    assert.equal(result.state, entry.state, entry.name);
  }
});

test('freshness boundary is inclusive at 900s and rejects beyond it', () => {
  const exact = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      challenges: [{ correlation: CORRELATION, harness: 'codex', baselineAt: '2026-08-16T11:40:00.000Z' }],
      receipts: [receipt({ producedAt: new Date(NOW - 900_000).toISOString() })],
    }),
    now: NOW,
  });
  assert.equal(exact.state, 'active', 'exact 900s remains fresh');

  const stale = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      challenges: [{ correlation: CORRELATION, harness: 'codex', baselineAt: '2026-08-16T11:40:00.000Z' }],
      receipts: [receipt({ producedAt: new Date(NOW - 900_001).toISOString() })],
    }),
    now: NOW,
  });
  assert.equal(stale.state, 'degraded');
  assert.ok(stale.reasons.includes('receipt_stale'));
});

test('forward skew tolerates 30 seconds and rejects larger future skew', () => {
  const within = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      receipts: [receipt({ producedAt: new Date(NOW + 30_000).toISOString() })],
    }),
    now: NOW,
  });
  assert.equal(within.state, 'active');

  const future = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      receipts: [receipt({ producedAt: new Date(NOW + 30_001).toISOString() })],
    }),
    now: NOW,
  });
  assert.equal(future.state, 'degraded');
  assert.ok(future.reasons.includes('receipt_future'));
});

test('invalid dates and missing configuration fail closed', () => {
  const invalidDate = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      receipts: [receipt({ producedAt: 'not-a-date' })],
    }),
    now: NOW,
  });
  assert.notEqual(invalidDate.state, 'active');
  assert.ok(invalidDate.reasons.includes('receipt_invalid') || invalidDate.ok === false);

  const missing = evaluateManagedActivation({
    contract: validContract(),
    evidence: {
      configured: false,
      prepared: false,
      attestation: { ok: false },
      challenges: [],
      receipts: [],
      health: { available: false },
      rollback: { status: 'none' },
    },
    now: NOW,
  });
  assert.equal(missing.state, 'unconfigured');
  assert.ok(missing.reasons.includes('missing_configuration'));
});

test('safe no-evidence pending behavior does not invent active', () => {
  const result = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      receipts: null,
      challenges: [],
    }),
    now: NOW,
  });
  assert.equal(result.state, 'awaiting_live_proof');
  assert.ok(result.reasons.includes('no_live_receipt'));
});

test('tuple asset entrypoint and config drift degrade instead of activating', () => {
  const expected = selectedTuple();
  const live = selectedTuple({ assetDigest: DIGEST_D });
  const result = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      attestation: {
        ok: true,
        harness: live.harness,
        generation: live.generation,
        assetDigest: live.assetDigest,
        entrypointDigest: live.entrypointDigest,
        configBindingDigest: live.configBindingDigest,
        tupleDigest: live.tupleDigest,
      },
      receipts: [receipt({ tupleDigest: expected.tupleDigest })],
    }),
    now: NOW,
  });
  assert.equal(result.state, 'degraded');
  assert.ok(result.reasons.includes('selected_tuple_mismatch'));
});

test('replay mismatched challenge receipt-before-baseline and overlapping correlations are rejected', () => {
  const tuple = selectedTuple();
  const first = receipt({ producedAt: '2026-08-16T11:55:00.000Z', tupleDigest: tuple.tupleDigest });

  const replay = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      receipts: [first, { ...first }],
      consumedCorrelations: [CORRELATION],
    }),
    now: NOW,
  });
  assert.equal(replay.state, 'degraded');
  assert.ok(replay.reasons.includes('receipt_replay') || replay.reasons.includes('challenge_mismatch'));

  const mismatch = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      challenges: [{ correlation: 'other-challenge', harness: 'codex', baselineAt: '2026-08-16T11:50:00.000Z' }],
      receipts: [receipt({ correlation: CORRELATION, tupleDigest: tuple.tupleDigest })],
    }),
    now: NOW,
  });
  assert.equal(mismatch.state, 'degraded');
  assert.ok(mismatch.reasons.includes('challenge_mismatch'));

  const beforeBaseline = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      challenges: [{ correlation: CORRELATION, harness: 'codex', baselineAt: '2026-08-16T11:56:00.000Z' }],
      receipts: [receipt({ producedAt: '2026-08-16T11:55:00.000Z', tupleDigest: tuple.tupleDigest })],
    }),
    now: NOW,
  });
  assert.equal(beforeBaseline.state, 'degraded');
  assert.ok(beforeBaseline.reasons.includes('receipt_before_baseline'));

  const overlapping = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      challenges: [
        { correlation: CORRELATION, harness: 'codex', baselineAt: '2026-08-16T11:50:00.000Z' },
        { correlation: 'challenge-codex-run-002', harness: 'codex', baselineAt: '2026-08-16T11:51:00.000Z' },
      ],
      receipts: [
        receipt({ correlation: CORRELATION, producedAt: '2026-08-16T11:55:00.000Z', tupleDigest: tuple.tupleDigest }),
        receipt({
          correlation: 'challenge-codex-run-002',
          producedAt: '2026-08-16T11:56:00.000Z',
          tupleDigest: tuple.tupleDigest,
          eventClass: 'turn',
        }),
      ],
    }),
    now: NOW,
  });
  assert.equal(overlapping.state, 'active');
});

test('health alone cannot activate and failed health degrades a live path', () => {
  const healthOnly = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      receipts: [],
      health: { available: true, healthy: true },
    }),
    now: NOW,
  });
  assert.equal(healthOnly.state, 'awaiting_live_proof');
  assert.ok(!healthOnly.reasons.includes('live_proof_fresh'));

  const degraded = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      health: { available: true, healthy: false },
    }),
    now: NOW,
  });
  assert.equal(degraded.state, 'degraded');
  assert.ok(degraded.reasons.includes('health_degraded'));
});

test('rollback invalidates generation and modified state refuses with rollback_pending', () => {
  const invalidated = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      rollback: { status: 'completed', invalidatedGeneration: GENERATION },
    }),
    now: NOW,
  });
  assert.equal(invalidated.state, 'rolled_back');
  assert.ok(invalidated.reasons.includes('generation_invalidated'));

  const modified = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      rollback: { status: 'refused', modifiedOrAmbiguous: true },
    }),
    now: NOW,
  });
  assert.equal(modified.state, 'rollback_pending');
  assert.ok(modified.reasons.includes('rollback_refused_modified'));
});

test('dual-receipt contracts require ordered session then turn', () => {
  const contract = dualContract('hermes');
  const tuple = selectedTuple({ harness: 'hermes' });
  const session = receipt({
    harness: 'hermes',
    eventClass: 'session',
    producedAt: '2026-08-16T11:54:00.000Z',
    tupleDigest: tuple.tupleDigest,
  });
  const turn = receipt({
    harness: 'hermes',
    eventClass: 'turn',
    producedAt: '2026-08-16T11:55:00.000Z',
    tupleDigest: tuple.tupleDigest,
  });

  const incomplete = evaluateManagedActivation({
    contract,
    evidence: baselineEvidence({
      attestation: { ...baselineEvidence().attestation, harness: 'hermes', tupleDigest: tuple.tupleDigest },
      challenges: [{ correlation: CORRELATION, harness: 'hermes', baselineAt: '2026-08-16T11:50:00.000Z' }],
      receipts: [session],
    }),
    now: NOW,
  });
  assert.equal(incomplete.state, 'awaiting_live_proof');

  const ordered = evaluateManagedActivation({
    contract,
    evidence: baselineEvidence({
      attestation: {
        ok: true,
        harness: 'hermes',
        generation: GENERATION,
        assetDigest: DIGEST_A,
        entrypointDigest: DIGEST_B,
        configBindingDigest: DIGEST_C,
        tupleDigest: tuple.tupleDigest,
      },
      challenges: [{ correlation: CORRELATION, harness: 'hermes', baselineAt: '2026-08-16T11:50:00.000Z' }],
      receipts: [session, turn],
    }),
    now: NOW,
  });
  assert.equal(ordered.state, 'active');

  const outOfOrder = evaluateManagedActivation({
    contract,
    evidence: baselineEvidence({
      attestation: {
        ok: true,
        harness: 'hermes',
        generation: GENERATION,
        assetDigest: DIGEST_A,
        entrypointDigest: DIGEST_B,
        configBindingDigest: DIGEST_C,
        tupleDigest: tuple.tupleDigest,
      },
      challenges: [{ correlation: CORRELATION, harness: 'hermes', baselineAt: '2026-08-16T11:50:00.000Z' }],
      receipts: [
        receipt({
          harness: 'hermes',
          eventClass: 'turn',
          producedAt: '2026-08-16T11:54:00.000Z',
          tupleDigest: tuple.tupleDigest,
        }),
        receipt({
          harness: 'hermes',
          eventClass: 'session',
          producedAt: '2026-08-16T11:55:00.000Z',
          tupleDigest: tuple.tupleDigest,
        }),
      ],
    }),
    now: NOW,
  });
  assert.notEqual(outOfOrder.state, 'active');
});

test('safe collector rejects relative paths symlinks special files and unsafe modes', () => {
  const root = fixtureRoot();
  try {
    const asset = path.join(root, 'asset.js');
    const entry = path.join(root, 'entrypoint.js');
    const config = path.join(root, 'config.json');
    writeOwnerFile(asset, 'asset-bytes');
    writeOwnerFile(entry, 'entry-bytes');
    writeOwnerFile(config, '{"bound":true}');

    const ok = collectManagedActivationAttestation({
      harness: 'codex',
      generation: GENERATION,
      assetPaths: [asset],
      entrypointPath: entry,
      configBindingPath: config,
    });
    assert.equal(ok.ok, true, (ok.errors || []).join('\n'));
    assert.match(ok.tupleDigest, /^[a-f0-9]{64}$/);
    assert.equal(ok.assetDigest, sha256('asset-bytes'));
    assert.equal(ok.entrypointDigest, sha256('entry-bytes'));
    assert.equal(ok.configBindingDigest, sha256('{"bound":true}'));

    const relative = collectManagedActivationAttestation({
      harness: 'codex',
      generation: GENERATION,
      assetPaths: ['relative/asset.js'],
      entrypointPath: entry,
      configBindingPath: config,
    });
    assert.equal(relative.ok, false);
    assert.ok(!JSON.stringify(relative).includes('relative/asset.js') || relative.reasonCode);

    const link = path.join(root, 'link-asset.js');
    fs.symlinkSync(asset, link);
    const symlink = collectManagedActivationAttestation({
      harness: 'codex',
      generation: GENERATION,
      assetPaths: [link],
      entrypointPath: entry,
      configBindingPath: config,
    });
    assert.equal(symlink.ok, false);

    const unsafe = path.join(root, 'unsafe.js');
    writeOwnerFile(unsafe, 'unsafe', 0o666);
    const unsafeMode = collectManagedActivationAttestation({
      harness: 'codex',
      generation: GENERATION,
      assetPaths: [unsafe],
      entrypointPath: entry,
      configBindingPath: config,
    });
    assert.equal(unsafeMode.ok, false);

    const changed = collectManagedActivationAttestation({
      harness: 'codex',
      generation: GENERATION,
      assetPaths: [asset],
      entrypointPath: entry,
      configBindingPath: config,
      expected: {
        assetDigest: DIGEST_D,
        entrypointDigest: ok.entrypointDigest,
        configBindingDigest: ok.configBindingDigest,
      },
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.reasonCode, 'asset_digest_mismatch');

    const specialDir = path.join(root, 'not-a-file');
    fs.mkdirSync(specialDir, { mode: 0o700 });
    fs.chmodSync(specialDir, 0o700);
    const directoryPath = collectManagedActivationAttestation({
      harness: 'codex',
      generation: GENERATION,
      assetPaths: [specialDir],
      entrypointPath: entry,
      configBindingPath: config,
    });
    assert.equal(directoryPath.ok, false);

    const fifoPath = path.join(root, 'fifo-asset');
    try {
      const { spawnSync } = require('child_process');
      const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
      if (mkfifo.status === 0) {
        const special = collectManagedActivationAttestation({
          harness: 'codex',
          generation: GENERATION,
          assetPaths: [fifoPath],
          entrypointPath: entry,
          configBindingPath: config,
        });
        assert.equal(special.ok, false);
      }
    } catch (_) {
      // mkfifo may be unavailable; directory/symlink/mode cases still cover non-regular rejection.
    }

    const hijackDir = path.join(root, 'writable-ancestor');
    fs.mkdirSync(hijackDir, { mode: 0o777 });
    fs.chmodSync(hijackDir, 0o777);
    const hijacked = path.join(hijackDir, 'asset.js');
    fs.writeFileSync(hijacked, 'hijacked', { mode: 0o600 });
    fs.chmodSync(hijacked, 0o600);
    const unsafeAncestor = collectManagedActivationAttestation({
      harness: 'codex',
      generation: GENERATION,
      assetPaths: [hijacked],
      entrypointPath: entry,
      configBindingPath: config,
    });
    assert.equal(unsafeAncestor.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('owner evidence loader accepts only safe absolute regular files', () => {
  const root = fixtureRoot();
  try {
    const evidencePath = path.join(root, 'evidence.json');
    const payload = {
      configured: true,
      prepared: true,
      receipts: [],
    };
    writeOwnerFile(evidencePath, `${JSON.stringify(payload)}\n`);

    const loaded = loadOwnerEvidence(evidencePath);
    assert.equal(loaded.ok, true, (loaded.errors || []).join('\n'));
    assert.equal(loaded.value.configured, true);

    const relative = loadOwnerEvidence('evidence.json');
    assert.equal(relative.ok, false);
    assert.equal(relative.reasonCode, 'evidence_unreadable');
    assert.ok(!JSON.stringify(relative).includes('evidence.json') || !String(relative.errors || '').includes(process.cwd()));

    const link = path.join(root, 'evidence-link.json');
    fs.symlinkSync(evidencePath, link);
    const linked = loadOwnerEvidence(link);
    assert.equal(linked.ok, false);

    const world = path.join(root, 'world.json');
    writeOwnerFile(world, '{}', 0o644);
    const worldReadable = loadOwnerEvidence(world);
    assert.equal(worldReadable.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public status never emits private path session process or raw diagnostic strings', () => {
  const result = evaluateManagedActivation({
    contract: validContract(),
    evidence: baselineEvidence({
      attestation: {
        ok: false,
        reasonCode: 'attestation_unavailable',
        diagnostic: SENTINEL_DIAG,
        path: SENTINEL_PATH,
        sessionId: SENTINEL_SESSION,
        processId: SENTINEL_PROCESS,
      },
      receipts: [receipt({
        // invalid private fields are rejected by receipt validation before evaluation
      })],
    }),
    now: NOW,
  });
  const publicStatus = toPublicActivationStatus(result);
  const encoded = JSON.stringify(publicStatus);
  assert.equal(encoded.includes(SENTINEL_PATH), false);
  assert.equal(encoded.includes(SENTINEL_SESSION), false);
  assert.equal(encoded.includes(SENTINEL_PROCESS), false);
  assert.equal(encoded.includes(SENTINEL_DIAG), false);
  assert.equal(encoded.includes('/Users/'), false);
  assert.ok(Array.isArray(publicStatus.reasons));
  for (const reason of publicStatus.reasons) {
    assert.ok(MANAGED_ACTIVATION_REASON_CODES.has(reason), reason);
  }
  for (const key of Object.keys(publicStatus)) {
    assert.ok([
      'schemaVersion',
      'harness',
      'state',
      'generationDigest',
      'evidenceClasses',
      'freshThrough',
      'reasons',
      'evaluatedAt',
    ].includes(key), key);
  }
});

test('unknown receipt type version and harness are rejected before activation', () => {
  const unknownHarness = evaluateManagedActivation({
    contract: validContract({ harness: 'codex' }),
    evidence: baselineEvidence({
      receipts: [receipt({ harness: 'not-a-harness' })],
    }),
    now: NOW,
  });
  assert.notEqual(unknownHarness.state, 'active');

  const badType = validateManagedActivationReceipt(receipt({ eventClass: 1 }));
  assert.equal(badType.ok, false);
});
