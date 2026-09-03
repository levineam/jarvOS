'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const gbrain = require('../src/index.js');
const JARVOS_PATHS_MODULE = path.resolve(
  __dirname,
  '..',
  '..',
  'jarvos-secondbrain',
  'bridge',
  'config',
  'jarvos-paths.js',
);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-gbrain-'));
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    if (fs.existsSync(JARVOS_PATHS_MODULE)) {
      require(JARVOS_PATHS_MODULE).resetConfigCache();
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (fs.existsSync(JARVOS_PATHS_MODULE)) {
      require(JARVOS_PATHS_MODULE).resetConfigCache();
    }
  }
}

test('slugify produces stable filesystem-safe slugs', () => {
  assert.equal(gbrain.slugify('Andrew & JarVOS: Brain Notes'), 'andrew-and-jarvos-brain-notes');
  assert.equal(gbrain.slugify(''), 'untitled');
});

test('resolveConfig uses shared jarvOS vault paths when available', () => {
  const root = tempDir();
  const clawd = path.join(root, 'clawd');
  const vault = path.join(root, 'Vaults', 'Vault v3');
  const notes = path.join(vault, 'Notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(clawd, { recursive: true });
  fs.writeFileSync(
    path.join(clawd, 'jarvos.config.json'),
    JSON.stringify({ paths: { vault, notes } }),
    'utf8',
  );

  withEnv({
    JARVOS_CLAWD_DIR: clawd,
    CLAWD_DIR: undefined,
    JARVOS_VAULT_DIR: undefined,
    JARVOS_NOTES_DIR: undefined,
    VAULT_NOTES_DIR: undefined,
  }, () => {
    const result = gbrain.resolveConfig({ brainDir: path.join(root, 'brain') });
    assert.equal(result.vaultDir, vault);
    assert.equal(result.notesDir, notes);
  });
});

test('resolveConfig can load shared paths from an installed secondbrain package', () => {
  const root = tempDir();
  const gbrainRoot = path.join(root, 'node_modules', '@jarvos', 'gbrain');
  const packageRoot = path.join(root, 'node_modules', '@jarvos', 'secondbrain');
  const packageDir = path.join(packageRoot, 'bridge', 'config');
  const installedModule = path.join(packageDir, 'jarvos-paths.js');
  const vault = path.join(root, 'installed-vault');
  const notes = path.join(vault, 'Installed Notes');

  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@jarvos/secondbrain' }), 'utf8');
  fs.writeFileSync(
    installedModule,
    `exports.getVaultDir = () => ${JSON.stringify(vault)};
exports.getNotesDir = () => ${JSON.stringify(notes)};
`,
    'utf8',
  );
  fs.mkdirSync(path.join(gbrainRoot, 'src'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'src', 'index.js'),
    path.join(gbrainRoot, 'src', 'index.js'),
  );
  const env = { ...process.env };
  for (const key of ['JARVOS_CLAWD_DIR', 'CLAWD_DIR', 'JARVOS_VAULT_DIR', 'JARVOS_NOTES_DIR', 'VAULT_NOTES_DIR']) {
    delete env[key];
  }
  const child = spawnSync(process.execPath, [
    '-e',
    `const gbrain = require(${JSON.stringify(path.join(gbrainRoot, 'src', 'index.js'))});
const result = gbrain.resolveConfig({ brainDir: ${JSON.stringify(path.join(root, 'brain'))} });
process.stdout.write(JSON.stringify({ vaultDir: result.vaultDir, notesDir: result.notesDir }));
`,
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.vaultDir, vault);
  assert.equal(result.notesDir, notes);
});

test('resolveConfig does not load shared paths from the working directory', () => {
  const root = tempDir();
  const packageDir = path.join(root, 'node_modules', '@jarvos', 'secondbrain', 'bridge', 'config');
  const marker = path.join(root, 'loaded');
  const vault = path.join(root, 'safe-vault');
  const notes = path.join(root, 'safe-notes');

  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'jarvos-paths.js'),
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\n`,
    'utf8',
  );
  const child = spawnSync(process.execPath, [
    '-e',
    `const gbrain = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'index.js'))});
