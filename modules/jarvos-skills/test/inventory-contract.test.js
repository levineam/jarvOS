'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  defaultConfig,
  normalizeConfig,
  resolveConfigPaths,
  saveConfig,
  loadConfig,
  ensureDir,
  ensureControlPlane,
  CONFIG_SCHEMA_VERSION,
} = require('../src/config');

const {
  INVENTORY_SCHEMA_VERSION,
  STATUS_SCHEMA_VERSION,
  INSPECT_SCHEMA_VERSION,
  EXCLUSION_SCHEMA_VERSION,
  ROOT_LIFECYCLES,
  TRUST_CLASSES,
  SOURCE_STATES,
  DISPOSITIONS,
  PROJECTION_STATES,
  VERIFICATION_STATES,
  ATTENTION_STATES,
  ALLOWED_REASON_CODES,
  AUTONOMOUS_SERVICE_PRINCIPAL,
  inventoryDigest,
  defaultInventoryPolicy,
  normalizeInventoryPolicy,
  normalizeRetirementPolicy,
  assertAutonomousPrincipal,
  validateInventoryDocument,
  validateExclusionOverlay,
  serializeOutwardStatus,
  validateOutwardStatus,
  serializeOwnerInspect,
  validateOwnerInspect,
  ensureInventoryStateLayout,
  loadExclusionOverlay,
  saveExclusionOverlay,
} = require('../src/inventory-contract');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function temp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function sampleRoot(overrides = {}) {
  return {
    rootId: 'root-codex-user',
    harness: 'codex',
    root: path.join(os.homedir(), '.codex', 'skills'),
    lifecycle: 'available',
    trustClass: 'markdown-only',
    complete: true,
    ...overrides,
  };
}

function sampleSkill(overrides = {}) {
  return {
    logicalId: 'writing-skill',
    observedName: 'writing-skill',
    treeDigest: DIGEST_A,
    observations: [{
      rootId: 'root-codex-user',
      relativePath: 'writing-skill',
      absolutePath: path.join(os.homedir(), '.codex', 'skills', 'writing-skill'),
      state: 'new',
      observedAt: '2026-08-15T12:00:00.000Z',
    }],
    disposition: {
      kind: 'shared',
      reasonCode: 'rule_proven_portable',
    },
    matrix: [
      { harness: 'codex', projection: 'source_present', verification: 'model_visible' },
      { harness: 'claude', projection: 'missing', verification: 'verification_pending' },
      { harness: 'openclaw', projection: 'missing', verification: 'unverifiable' },
      { harness: 'hermes', projection: 'missing', verification: 'unverifiable' },
    ],
    attention: 'quiet',
    ...overrides,
  };
}

function sampleInventory(overrides = {}) {
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generationId: 'gen-001',
    acceptedGenerationId: 'gen-001',
    acceptedAt: '2026-08-15T12:05:00.000Z',
    observedAt: '2026-08-15T12:00:00.000Z',
    roots: [sampleRoot()],
    skills: [sampleSkill()],
    exclusions: [],
    ...overrides,
  };
}

test('happy path inventory document validates and digests deterministically', () => {
  const first = validateInventoryDocument(sampleInventory());
  const second = validateInventoryDocument(JSON.parse(JSON.stringify(sampleInventory())));
  assert.equal(first.status, 'valid');
  assert.equal(first.mutate, false);
  assert.equal(first.digest, second.digest);
  assert.equal(first.document.skills[0].disposition.kind, 'shared');
  assert.equal(first.document.roots[0].trustClass, 'markdown-only');
  assert.equal(inventoryDigest(first.document), first.digest);
});

test('unknown schema versions are unsupported and non-mutating', () => {
  const inventory = validateInventoryDocument({
    ...sampleInventory(),
    schemaVersion: 'jarvos.skill-inventory/v9',
  });
  assert.equal(inventory.status, 'unsupported');
  assert.equal(inventory.mutate, false);

  const exclusions = validateExclusionOverlay({
    schemaVersion: 'jarvos.skill-exclusions/v9',
    entries: [],
  });
  assert.equal(exclusions.status, 'unsupported');
  assert.equal(exclusions.mutate, false);

  assert.throws(
    () => validateOutwardStatus({ schemaVersion: 'future', skills: [] }),
    /unsupported/,
  );
});

