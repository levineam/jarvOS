'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { planTasks, readProjectsFiles, projectStatusChanges, selectPlanTask, readPlanTaskContext, checkpointPlanTask } = require('../../modules/jarvos-agent-context/src/projects-files');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-task-'));
  const directory = path.join(root, 'projects'); fs.mkdirSync(directory);
  const stateDir = path.join(root, 'state', 'jarvos', 'session-state', 'codex');
  const artifact = path.join(root, 'report.md'); fs.writeFileSync(artifact, 'Real fixture input\n');
  const file = path.join(directory, 'Project.md');
  const body = `---\ntype: project\nid: prj_named\ntitle: Project\nstatus: active\ncreated: 2026-11-01\nupdated: 2026-11-11\nsessions: []\n---\n\n## Goal\nKeep task identity.\n\n## Acceptance criteria\n- [ ] Read and continue\n\n## Plan\n- [ ] Task A\n  Owner: Source (${A})\n  Next: Read A\n  Inputs: [Report](<${artifact}>)\n- [ ] Task B\n  Owner: Journal (${B})\n  Next: Read B\n  Inputs: ${artifact}\n\n## Backlog\n- [ ] Not selected\n\n## Log\n- 2026-11-11 Started.\n`;
  fs.writeFileSync(file, body);
  const git = (...args) => {
    const r = spawnSync('/usr/bin/git', ['-C', directory, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
  };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '--', 'Project.md'); git('commit', '-qm', 'Initial task');
  const options = (sessionId = A) => ({ directory, stateDir, sessionId });
  const select = (task = 'Task A', sessionId = A, extra = {}) => selectPlanTask({ ...options(sessionId), project: 'prj_named', task, ...extra });
  const read = (sessionId = A) => readPlanTaskContext(options(sessionId));
  const change = (from, to) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to));
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state'), CODEX_THREAD_ID: A, JARVOS_PROJECTS_DIR: directory,
    JARVOS_VAULT_DIR: root, JARVOS_NOTES_DIR: path.join(root, 'Notes'), JARVOS_JOURNAL_DIR: path.join(root, 'Journal'),
    JARVOS_WORKSPACE_DIR: root, JARVOS_PAPERCLIP_ENV_FILE: path.join(root, 'absent'), JARVOS_STEWARDSHIP_BRIDGE_COMMAND: '' };
  fs.mkdirSync(env.JARVOS_NOTES_DIR); fs.mkdirSync(env.JARVOS_JOURNAL_DIR);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, stateDir, file, artifact, body, git, options, select, read, change, env };
}

test('Plan selection ignores fenced, nested, acceptance and Backlog checkboxes', () => {
  const body = '## Plan\n- [ ] A\n  Owner: one\n  - [ ] nested\n```\n- [ ] fenced\n```\n- [x] B\n## Backlog\n- [ ] C';
  assert.deepEqual(planTasks(body).map((x) => [x.selector, x.completed]), [['A', false], ['B', true]]);
});

test('two session pointers keep separate canonical tasks, owners, next actions and artifacts', async (t) => {
  const f = fixture(t);
  assert.equal((await f.read()).status, 'not_selected');
  const a = await f.select(), b = await f.select('Task B', B);
  assert.equal(a.disposition, 'current_owner'); assert.equal(b.disposition, 'current_owner');
  assert.equal(a.task.nextAction, 'Read A'); assert.equal(b.task.nextAction, 'Read B');
  assert.equal(a.task.artifacts[0].ref, f.artifact); assert.equal(a.project.goal, 'Keep task identity.');
  assert.match(a.project.acceptance, /Read and continue/);
  f.change('Next: Read A', 'Next: Verify A');
  assert.equal((await f.read()).task.nextAction, 'Verify A');
  const stillB = await f.read(B); assert.equal(stillB.task.selector, 'Task B'); assert.equal(stillB.task.nextAction, 'Read B');
  assert.equal(stillB.changedSinceSelection, true); assert.equal(stillB.project.status, 'active');
  assert.equal(stillB.effectsAuthorized, false);
});

test('task details refresh with unchanged active status; legacy status cache migrates safely', async (t) => {
  const f = fixture(t), cache = path.join(f.root, 'cache');
  assert.equal(projectStatusChanges(f.directory, A, { stateDir: cache }), '');
  f.change('Next: Read A', 'Next: New input');
  assert.match(projectStatusChanges(f.directory, A, { stateDir: cache }), /task or project details changed/);
  assert.equal(projectStatusChanges(f.directory, A, { stateDir: cache }), '');
});