const result = gbrain.resolveConfig({ vaultDir: ${JSON.stringify(vault)}, notesDir: ${JSON.stringify(notes)} });
process.stdout.write(JSON.stringify({ vaultDir: result.vaultDir, notesDir: result.notesDir }));
`,
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { vaultDir: vault, notesDir: notes });
  assert.equal(fs.existsSync(marker), false);
});

test('resolveConfig derives notes from an explicit vault override', () => {
  const root = tempDir();
  const vault = path.join(root, 'vault');
  const result = gbrain.resolveConfig({ vaultDir: vault });

  assert.equal(result.vaultDir, vault);
  assert.equal(result.notesDir, path.join(vault, 'Notes'));
});

test('createImportPlan maps curated manifest items to GBrain targets', () => {
  const root = tempDir();
  const vault = path.join(root, 'vault');
  const brain = path.join(root, 'brain');
  const note = path.join(vault, 'Notes', 'JarVOS Brain.md');
  const manifestPath = path.join(root, 'manifest.json');

  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, '# JarVOS Brain\n\nImportant context.', 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    items: [
      {
        type: 'project',
        title: 'JarVOS Brain',
        sourcePath: 'Notes/JarVOS Brain.md',
        tags: ['jarvos'],
      },
      {
        type: 'unknown',
        title: 'Skip me',
        sourcePath: 'Notes/JarVOS Brain.md',
      },
    ],
  }), 'utf8');

  const plan = gbrain.createImportPlan({ vaultDir: vault, brainDir: brain, manifestPath });
  assert.equal(plan.itemCount, 1);
  assert.equal(plan.items[0].type, 'project');
  assert.equal(plan.items[0].targetPath, path.join(brain, 'projects', 'jarvos-brain.md'));
  assert.equal(plan.warnings.length, 1);
});

test('importToBrain dry-run does not write generated pages', () => {
  const root = tempDir();
  const vault = path.join(root, 'vault');
  const brain = path.join(root, 'brain');
  const note = path.join(vault, 'Notes', 'Person.md');
  const manifestPath = path.join(root, 'manifest.json');

  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, '# Person\n\nUseful context.', 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    items: [{ type: 'person', title: 'Person', sourcePath: 'Notes/Person.md' }],
  }), 'utf8');

  const plan = gbrain.createImportPlan({ vaultDir: vault, brainDir: brain, manifestPath });
  const result = gbrain.importToBrain(plan, { dryRun: true });

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].dryRun, true);
  assert.equal(fs.existsSync(result.imported[0].targetPath), false);
});

test('importToBrain writes generated pages with source provenance', () => {
  const root = tempDir();
  const vault = path.join(root, 'vault');
  const brain = path.join(root, 'brain');
  const note = path.join(vault, 'Notes', 'Concept.md');
  const manifestPath = path.join(root, 'manifest.json');

  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, '# Concept\n\nA durable concept.', 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    items: [{ type: 'concept', title: 'Concept', sourcePath: 'Notes/Concept.md' }],
  }), 'utf8');

  const plan = gbrain.createImportPlan({ vaultDir: vault, brainDir: brain, manifestPath });
  const result = gbrain.importToBrain(plan);
  const target = result.imported[0].targetPath;
  const body = fs.readFileSync(target, 'utf8');

  assert.equal(fs.existsSync(target), true);
  assert.match(body, /provenance:\n  kind: "obsidian"/);
  assert.match(body, /importedBy: "jarvos-gbrain"/);
  assert.match(body, /Source path: `Notes\/Concept.md`/);
  assert.match(body, /A durable concept/);
});

test('renderBrainPage escapes YAML scalar control characters', () => {
  const root = tempDir();
  const vault = path.join(root, 'vault');
  const sourcePath = path.join(vault, 'Notes', 'Escapes.md');
  const config = gbrain.resolveConfig({ vaultDir: vault, brainDir: path.join(root, 'brain') });
  const body = gbrain.renderBrainPage({
    type: 'source',
    title: 'Line "One"\nTab\tBack\\slash',
    sourcePath,
    tags: ['tag\nline'],
  }, 'body', config);

  assert.match(body, /title: "Line \\"One\\"\\nTab\\tBack\\\\slash"/);
  assert.match(body, /  - "tag\\nline"/);
});

test('renderBrainPage includes graph-friendly frontmatter and wikilinks', () => {
  const root = tempDir();
  const vault = path.join(root, 'vault');
  const sourcePath = path.join(vault, 'Notes', 'Person.md');
  const config = gbrain.resolveConfig({ vaultDir: vault, brainDir: path.join(root, 'brain') });
  const body = gbrain.renderBrainPage({
    type: 'person',
    title: 'Ada Example',
    sourcePath,
    aliases: ['A. Example'],
    company: 'companies/example-inc',
    founded: 2020,
    related: ['concepts/jarvos-memory'],
    source: 'sources/person-note',
    sources: ['sources/person-interview'],
  }, 'body', config);

  assert.match(body, /aliases:\n  - "A\. Example"/);
  assert.match(body, /company: "companies\/example-inc"/);
  assert.match(body, /founded:\n  - "2020"/);
  assert.match(body, /related:\n  - "concepts\/jarvos-memory"/);
  assert.match(body, /^source: "sources\/person-note"$/m);
  assert.match(body, /sources:\n  - "sources\/person-interview"/);
  assert.match(body, /## Graph Links/);
  assert.match(body, /company: \[\[companies\/example-inc\]\]/);
  assert.match(body, /founded: \[\[2020\]\]/);
  assert.match(body, /related: \[\[concepts\/jarvos-memory\]\]/);
  assert.match(body, /source: \[\[sources\/person-note\]\]/);
  assert.match(body, /sources: \[\[sources\/person-interview\]\]/);
});

test('renderBrainPage accepts graph fields grouped under graph or relationships', () => {
  const root = tempDir();
  const vault = path.join(root, 'vault');
  const sourcePath = path.join(vault, 'Notes', 'Meeting.md');
  const config = gbrain.resolveConfig({ vaultDir: vault, brainDir: path.join(root, 'brain') });
  const body = gbrain.renderBrainPage({
    type: 'meeting',
    title: 'Planning Meeting',
    sourcePath,
    graph: { attendees: ['people/andrew'] },
    relationships: { see_also: ['projects/jarvos'] },
  }, 'body', config);

  assert.match(body, /attendees:\n  - "people\/andrew"/);
  assert.match(body, /see_also:\n  - "projects\/jarvos"/);
  assert.match(body, /attendees: \[\[people\/andrew\]\]/);
  assert.match(body, /see also: \[\[projects\/jarvos\]\]/);
});

test('importToBrain records write failures without false imported entries', () => {
  const root = tempDir();
  const vault = path.join(root, 'vault');
  const blocker = path.join(root, 'not-a-directory');
  const note = path.join(vault, 'Notes', 'Write Failure.md');
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, '# Write Failure', 'utf8');
  fs.writeFileSync(blocker, 'file blocks directory creation', 'utf8');

  const plan = {
    config: gbrain.resolveConfig({ vaultDir: vault, brainDir: path.join(root, 'brain') }),
    warnings: [],
    items: [{
      type: 'source',
      title: 'Write Failure',
      sourcePath: note,
      targetPath: path.join(blocker, 'out.md'),
      item: { type: 'source', title: 'Write Failure', sourcePath: note },
    }],
  };
  const result = gbrain.importToBrain(plan);

  assert.equal(result.imported.length, 0);
  assert.match(result.warnings[0], /Could not write/);
});

test('CLI reports JSON parse errors without a stack trace', () => {
  const root = tempDir();
  const manifestPath = path.join(root, 'bad.json');
  fs.writeFileSync(manifestPath, '{bad json', 'utf8');

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'jarvos-gbrain.js'),
    'plan',
    '--manifest',
    manifestPath,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error: Could not read JSON file/);
  assert.doesNotMatch(result.stderr, /\n\s+at\s/);
});

test('syncBrain dry-run returns planned gbrain commands', () => {
  const result = gbrain.syncBrain({ brainDir: '/tmp/brain', gbrainDir: '/tmp/gbrain' }, { dryRun: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sync.args, ['sync', '--repo', '/tmp/brain']);
  assert.deepEqual(result.embed.args, ['embed', '--stale']);
});

test('runRetrievalEval fails when expected evidence is missing from search output', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const binPath = path.join(root, 'fake-gbrain');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{ query: 'where is the project context?', expected: 'projects/jarvos-brain' }],
  }), 'utf8');
  fs.writeFileSync(binPath, '#!/bin/sh\nprintf "%s\\n" "[0.99] concepts/other -- unrelated result"\n', 'utf8');
  fs.chmodSync(binPath, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin: binPath,
    gbrainDir: root,
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].expectedMatched, false);
  assert.deepEqual(result.results[0].missingExpected, ['projects/jarvos-brain']);
});

test('runRetrievalEval passes when expected evidence appears in search output', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const binPath = path.join(root, 'fake-gbrain');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query: 'where is the project context?',
      expected: { slug: 'projects/jarvos-brain', any: ['Important context', 'fallback context'] },
    }],
  }), 'utf8');
  fs.writeFileSync(binPath, '#!/bin/sh\nprintf "%s\\n" "[0.99] projects/jarvos-brain -- Important context"\n', 'utf8');
  fs.chmodSync(binPath, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin: binPath,
    gbrainDir: root,
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].expectedMatched, true);
  assert.deepEqual(result.results[0].missingExpected, []);
});

test('runRetrievalEval can compare QMD with engine-specific expected evidence', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  const query = 'where is OpenClaw gateway recovery documented?';
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query,
      qmdQuery: 'OpenClaw gateway auth recovery',
      expected: {
        gbrain: {
          slug: 'sources/openclaw-gateway-auth-recovery-playbook',
          any: ['gateway', 'auth'],
        },
        qmd: {
          all: ['qmd://notes/openclaw-gateway-auth-recovery-playbook.md'],
          any: ['OpenClaw Gateway', 'auth'],
        },
      },
    }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nprintf "%s\\n" "[0.99] sources/openclaw-gateway-auth-recovery-playbook -- gateway auth"\n', 'utf8');
  fs.writeFileSync(qmdBin, '#!/bin/sh\nprintf "%s\\n" "[{\\"file\\":\\"qmd://notes/openclaw-gateway-auth-recovery-playbook.md\\",\\"title\\":\\"OpenClaw Gateway + Auth Recovery Playbook\\",\\"snippet\\":\\"auth recovery\\"}]"\n', 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin,
    gbrainDir: root,
    qmdBin,
    qmdIndex: 'notes-index',
    qmdCollection: 'notes',
  }, { compareQmd: true, limit: 3 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.engines.gbrain, { passed: 1, failed: 0 });
  assert.deepEqual(result.summary.engines.qmd, { passed: 1, failed: 0 });
  assert.equal(result.compareQmd, true);
  assert.equal(result.results[0].engines.gbrain.ok, true);
  assert.equal(result.results[0].engines.qmd.ok, true);
  assert.deepEqual(result.results[0].engines.qmd.command.args, [
    'search',
    '--index',
    'notes-index',
    'OpenClaw gateway auth recovery',
    '-n',
    '3',
    '--json',
    '--collection',
    'notes',
  ]);
});

test('runRetrievalEval marks timed-out comparison commands as failed', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'slow-qmd');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query: 'slow comparison',
      expected: {
        gbrain: 'projects/ok',
        qmd: 'qmd://notes/ok.md',
      },
    }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nprintf "%s\\n" "projects/ok"\n', 'utf8');
  fs.writeFileSync(qmdBin, '#!/bin/sh\nsleep 2\nprintf "%s\\n" "qmd://notes/ok.md"\n', 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin,
    gbrainDir: root,
    qmdBin,
    retrievalTimeoutMs: 100,
  }, { compareQmd: true });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].engines.qmd.ok, false);
  assert.equal(result.results[0].engines.qmd.command.timedOut, true);
});

test('runRetrievalEval can compare graph sidecar evidence separately from search', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query: 'what connects memory and continuity?',
      graphSeeds: ['projects/jarvos-context-engineering-upgrade'],
      graphDepth: 2,
      expected: {
        gbrain: 'projects/missing-from-search',
        graph: {
          all: ['concepts/openclaw-context-management-lessons'],
          any: ['continuity', 'memory'],
        },
      },
    }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'graph-query') {
  process.stdout.write(JSON.stringify([
    { slug: 'projects/jarvos-context-engineering-upgrade', title: 'Context Engineering', depth: 0, links: [{ to_slug: 'concepts/openclaw-context-management-lessons', link_type: 'mentions' }] },
    { slug: 'concepts/openclaw-context-management-lessons', title: 'Memory Continuity Lessons', depth: 1, links: [] }
  ]));
} else {
  process.stdout.write('[0.1] sources/other -- unrelated search result');
}
`, 'utf8');
  fs.chmodSync(gbrainBin, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin,
    gbrainDir: root,
  }, { compareGraph: true });

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.engines.gbrain, { passed: 0, failed: 1 });
  assert.deepEqual(result.summary.engines.gbrain_graph, { passed: 1, failed: 0 });
  assert.equal(result.results[0].engines.gbrain.ok, false);
  assert.equal(result.results[0].engines.gbrain_graph.ok, true);
  assert.deepEqual(result.results[0].engineQueries.gbrain_graph, ['projects/jarvos-context-engineering-upgrade']);
  assert.equal(result.results[0].engines.gbrain_graph.recall.results[0].nodeCount, 2);
});