test('invalid enum, path, and digest values fail closed', () => {
  assert.throws(
    () => validateInventoryDocument(sampleInventory({
      skills: [sampleSkill({ disposition: { kind: 'maybe', reasonCode: 'rule_proven_portable' } })],
    })),
    /disposition/,
  );

  assert.throws(
    () => validateInventoryDocument(sampleInventory({
      roots: [sampleRoot({ lifecycle: 'ghost' })],
    })),
    /lifecycle/,
  );

  assert.throws(
    () => validateInventoryDocument(sampleInventory({
      skills: [sampleSkill({ treeDigest: 'not-a-digest' })],
    })),
    /SHA-256/,
  );

  assert.throws(
    () => validateInventoryDocument(sampleInventory({
      skills: [sampleSkill({
        observations: [{
          rootId: 'root-codex-user',
          relativePath: '../escape',
          absolutePath: '/tmp/escape',
          state: 'new',
          observedAt: '2026-08-15T12:00:00.000Z',
        }],
      })],
    })),
    /relative path/,
  );

  assert.throws(
    () => validateInventoryDocument(sampleInventory({
      skills: [sampleSkill({
        disposition: { kind: 'blocked', reasonCode: 'custom-unlisted' },
      })],
    })),
    /reason code/,
  );

  assert.ok(ROOT_LIFECYCLES.includes('available'));
  assert.ok(TRUST_CLASSES.includes('portable-bundles'));
  assert.ok(SOURCE_STATES.includes('unsafe'));
  assert.ok(DISPOSITIONS.includes('needs_input'));
  assert.ok(PROJECTION_STATES.includes('retired'));
  assert.ok(VERIFICATION_STATES.includes('model_visible'));
  assert.ok(ATTENTION_STATES.includes('actionable'));
  assert.ok(ALLOWED_REASON_CODES.includes('rule_proven_portable'));
});

test('incomplete matrix rows and duplicate identities fail closed', () => {
  assert.throws(
    () => validateInventoryDocument(sampleInventory({
      skills: [sampleSkill({
        matrix: [
          { harness: 'codex', projection: 'source_present', verification: 'model_visible' },
          { harness: 'claude', projection: 'missing', verification: 'verification_pending' },
        ],
      })],
    })),
    /matrix/,
  );

  assert.throws(
    () => validateInventoryDocument(sampleInventory({
      skills: [sampleSkill(), sampleSkill({ logicalId: 'writing-skill', observedName: 'other' })],
    })),
    /duplicated/,
  );

  assert.throws(
    () => validateInventoryDocument(sampleInventory({
      roots: [sampleRoot(), sampleRoot({ rootId: 'root-codex-user', harness: 'claude' })],
    })),
    /duplicated/,
  );
});

test('autonomous service principal is narrow and rejects excess authority', () => {
  const principal = assertAutonomousPrincipal(AUTONOMOUS_SERVICE_PRINCIPAL);
  assert.equal(principal.kind, 'autonomous-inventory-service');
  assert.ok(principal.capabilities.includes('inventory.observe'));
  assert.ok(principal.capabilities.includes('inventory.auto_admit_rule_proven'));
  assert.ok(principal.capabilities.includes('inventory.reconcile_accepted'));
  assert.ok(principal.denied.includes('roots.register'));
  assert.ok(principal.denied.includes('needs_input.approve'));
  assert.ok(principal.denied.includes('generation.rollback'));
  assert.ok(principal.denied.includes('private.reveal'));

  assert.throws(
    () => assertAutonomousPrincipal({
      ...AUTONOMOUS_SERVICE_PRINCIPAL,
      capabilities: [...AUTONOMOUS_SERVICE_PRINCIPAL.capabilities, 'roots.register'],
    }),
    /excess|denied|authority|capability/i,
  );

  assert.throws(
    () => assertAutonomousPrincipal({
      kind: 'autonomous-inventory-service',
      capabilities: ['inventory.observe', 'needs_input.approve'],
      denied: AUTONOMOUS_SERVICE_PRINCIPAL.denied,
    }),
    /excess|denied|authority|capability/i,
  );
});

