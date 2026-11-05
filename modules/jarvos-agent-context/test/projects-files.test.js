'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse, readProjectsFiles } = require('../src/projects-files.js');
const { callTool, setMcpProjectsContextProvider, TOOLS } = require('../scripts/jarvos-mcp.js');

const BODY = `
# Notes Editor

## Goal
Keep notes editable.

## Definition of Done
- [x] Saved — evidence: PR #31
- [X] Restored — evidence: PR #32
- [ ] Searchable

## Plan
- [x] Shipped
- [ ] Next step (in progress: Codex, 10-28)
- Then: later stuff
- [ ] Second step
- [ ] Third step
- [ ] Fourth step

## Log
- 2026-10-28 Codex: shipped autosave prototype.
- 2026-10-27 Codex: started.
`;

function source({ id = 'prj_000123', title = 'Notes Editor', updated = '2026-10-28', extra = '', body = BODY } = {}) {
  return `---\ntype: project\nid: ${id}\ntitle: ${JSON.stringify(title)}\nparent: jarvOS Desktop # parent title\nstatus: active # current\ncreated: 2026-10-28\nupdated: ${updated}\nsessions: ["abc", "def # ghi"] # sessions\n${extra}---\n${body}`;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-projects-files-'));
  const dir = path.join(root, 'projects');
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, write: (file, text) => fs.writeFileSync(path.join(dir, file), text) };
}

function env(t, directory) {
  const previous = process.env.JARVOS_PROJECTS_DIR;
  if (directory === undefined) delete process.env.JARVOS_PROJECTS_DIR;
  else process.env.JARVOS_PROJECTS_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.JARVOS_PROJECTS_DIR;
    else process.env.JARVOS_PROJECTS_DIR = previous;
    setMcpProjectsContextProvider(null);
  });
}

async function call(args = {}) {
  const result = await callTool('jarvos_projects_context', args);
  return JSON.parse(result.content[0].text);
}

test('orientation skips reserved/non-project/malformed files and marks private projects', async (t) => {
  const { dir, write } = fixture(t);
  write('README.md', '---\ntype: project-contract\n---\nContract');
  write('index.md', source({ title: 'Index is not a project' }));
  write('note.md', '---\ntype: note\n---\nNot a project');
  write('broken.md', '---\ntype: project\ntitle: "unterminated\n---\n');
  write('editor.md', source({ extra: 'private: true # included\n' }));
  write('ignored.txt', source());
  const packet = await readProjectsFiles(dir);
  assert.equal(packet.ok, true);
  assert.equal(packet.status, 'ok');
  assert.equal(packet.contract, 'jarvos.projects-files/v1');
  assert.equal(packet.source, 'project-files');
  assert.ok(Number.isFinite(Date.parse(packet.capturedAt)));
  assert.equal(packet.count, 1);
  assert.deepEqual(packet.projects, [{
    id: 'prj_000123', title: 'Notes Editor', parent: 'jarvOS Desktop', status: 'active', private: true,
    updated: '2026-10-28', goal: 'Keep notes editable.', done: { checked: 2, total: 3 },
    nextSteps: ['Next step (in progress: Codex, 10-28)', 'Second step', 'Third step'],
    lastLog: '2026-10-28 Codex: shipped autosave prototype.',
  }]);
  assert.deepEqual(packet.skipped.map((item) => item.file).sort(), ['README.md', 'broken.md', 'index.md', 'note.md'].sort());
  assert.ok(packet.skipped.every((item) => item.reason.length > 0 && item.reason.length < 80));
});

test('ported parser preserves quotes, comments, custom fields and CRLF body', () => {
  const text = source({ title: 'Notes "Editor" # one', extra: "owner: 'O''Brien # owner' # comment\nprivate: 'true'\n" }).replace(/\n/g, '\r\n');
  const record = parse(text);
  assert.equal(record.title, 'Notes "Editor" # one');
  assert.equal(record.owner, "O'Brien # owner");
  assert.equal(record.type, 'project');
  assert.equal(record.private, true);
  assert.deepEqual(record.sessions, ['abc', 'def # ghi']);
  assert.equal(record.body, BODY.replace(/\n/g, '\r\n'));
  for (const invalid of [
    'no frontmatter', source({ extra: 'id: duplicate\n' }), source({ updated: '2026-02-30' }),
    source({ updated: '2026-99-99' }), source().replace('["abc", "def # ghi"]', '["unterminated]'),
    source().replace('["abc", "def # ghi"]', 'null'),
    source().replace('status: active', 'status: unknown'), source({ extra: "owner: 'bad\n" }),
  ]) assert.throws(() => parse(invalid));
});

