'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CATALOG_SCHEMA_VERSION,
  OVERLAY_SCHEMA_VERSION,
  PUBLIC_SOURCE_KIND,
  LOCAL_OVERLAY_SOURCE_KIND,
  computeBundleTree,
  validatePublicCatalog,
  validateLocalOverlay,
  composeEffectiveCatalog,
  attestCatalogBundle,
  redactEffectiveCatalog,
  assertPublicOnlyCatalog,
  catalogDigest,
} = require('../src/catalog');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'catalog');
const PUBLIC_FIXTURE = path.join(FIXTURE_ROOT, 'public-fixture');
const PRIVATE_FIXTURE = path.join(FIXTURE_ROOT, 'private-fixture');

function tempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function publicCatalogFromFixture(tree) {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    entries: [{
      id: 'public-fixture',
      allowedHarnesses: ['codex', 'claude', 'openclaw', 'hermes'],
      bundle: {
        root: 'public-fixture',
        allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
        treeDigest: tree.treeDigest,
      },
    }],
  };
}

function overlayFromFixture(tree, {
  id = 'private-fixture',
  root = 'private-fixture',
  harnesses = ['codex', 'claude', 'openclaw', 'hermes'],
} = {}) {
  return {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    entries: [{
      id,
      allowedHarnesses: harnesses,
      verification: Object.fromEntries(harnesses.map((harness) => [harness, {
        tier: 'adapter-declared',
        remoteModelProbe: false,
      }])),
      bundle: {
        root,
        allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
        treeDigest: tree.treeDigest,
      },
    }],
  };
}

test('valid public catalog and local overlay produce a deterministic effective catalog digest', () => {
  const publicTree = computeBundleTree(PUBLIC_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const privateTree = computeBundleTree(PRIVATE_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });

  const first = composeEffectiveCatalog({
    publicCatalog: publicCatalogFromFixture(publicTree),
    localOverlay: overlayFromFixture(privateTree),
  });
  const second = composeEffectiveCatalog({
    publicCatalog: JSON.parse(JSON.stringify(publicCatalogFromFixture(publicTree))),
    localOverlay: JSON.parse(JSON.stringify(overlayFromFixture(privateTree))),
  });

  assert.equal(first.status, 'valid');
  assert.equal(first.digest, second.digest);
  assert.equal(first.pairs.length, 8);
  assert.deepEqual(first.catalog.entries.map((entry) => entry.id), ['private-fixture', 'public-fixture']);
  assert.equal(first.catalog.entries.find((entry) => entry.id === 'public-fixture').sourceKind, PUBLIC_SOURCE_KIND);
  assert.equal(first.catalog.entries.find((entry) => entry.id === 'private-fixture').sourceKind, LOCAL_OVERLAY_SOURCE_KIND);
});