test('outward status omits privacy sentinels while owner inspect may reveal names and paths', () => {
  const privateName = 'secret-transcribe';
  const privatePath = path.join(os.homedir(), '.openclaw', 'skills', 'secret-transcribe');
  const privateBody = 'PRIVATE_BODY_SENTINEL_do_not_leak';
  const rawParserError = 'SyntaxError: unexpected token near /Users/private';
  const credential = 'sk-live-super-secret-token';

  const document = sampleInventory({
    roots: [sampleRoot({
      rootId: 'root-openclaw',
      harness: 'openclaw',
      root: path.dirname(privatePath),
    })],
    skills: [sampleSkill({
      logicalId: 'skill-opaque-1',
      observedName: privateName,
      observations: [{
        rootId: 'root-openclaw',
        relativePath: 'secret-transcribe',
        absolutePath: privatePath,
        state: 'unchanged',
        observedAt: '2026-08-15T12:00:00.000Z',
        parserError: rawParserError,
        excerpt: privateBody,
        credentialHint: credential,
      }],
      disposition: { kind: 'shared', reasonCode: 'rule_proven_portable' },
      matrix: [
        { harness: 'codex', projection: 'installed', verification: 'model_visible' },
        { harness: 'claude', projection: 'installed', verification: 'verification_pending' },
        { harness: 'openclaw', projection: 'source_present', verification: 'model_visible' },
        { harness: 'hermes', projection: 'missing', verification: 'unverifiable' },
      ],
    })],
  });

  const validated = validateInventoryDocument(document);
  assert.equal(validated.status, 'valid');

  const status = serializeOutwardStatus(validated.document, {
    counts: { skills: 1, shared: 1, blocked: 0, needs_input: 0, actionable: 0 },
  });
  assert.equal(status.schemaVersion, STATUS_SCHEMA_VERSION);
  validateOutwardStatus(status);
  const statusText = JSON.stringify(status);
  assert.equal(statusText.includes(privateName), false);
  assert.equal(statusText.includes(privatePath), false);
  assert.equal(statusText.includes(privateBody), false);
  assert.equal(statusText.includes(rawParserError), false);
  assert.equal(statusText.includes(credential), false);
  assert.equal(statusText.includes(os.homedir()), false);
  assert.equal(status.skills[0].logicalId, 'skill-opaque-1');
  assert.equal(status.skills[0].treeDigest, DIGEST_A);
  assert.equal(status.skills[0].disposition.reasonCode, 'rule_proven_portable');

  assert.throws(
    () => validateOutwardStatus({
      ...status,
      skills: [{
        ...status.skills[0],
        observedName: privateName,
        absolutePath: privatePath,
        body: privateBody,
      }],
    }),
    /private|forbidden|not allowed|must not/i,
  );

  const inspect = serializeOwnerInspect(validated.document, { authorized: true });
  assert.equal(inspect.schemaVersion, INSPECT_SCHEMA_VERSION);
  validateOwnerInspect(inspect);
  assert.equal(inspect.skills[0].observedName, privateName);
  assert.equal(inspect.skills[0].observations[0].absolutePath, privatePath);
  const inspectText = JSON.stringify(inspect);
  assert.equal(inspectText.includes(privateBody), false);
  assert.equal(inspectText.includes(credential), false);
  assert.equal(inspectText.includes(rawParserError), false);

  assert.throws(
    () => serializeOwnerInspect(validated.document, { authorized: false }),
    /authoriz/i,
  );
});

