'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const gbrain = require('../src/index.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-gbrain-'));
}

test('slugify produces stable filesystem-safe slugs', () => {
  assert.equal(gbrain.slugify('Andrew & JarVOS: Brain Notes'), 'andrew-and-jarvos-brain-notes');
  assert.equal(gbrain.slugify(''), 'untitled');
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
    brainDir: root,
    gbrainDir: root,
    gbrainBin: 'node',
  });

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
    brainDir: root,
    gbrainDir: root,
    gbrainBin: `node; touch ${sentinel}`,
  });

  assert.equal(result.checks.find((check) => check.name === 'gbrainBin').ok, false);
  assert.equal(fs.existsSync(sentinel), false);
});
