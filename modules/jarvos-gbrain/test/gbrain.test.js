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
  const env = { ...process.env };
  for (const key of ['JARVOS_CLAWD_DIR', 'CLAWD_DIR', 'JARVOS_VAULT_DIR', 'JARVOS_NOTES_DIR', 'VAULT_NOTES_DIR']) {
    delete env[key];
  }
  const child = spawnSync(process.execPath, [
    '-e',
    `const gbrain = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'index.js'))});
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

test('graphRecall traverses seed pages through the gbrain graph command', () => {
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
  assert.deepEqual(captured.args, ['graph', 'projects/jarvos-context-engineering-upgrade', '--depth', '3']);
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
