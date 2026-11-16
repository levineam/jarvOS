'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readProjectsFiles, STALL_AFTER_DAYS } = require('../src/projects-files');
const { renderProjectsContextMarkdown } = require('../src');
const { callTool } = require('../scripts/jarvos-mcp');

function fixture(t, plan, log = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-stalled-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'project.md'), `---
type: project
id: prj_stall
title: Stalled project
status: active
created: 2026-10-28
updated: 2026-11-16
---
## Plan
${plan}
## Log
${log}
`);
  return directory;
}

const NOW = '2026-11-16T12:00:00Z';
const read = (directory, options = {}) => readProjectsFiles(directory, { now: NOW, ...options });

test('only open tracked steps stall; owner, in-progress and release markers work in text and details', async (t) => {
  const directory = fixture(t, `- [ ] Ordinary unclaimed step 2026-10-29
- [x] Completed step Owner: Pat 2026-10-29
- [ ] Inline task Owner: Alice
- [ ] Detailed task
	Owner: Bob
    Updated: 2026-11-14
- [ ] Progress task (in progress: Codex, 11-13)
- [ ] Progress detail task
  (in progress: Claude, 2026-11-14)
- [ ] Queue task for the NEXT INSTALL
- [ ] Next-release task
  next release
- [ ] Promotion task
  FOR THE NEXT PROMOTION
- [ ] Release task for the next release
- [ ] Install task
  next install
- [ ] Future task Owner: Future 2026-11-17
## Backlog
- [ ] Ignored backlog Owner: Nobody`);
  const packet = await read(directory);
  assert.equal(STALL_AFTER_DAYS, 1);
  assert.equal(packet.summary.stalled, 9);
  const stalled = packet.projects[0].stalled;
  assert.deepEqual(stalled.slice(0, 4), [
    { step: 'Inline task Owner: Alice', owner: 'Alice', lastUpdate: '2026-10-28', days: 19 },
    { step: 'Detailed task', owner: 'Bob', lastUpdate: '2026-11-14', days: 2 },
    { step: 'Progress task (in progress: Codex, 11-13)', owner: 'Codex', lastUpdate: '2026-11-13', days: 3 },
    { step: 'Progress detail task', owner: 'Claude', lastUpdate: '2026-11-14', days: 2 },
  ]);
  assert.equal(stalled[4].owner, undefined);
});

test('Log mentions use five normalized words after Andrew; newest matching update wins without prefix-word matches', async (t) => {
  const directory = fixture(t, `- [ ] Andrew: Ship the new desktop app (in progress: Codex, 11-01)
  Update: 2026-11-10`, `- 2026-11-12 Codex: SHIP, the new desktop APP — built.
- 2026-11-11 Codex: Ship the new desktop app tested.
- 2026-11-16 Codex: Ship the new desktop apple; unrelated.
- 2026-11-15 Other work
  Ship the new desktop app verified.`);
  const packet = await read(directory);
  assert.deepEqual(packet.projects[0].stalled, [{
    step: 'Andrew: Ship the new desktop app (in progress: Codex, 11-01)',
    owner: 'Codex', lastUpdate: '2026-11-15', days: 1,
  }]);
});

test('Blocked text and indented fields exclude tasks; fenced examples do not track or update tasks', async (t) => {
  const directory = fixture(t, `- [ ] Blocked: approval Owner: Alice
- [ ] Waiting (in progress: Bob, 11-01)
  Blocked: a dependency
- [ ] Real step with five words
  Owner: Codex
  Updated: 2026-11-13
\`\`\`md
- [ ] Fake step Owner: Nobody
\`\`\``, `\`\`\`md
- 2026-11-16 Real step with five words
\`\`\``);
  assert.deepEqual((await read(directory)).projects[0].stalled, [{
    step: 'Real step with five words', owner: 'Codex', lastUpdate: '2026-11-13', days: 3,
  }]);
});

test('created fallback ignores project updated; threshold uses elapsed 24 hours and accepts an override', async (t) => {
  const directory = fixture(t, '- [ ] Ship next install');
  assert.deepEqual((await read(directory)).projects[0].stalled, [{ step: 'Ship next install', lastUpdate: '2026-10-28', days: 19 }]);
  assert.equal((await read(directory, { now: '2026-10-28T23:59:59.999Z' })).summary.stalled, 0);
  assert.equal((await read(directory, { now: '2026-10-29T00:00:00Z' })).summary.stalled, 1);
  assert.equal((await read(directory, { stallAfterDays: 20 })).summary.stalled, 0);
  assert.equal((await read(directory, { stallAfterDays: 19.5 })).summary.stalled, 1);
  assert.equal((await read(directory, { project: 'prj_stall' })).project.stalled.length, 1);
  await assert.rejects(read(directory, { stallAfterDays: -1 }), /Invalid stalled-step options/);
});

test('short in-progress dates resolve to the most recent past year, including leap days', async (t) => {
  const directory = fixture(t, `- [ ] Year rollover (in progress: Alice, 12-31)
- [ ] Leap day (in progress: Bob, 02-29)
- [ ] Invalid date (in progress: Carl, 02-30)`);
  const stalled = (await read(directory, { now: '2026-01-02T00:00:00Z' })).projects[0].stalled;
  assert.equal(stalled[0].lastUpdate, '2025-12-31');
  assert.equal(stalled[1].lastUpdate, '2024-02-29');
  assert.equal(stalled.length, 2);
});

test('MCP and bounded context rendering expose stalled steps with optional owners', async (t) => {
  const directory = fixture(t, `- [ ] Ship the next install
- [ ] Review results
  Owner: Codex`);
  const previous = process.env.JARVOS_PROJECTS_DIR;
  process.env.JARVOS_PROJECTS_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.JARVOS_PROJECTS_DIR;
    else process.env.JARVOS_PROJECTS_DIR = previous;
  });
  const result = JSON.parse((await callTool('jarvos_projects_context', {})).content[0].text);
  assert.equal(result.contract, 'jarvos.projects-files/v1');
  assert.equal(result.summary.stalled, 2);
  const packet = await read(directory);
  const markdown = renderProjectsContextMarkdown(packet, 2000);
  assert.match(markdown, /Stalled 19 days: Ship the next install/);
  assert.match(markdown, /Stalled 19 days: Review results \(owner: Codex\)/);
  assert.ok(renderProjectsContextMarkdown(packet, 700).length <= 700);
});


test('all short progress dates participate and an empty Owner line still tracks the step', async (t) => {
  const directory = fixture(t, `- [ ] Update all progress notes (in progress: Alice, 11-01)
  (in progress: Bob, 11-15)
- [ ] Empty owner task
  Owner:`);
  const stalled = (await read(directory)).projects[0].stalled;
  assert.equal(stalled[0].lastUpdate, '2026-11-15');
  assert.deepEqual(stalled[1], { step: 'Empty owner task', lastUpdate: '2026-10-28', days: 19 });
});

test('large stalled arrays respect orientation and full-record byte limits', async (t) => {
  const directory = fixture(t, Array.from({ length: 100 }, (_, i) => `- [ ] ${i} ${'x'.repeat(1000)} next install`).join('\n'));
  for (const options of [{}, { project: 'prj_stall' }]) {
    const packet = await read(directory, options);
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 60_000);
    assert.equal(packet.truncated, true);
    if (packet.projects) assert.equal(packet.summary.stalled, packet.projects.reduce((sum, item) => sum + item.stalled.length, 0));
  }
});