test('owner exclusion overlay is durable and keyed by logical skill identity', () => {
  const root = temp('jarvos-excl-');
  try {
    const overlayPath = path.join(root, 'exclusions.json');
    const overlay = {
      schemaVersion: EXCLUSION_SCHEMA_VERSION,
      entries: [{
        logicalId: 'writing-skill',
        reasonCode: 'owner_excluded',
        excludedAt: '2026-08-15T12:00:00.000Z',
      }],
    };
    const validated = validateExclusionOverlay(overlay);
    assert.equal(validated.status, 'valid');
    saveExclusionOverlay(overlay, overlayPath);
    const loaded = loadExclusionOverlay(overlayPath);
    assert.equal(loaded.overlay.entries[0].logicalId, 'writing-skill');
    assert.equal(loaded.overlay.entries[0].reasonCode, 'owner_excluded');

    assert.throws(
      () => validateExclusionOverlay({
        schemaVersion: EXCLUSION_SCHEMA_VERSION,
        entries: [
          { logicalId: 'writing-skill', reasonCode: 'owner_excluded', excludedAt: '2026-08-15T12:00:00.000Z' },
          { logicalId: 'writing-skill', reasonCode: 'owner_excluded', excludedAt: '2026-08-15T13:00:00.000Z' },
        ],
      }),
      /duplicated/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config inventory policy has finite defaults and retirement floor', () => {
  const config = defaultConfig();
  assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.ok(config.inventory);
  assert.equal(config.inventory.enabled, false);

  const policy = normalizeInventoryPolicy(config.inventory);
  assert.ok(policy.limits.maxRoots >= 1);
  assert.ok(policy.limits.maxEntriesPerRoot >= 1);
  assert.ok(policy.limits.maxBundleFiles >= 1);
  assert.ok(policy.limits.maxBundleBytes >= 1);
  assert.ok(policy.limits.maxEventsPerRun >= 1);
  assert.ok(policy.limits.maxRollbackGenerations >= 1);
  assert.ok(policy.limits.maxAttentionHistory >= 1);
  assert.equal(Number.isFinite(policy.limits.maxRoots), true);
  assert.equal(Number.isFinite(policy.eventQuiescence.digestStabilityMs), true);

  const retirement = normalizeRetirementPolicy(policy.retirement, {
    intervalMinutes: config.scheduler.intervalMinutes,
  });
  assert.ok(retirement.minAbsenceObservations >= 2);
  assert.ok(retirement.minAbsenceIntervalHours >= 24);
  assert.ok(retirement.minSchedulerIntervals >= 2);
  const twoIntervalsHours = (2 * config.scheduler.intervalMinutes) / 60;
  assert.ok(retirement.effectiveAbsenceIntervalHours >= Math.max(24, twoIntervalsHours));

  assert.throws(
    () => normalizeRetirementPolicy({
      minAbsenceObservations: 1,
      minAbsenceIntervalHours: 24,
      minSchedulerIntervals: 2,
    }, { intervalMinutes: 60 }),
    /two|absence|observation/i,
  );

  assert.throws(
    () => normalizeRetirementPolicy({
      minAbsenceObservations: 2,
      minAbsenceIntervalHours: 1,
      minSchedulerIntervals: 2,
    }, { intervalMinutes: 60 }),
    /24|hour/i,
  );

  const withRoot = normalizeConfig({
    ...config,
    inventory: {
      ...config.inventory,
      registeredRoots: [{
        rootId: 'root-codex-user',
        harness: 'codex',
        root: '~/.codex/skills',
        trustClass: 'portable-bundles',
        lifecycle: 'available',
      }],
    },
  });
  assert.equal(withRoot.inventory.registeredRoots[0].trustClass, 'portable-bundles');
  assert.equal(withRoot.inventory.registeredRoots[0].root.startsWith('~/') || withRoot.inventory.registeredRoots[0].root.includes('codex'), true);

  assert.throws(
    () => normalizeConfig({
      ...config,
      inventory: {
        ...config.inventory,
        registeredRoots: [{
          rootId: 'bad',
          harness: 'codex',
          root: 'relative/not/allowed',
          trustClass: 'markdown-only',
          lifecycle: 'available',
        }],
      },
    }),
    /absolute|path/i,
  );

  assert.throws(
    () => normalizeConfig({
      ...defaultConfig(),
      schemaVersion: 'jarvos.shared-skill-config/v9',
    }),
    /unsupported/,
  );
});

test('private inventory state paths are owner-only, no-follow, and fail closed', () => {
  const root = temp('jarvos-inv-state-');
  try {
    const controlRoot = path.join(root, 'control');
    ensureDir(controlRoot, 'control root');
    const layout = ensureInventoryStateLayout({
      controlRoot,
      inventory: defaultInventoryPolicy(),
    });
    assert.ok(fs.existsSync(layout.stateRoot));
    const stateStat = fs.lstatSync(layout.stateRoot);
    assert.equal(stateStat.isSymbolicLink(), false);
    assert.equal((stateStat.mode & 0o077), 0);
    assert.ok(fs.existsSync(layout.sourceStorePath));
    assert.ok(fs.existsSync(path.dirname(layout.exclusionOverlayPath)));

    const worldWritable = path.join(root, 'world');
    fs.mkdirSync(worldWritable, { recursive: true, mode: 0o777 });
    fs.chmodSync(worldWritable, 0o777);
    assert.throws(
      () => ensureInventoryStateLayout({
        controlRoot: worldWritable,
        inventory: defaultInventoryPolicy(),
      }),
      /group- or world|owner-only|permissions|writable/i,
    );

    const linkParent = path.join(root, 'link-parent');
    ensureDir(linkParent, 'link parent');
    const realTarget = path.join(root, 'link-target');
    ensureDir(realTarget, 'link target');
    const linkedState = path.join(linkParent, 'inventory');
    fs.symlinkSync(realTarget, linkedState);
    const policy = {
      ...defaultInventoryPolicy(),
      state: {
        ...defaultInventoryPolicy().state,
        stateRootName: 'inventory',
      },
    };
    assert.throws(
      () => ensureInventoryStateLayout({
        controlRoot: linkParent,
        inventory: policy,
      }),
      /symbolic link|no-follow|must not/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing shared-skill config remains compatible and inventory defaults do not enable live behavior', () => {
  const root = temp('jarvos-inv-config-');
  try {
    const controlRoot = path.join(root, 'control');
    const configPath = path.join(controlRoot, 'config.json');
    const saved = saveConfig({
      ...defaultConfig(),
      controlRoot,
      publicCatalogPath: path.join(controlRoot, 'public-catalog.json'),
      localOverlayPath: path.join(controlRoot, 'local-overlay.json'),
    }, configPath);
    assert.equal(saved.config.inventory.enabled, false);
    assert.equal(saved.config.scheduler.enabled, false);

    const loaded = loadConfig(configPath);
    assert.equal(loaded.config.schemaVersion, CONFIG_SCHEMA_VERSION);
    assert.equal(loaded.config.inventory.enabled, false);
    assert.ok(loaded.config.inventory.limits.maxRoots > 0);

    const resolved = resolveConfigPaths(loaded.config);
    assert.ok(resolved.controlRoot);
    ensureControlPlane(loaded.config);
    assert.equal(fs.existsSync(resolved.publicCatalogPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