test('runRetrievalEval fails graph expectations that omit seeds', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query: 'what connects memory and continuity?',
      expected: {
        gbrain: 'projects/jarvos-context-engineering-upgrade',
        graph: 'concepts/openclaw-context-management-lessons',
      },
    }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nprintf "%s\\n" "projects/jarvos-context-engineering-upgrade"\n', 'utf8');
  fs.chmodSync(gbrainBin, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin,
    gbrainDir: root,
  }, { compareGraph: true });

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.engines.gbrain, { passed: 1, failed: 0 });
  assert.deepEqual(result.summary.engines.gbrain_graph, { passed: 0, failed: 1 });
  assert.equal(result.results[0].engines.gbrain.ok, true);
  assert.equal(result.results[0].engines.gbrain_graph.ok, false);
  assert.equal(result.results[0].engines.gbrain_graph.recall.seedCount, 0);
  assert.deepEqual(result.results[0].engines.gbrain_graph.missingExpected, ['concepts/openclaw-context-management-lessons']);
});

test('runRetrievalEval can score combined runtime recall separately from direct search', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query: 'what should runtime recall know?',
      graphSeeds: ['sources/runtime-recall-seed'],
      expected: {
        gbrain: 'projects/missing-direct-answer',
        qmd: 'qmd://notes/runtime-recall.md',
        graph: 'concepts/runtime-context',
      },
    }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'graph-query') {
  process.stdout.write(JSON.stringify([
    { slug: args[1], title: 'Runtime Recall Seed', type: 'source', depth: 0, links: [] },
    { slug: 'concepts/runtime-context', title: 'Runtime Context', type: 'concept', depth: 1, links: [] }
  ]));
} else {
  process.stdout.write('[0.91] sources/runtime-recall-seed -- anchor only');
}
`, 'utf8');
  fs.writeFileSync(qmdBin, '#!/bin/sh\nprintf "%s\\n" "[{\\"file\\":\\"qmd://notes/runtime-recall.md\\",\\"snippet\\":\\"broad lookup evidence\\"}]"\n', 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin,
    gbrainDir: root,
    qmdBin,
  }, {
    compareQmd: true,
    compareGraph: true,
    compareRecall: true,
    graphSeedLimit: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.compareRecall, true);
  assert.deepEqual(result.summary.engines.gbrain, { passed: 0, failed: 1 });
  assert.deepEqual(result.summary.engines.qmd, { passed: 1, failed: 0 });
  assert.deepEqual(result.summary.engines.gbrain_graph, { passed: 1, failed: 0 });
  assert.deepEqual(result.summary.engines.gbrain_recall, { passed: 1, failed: 0 });
  assert.equal(result.results[0].engines.gbrain.ok, false);
  assert.equal(result.results[0].engines.gbrain_recall.ok, true);
});

test('runRetrievalEval writes only sanitized health-bearing failure evidence', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'private-eval.json');
  const artifactPath = path.join(root, 'state', 'combined-recall-latest.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  const privateQuery = 'private punctuation-sensitive question';
  const privateExpected = 'Gamma—Delta';
  const privatePath = 'qmd://notes/private-alpha-beta.md';
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query: privateQuery,
      expected: {
        gbrain: 'projects/intentionally-missing-direct-result',
        qmd: privatePath,
        recall: { any: [privateExpected] },
      },
    }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nif [ "$1" = "graph-query" ]; then printf "%s\\n" "No edges found"; else printf "%s\\n" "[0.5] projects/other -- unrelated"; fi\n', 'utf8');
  fs.writeFileSync(qmdBin, `#!/bin/sh