test('orientation sorts updated descending then title and bounds goal/log text', async (t) => {
  const { dir, write } = fixture(t);
  const body = `## Goal\n${'g'.repeat(500)}\n## Log\n- ${'l'.repeat(400)}\n`;
  for (const [id, title, updated] of [['1', 'Old', '2026-10-28'], ['2', 'Zebra', '2026-10-30'], ['3', 'Alpha', '2026-10-30']]) {
    write(`${id}.md`, source({ id, title, updated, body }));
  }
  const packet = await readProjectsFiles(dir);
  assert.deepEqual(packet.projects.map((record) => record.title), ['Alpha', 'Zebra', 'Old']);
  assert.equal(packet.projects[0].goal, `${'g'.repeat(399)}…`);
  assert.equal(packet.projects[0].lastLog, `${'l'.repeat(299)}…`);
  assert.equal(packet.projects[0].private, false);
});

test('checkbox and Log summaries ignore fenced examples and other sections', async (t) => {
  const { dir, write } = fixture(t);
  write('project.md', source({ body: '## Definition of Done\n```md\n- [x] example\n```\n- [ ] actual\n## Plan\n~~~md\n- [ ] example\n~~~\n- [ ] actual\n## Log\n```md\n- example\n```\n- actual\n# Other\n- [x] unrelated\n' }));
  const [record] = (await readProjectsFiles(dir)).projects;
  assert.deepEqual(record.done, { checked: 0, total: 1 });
  assert.deepEqual(record.nextSteps, ['actual']);
  assert.equal(record.lastLog, 'actual');
});

test('full record matches id before title, matches title case-insensitively, and preserves body', async (t) => {
  const { dir, write } = fixture(t);
  write('a.md', source({ id: 'another', title: 'prj_000123' }));
  write('z.md', source({ extra: 'private: true\nowner: Codex\n' }));
  for (const project of ['prj_000123', 'nOtEs EdItOr']) {
    const packet = await readProjectsFiles(dir, { project });
    assert.equal(packet.ok, true);
    assert.equal(packet.contract, 'jarvos.projects-files/v1');
    assert.equal(packet.source, 'project-files');
    assert.equal(packet.project.id, 'prj_000123');
    assert.equal(packet.project.title, 'Notes Editor');
    assert.equal(packet.project.owner, undefined);
    assert.equal(packet.project.private, true);
    assert.deepEqual(packet.project.sessions, ['abc', 'def # ghi']);
    assert.equal(packet.project.body, BODY);
    assert.equal(packet.truncated, undefined);
  }
});

test('full record body is capped at 40,000 characters', async (t) => {
  const { dir, write } = fixture(t);
  write('large.md', source({ body: 'x'.repeat(40_001) }));
  const packet = await readProjectsFiles(dir, { project: 'Notes Editor' });
  assert.equal(packet.project.body, 'x'.repeat(40_000));
  assert.equal(packet.truncated, true);
});

test('full record stays under 60KB even with oversized frontmatter', async (t) => {
  const { dir, write } = fixture(t);
  const sessions = JSON.stringify(Array.from({ length: 500 }, (_, i) => `s${i}-${'y'.repeat(300)}`));
  write('big.md', `---\ntype: project\nid: prj_big\ntitle: Big\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nsessions: ${sessions}\nnotes: ${'z'.repeat(100_000)}\n---\n${'é'.repeat(39_000)}`);
  const packet = await readProjectsFiles(dir, { project: 'prj_big' });
  assert.equal(packet.ok, true);
  assert.equal(packet.truncated, true);
  assert.equal(packet.project.notes, undefined);
  assert.equal(packet.project.sessions.length, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(packet), 'utf8') <= 60_000);
});

test('not_found candidate titles are bounded', async (t) => {
  const { dir, write } = fixture(t);
  write('long.md', source({ id: 'prj_long', title: `Needle ${'x'.repeat(100_000)}` }));
  const packet = await readProjectsFiles(dir, { project: 'Needle' });
  assert.equal(packet.status, 'not_found');
  assert.equal(packet.candidates[0].length, 200);
});

test('not_found offers at most five case-insensitive substring candidates', async (t) => {
  const { dir, write } = fixture(t);
  for (let i = 0; i < 7; i++) write(`${i}.md`, source({ id: String(i), title: `Notes ${i}` }));
  assert.deepEqual(await readProjectsFiles(dir, { project: 'NOTE' }), {
    ok: false, status: 'not_found', code: 'PROJECT_NOT_FOUND', candidates: ['Notes 0', 'Notes 1', 'Notes 2', 'Notes 3', 'Notes 4'],
  });
  assert.deepEqual((await readProjectsFiles(dir, { project: 'missing' })).candidates, []);
});

test('reader resolves directory aliases but never follows file symlinks or recurses', async (t) => {
  const { root, dir, write } = fixture(t);
  write('valid.md', source());
  fs.writeFileSync(path.join(root, 'outside.md'), source({ id: 'outside' }));
  fs.symlinkSync(path.join(root, 'outside.md'), path.join(dir, 'escape.md'));
  fs.symlinkSync(path.join(dir, 'valid.md'), path.join(dir, 'inside-link.md'));
  fs.mkdirSync(path.join(dir, 'nested.md'));
  fs.writeFileSync(path.join(dir, 'nested.md', 'child.md'), source({ id: 'nested' }));
  const alias = path.join(root, 'alias');
  fs.symlinkSync(dir, alias);
  const packet = await readProjectsFiles(alias);
  assert.equal(packet.count, 1);
  assert.equal(packet.projects[0].id, 'prj_000123');
  assert.deepEqual(packet.skipped.map((item) => item.file), ['escape.md', 'inside-link.md', 'nested.md']);
});

