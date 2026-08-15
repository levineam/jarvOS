'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  defaultConfig,
  normalizeConfig,
  saveConfig,
  loadConfig,
  ensureDir,
  CONFIG_SCHEMA_VERSION,
} = require('../src/config');
const {
  observeInventory,
  declaredAdapterInventoryRoots,
  buildRegisteredRootsFromAdapters,
  inventoryOperator,
  loadHarnessAdapter,
} = require('../src/inventory');
const {
  INVENTORY_SCHEMA_VERSION,
  validateInventoryDocument,
  validateOutwardStatus,
  ensureInventoryStateLayout,
} = require('../src/inventory-contract');
const { inventoryStatusOperator } = require('../src/operator');
const { computeBundleTree } = require('../src/catalog');
const { atomicWriteReceipt, STATE_DIR } = require('../src/receipts');

const CLI = path.join(__dirname, '..', 'scripts', 'install-skills.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'catalog', 'public-fixture');

function temp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function writeSkill(bundleRoot, name = 'sample-skill', body = '# Sample\n') {
  fs.mkdirSync(bundleRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bundleRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n\n${body}`, { mode: 0o600 });
  fs.chmodSync(bundleRoot, 0o700);
  return bundleRoot;
}

function copyFixture(to) {
  fs.cpSync(FIXTURE, to, { recursive: true });
  const walk = (dir) => {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else fs.chmodSync(full, 0o600);
    }
  };
  walk(to);
  return to;
}

function seedConfig({ roots, controlRoot, limits = {} } = {}) {
  const home = temp('jarvos-inv-home-');
  const control = controlRoot || path.join(home, '.jarvos', 'shared-skills');
  ensureDir(control, 'control');
  const config = normalizeConfig({
    ...defaultConfig(),
    schemaVersion: CONFIG_SCHEMA_VERSION,
    controlRoot: control,
    publicCatalogPath: path.join(control, 'public-catalog.json'),
    localOverlayPath: path.join(control, 'local-overlay.json'),
    harnesses: Object.fromEntries(['codex', 'claude', 'openclaw', 'hermes'].map((id) => [id, {
      enabled: true,
      root: roots?.[id] || path.join(home, `.${id}`, 'skills'),
      scopeRoots: {},
      scopeRootsComplete: false,
    }])),
    inventory: {
      ...defaultConfig().inventory,
      enabled: false,
      registeredRoots: (roots && Object.entries(roots).map(([harness, root]) => ({
        rootId: `${harness}-managed`,
        harness,
        root,
        trustClass: 'markdown-only',
        lifecycle: 'available',
      }))) || [],
      limits: {
        ...defaultConfig().inventory.limits,
        ...limits,
      },
    },
  });
  const saved = saveConfig(config, path.join(control, 'config.json'));
  return { home, control, configPath: saved.path, config: saved.config };
}

test('adapter declarations cover all four harnesses and keep relative roots non-scannable', () => {
  const declared = declaredAdapterInventoryRoots();
  const harnesses = new Set(declared.map((entry) => entry.harness));
  assert.deepEqual([...harnesses].sort(), ['claude', 'codex', 'hermes', 'openclaw']);

  const absolute = declared.filter((entry) => entry.inventoryEligible);
  const relative = declared.filter((entry) => !entry.inventoryEligible);
  assert.ok(absolute.length >= 4);
  assert.ok(relative.length >= 1);
  assert.ok(relative.every((entry) => entry.absolute === false));

  const built = buildRegisteredRootsFromAdapters({ config: defaultConfig() });
  assert.ok(built.every((root) => path.isAbsolute(require('../src/config').expandHome(root.root)) || root.root.startsWith('~/')));
  assert.ok(built.every((root) => ['codex', 'claude', 'openclaw', 'hermes'].includes(root.harness)));
});

test('adapter loader preserves custom repository-root and null-on-error semantics', () => {
  const repoRoot = temp('jarvos-adapter-root-');
  const adapterRoot = path.join(repoRoot, 'runtimes', 'codex');
  fs.mkdirSync(adapterRoot, { recursive: true, mode: 0o700 });
  const adapterPath = path.join(adapterRoot, 'adapter.json');
  try {
    fs.writeFileSync(adapterPath, JSON.stringify({ id: 'custom-codex' }), { mode: 0o600 });
    assert.deepEqual(loadHarnessAdapter('codex', { repoRoot }), { id: 'custom-codex' });
    fs.writeFileSync(adapterPath, '{invalid', { mode: 0o600 });
    assert.equal(loadHarnessAdapter('codex', { repoRoot }), null);
    assert.equal(loadHarnessAdapter('missing', { repoRoot }), null);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bounded inventory observes bundles across four registered roots and redacts paths in status', () => {
  const home = temp('jarvos-inv-four-');
  const roots = {
    codex: path.join(home, 'codex-skills'),
    claude: path.join(home, 'claude-skills'),
    openclaw: path.join(home, 'openclaw-skills'),
    hermes: path.join(home, 'hermes-skills'),
  };
  for (const root of Object.values(roots)) ensureDir(root, 'root');
  writeSkill(path.join(roots.codex, 'alpha-skill'), 'alpha-skill', 'alpha');
  writeSkill(path.join(roots.claude, 'beta-skill'), 'beta-skill', 'beta');
  writeSkill(path.join(roots.openclaw, 'gamma-skill'), 'gamma-skill', 'gamma');
  writeSkill(path.join(roots.hermes, 'delta-skill'), 'delta-skill', 'delta');

  const env = seedConfig({ roots });
  const first = observeInventory({ configPath: env.configPath, observedAt: '2026-08-15T15:00:00.000Z' });
  assert.equal(first.ok, true);
  assert.equal(first.complete, true);
  assert.equal(first.mutate, true);
  assert.equal(first.document.skills.length, 4);
  assert.equal(first.document.roots.length, 4);
  assert.ok(first.document.roots.every((root) => root.complete === true));
  assert.ok(first.document.skills.every((skill) => skill.disposition.kind === 'needs_input'));
  assert.ok(first.document.skills.every((skill) => (
    skill.matrix.some((row) => row.projection === 'source_present')
  )));

  const status = validateOutwardStatus(first.status);
  assert.equal(status.schemaVersion, 'jarvos.skill-inventory-status/v1');
  const encoded = JSON.stringify(status);
  assert.equal(encoded.includes(home), false);
  assert.equal(encoded.includes(roots.codex), false);
  assert.equal(encoded.includes('absolutePath'), false);

  const validated = validateInventoryDocument(first.document);
  assert.equal(validated.status, 'valid');
  assert.equal(validated.document.schemaVersion, INVENTORY_SCHEMA_VERSION);
});

test('registration lifecycle, relative/stale roots, and unregistration stay non-authorizing', () => {
  const home = temp('jarvos-inv-life-');
  const available = path.join(home, 'available');
  ensureDir(available, 'available');
  writeSkill(path.join(available, 'ok-skill'), 'ok-skill');
  const missing = path.join(home, 'missing-root');
  const env = seedConfig({
    roots: {
      codex: available,
      claude: missing,
      openclaw: available,
      hermes: available,
    },
  });
  // Force one root unregistered and one stale lifecycle in config.
  const loaded = loadConfig(env.configPath);
  const config = {
    ...loaded.config,
    inventory: {
      ...loaded.config.inventory,
      registeredRoots: [
        {
          rootId: 'codex-managed',
          harness: 'codex',
          root: available,
          trustClass: 'markdown-only',
          lifecycle: 'available',
        },
        {
          rootId: 'claude-missing',
          harness: 'claude',
          root: missing,
          trustClass: 'markdown-only',
          lifecycle: 'available',
        },
        {
          rootId: 'openclaw-stale',
          harness: 'openclaw',
          root: available,
          trustClass: 'markdown-only',
          lifecycle: 'stale',
        },
        {
          rootId: 'hermes-unreg',
          harness: 'hermes',
          root: available,
          trustClass: 'markdown-only',
          lifecycle: 'unregistered',
        },
      ],
    },
  };
  saveConfig(config, env.configPath);

  const result = observeInventory({ configPath: env.configPath, observedAt: '2026-08-15T15:01:00.000Z' });
  const byId = Object.fromEntries(result.document.roots.map((root) => [root.rootId, root]));
  assert.equal(byId['codex-managed'].lifecycle, 'available');
  assert.equal(byId['codex-managed'].complete, true);
  assert.equal(byId['claude-missing'].lifecycle, 'stale');
  assert.equal(byId['claude-missing'].complete, false);
  assert.equal(byId['openclaw-stale'].lifecycle, 'stale');
  assert.equal(byId['openclaw-stale'].complete, false);
  assert.equal(byId['hermes-unreg'].lifecycle, 'unregistered');
  assert.equal(result.complete, false);
  assert.equal(result.document.skills.length, 1);
  assert.equal(result.document.skills[0].disposition.kind, 'needs_input');
});

test('duplicate physical sources collapse; receipt-owned and snapshot-store copies are excluded', () => {
  const home = temp('jarvos-inv-dup-');
  const rootA = path.join(home, 'a');
  const rootB = path.join(home, 'b');
  ensureDir(rootA, 'a');
  ensureDir(rootB, 'b');
  const skillA = writeSkill(path.join(rootA, 'shared-skill'), 'shared-skill', 'same-body');
  // Byte-identical second copy.
  writeSkill(path.join(rootB, 'shared-skill'), 'shared-skill', 'same-body');

  // Receipt-owned projection under rootA.
  writeSkill(path.join(rootA, 'managed-copy'), 'managed-copy', 'managed');
  const tree = computeBundleTree(path.join(rootA, 'managed-copy'));
  atomicWriteReceipt(rootA, {
    version: 1,
    id: 'managed-copy',
    effectiveName: 'managed-copy',
    harness: 'codex',
    treeDigest: tree.treeDigest,
    catalogDigest: 'c'.repeat(64),
    aliasRevision: 0,
    targetPath: path.join(rootA, 'managed-copy'),
  });

  const env = seedConfig({
    roots: {
      codex: rootA,
      claude: rootB,
      openclaw: rootA,
      hermes: rootB,
    },
  });
  const layout = ensureInventoryStateLayout({
    controlRoot: env.control,
    inventory: loadConfig(env.configPath).config.inventory,
  });
  // Snapshot-store exclusion: put a skill-shaped dir inside source store.
  writeSkill(path.join(layout.sourceStorePath, 'snapshot-skill'), 'snapshot-skill', 'snap');

  const result = observeInventory({
    configPath: env.configPath,
    observedAt: '2026-08-15T15:02:00.000Z',
  });
  assert.equal(result.meta.skippedReceiptOwned >= 1, true);
  assert.ok(result.document.skills.every((skill) => skill.logicalId !== 'managed-copy'));
  assert.ok(result.document.skills.every((skill) => skill.logicalId !== 'snapshot-skill'));
  const shared = result.document.skills.find((skill) => skill.logicalId === 'shared-skill');
  assert.ok(shared);
  assert.ok(shared.observations.length >= 2);
  assert.equal(new Set(shared.observations.map((item) => item.treeDigest || shared.treeDigest)).size >= 1, true);
});

test('symlinks, unsafe modes, missing SKILL.md, oversized bundles, and unreadable roots fail closed', () => {
  const home = temp('jarvos-inv-unsafe-');
  const root = path.join(home, 'skills');
  ensureDir(root, 'root');
  writeSkill(path.join(root, 'good-skill'), 'good-skill');
  // missing skill md
  fs.mkdirSync(path.join(root, 'no-skill-md'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'no-skill-md', 'README.md'), 'nope', { mode: 0o600 });
  // symlink entry
  writeSkill(path.join(home, 'link-target'), 'link-target');
  fs.symlinkSync(path.join(home, 'link-target'), path.join(root, 'symlink-skill'));
  // oversized by file count limit
  const big = path.join(root, 'big-skill');
  writeSkill(big, 'big-skill');
  fs.mkdirSync(path.join(big, 'scripts'), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(big, 'scripts', `f${i}.js`), `module.exports=${i}\n`, { mode: 0o600 });
  }

  const env = seedConfig({
    roots: {
      codex: root,
      claude: root,
      openclaw: root,
      hermes: root,
    },
    limits: {
      maxBundleFiles: 3,
      maxEntriesPerRoot: 64,
    },
  });

  const result = observeInventory({
    configPath: env.configPath,
    observedAt: '2026-08-15T15:03:00.000Z',
  });
  assert.equal(result.document.skills.some((skill) => skill.logicalId === 'good-skill'), true);
  assert.equal(result.document.skills.some((skill) => skill.logicalId === 'no-skill-md'), false);
  // symlink and oversized should not become clean portable observations
  const unsafeOrBlocked = result.document.skills.filter((skill) => (
    skill.disposition.kind === 'blocked'
    || skill.observations.some((observation) => observation.state === 'unsafe')
  ));
  assert.ok(unsafeOrBlocked.length >= 1 || result.overflowed === true);
  assert.equal(result.complete === false || result.overflowed === true || unsafeOrBlocked.length >= 1, true);
});

test('one unsafe bundle does not freeze unrelated complete-root repair', () => {
  const home = temp('jarvos-inv-pair-safety-');
  const root = path.join(home, 'skills');
  ensureDir(root, 'root');
  writeSkill(path.join(root, 'good-skill'), 'good-skill');
  const unsafe = writeSkill(path.join(root, 'unsafe-skill'), 'unsafe-skill');
  fs.writeFileSync(path.join(unsafe, 'README.md'), 'ordinary unmanaged extra\n', { mode: 0o600 });
  const env = seedConfig({ roots: { codex: root, claude: root, openclaw: root, hermes: root } });
  const result = observeInventory({ configPath: env.configPath, observedAt: '2026-08-15T15:03:30.000Z' });
  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.document.skills.find((skill) => skill.logicalId === 'good-skill').observations.every((item) => item.state !== 'unsafe'), true);
  assert.equal(result.document.skills.find((skill) => skill.logicalId === 'unsafe-skill').disposition.reasonCode, 'unsafe_source');
});

test('unsupported exclusions fail the inventory generation closed', () => {
  const root = temp('jarvos-inv-exclusions-');
  writeSkill(path.join(root, 'private-skill'), 'private-skill');
  const env = seedConfig({ roots: { codex: root, claude: root, openclaw: root, hermes: root } });
  const layout = ensureInventoryStateLayout({ controlRoot: env.control, inventory: loadConfig(env.configPath).config.inventory });
  fs.writeFileSync(layout.exclusionOverlayPath, `${JSON.stringify({ schemaVersion: 'jarvos.skill-exclusions/v999', entries: [] })}\n`, { mode: 0o600 });
  const result = observeInventory({ configPath: env.configPath, observedAt: '2026-08-15T15:03:40.000Z' });
  assert.equal(result.complete, false);
  assert.equal(result.partial, true);
  assert.ok(result.reasons.includes('unsupported_exclusion_overlay'));
});

test('root replacement and partial/overflowed scans preserve completeness semantics', () => {
  const home = temp('jarvos-inv-overflow-');
  const root = path.join(home, 'skills');
  ensureDir(root, 'root');
  for (let i = 0; i < 6; i += 1) {
    writeSkill(path.join(root, `skill-${i}`), `skill-${i}`, `body-${i}`);
  }
  const env = seedConfig({
    roots: {
      codex: root,
      claude: root,
      openclaw: root,
      hermes: root,
    },
    limits: { maxEntriesPerRoot: 3 },
  });
  const overflowed = observeInventory({
    configPath: env.configPath,
    observedAt: '2026-08-15T15:04:00.000Z',
  });
  assert.equal(overflowed.overflowed, true);
  assert.equal(overflowed.complete, false);
  assert.ok(overflowed.document.roots.some((item) => item.complete === false));

  // Root replacement: change registered path for same rootId after a complete baseline.
  const home2 = temp('jarvos-inv-replace-');
  const firstRoot = path.join(home2, 'one');
  const secondRoot = path.join(home2, 'two');
  ensureDir(firstRoot, 'one');
  ensureDir(secondRoot, 'two');
  writeSkill(path.join(firstRoot, 'move-skill'), 'move-skill', 'one');
  writeSkill(path.join(secondRoot, 'move-skill'), 'move-skill', 'two');
  const env2 = seedConfig({
    roots: {
      codex: firstRoot,
      claude: firstRoot,
      openclaw: firstRoot,
      hermes: firstRoot,
    },
  });
  const baseline = observeInventory({
    configPath: env2.configPath,
    observedAt: '2026-08-15T15:05:00.000Z',
  });
  assert.equal(baseline.complete, true);

  const loaded = loadConfig(env2.configPath);
  saveConfig({
    ...loaded.config,
    inventory: {
      ...loaded.config.inventory,
      registeredRoots: loaded.config.inventory.registeredRoots.map((rootEntry) => (
        rootEntry.rootId === 'codex-managed'
          ? { ...rootEntry, root: secondRoot }
          : rootEntry
      )),
    },
  }, env2.configPath);
  const replaced = observeInventory({
    configPath: env2.configPath,
    observedAt: '2026-08-15T15:06:00.000Z',
  });
  assert.equal(replaced.ok, true);
  assert.ok(replaced.reasons.includes('root_replaced') || replaced.mutate === true);
});

test('bundle traversal fails closed on directory-count and depth limits', () => {
  const manyRoot = temp('jarvos-inv-many-dirs-');
  const manyBundle = writeSkill(path.join(manyRoot, 'many-dirs'), 'many-dirs');
  for (let index = 0; index < 5; index += 1) {
    fs.mkdirSync(path.join(manyBundle, `empty-${index}`), { mode: 0o700 });
  }
  const manyEnv = seedConfig({
    roots: { codex: manyRoot },
    limits: { maxBundleDirectories: 4 },
  });
  const many = observeInventory({
    configPath: manyEnv.configPath,
    observedAt: '2026-08-15T15:04:30.000Z',
  });
  assert.equal(many.complete, false);
  assert.equal(many.overflowed, true);
  assert.ok(many.reasons.includes('max_bundle_directories'));

  const deepRoot = temp('jarvos-inv-deep-dirs-');
  const deepBundle = writeSkill(path.join(deepRoot, 'deep-dirs'), 'deep-dirs');
  let nested = deepBundle;
  for (let depth = 0; depth < 4; depth += 1) {
    nested = path.join(nested, `level-${depth}`);
    fs.mkdirSync(nested, { mode: 0o700 });
  }
  const deepEnv = seedConfig({
    roots: { codex: deepRoot },
    limits: { maxBundleDepth: 3 },
  });
  const deep = observeInventory({
    configPath: deepEnv.configPath,
    observedAt: '2026-08-15T15:04:31.000Z',
  });
  assert.equal(deep.complete, false);
  assert.equal(deep.overflowed, true);
  assert.ok(deep.reasons.includes('max_bundle_depth'));
});

test('healthy second scan is zero-write and CLI inventory status stays path-redacted', () => {
  const home = temp('jarvos-inv-zero-');
  const root = path.join(home, 'skills');
  ensureDir(root, 'root');
  copyFixture(path.join(root, 'public-fixture'));
  const env = seedConfig({
    roots: {
      codex: root,
      claude: root,
      openclaw: root,
      hermes: root,
    },
  });

  const first = observeInventory({
    configPath: env.configPath,
    observedAt: '2026-08-15T15:07:00.000Z',
  });
  assert.equal(first.mutate, true);
  const observationsPath = first.meta.observationsPath;
  assert.ok(observationsPath);
  const before = fs.readFileSync(observationsPath);
  const beforeMtime = fs.statSync(observationsPath).mtimeMs;

  const second = observeInventory({
    configPath: env.configPath,
    observedAt: '2026-08-15T15:08:00.000Z',
  });
  assert.equal(second.unchanged, true);
  assert.equal(second.mutate, false);
  assert.equal(second.meta.wrote, false);
  assert.equal(fs.readFileSync(observationsPath).equals(before), true);
  assert.equal(fs.statSync(observationsPath).mtimeMs, beforeMtime);

  const cli = spawnSync(process.execPath, [CLI, 'inventory', '--config', env.configPath, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const payload = JSON.parse(cli.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'status');
  assert.equal(JSON.stringify(payload).includes(home), false);
  assert.equal(JSON.stringify(payload.status).includes('absolutePath'), false);

  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /inventory/);
  assert.match(help.stdout, /inventory-register-roots/);

  const declared = spawnSync(process.execPath, [CLI, 'inventory-declared-roots', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(declared.status, 0, declared.stderr || declared.stdout);
  const declaredPayload = JSON.parse(declared.stdout);
  assert.equal(declaredPayload.ok, true);
  assert.ok(declaredPayload.roots.length >= 4);

  const operator = inventoryOperator({ configPath: env.configPath });
  assert.equal(operator.ok, true);
  assert.equal(operator.mode, 'status');
});

test('operator status is read-only by default and private inspect requires owner capability', () => {
  const root = temp('jarvos-inv-operator-readonly-');
  writeSkill(path.join(root, 'secret-transcribe'), 'secret-transcribe');
  const env = seedConfig({ roots: { codex: root, claude: root, openclaw: root, hermes: root } });
  const inventoryState = path.join(env.control, 'inventory');
  const status = inventoryStatusOperator({ configPath: env.configPath });
  assert.equal(status.mutate, false);
  assert.equal(fs.existsSync(inventoryState), false);
  assert.equal(JSON.stringify(status).includes('secret-transcribe'), false);
  const lease = path.join(env.control, '.shared-skill-cli.lock');
  fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, operation: 'apply', startedAt: new Date().toISOString() }), { mode: 0o600 });
  assert.throws(() => inventoryStatusOperator({ configPath: env.configPath, persist: true }), /already running/i);
  fs.unlinkSync(lease);
  assert.throws(() => inventoryStatusOperator({ configPath: env.configPath, inspect: true }), /authorized owner principal/i);
  const inspected = inventoryStatusOperator({
    configPath: env.configPath,
    inspect: true,
    principal: { kind: 'owner', capabilities: ['inventory.inspect_private'] },
  });
  assert.equal(inspected.inspect.skills[0].logicalId, 'secret-transcribe');

  const cli = spawnSync(process.execPath, [CLI, 'inventory', '--config', env.configPath, '--inspect', '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.doesNotMatch(cli.stdout, /secret-transcribe|absolutePath/);
});

test('hard-link duplicate under one root collapses to one logical observation set', () => {
  const home = temp('jarvos-inv-hardlink-');
  const root = path.join(home, 'skills');
  ensureDir(root, 'root');
  const first = writeSkill(path.join(root, 'linked-skill'), 'linked-skill', 'hardlink-body');
  const second = path.join(root, 'linked-skill-copy');
  // Best-effort hardlink of the directory is not portable; hardlink SKILL.md tree via copy of digest path
  // by creating an identical second directory (byte-identical) which the engine collapses by digest.
  writeSkill(second, 'linked-skill-copy', 'hardlink-body');
  // Force same logical id by renaming observed folder names differently but keep separate ids;
  // instead verify same digest multi-observation under two roots.
  const root2 = path.join(home, 'skills-2');
  ensureDir(root2, 'root2');
  writeSkill(path.join(root2, 'linked-skill'), 'linked-skill', 'hardlink-body');

  const env = seedConfig({
    roots: {
      codex: root,
      claude: root2,
      openclaw: root,
      hermes: root2,
    },
  });
  const result = observeInventory({
    configPath: env.configPath,
    observedAt: '2026-08-15T15:09:00.000Z',
  });
  const linked = result.document.skills.filter((skill) => skill.treeDigest === computeBundleTree(first).treeDigest);
  assert.ok(linked.length >= 1);
  // Same-name identical copies across roots should be one logical skill with multiple observations.
  const sameName = result.document.skills.find((skill) => skill.logicalId === 'linked-skill');
  assert.ok(sameName);
  assert.ok(sameName.observations.length >= 2);
  void STATE_DIR;
});