printf "%s\\n" '[{"file":"${privatePath}","snippet":"Alpha - Beta"}]'
`, 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin,
    gbrainDir: root,
    qmdBin,
  }, {
    compareQmd: true,
    compareRecall: true,
    artifactPath,
    publicRevision: 'a'.repeat(40),
    runtimeRevision: 'b'.repeat(40),
    now: new Date('2026-08-24T12:00:00.000Z'),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.engines.gbrain, { passed: 0, failed: 1 });
  assert.deepEqual(result.artifact, {
    ok: true,
    path: artifactPath,
    digest: result.artifact.digest,
    failureCount: 1,
  });
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assert.equal(artifact.schema, gbrain.RETRIEVAL_EVAL_ARTIFACT_SCHEMA);
  assert.equal(artifact.generatedAt, '2026-08-24T12:00:00.000Z');
  assert.equal(artifact.publicRevision, 'a'.repeat(40));
  assert.equal(artifact.runtimeRevision, 'b'.repeat(40));
  assert.match(artifact.corpusDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(artifact.failures.map((failure) => ({ engine: failure.engine, reason: failure.failureReason })), [
    { engine: 'gbrain_recall', reason: 'expected-candidate-missing' },
  ]);
  assert.match(artifact.failures[0].questionId, /^question-01-[0-9a-f]{12}$/);
  assert.ok(artifact.failures[0].expectedCandidateDigests.every((value) => /^sha256:[0-9a-f]{64}$/.test(value)));
  assert.ok(artifact.failures[0].actualCandidateDigests.every((value) => value.rank > 0 && /^sha256:[0-9a-f]{64}$/.test(value.candidateDigest)));
  assert.equal(fs.statSync(artifactPath).mode & 0o777, 0o600);
  const serialized = fs.readFileSync(artifactPath, 'utf8');
  for (const privateValue of [privateQuery, privateExpected, privatePath, 'Alpha - Beta', 'projects/other']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('runRetrievalEval recall candidates ignore omitted engine expectations', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query: 'qmd-only evidence',
      expected: {
        qmd: 'qmd://notes/expected.md',
      },
    }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nprintf "%s\\n" "[0.50] projects/other -- unrelated"\n', 'utf8');
  fs.writeFileSync(qmdBin, '#!/bin/sh\nprintf "%s\\n" "[{\\"file\\":\\"qmd://notes/other.md\\",\\"snippet\\":\\"unrelated\\"}]"\n', 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin,
    gbrainDir: root,
    qmdBin,
  }, {
    compareRecall: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].engines.gbrain.expectedMatched, undefined);
  assert.deepEqual(result.results[0].engines.gbrain_recall.expectedCandidates, ['qmd://notes/expected.md']);
  assert.equal(result.results[0].engines.gbrain_recall.ok, false);
  assert.deepEqual(result.results[0].engines.gbrain_recall.missingExpected, ['qmd://notes/expected.md']);
});

test('combined recall records an empty QMD subpath without hiding valid GBrain evidence', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{ query: 'structured answer', expected: { gbrain: 'projects/structured-answer' } }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nif [ "$1" = "graph-query" ]; then printf "%s\\n" "No edges found"; else printf "%s\\n" "[0.9] projects/structured-answer -- useful evidence"; fi\n', 'utf8');
  fs.writeFileSync(qmdBin, '#!/bin/sh\nprintf "%s\\n" "No results found."\n', 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({ evalPath, gbrainBin, gbrainDir: root, qmdBin }, { compareRecall: true });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].engines.gbrain_recall.ok, true);
  assert.equal(result.results[0].engines.gbrain_recall.bundle.engines.qmd.ok, false);
  assert.equal(result.results[0].engines.gbrain_recall.bundle.engines.qmd.failureReason, 'empty-candidate-set');
});

test('runRetrievalEval preserves generic expectations alongside recall overrides', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [{
      query: 'mixed direct and recall evidence',
      expected: {
        slug: 'projects/foo',
        recall: 'qmd://notes/foo.md',
      },
    }],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'graph-query') {
  process.stdout.write(JSON.stringify([{ slug: args[1], depth: 0, links: [] }]));
} else {
  process.stdout.write('[0.92] projects/foo -- direct answer');
}
`, 'utf8');
  fs.writeFileSync(qmdBin, '#!/bin/sh\nprintf "%s\\n" "[{\\"file\\":\\"qmd://notes/foo.md\\",\\"snippet\\":\\"recall answer\\"}]"\n', 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({
    evalPath,
    gbrainBin,
    gbrainDir: root,
    qmdBin,
  }, {
    compareRecall: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].engines.gbrain.expectedMatched, true);
  assert.deepEqual(result.results[0].engines.gbrain_recall.expectedCandidates, ['qmd://notes/foo.md']);
  assert.equal(result.results[0].engines.gbrain_recall.ok, true);
});