test('ambient workspace skills are excluded unless explicitly configured', () => {
  const publicTree = computeBundleTree(PUBLIC_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const root = tempRoot('jarvos-catalog-ambient-');
  try {
    const ambient = path.join(root, 'ambient-skill');
    fs.mkdirSync(ambient, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ambient, 'SKILL.md'), '---\nname: ambient-skill\n---\n', { mode: 0o600 });
    const effective = composeEffectiveCatalog({
      publicCatalog: publicCatalogFromFixture(publicTree),
      localOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
    });
    assert.equal(effective.status, 'valid');
    assert.equal(effective.catalog.entries.some((entry) => entry.id === 'ambient-skill'), false);
    assert.equal(fs.existsSync(path.join(ambient, 'SKILL.md')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate ids, public-id overrides, path traversal, symlinks, unsafe ownership, and digest drift fail closed', () => {
  const publicTree = computeBundleTree(PUBLIC_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const privateTree = computeBundleTree(PRIVATE_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const basePublic = publicCatalogFromFixture(publicTree);

  assert.throws(() => validatePublicCatalog({
    ...basePublic,
    entries: [basePublic.entries[0], basePublic.entries[0]],
  }), /duplicated/);

  assert.throws(() => composeEffectiveCatalog({
    publicCatalog: basePublic,
    localOverlay: overlayFromFixture(privateTree, { id: 'public-fixture' }),
  }), /cannot override public canonical id/);

  assert.throws(() => validatePublicCatalog({
    ...basePublic,
    entries: [{
      ...basePublic.entries[0],
      bundle: { ...basePublic.entries[0].bundle, root: '../escape' },
    }],
  }), /contained relative path/);

  assert.throws(() => validatePublicCatalog({
    ...basePublic,
    entries: [{
      ...basePublic.entries[0],
      bundle: { ...basePublic.entries[0].bundle, treeDigest: 'not-a-digest' },
    }],
  }), /SHA-256/);

  const linkRoot = tempRoot('jarvos-catalog-link-');
  try {
    const linked = path.join(linkRoot, 'linked-skill');
    fs.mkdirSync(linked, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(linked, 'SKILL.md'), '---\nname: linked\n---\n', { mode: 0o600 });
    fs.symlinkSync(os.tmpdir(), path.join(linked, 'scripts'));
    assert.throws(() => computeBundleTree(linked), /symbolic link/);
  } finally {
    fs.rmSync(linkRoot, { recursive: true, force: true });
  }

  const driftRoot = tempRoot('jarvos-catalog-drift-');
  try {
    const bundle = path.join(driftRoot, 'public-fixture');
    fs.cpSync(PUBLIC_FIXTURE, bundle, { recursive: true });
    fs.chmodSync(bundle, 0o700);
    for (const file of ['SKILL.md', 'scripts/hello.js', 'assets/note.txt']) {
      fs.chmodSync(path.join(bundle, file), 0o600);
    }
    fs.chmodSync(path.join(bundle, 'scripts'), 0o700);
    fs.chmodSync(path.join(bundle, 'assets'), 0o700);
    const entry = validatePublicCatalog(publicCatalogFromFixture(publicTree)).catalog.entries[0];
    fs.writeFileSync(path.join(bundle, 'assets', 'note.txt'), 'changed\n', { mode: 0o600 });
    assert.throws(() => attestCatalogBundle(entry, { sourceRoot: driftRoot }), /digest drift/);
  } finally {
    fs.rmSync(driftRoot, { recursive: true, force: true });
  }

  const writableRoot = tempRoot('jarvos-catalog-writable-');
  try {
    fs.chmodSync(writableRoot, 0o777);
    assert.throws(() => computeBundleTree(writableRoot), /group- or world-writable/);
  } finally {
    fs.chmodSync(writableRoot, 0o700);
    fs.rmSync(writableRoot, { recursive: true, force: true });
  }
});

test('unknown schema versions return a non-mutating unsupported result', () => {
  const publicTree = computeBundleTree(PUBLIC_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const unsupportedPublic = validatePublicCatalog({
    ...publicCatalogFromFixture(publicTree),
    schemaVersion: 'future.v9',
  });
  assert.equal(unsupportedPublic.status, 'unsupported');
  assert.equal(unsupportedPublic.mutate, false);

  const unsupportedOverlay = validateLocalOverlay({
    schemaVersion: 'future.v9',
    entries: [],
  });
  assert.equal(unsupportedOverlay.status, 'unsupported');
  assert.equal(unsupportedOverlay.mutate, false);

  const composed = composeEffectiveCatalog({
    publicCatalog: {
      ...publicCatalogFromFixture(publicTree),
      schemaVersion: 'future.v9',
    },
  });
  assert.equal(composed.status, 'unsupported');
  assert.equal(composed.mutate, false);
});

test('serialized public artifacts and redacted local results contain no private body or absolute path', () => {
  const publicTree = computeBundleTree(PUBLIC_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const privateTree = computeBundleTree(PRIVATE_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const effective = composeEffectiveCatalog({
    publicCatalog: publicCatalogFromFixture(publicTree),
    localOverlay: overlayFromFixture(privateTree),
  });
  const redacted = redactEffectiveCatalog(effective);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(PRIVATE_FIXTURE), false);
  assert.equal(serialized.includes('/Users/andrew'), false);
  assert.equal(serialized.includes('Local overlay only'), false);
  assert.equal(serialized.includes('private-fixture/SKILL.md'), false);
  assert.equal(assertPublicOnlyCatalog(publicCatalogFromFixture(publicTree)).entries[0].id, 'public-fixture');
  assert.equal(catalogDigest(effective.catalog), effective.digest);
});

test('bundle tree digest covers referenced scripts and assets and changes when a dependency changes', () => {
  const root = tempRoot('jarvos-catalog-tree-');
  try {
    const bundle = path.join(root, 'public-fixture');
    fs.cpSync(PUBLIC_FIXTURE, bundle, { recursive: true });
    fs.chmodSync(bundle, 0o700);
    for (const file of ['SKILL.md', 'scripts/hello.js', 'assets/note.txt']) {
      fs.chmodSync(path.join(bundle, file), 0o600);
    }
    fs.chmodSync(path.join(bundle, 'scripts'), 0o700);
    fs.chmodSync(path.join(bundle, 'assets'), 0o700);

    const first = computeBundleTree(bundle, {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    assert.equal(first.entries.some((entry) => entry.path === 'scripts/hello.js'), true);
    assert.equal(first.entries.some((entry) => entry.path === 'assets/note.txt'), true);

    fs.writeFileSync(path.join(bundle, 'scripts', 'hello.js'), "'use strict';\nconsole.log('changed');\n", { mode: 0o600 });
    const second = computeBundleTree(bundle, {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    assert.notEqual(first.treeDigest, second.treeDigest);

    fs.writeFileSync(path.join(bundle, 'unexpected.txt'), 'nope\n', { mode: 0o600 });
    assert.throws(() => computeBundleTree(bundle, {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    }), /unexpected path outside allowlist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