test('retained other owner, unknown owner and completed work never grant execution', async (t) => {
  const f = fixture(t);
  assert.equal((await f.select('Task B')).disposition, 'retained_other_owner');
  f.change(`Owner: Journal (${B})`, 'Owner: Journal');
  assert.equal((await f.read()).disposition, 'owner_unverified');
  f.change('- [ ] Task B', '- [x] Task B');
  const context = await f.read(); assert.equal(context.disposition, 'owner_unverified'); assert.equal(context.effectsAuthorized, false);
  const checkpoint = await checkpointPlanTask({ ...f.options(), project: 'prj_named', task: 'Task B', expectedState: context.stateRevision, expectedRevision: context.project.revision });
  assert.equal(checkpoint.code, 'PMS_RETAINED_OWNER_RECONCILIATION');
});

test('completed checkpoint requires exactly one current owner UUID', async (t) => {
  const f = fixture(t); const selected = await f.select();
  f.change('- [ ] Task A', '- [x] Task A');
  let previous = `Source (${A})`;
  for (const owner of [`Source (${A}) / Journal (${B})`, 'Source', `Journal (${B})`, `Source (${A})`]) {
    f.change(`Owner: ${previous}`, `Owner: ${owner}`); previous = owner;
    f.git('commit', '--only', '-qm', 'Record completed task owner', '--', 'Project.md');
    const current = await f.read();
    const checkpoint = await checkpointPlanTask({ ...f.options(), project: 'prj_named', task: 'Task A',
      expectedState: selected.stateRevision, expectedRevision: current.project.revision });
    if (owner !== `Source (${A})`) {
      assert.equal(checkpoint.code, 'PMS_RETAINED_OWNER_RECONCILIATION', owner);
      assert.equal((await f.read()).stateRevision, selected.stateRevision);
    } else {
      assert.equal(current.disposition, 'completed');
      assert.equal(checkpoint.status, 'ok');
      assert.equal(checkpoint.canonicalCommit, f.git('log', '-1', '--format=%H', '--', 'Project.md'));
    }
    assert.equal(current.effectsAuthorized, false);
  }
});

test('rename, duplicate and removed selection reconcile without replacing the saved pointer', async (t) => {
  const f = fixture(t); const saved = await f.select();
  f.change('- [ ] Task A', '- [ ] Renamed A');
  assert.equal((await f.read()).code, 'PMS_TASK_RENAMED_OR_MISSING');
  f.change('- [ ] Renamed A', '- [ ] Task A'); f.change('- [ ] Task B', '- [ ] Task A');
  assert.equal((await f.read()).code, 'PMS_TASK_AMBIGUOUS');
  const stale = await f.select('Task A', A, { expectedState: saved.stateRevision });
  assert.equal(stale.code, 'PMS_TASK_AMBIGUOUS');
});

test('duplicate project IDs, unsafe file links and missing artifacts remain unavailable', async (t) => {
  const f = fixture(t); await f.select();
  fs.writeFileSync(path.join(f.directory, 'Twin.md'), f.body);
  assert.equal((await readProjectsFiles(f.directory, { project: 'prj_named' })).code, 'PROJECT_AMBIGUOUS');
  fs.unlinkSync(path.join(f.directory, 'Twin.md')); fs.unlinkSync(f.artifact);
  assert.equal((await f.read()).disposition, 'artifact_read_required');
  fs.symlinkSync(f.file, f.artifact);
  assert.equal((await f.read()).task.artifacts[0].status, 'unavailable');
});

test('stale state/revision and concurrent selectors preserve the earlier successful selection', async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.select(), f.select('Task B')]);
  assert.deepEqual([a.status, b.status].sort(), ['ok', 'reconcile']);
  assert.equal((await f.read()).task.selector, 'Task A');
  assert.equal((await f.select('Task B')).code, 'PMS_POINTER_CONFLICT');
  const c = await f.read();
  const stale = await f.select('Task A', A, { expectedState: c.stateRevision, expectedRevision: '0'.repeat(64) });
  assert.equal(stale.code, 'PMS_PROJECT_REVISION_CONFLICT');
});