test('combined recall canonicalizes punctuation and whitespace without accepting a wrong phrase', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [
      { query: 'canonical match', expected: { qmd: 'qmd://notes/canonical.md', recall: { any: ['Alpha—Beta'] } } },
      { query: 'genuine wrong candidate', expected: { qmd: 'qmd://notes/wrong.md', recall: { any: ['Alpha—Beta'] } } },
    ],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nif [ "$1" = "graph-query" ]; then printf "%s\\n" "No edges found"; else printf "%s\\n" "[0.5] projects/other -- unrelated"; fi\n', 'utf8');
  fs.writeFileSync(qmdBin, `#!/usr/bin/env node
const query = process.argv.join(' ');
const canonical = query.includes('canonical match');
process.stdout.write(JSON.stringify([{ file: canonical ? 'qmd://notes/canonical.md' : 'qmd://notes/wrong.md', snippet: canonical ? 'Alpha -   Beta' : 'Alpha Gamma Beta' }]));
`, 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({ evalPath, gbrainBin, gbrainDir: root, qmdBin }, { compareQmd: true, compareRecall: true });

  assert.equal(result.results[0].engines.gbrain_recall.ok, true);
  assert.equal(result.results[1].engines.gbrain_recall.ok, false);
  assert.equal(result.limit, 10);
  assert.equal(result.results[0].engines.gbrain_recall.bundle.limit, 10);
  assert.equal(result.ok, false);

  const runtimeRecall = gbrain.recallBundle({ gbrainBin, gbrainDir: root, qmdBin }, { query: 'canonical match', autoGraph: false });
  assert.equal(runtimeRecall.limit, 5);
});

test('QMD comparison classifies malformed, empty, and missing engine results explicitly', () => {
  const root = tempDir();
  const evalPath = path.join(root, 'eval.json');
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  fs.writeFileSync(evalPath, JSON.stringify({
    version: 1,
    questions: [
      { query: 'malformed qmd', expected: { gbrain: 'projects/ok', qmd: 'not-json' } },
      { query: 'empty qmd', expected: { gbrain: 'projects/ok' } },
    ],
  }), 'utf8');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nprintf "%s\\n" "projects/ok"\n', 'utf8');
  fs.writeFileSync(qmdBin, `#!/usr/bin/env node
if (process.argv.join(' ').includes('malformed qmd')) process.stdout.write('not-json');
`, 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.runRetrievalEval({ evalPath, gbrainBin, gbrainDir: root, qmdBin }, { compareQmd: true });
  assert.equal(result.results[0].engines.qmd.ok, false);
  assert.equal(result.results[0].engines.qmd.failureReason, 'malformed-result');
  assert.equal(result.results[1].engines.qmd.ok, false);
  assert.equal(result.results[1].engines.qmd.failureReason, 'empty-candidate-set');

  const missing = gbrain.runRetrievalEval({ evalPath, gbrainBin, gbrainDir: root, qmdBin: path.join(root, 'missing-qmd') }, { compareQmd: true });
  assert.equal(missing.results[0].engines.qmd.ok, false);
  assert.equal(missing.results[0].engines.qmd.failureReason, 'missing-engine');
});

test('recallBundle combines GBrain search, QMD lookup, and graph expansion', () => {
  const root = tempDir();
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  fs.writeFileSync(gbrainBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'graph-query') {
  process.stdout.write(JSON.stringify([
    { slug: args[1], title: 'JarVOS Runtime Recall', type: 'project', depth: 0, links: [] },
    { slug: 'concepts/openclaw-context-management-lessons', title: 'OpenClaw Context Lessons', type: 'concept', depth: 1, links: [] }
  ]));
} else {
  process.stdout.write('[0.99] projects/jarvos-runtime-recall -- structured GBrain context\\n[0.80] concepts/other -- extra context');
}
`, 'utf8');
  fs.writeFileSync(qmdBin, '#!/bin/sh\nprintf "%s\\n" "[{\\"file\\":\\"qmd://notes/runtime-recall.md\\",\\"snippet\\":\\"broad lookup\\"}]"\n', 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);

  const result = gbrain.recallBundle({
    gbrainBin,
    gbrainDir: root,
    qmdBin,
  }, {
    query: 'runtime recall',
    limit: 2,
    graphSeedLimit: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.engines.gbrain.ok, true);
  assert.equal(result.engines.qmd.ok, true);
  assert.deepEqual(result.graphSeeds, ['projects/jarvos-runtime-recall']);
  assert.equal(result.graph.results[0].nodeCount, 2);
  assert.deepEqual(result.engines.qmd.command.args, ['search', 'runtime recall', '-n', '2', '--json']);
  assert.match(result.markdown, /## Direct GBrain Search/);
  assert.match(result.markdown, /## QMD Broad Lookup/);
  assert.match(result.markdown, /## GBrain Graph Sidecar/);
});

test('renderRecallMarkdown preserves recalled code fences', () => {
  const markdown = gbrain.renderRecallMarkdown({
    query: 'fenced snippets',
    engines: {
      gbrain: {
        ok: true,
        text: 'before\n```bash\nnpm test\n```',
      },
      qmd: {
        ok: true,
        text: 'wide\n````\nvalue\n````',
      },
    },
    graph: null,
  });

  assert.match(markdown, /````text\nbefore\n```bash\nnpm test\n```\n````/);
  assert.match(markdown, /`````text\nwide\n````\nvalue\n````\n`````/);
});

test('recallBundle reports missing query without spawning commands', () => {
  const result = gbrain.recallBundle({}, { query: '' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing query');
  assert.deepEqual(result.engines, {});
  assert.match(result.markdown, /Query: \(missing\)/);
});

test('CLI recall exits non-zero when recall bundle fails', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'jarvos-gbrain.js'),
    'recall',
  ], { encoding: 'utf8' });
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'missing query');
});

test('graphRecall traverses seed pages through the gbrain graph-query command', () => {
  const root = tempDir();
  const binPath = path.join(root, 'fake-gbrain');
  const argsPath = path.join(root, 'args.json');
  fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
process.stdout.write(JSON.stringify([
  { slug: 'projects/jarvos-context-engineering-upgrade', depth: 0 },
  { slug: 'concepts/openclaw-context-management-lessons', depth: 1 }
]));
`, 'utf8');
  fs.chmodSync(binPath, 0o755);

  const result = gbrain.graphRecall({
    gbrainBin: binPath,
    gbrainDir: root,
  }, {
    seeds: ['projects/jarvos-context-engineering-upgrade'],
    depth: 3,
  });
  const captured = JSON.parse(fs.readFileSync(argsPath, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.seedCount, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].depth, 3);
  assert.equal(result.results[0].nodeCount, 2);
  assert.equal(result.results[0].nodes[1].slug, 'concepts/openclaw-context-management-lessons');
  assert.equal(fs.realpathSync(captured.cwd), fs.realpathSync(root));
  assert.deepEqual(captured.args, ['graph-query', 'projects/jarvos-context-engineering-upgrade', '--depth', '3']);
});

