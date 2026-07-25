const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projects = require('../packages/jarvos-secondbrain-projects/src/projects.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-projects-'));
}

function write(dir, name, body) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function completePage(title, status = 'active') {
  return [
    '---',
    'type: project',
    `title: ${title}`,
    `status: ${status}`,
    'created: 2026-07-24',
    '---',
    '',
    `# ${title}`,
    '',
    '## Goal',
    'Ship the thing.',
    '',
    '## High-level plan',
    '1. Build it',
    '',
    '## Definition of Done',
    'It is shipped.',
    '',
  ].join('\n');
}

test('createProject writes a page with all three required sections', () => {
  const dir = tmpDir();
  const created = projects.createProject({ title: 'My Project', dir });

  const body = fs.readFileSync(created.path, 'utf8');
  assert.match(body, /^type: project$/m);
  assert.match(body, /^status: active$/m);
  assert.match(body, /^# My Project$/m);
  assert.match(body, /^## Goal$/m);
  assert.match(body, /^## High-level plan$/m);
  assert.match(body, /^## Definition of Done$/m);
});

test('createProject refuses to overwrite an existing project', () => {
  const dir = tmpDir();
  projects.createProject({ title: 'Dup', dir });
  assert.throws(() => projects.createProject({ title: 'Dup', dir }), /already exists/);
});

test('createProject rejects a blank title', () => {
  const dir = tmpDir();
  assert.throws(() => projects.createProject({ title: '   ', dir }), /needs a title/);
});

test('slugify strips path separators so a title cannot escape the directory', () => {
  assert.equal(projects.slugify('a/b'), 'ab');
  assert.equal(projects.slugify('../etc/passwd'), '..etcpasswd');
  assert.equal(projects.slugify('  spaced   out  '), 'spaced out');
});

test('a fresh project reports every section missing, a filled one reports none', () => {
  const dir = tmpDir();
  const created = projects.createProject({ title: 'Fresh', dir });
  const fresh = projects.readProject(created.path);
  assert.deepEqual(fresh.missingSections, ['goal', 'plan', 'definition-of-done']);
  assert.equal(fresh.complete, false);

  const filled = projects.readProject(write(dir, 'Filled.md', completePage('Filled')));
  assert.deepEqual(filled.missingSections, []);
  assert.equal(filled.complete, true);
});

test('a section containing only the template dash does not count as filled', () => {
  assert.equal(projects.isFilled('-'), false);
  assert.equal(projects.isFilled('  \n - \n'), false);
  assert.equal(projects.isFilled('real content'), true);
});

test('listProjects skips the generated index and sorts by title', () => {
  const dir = tmpDir();
  write(dir, 'index.md', '# Projects\n');
  write(dir, 'Zeta.md', completePage('Zeta'));
  write(dir, 'Alpha.md', completePage('Alpha'));

  const list = projects.listProjects({ dir });
  assert.deepEqual(list.map((p) => p.title), ['Alpha', 'Zeta']);
});

test('listProjects ignores non-markdown files and survives an unreadable directory', () => {
  const dir = tmpDir();
  write(dir, 'notes.txt', 'not a project');
  write(dir, 'Real.md', completePage('Real'));
  assert.deepEqual(projects.listProjects({ dir }).map((p) => p.title), ['Real']);

  assert.deepEqual(projects.listProjects({ dir: path.join(dir, 'missing') }), []);
});

test('paused projects are ongoing; done and abandoned are not', () => {
  const dir = tmpDir();
  write(dir, 'A.md', completePage('A', 'active'));
  write(dir, 'P.md', completePage('P', 'paused'));
  write(dir, 'D.md', completePage('D', 'done'));
  write(dir, 'X.md', completePage('X', 'abandoned'));

  const list = projects.listProjects({ dir });
  const ongoing = list.filter((p) => projects.isOngoing(p)).map((p) => p.title);
  assert.deepEqual(ongoing.sort(), ['A', 'P']);
});

test('journalProjectLines emits wiki-links for ongoing projects only', () => {
  const dir = tmpDir();
  write(dir, 'A.md', completePage('A', 'active'));
  write(dir, 'P.md', completePage('P', 'paused'));
  write(dir, 'D.md', completePage('D', 'done'));

  const lines = projects.journalProjectLines(projects.listProjects({ dir }));
  assert.equal(lines, '- [[A]]\n- [[P]]');
  assert.ok(!lines.includes('[[D]]'));
});

test('journalProjectLines says so when there is nothing ongoing', () => {
  const dir = tmpDir();
  write(dir, 'D.md', completePage('D', 'done'));
  assert.equal(projects.journalProjectLines(projects.listProjects({ dir })), '- No ongoing projects');
  assert.equal(projects.journalProjectLines([]), '- No ongoing projects');
});

test('journalProjectLines caps the list and says how many were held back', () => {
  const config = { ...projects.loadConfig() };
  config.journal = { ...config.journal, maxItems: 2 };
  const list = ['A', 'B', 'C', 'D'].map((title) => ({ title, status: 'active' }));

  const lines = projects.journalProjectLines(list, config);
  assert.equal(lines, '- [[A]]\n- [[B]]\n- _...and 2 more_');
});

test('checkProjects reports only ongoing projects that are missing sections', () => {
  const dir = tmpDir();
  projects.createProject({ title: 'Empty Active', dir });
  write(dir, 'Good.md', completePage('Good'));
  write(dir, 'Old.md', [
    '---',
    'type: project',
    'title: Old',
    'status: done',
    '---',
    '',
    '# Old',
    '',
    '## Goal',
    '-',
    '',
  ].join('\n'));

  const result = projects.checkProjects({ dir });
  assert.equal(result.ok, false);
  assert.equal(result.checked, 3);
  assert.deepEqual(result.issues.map((i) => i.title), ['Empty Active']);
  assert.deepEqual(result.issues[0].missing, ['goal', 'plan', 'definition-of-done']);
});

test('checkProjects passes when every ongoing project is complete', () => {
  const dir = tmpDir();
  write(dir, 'Good.md', completePage('Good'));
  const result = projects.checkProjects({ dir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('the index separates ongoing from closed and flags incomplete pages', () => {
  const dir = tmpDir();
  projects.createProject({ title: 'Thin', dir });
  write(dir, 'Good.md', completePage('Good'));
  write(dir, 'Done.md', completePage('Done', 'done'));

  const written = projects.writeIndex({ dir });
  const body = fs.readFileSync(written.path, 'utf8');

  assert.equal(written.count, 3);
  assert.match(body, /## Ongoing/);
  assert.match(body, /## Closed/);
  assert.match(body, /- \[\[Thin\]\] \(active\) — _missing: goal, plan, definition-of-done_/);
  assert.match(body, /- \[\[Good\]\] \(active\)$/m);
  assert.match(body, /- \[\[Done\]\] \(done\)/);
});

test('the index omits the Closed heading when nothing is closed', () => {
  const dir = tmpDir();
  write(dir, 'Good.md', completePage('Good'));
  const body = fs.readFileSync(projects.writeIndex({ dir }).path, 'utf8');
  assert.ok(!body.includes('## Closed'));
});

test('writeIndex does not list the index it just wrote', () => {
  const dir = tmpDir();
  write(dir, 'Good.md', completePage('Good'));
  projects.writeIndex({ dir });
  const second = projects.writeIndex({ dir });
  assert.equal(second.count, 1);
});

test('a project title falls back to the filename when frontmatter has none', () => {
  const dir = tmpDir();
  write(dir, 'Untitled Thing.md', '## Goal\nSomething.\n');
  const [project] = projects.listProjects({ dir });
  assert.equal(project.title, 'Untitled Thing');
  assert.equal(project.status, 'active');
});

test('CRLF files parse the same as LF files', () => {
  const dir = tmpDir();
  write(dir, 'Windows.md', completePage('Windows').replace(/\n/g, '\r\n'));

  const [project] = projects.listProjects({ dir });
  assert.equal(project.title, 'Windows');
  assert.equal(project.status, 'active');
  assert.deepEqual(project.missingSections, []);
});

test('a duplicated heading keeps the content of the first occurrence', () => {
  const dir = tmpDir();
  write(dir, 'Dupe.md', [
    '---',
    'type: project',
    'title: Dupe',
    'status: active',
    '---',
    '',
    '# Dupe',
    '',
    '## Goal',
    'The real goal.',
    '',
    '## High-level plan',
    'Step one.',
    '',
    '## Definition of Done',
    'Shipped.',
    '',
    '## Goal',
    '-',
    '',
  ].join('\n'));

  const [project] = projects.listProjects({ dir });
  // Last-wins would see an empty second "## Goal" and call the project incomplete.
  assert.deepEqual(project.missingSections, []);
  assert.match(project.sections.goal, /The real goal\./);
});

test('JARVOS_PROJECTS_DIR wins over the configured directory', () => {
  const dir = tmpDir();
  const resolved = projects.resolveProjectsDir(
    { vault: { projectsDir: '/should/not/win' } },
    { env: { JARVOS_PROJECTS_DIR: dir } },
  );
  assert.equal(resolved, dir);
});

test('an unreadable projects directory is not reported as "no projects"', () => {
  // An unmounted vault or a mistyped JARVOS_PROJECTS_DIR must not render as a
  // confident empty list. The Projects section renders on every date, so a
  // positive "no ongoing projects" would overwrite it everywhere; the
  // unavailable marker is what the journal treats as a degraded source.
  assert.equal(projects.readProjectsDir({ dir: '/definitely/not/a/directory' }), null);
  assert.equal(
    projects.journalProjectLines(projects.readProjectsDir({ dir: '/definitely/not/a/directory' })),
    '- (projects unavailable)',
  );
});

test('a genuinely empty projects directory still reports no projects', () => {
  const dir = tmpDir();
  assert.deepEqual(projects.readProjectsDir({ dir }), []);
  assert.equal(projects.journalProjectLines(projects.readProjectsDir({ dir })), '- No ongoing projects');
});

test('listProjects still flattens an unreadable directory to an empty list', () => {
  assert.deepEqual(projects.listProjects({ dir: '/definitely/not/a/directory' }), []);
});

test('creating a project cannot collide with the generated index', () => {
  const dir = tmpDir();
  // Would otherwise write Index.md and then be overwritten by writeIndex() on a
  // case-insensitive filesystem, silently discarding the page just created.
  assert.throws(() => projects.createProject({ title: 'Index', dir }), /collides with the generated index/);
  assert.throws(() => projects.createProject({ title: 'index', dir }), /collides with the generated index/);
  assert.deepEqual(projects.listProjects({ dir }), []);
});

/**
 * The shared-config bridge throws deliberately when the resolved vault is stale
 * or outside JARVOS_REQUIRE_CANONICAL_VAULT. tryResolveSharedConfig() used to
 * catch everything and return null, so resolveProjectsDir() dropped through to
 * $HOME/Vaults/Vault v3/Projects -- turning a fail-closed guard into a silent
 * write into a dead vault. Nothing asserted this, which is why it shipped.
 */
test('a fail-closed vault guard rejection is not swallowed into a $HOME fallback', () => {
  const saved = {
    required: process.env.JARVOS_REQUIRE_CANONICAL_VAULT,
    vault: process.env.JARVOS_VAULT_DIR,
    projects: process.env.JARVOS_PROJECTS_DIR,
  };
  try {
    // JARVOS_PROJECTS_DIR would short-circuit before the bridge is consulted.
    delete process.env.JARVOS_PROJECTS_DIR;
    process.env.JARVOS_REQUIRE_CANONICAL_VAULT = path.join(os.tmpdir(), 'required-canonical-vault');
    process.env.JARVOS_VAULT_DIR = path.join(os.tmpdir(), 'somewhere-else-entirely');

    assert.throws(
      () => projects.resolveProjectsDir(),
      /outside the required canonical vault/,
      'the guard must propagate rather than resolving to a $HOME-derived path',
    );
  } finally {
    for (const [key, value] of [
      ['JARVOS_REQUIRE_CANONICAL_VAULT', saved.required],
      ['JARVOS_VAULT_DIR', saved.vault],
      ['JARVOS_PROJECTS_DIR', saved.projects],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('an absent bridge is still tolerated and falls back', () => {
  // The other half of the contract: a standalone install with no bridge must
  // keep working. Only MODULE_NOT_FOUND is swallowed.
  const saved = process.env.JARVOS_PROJECTS_DIR;
  try {
    process.env.JARVOS_PROJECTS_DIR = path.join(os.tmpdir(), 'explicit-projects-dir');
    assert.equal(projects.resolveProjectsDir(), path.join(os.tmpdir(), 'explicit-projects-dir'));
  } finally {
    if (saved === undefined) delete process.env.JARVOS_PROJECTS_DIR;
    else process.env.JARVOS_PROJECTS_DIR = saved;
  }
});
