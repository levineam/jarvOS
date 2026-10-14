'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const CONTENT_DIR = path.join(ROOT, 'modules', 'jarvos-instruction-projection', 'content');
const CONTRACT_PATH = path.join(CONTENT_DIR, 'durable-orientation.md');
const SCENARIOS_PATH = path.join(CONTENT_DIR, 'durable-orientation.scenarios.json');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('portable contract covers the reviewed behavior without private policy', () => {
  const contract = fs.readFileSync(CONTRACT_PATH, 'utf8');
  for (const phrase of [
    'Projects context as the source for Project and Outcome identities',
    'intentional one-off',
    'missing alignment evidence is not evidence of misalignment',
    'Current user direction prevails',
    'grant no authority',
  ]) {
    assert.match(contract, new RegExp(phrase, 'i'));
  }
  assert.doesNotMatch(contract, /\/Users\/|Andrew|Paperclip|OpenClaw|Hermes|Codex|Claude|heartbeat/i);
});

test('scenario fixture contains all eight reviewed cases and universal negative checks', () => {
  const fixture = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  assert.equal(fixture.schemaVersion, 'jarvos.durable-orientation-scenarios/v1');
  assert.deepEqual(fixture.scenarios.map(({ id }) => id), [
    'existing-project',
    'appropriate-child',
    'finite-outcome-or-task',
    'intentional-one-off',
    'projects-unavailable',
    'ontology-missing-or-stale',
    'current-direction-wins',
    'concrete-priority-conflict',
  ]);
  assert.equal(fixture.negativeChecks.length, 3);
  assert.match(fixture.negativeChecks.join('\n'), /Do not create or require/);
  assert.match(fixture.negativeChecks.join('\n'), /Do not stop, dispatch, publish, notify, install, or activate/);
  assert.match(fixture.negativeChecks.join('\n'), /Do not invent/);
});

test('native source entry points use short references to the one contract', () => {
  for (const relativePath of [
    'templates/AGENTS-template.md',
    'core/AGENTS.md',
    'runtimes/claude/templates/CLAUDE.md.template',
    'modules/jarvos-skills/skills/context-management/SKILL.md',
  ]) {
    assert.match(read(relativePath), /WORK-CONTEXT\.md/);
  }
  for (const relativePath of [
    'bootstrap.js',
    'runtimes/openclaw/setup.sh',
    'runtimes/hermes/setup.sh',
    'runtimes/claude/setup.sh',
  ]) {
    assert.match(read(relativePath), /durable-orientation\.md/);
  }
  assert.match(read('core/pms/README.md'), /conventions are optional/);
});

test('fresh core bootstrap installs the canonical contract and preserves customized files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-context-'));
  try {
    const workspace = path.join(tmp, 'workspace');
    const vault = path.join(tmp, 'vault');
    const claudeMd = path.join(tmp, 'home', '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    fs.writeFileSync(claudeMd, '# Customized CLAUDE\n');
    const env = {
      ...process.env,
      HOME: path.join(tmp, 'home'),
      JARVOS_YES: '1',
      JARVOS_NO_DESKTOP: '1',
      JARVOS_ASSISTANT_NAME: 'TestJarvis',
      JARVOS_USER_NAME: 'TestUser',
      JARVOS_COACH_NAME: 'TestCoach',
      JARVOS_WORKSPACE_PATH: workspace,
      JARVOS_VAULT_PATH: vault,
    };
    const first = spawnSync(process.execPath, [path.join(ROOT, 'bootstrap.js'), '--yes'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const contract = fs.readFileSync(CONTRACT_PATH, 'utf8');
    const agents = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8');
    const begin = '<!-- BEGIN jarvOS durable orientation -->';
    const end = '<!-- END jarvOS durable orientation -->';
    assert.equal(fs.readFileSync(path.join(workspace, 'WORK-CONTEXT.md'), 'utf8'), contract);
    assert.equal(agents.slice(agents.indexOf(begin) + begin.length, agents.indexOf(end)).trim(), contract.trim());
    assert.equal(fs.readFileSync(claudeMd, 'utf8'), '# Customized CLAUDE\n');

    const customAgents = '# Customized AGENTS\n';
    const customContext = '# Customized work context\n';
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), customAgents);
    fs.writeFileSync(path.join(workspace, 'WORK-CONTEXT.md'), customContext);
    const second = spawnSync(process.execPath, [path.join(ROOT, 'bootstrap.js'), '--yes'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), customAgents);
    assert.equal(fs.readFileSync(path.join(workspace, 'WORK-CONTEXT.md'), 'utf8'), customContext);
    assert.equal(fs.readFileSync(claudeMd, 'utf8'), '# Customized CLAUDE\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('module and root package manifests ship the canonical content', () => {
  const modulePackage = JSON.parse(read('modules/jarvos-instruction-projection/package.json'));
  const rootPackage = JSON.parse(read('package.json'));
  assert(modulePackage.files.includes('content/'));
  assert(rootPackage.files.includes('modules/jarvos-instruction-projection/content/'));
  assert.match(rootPackage.scripts.test, /modules\/jarvos-instruction-projection\/test\/\*\.test\.js/);
});