test('graphRecall parses gbrain graph-query text output', () => {
  const root = tempDir();
  const binPath = path.join(root, 'fake-gbrain');
  fs.writeFileSync(binPath, `#!/bin/sh
cat <<'OUT'
[depth 0] sources/paperclip-openclaw-setup-guide-draft
  --mentions-> concepts/jarvos-task-management-component (depth 1)
    --mentions-> concepts/jarvos-memory-module-spec (depth 2)
OUT
`, 'utf8');
  fs.chmodSync(binPath, 0o755);

  const result = gbrain.graphRecall({
    gbrainBin: binPath,
    gbrainDir: root,
  }, {
    seeds: ['sources/paperclip-openclaw-setup-guide-draft'],
    depth: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].nodeCount, 3);
  assert.equal(result.results[0].nodes[1].slug, 'concepts/jarvos-task-management-component');
  assert.deepEqual(result.results[0].nodes[1].links, [{
    from_slug: 'sources/paperclip-openclaw-setup-guide-draft',
    to_slug: 'concepts/jarvos-task-management-component',
    link_type: 'mentions',
  }]);
});

test('graphRecall accepts graph-query no-edge output', () => {
  const root = tempDir();
  const binPath = path.join(root, 'fake-gbrain');
  fs.writeFileSync(binPath, '#!/bin/sh\nprintf "%s\\n" "No edges found for this node."\n', 'utf8');
  fs.chmodSync(binPath, 0o755);

  const result = gbrain.graphRecall({
    gbrainBin: binPath,
    gbrainDir: root,
  }, {
    seeds: ['projects/no-edge-seed'],
    depth: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].nodeCount, 1);
  assert.deepEqual(result.results[0].nodes[0], {
    slug: 'projects/no-edge-seed',
    depth: 0,
    links: [],
  });
  assert.equal(result.results[0].parseError, null);
});

test('graphRecall fails when graph output is not a JSON array', () => {
  const root = tempDir();
  const binPath = path.join(root, 'fake-gbrain');
  fs.writeFileSync(binPath, '#!/bin/sh\nprintf "%s\\n" "not json"\n', 'utf8');
  fs.chmodSync(binPath, 0o755);

  const result = gbrain.graphRecall({
    gbrainBin: binPath,
    gbrainDir: root,
  }, {
    seeds: ['projects/jarvos-context-engineering-upgrade'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].parseError, /JSON/);
});

test('resolveConfig expands tilde gbrainBin paths before spawning', () => {
  const result = gbrain.resolveConfig({ gbrainBin: '~/bin/gbrain' });
  assert.equal(result.gbrainBin, path.join(os.homedir(), 'bin', 'gbrain'));
});

test('doctor can detect commands available on PATH', () => {
  const root = tempDir();
  const manifestPath = path.join(root, 'manifest.json');
  const evalPath = path.join(root, 'eval.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, items: [] }), 'utf8');
  fs.writeFileSync(evalPath, JSON.stringify({ version: 1, questions: [] }), 'utf8');

  const result = gbrain.doctor({
    manifestPath,
    evalPath,
    vaultDir: root,
    notesDir: root,
    brainDir: root,
    gbrainDir: root,
    gbrainBin: 'node',
  });

  assert.equal(result.checks.find((check) => check.name === 'vaultDir').ok, true);
  assert.equal(result.checks.find((check) => check.name === 'notesDir').ok, true);
  assert.equal(result.checks.find((check) => check.name === 'gbrainBin').ok, true);
});

test('doctor does not execute shell metacharacters in gbrainBin', () => {
  const root = tempDir();
  const manifestPath = path.join(root, 'manifest.json');
  const evalPath = path.join(root, 'eval.json');
  const sentinel = path.join(root, 'should-not-exist');
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, items: [] }), 'utf8');
  fs.writeFileSync(evalPath, JSON.stringify({ version: 1, questions: [] }), 'utf8');

  const result = gbrain.doctor({
    manifestPath,
    evalPath,
    vaultDir: root,
    notesDir: root,
    brainDir: root,
    gbrainDir: root,
    gbrainBin: `node; touch ${sentinel}`,
  });

  assert.equal(result.checks.find((check) => check.name === 'gbrainBin').ok, false);
  assert.equal(fs.existsSync(sentinel), false);
});

test('resolveConfig falls back to the bun-link gbrain path when PATH omits it', () => {
  const fakeHome = tempDir();
  const bunBinDir = path.join(fakeHome, '.bun', 'bin');
  const gbrainBinPath = path.join(bunBinDir, 'gbrain');
  fs.mkdirSync(bunBinDir, { recursive: true });
  fs.writeFileSync(gbrainBinPath, '#!/usr/bin/env node\n', { mode: 0o755 });

  const env = { ...process.env, HOME: fakeHome, PATH: '/usr/bin:/bin' };
  delete env.JARVOS_GBRAIN_BIN;
  const child = spawnSync(process.execPath, [
    '-e',
    `const gbrain = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'index.js'))});
process.stdout.write(JSON.stringify(gbrain.resolveConfig({}).gbrainBin));
`,
  ], {
    cwd: fakeHome,
    env,
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), gbrainBinPath);
});

function sha256File(filePath) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function managedRuntimeDescriptor(executablePath, extras = {}) {
  return {
    executablePath,
    sha256: sha256File(executablePath),
    expectedOwnerUid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    ...extras,
  };
}

test('managed GBrain runtime resolves a symlink but pins the resolved executable', () => {
  const root = tempDir();
  const target = path.join(root, 'gbrain-real');
  const link = path.join(root, 'gbrain-link');
  fs.writeFileSync(target, '#!/bin/sh\nprintf managed\n', { mode: 0o755 });
  fs.symlinkSync(target, link);

  const runtime = gbrain.validateManagedRuntime(managedRuntimeDescriptor(link, {
    version: '0.46.32',
    commit: 'abc123',
    engineKind: 'postgres',
    storeIdentity: { host: '127.0.0.1', port: 5432, database: 'brain', pageCount: 2 },
  }));
  assert.equal(runtime.ok, true);
  assert.equal(runtime.executablePath, fs.realpathSync(target));
  assert.equal(runtime.provenance.managed, true);
  assert.equal(runtime.provenance.verified, true);
  assert.equal(runtime.provenance.selectedRuntimeVersion, '0.46.32');
  assert.equal(runtime.provenance.engineKind, 'postgres');
  assert.match(runtime.provenance.canonicalStoreIdentityDigest, /^sha256:/);
});