test('writeback distinguishes saved, failed commit and actual scoped committed readback', async (t) => {
  const f = fixture(t); const selected = await f.select();
  f.change('Next: Read A', 'Next: Verify saved result');
  let current = await f.read();
  assert.equal(current.project.commitState, 'uncommitted');
  const checkpoint = () => checkpointPlanTask({ ...f.options(), project: 'prj_named', task: 'Task A', expectedState: selected.stateRevision, expectedRevision: current.project.revision });
  assert.equal((await checkpoint()).code, 'PMS_CANONICAL_UNCOMMITTED');
  fs.writeFileSync(path.join(f.directory, '.git', 'index.lock'), 'occupied');
  const failure = spawnSync('/usr/bin/git', ['-C', f.directory, 'commit', '--only', '-m', 'Continuation', '--', 'Project.md']);
  assert.notEqual(failure.status, 0); assert.equal((await checkpoint()).code, 'PMS_CANONICAL_UNCOMMITTED');
  fs.unlinkSync(path.join(f.directory, '.git', 'index.lock'));
  fs.writeFileSync(path.join(f.directory, 'Other.md'), 'Unrelated staged edit'); f.git('add', '--', 'Other.md');
  f.git('commit', '--only', '-qm', 'Meaningful continuation', '--', 'Project.md');
  current = await f.read(); const committed = await checkpoint();
  assert.equal(committed.status, 'ok'); assert.equal(committed.canonicalCommit, f.git('log', '-1', '--format=%H', '--', 'Project.md'));
  assert.equal(committed.changedSinceSelection, false); assert.equal(committed.task.nextAction, 'Verify saved result');
  assert.match(f.git('status', '--porcelain'), /A  Other.md/);
  assert.equal((await checkpointPlanTask({ ...f.options(), project: 'prj_named', task: 'Task A', expectedState: committed.stateRevision, expectedRevision: current.project.revision })).code, 'PMS_NO_CANONICAL_PROGRESS');
});

test('unsafe/corrupt pointer state is explicit, not treated as an unselected session', async (t) => {
  const f = fixture(t); await f.select();
  const file = fs.readdirSync(f.stateDir).find((name) => name.endsWith('.json'));
  fs.writeFileSync(path.join(f.stateDir, file), '{');
  assert.equal((await f.read()).status, 'reconcile');
  fs.unlinkSync(path.join(f.stateDir, file)); fs.symlinkSync(f.file, path.join(f.stateDir, file));
  assert.equal((await f.read()).code, 'PMS_POINTER_UNAVAILABLE');
  fs.unlinkSync(path.join(f.stateDir, file)); fs.symlinkSync(path.join(f.root, 'absent'), path.join(f.stateDir, file));
  assert.equal((await f.read()).code, 'PMS_POINTER_UNAVAILABLE');
});

test('supported startup/resume and turn callers carry current task context; CLI cannot choose another session', async (t) => {
  const f = fixture(t); await f.select();
  const run = (script, input, extra = []) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, script), ...extra], { env: f.env, input: JSON.stringify(input), encoding: 'utf8', timeout: 12000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const start = run('jarvos-session-start-hook.js', { hook_event_name: 'SessionStart', session_id: A, source: 'resume' });
  assert.match(start.hookSpecificOutput.additionalContext, /Selected canonical Plan task/);
  assert.match(start.hookSpecificOutput.additionalContext, /Read A/);
  f.change('Next: Read A', 'Next: Refreshed task');
  const turn = run('jarvos-session-turn-hook.js', { hook_event_name: 'UserPromptSubmit', session_id: A });
  assert.match(turn.hookSpecificOutput.additionalContext, /Refreshed task/);
  const alongside = run('plan-task-continuity.js', { hook_event_name: 'UserPromptSubmit', session_id: A, prompt: 'x'.repeat(20_000) }, ['hook']);
  assert.match(alongside.hookSpecificOutput.additionalContext, /Refreshed task/);
  assert.deepEqual(run('plan-task-continuity.js', { hook_event_name: 'SessionStart', session_id: A, source: 'compact' }, ['hook']), {});
  const attack = spawnSync(process.execPath, [path.join(__dirname, 'plan-task-continuity.js'), 'read'], {
    env: f.env, input: JSON.stringify({ sessionId: B, directory: f.directory }), encoding: 'utf8',
  });
  assert.notEqual(attack.status, 0); assert.match(attack.stdout, /PMS_POINTER_INPUT_UNAVAILABLE/);
});