test('orientation caps projects at 200 without limiting full-record lookup', async (t) => {
  const { dir, write } = fixture(t);
  for (let i = 0; i < 201; i++) write(`${i}.md`, source({ id: String(i), title: `Project ${String(i).padStart(3, '0')}`, body: '' }));
  const packet = await readProjectsFiles(dir);
  assert.equal(packet.count, 200);
  assert.equal(packet.projects.length, 200);
  assert.equal(packet.truncated, true);
  assert.equal((await readProjectsFiles(dir, { project: '200' })).project.id, '200');
});

test('orientation stays under 60KB UTF-8 and drops oldest detail first', async (t) => {
  const { dir, write } = fixture(t);
  for (let i = 0; i < 70; i++) write(`${i}.md`, source({ id: String(i), title: `Project ${String(i).padStart(3, '0')}`, body: `## Goal\n${'界'.repeat(400)}\n## Log\n- ${'界'.repeat(300)}` }));
  const packet = await readProjectsFiles(dir);
  assert.equal(packet.truncated, true);
  assert.equal(packet.count, 70);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 60_000);
  assert.equal(packet.projects[0].goal.length, 400);
  assert.equal(packet.projects.at(-1).goal, undefined);
  assert.equal(packet.projects.at(-1).lastLog, undefined);
});

test('oversized Plan fields and skipped lists cannot defeat orientation budget', async (t) => {
  const { dir, write } = fixture(t);
  write('huge.md', source({ body: `## Plan\n- [ ] ${'x'.repeat(65_000)}` }));
  for (let i = 0; i < 300; i++) write(`${String(i).padStart(3, '0')}-${'x'.repeat(220)}.md`, 'invalid');
  const packet = await readProjectsFiles(dir);
  assert.equal(packet.truncated, true);
  assert.equal(packet.count, packet.projects.length);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 60_000);
});

test('MCP files mode bypasses provider and recent-activity ignores window arguments', async (t) => {
  const { dir, write } = fixture(t);
  write('project.md', source());
  env(t, dir);
  setMcpProjectsContextProvider({ read: async () => { assert.fail('Registry must not be read'); } });
  const orientation = await call();
  const recent = await call({ profile: 'recent-activity', date: 'invalid', timeZone: 'invalid', from: 'invalid', to: 'invalid' });
  assert.equal(orientation.count, 1);
  assert.deepEqual(recent.projects, orientation.projects);
  assert.equal((await call({ project: 'prj_000123' })).project.body, BODY);
  for (const profile of ['session-focus', 'unknown', null]) {
    assert.equal((await call({ profile })).code, 'PROJECTS_QUERY_UNAVAILABLE');
  }
});

test('invalid configured directory returns unavailable with no registry fallback', async (t) => {
  const { dir, write } = fixture(t);
  write('file.md', source());
  env(t, dir);
  let reads = 0;
  setMcpProjectsContextProvider({ read: async () => { reads++; return { status: 'ok' }; } });
  for (const value of ['', '.', 'relative/projects', path.join(dir, 'missing'), path.join(dir, 'file.md')]) {
    process.env.JARVOS_PROJECTS_DIR = value;
    const result = await call();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'PROJECTS_FILES_UNAVAILABLE');
    assert.equal(result.packet, null);
  }
  assert.equal(reads, 0);
});

test('unset directory retains provider path', async (t) => {
  env(t, undefined);
  let reads = 0;
  setMcpProjectsContextProvider({ read: async () => { reads++; return { status: 'unavailable', code: 'TEST_PROVIDER_UNAVAILABLE' }; } });
  const result = await call();
  assert.equal(reads, 1);
  assert.equal(result.status, 'unavailable');
  assert.notEqual(result.code, 'PROJECTS_FILES_UNAVAILABLE');
});

test('project lookup is bounded and single-line in schema and runtime', async (t) => {
  const { dir } = fixture(t);
  env(t, dir);
  const schema = TOOLS.find((tool) => tool.name === 'jarvos_projects_context').inputSchema.properties.project;
  assert.equal(schema.minLength, 1);
  assert.equal(schema.maxLength, 200);
  for (const project of ['', 'x'.repeat(201), 'two\nlines', 'trailing\n', 'trailing\r', 'bad\u0085line', 'bad\u2028line', 42, null]) {
    assert.equal((await call({ project })).code, 'PROJECTS_QUERY_UNAVAILABLE');
  }
  for (const project of ['trailing\n', 'trailing\r', 'bad\u0085line', 'bad\u2028line']) assert.equal(new RegExp(schema.pattern).test(project), false);
});