test('managed GBrain runtime fails closed for owner, mode, and digest drift', () => {
  const root = tempDir();
  const executable = path.join(root, 'gbrain');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf managed\n', { mode: 0o755 });
  const descriptor = managedRuntimeDescriptor(executable);

  assert.equal(gbrain.validateManagedRuntime({ ...descriptor, expectedOwnerUid: 999999 }).failureClass, 'runtime-owner-mismatch');
  fs.chmodSync(executable, 0o775);
  assert.equal(gbrain.validateManagedRuntime(descriptor).failureClass, 'runtime-mode-unsafe');
  fs.chmodSync(executable, 0o755);
  assert.equal(gbrain.validateManagedRuntime({ ...descriptor, sha256: '0'.repeat(64) }).failureClass, 'runtime-digest-mismatch');
});

test('managed GBrain runtime rejects a group-writable ancestor', () => {
  const root = tempDir();
  const unsafe = path.join(root, 'unsafe-runtime');
  fs.mkdirSync(unsafe, { mode: 0o770 });
  fs.chmodSync(unsafe, 0o770);
  const executable = path.join(unsafe, 'gbrain');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf unsafe\n', { mode: 0o700 });
  const result = gbrain.validateManagedRuntime(managedRuntimeDescriptor(executable));
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'runtime-ancestor-unsafe');
});

test('managed GBrain runtime revalidates before every spawn', () => {
  const root = tempDir();
  const executable = path.join(root, 'gbrain');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf first\n', { mode: 0o755 });
  const config = {
    gbrainBin: executable,
    gbrainDir: root,
    gbrainHome: root,
    gbrainStore: path.join(root, 'store'),
    managedRuntime: managedRuntimeDescriptor(executable),
  };

  assert.equal(gbrain.runGbrainCommand(config, ['search', 'one']).ok, true);
  fs.writeFileSync(executable, '#!/bin/sh\nprintf changed\n', { mode: 0o755 });
  const second = gbrain.runGbrainCommand(config, ['search', 'two']);
  assert.equal(second.ok, false);
  assert.equal(second.failureClass, 'runtime-digest-mismatch');
});

test('managed GBrain uses neutral cwd, minimal env, and does not inherit database routing', () => {
  const root = tempDir();
  const executable = path.join(root, 'gbrain');
  const home = path.join(root, 'home');
  const store = path.join(root, 'store');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s|%s|%s|%s|%s|%s" "$PWD" "$GBRAIN_HOME" "$GBRAIN_STORE" "${DATABASE_URL:+set}" "${GBRAIN_BRAIN_ID:+set}" "$GBRAIN_SWEEP"\n', { mode: 0o755 });
  const result = withEnv({
    PRIVATE_TOKEN: 'do-not-inherit',
    DATABASE_URL: 'postgresql://private:secret@localhost/brain',
    GBRAIN_ENGINE: 'postgres',
  }, () => gbrain.runGbrainCommand({
    gbrainBin: executable,
    gbrainDir: root,
    gbrainHome: home,
    gbrainStore: store,
    managedRuntime: managedRuntimeDescriptor(executable),
    managedProviderEnv: { GBRAIN_BRAIN_ID: 'host' },
  }, ['search', 'one']));

  assert.equal(result.ok, true);
  assert.equal(result.stdout, `${fs.realpathSync(os.tmpdir())}|${home}|${store}||set|0`);
});

function writeManagedProviderDescriptor(root, executable, extras = {}) {
  const descriptorPath = path.join(root, 'gbrain-runtime.json');
  const skillsDir = path.join(root, 'skills');
  const skillifyDir = path.join(skillsDir, 'skillify');
  const manifestPath = path.join(skillsDir, 'manifest.json');
  const skillifyPath = path.join(skillifyDir, 'SKILL.md');
  fs.mkdirSync(skillifyDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(manifestPath, JSON.stringify({ skills: [{ name: 'skillify', path: 'skillify/SKILL.md' }] }), { mode: 0o644 });
  fs.writeFileSync(skillifyPath, '# Skillify\n', { mode: 0o644 });
  const interpreterPath = path.join(root, 'node-interpreter');
  fs.writeFileSync(interpreterPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o700 });
  const descriptor = {
    schemaVersion: 'jarvos-gbrain-runtime-descriptor/v1',
    executablePath: executable,
    sha256: sha256File(executable),
    expectedOwnerUid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    version: '0.46.32.0',
    commit: 'd11b7992d7085ada60505730f53bda7ab4df3313',
    engineKind: 'postgres',
    storeIdentity: { host: '127.0.0.1', port: 5432, database: 'gbrain' },
    gbrainHome: path.join(root, 'home'),
    gbrainStore: path.join(root, 'store'),
    providerEnv: { GBRAIN_BRAIN_ID: 'host' },
    interpreter: {
      executablePath: interpreterPath,
      sha256: sha256File(interpreterPath),
      expectedOwnerUid: fs.statSync(interpreterPath).uid,
    },
    skills: {
      directoryPath: skillsDir,
      manifestSha256: sha256File(manifestPath),
      skillifySha256: sha256File(skillifyPath),
    },
    ...extras,
  };
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  fs.chmodSync(descriptorPath, 0o600);
  return { descriptorPath, descriptor };
}

test('managed provider descriptor pins the source and interpreter and prepares provider-owned stdio', () => {
  const root = tempDir();
  const executable = path.join(root, 'gbrain.js');
  fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
  const { descriptorPath } = writeManagedProviderDescriptor(root, executable);

  const loaded = gbrain.loadManagedRuntimeDescriptor(descriptorPath);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.runtime.executablePath, fs.realpathSync(executable));
  assert.equal(loaded.runtime.launchCommand, fs.realpathSync(path.join(root, 'node-interpreter')));
  assert.match(loaded.runtime.provenance.interpreterDigest, /^sha256:/);
  assert.match(loaded.skills.manifestDigest, /^sha256:/);
  assert.match(loaded.skills.skillifyDigest, /^sha256:/);

  const prepared = withEnv({ DATABASE_URL: 'postgresql://ambient/must-not-leak' }, () => (
    gbrain.prepareManagedGbrainProvider(descriptorPath)
  ));
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.args, [fs.realpathSync(executable), 'serve']);
  assert.equal(prepared.env.DATABASE_URL, undefined);
  assert.equal(prepared.env.GBRAIN_SWEEP, '0');
  assert.equal(prepared.env.GBRAIN_BRAIN_ID, 'host');
  assert.equal(prepared.env.GBRAIN_SKILLS_DIR, fs.realpathSync(path.join(root, 'skills')));
  assert.match(prepared.provenance.skillifyDigest, /^sha256:/);
});

test('managed provider descriptor fails closed for unsafe mode and provider env', () => {
  const root = tempDir();
  const executable = path.join(root, 'gbrain.js');
  fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
  const { descriptorPath, descriptor } = writeManagedProviderDescriptor(root, executable);

  fs.chmodSync(descriptorPath, 0o644);
  assert.equal(gbrain.loadManagedRuntimeDescriptor(descriptorPath).failureClass, 'descriptor-mode-unsafe');

  fs.writeFileSync(descriptorPath, JSON.stringify({
    ...descriptor,
    providerEnv: { DATABASE_URL: 'postgresql://must-live-in-owner-config' },
  }), { mode: 0o600 });
  fs.chmodSync(descriptorPath, 0o600);
  assert.equal(gbrain.loadManagedRuntimeDescriptor(descriptorPath).failureClass, 'descriptor-provider-env-invalid');

  fs.writeFileSync(path.join(root, 'skills', 'skillify', 'SKILL.md'), '# drifted\n');
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  fs.chmodSync(descriptorPath, 0o600);
  assert.equal(gbrain.loadManagedRuntimeDescriptor(descriptorPath).failureClass, 'runtime-skills-digest-mismatch');
});

test('provider launcher streams GBrain stdio without inheriting ambient database credentials', () => {
  const root = tempDir();
  const executable = path.join(root, 'gbrain.js');
  fs.writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  databaseUrl: process.env.DATABASE_URL || null,
  sweep: process.env.GBRAIN_SWEEP,
  brain: process.env.GBRAIN_BRAIN_ID,
  skillsDir: process.env.GBRAIN_SKILLS_DIR || null,
}));
`, { mode: 0o755 });
  const { descriptorPath } = writeManagedProviderDescriptor(root, executable);
  const launcher = path.join(__dirname, '..', 'scripts', 'jarvos-gbrain-provider.js');
  const launched = spawnSync(process.execPath, [launcher], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://ambient/must-not-leak',
      JARVOS_GBRAIN_RUNTIME_DESCRIPTOR: descriptorPath,
    },
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(launched.stdout), {
    args: ['serve'],
    databaseUrl: null,
    sweep: '0',
    brain: 'host',
    skillsDir: fs.realpathSync(path.join(root, 'skills')),
  });
});

test('successful managed recall redacts command path and query from public provenance', () => {
  const root = tempDir();
  const executable = path.join(root, 'gbrain');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "[0.9] projects/safe-result -- answer"\n', { mode: 0o755 });
  const privateQuery = 'private query must not reach provenance';
  const result = gbrain.recallBundle({
    gbrainBin: executable,
    gbrainDir: root,
    gbrainHome: root,
    gbrainStore: path.join(root, 'store'),
    managedRuntime: managedRuntimeDescriptor(executable),
    includeQmd: false,
  }, { query: privateQuery });

  assert.equal(result.engines.gbrain.ok, true);
  assert.equal(result.engines.gbrain.command.command, null);
  assert.deepEqual(result.engines.gbrain.command.args, []);
  assert.equal(result.engines.gbrain.command.stdoutSample, '');
  const receipt = JSON.stringify({ command: result.engines.gbrain.command, provenance: result.provenance });
  assert.doesNotMatch(receipt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(receipt, /private query/);
});

test('managed runtime failure provenance is sanitized', () => {
  const result = gbrain.recallBundle({
    gbrainDir: '/private/gbrain',
    gbrainHome: '/private/gbrain',
    gbrainStore: '/private/store',
    managedRuntime: { executablePath: 'relative', sha256: '0'.repeat(64) },
    includeQmd: false,
  }, { query: 'safe query' });

  assert.equal(result.engines.gbrain.failureClass, 'runtime-invalid-descriptor');
  assert.equal(result.engines.gbrain.text, '');
  assert.equal(result.engines.gbrain.command.stderrSample, '');
  assert.equal(result.provenance.gbrain.managed, true);
  assert.equal(result.provenance.gbrain.verified, false);
  assert.equal(result.provenance.gbrain.selectedRuntimeVersion, null);
  assert.equal(result.provenance.gbrain.canonicalStoreIdentityDigest, null);
  assert.equal(result.provenance.gbrain.failureClass, 'runtime-invalid-descriptor');
  assert.doesNotMatch(JSON.stringify(result), /\/private\/gbrain|\/private\/store/);
});

test('stable GBrain identity ignores mutable corpus counts', () => {
  const first = gbrain.deriveStableBrainIdentity({
    engineKind: 'postgres',
    storeIdentity: { host: '127.0.0.1', port: 5432, database: 'brain', pageCount: 1 },
    sentinelDigest: 'sha256:sentinel',
  });
  const second = gbrain.deriveStableBrainIdentity({
    engineKind: 'postgres',
    storeIdentity: { database: 'brain', port: 5432, host: '127.0.0.1', pageCount: 9999 },
    sentinelDigest: 'sha256:sentinel',
  });
  assert.equal(first.logicalBrainDigest, second.logicalBrainDigest);
  assert.equal(first.storeIdentityDigest, second.storeIdentityDigest);
  const otherStore = gbrain.deriveStableBrainIdentity({
    engineKind: 'postgres',
    storeIdentity: { host: '127.0.0.1', port: 5432, database: 'other-brain' },
    sentinelDigest: 'sha256:sentinel',
  });
  assert.notEqual(first.storeIdentityDigest, otherStore.storeIdentityDigest);
  assert.equal(first.logicalBrainDigest, otherStore.logicalBrainDigest);
});

test('stable GBrain identity rejects unsafe store identity fields', () => {
  const result = gbrain.deriveStableBrainIdentity({
    engineKind: 'postgres',
    storeIdentity: { host: '127.0.0.1', port: 5432, database: 'brain', ['pass' + 'word']: 'not-safe' },
    sentinelDigest: 'sha256:sentinel',
  });
  assert.deepEqual(result, { ok: false, failureClass: 'store-identity-invalid' });
});

test('legacy GBrain remains optional and never claims continuity', () => {
  const root = tempDir();
  const executable = path.join(root, 'gbrain');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf legacy\n', { mode: 0o755 });
  const result = gbrain.recallBundle({ gbrainBin: executable, gbrainDir: root, includeQmd: false }, { query: 'legacy' });
  assert.equal(result.engines.gbrain.ok, true);
  assert.equal(result.engines.gbrain.provenance.managed, false);
  assert.equal(result.provenance.gbrain.continuityClaimed, false);
});
