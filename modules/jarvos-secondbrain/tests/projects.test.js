const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const projectModule = require('../packages/jarvos-secondbrain-projects/src/projects.js');

function fakeOwnedMutation({ filePath, expectedContent, nextContent }) {
  if (expectedContent !== undefined && fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') !== expectedContent) return { status: 'conflict' };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return { status: 'committed' };
}

const projects = {
  ...projectModule,
  createProject: (input) => projectModule.createProject({ ...input, createMarkdownFile: fakeOwnedMutation }),
  writeIndex: (input) => projectModule.writeIndex({
    ...input,
    createMarkdownFile: fakeOwnedMutation,
    applyMarkdownMutation: fakeOwnedMutation,
  }),
};

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

test('project Markdown writes fail closed and preserve concurrent index edits', () => {
  const dir = tmpDir();
  assert.throws(() => projectModule.createProject({ title: 'No Owner', dir }), /Obsidian-owned/);
  assert.equal(fs.existsSync(path.join(dir, 'No Owner.md')), false);

  write(dir, 'Good.md', completePage('Good'));
  const indexPath = write(dir, 'index.md', '# mobile index edit\n');
  assert.throws(() => projectModule.writeIndex({
    dir,
    applyMarkdownMutation: () => ({ status: 'conflict' }),
  }), /conflict/);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), '# mobile index edit\n');
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

test('journalProjectLines delegates touched-only rendering to canonical note mappings', () => {
  const list = [
    { id: 'prj_000001', kind: 'project', title: 'A', lifecycle: 'active' },
    { id: 'prj_000002', kind: 'project', title: 'P', lifecycle: 'paused' },
    { id: 'prj_000003', kind: 'project', title: 'D', lifecycle: 'archived' },
  ];
  const lines = projects.journalProjectLines(list, projects.loadConfig(), {
    date: '2026-08-08',
    timeZone: 'UTC',
    activities: [
      { canonicalId: 'prj_000001', occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified' },
      { canonicalId: 'prj_000003', occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified' },
    ],
    noteMappings: {
      prj_000001: { target: 'Projects/A' },
      prj_000003: { target: 'Projects/D' },
    },
  });
  assert.equal(lines, '- [[Projects/A]]\n- [[Projects/D]]');
  assert.ok(!lines.includes('[[P]]'));
});

test('journalProjectLines says so when there is no accepted touch', () => {
  const dir = tmpDir();
  write(dir, 'D.md', completePage('D', 'done'));
  assert.equal(projects.journalProjectLines(projects.listProjects({ dir })), '- No projects touched today');
  assert.equal(projects.journalProjectLines([]), '- No projects touched today');
});

test('journalProjectLines caps mapped touched projects and says how many were held back', () => {
  const config = { ...projects.loadConfig() };
  config.journal = { ...config.journal, maxItems: 2 };
  const list = ['A', 'B', 'C', 'D'].map((title, index) => ({
    id: `prj_00000${index + 1}`, kind: 'project', title, lifecycle: 'active',
  }));

  const lines = projects.journalProjectLines(list, config, {
    date: '2026-08-08',
    timeZone: 'UTC',
    activities: list.map((project) => ({
      canonicalId: project.id, occurredAt: '2026-08-08T11:00:00.000Z', trust: 'verified',
    })),
    noteMappings: Object.fromEntries(list.map((project) => [project.id, { target: `Projects/${project.title}` }])),
  });
  assert.equal(lines, '- [[Projects/A]]\n- [[Projects/B]]\n- _...and 2 more_');
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
  assert.equal(projects.journalProjectLines(projects.readProjectsDir({ dir })), '- No projects touched today');
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

/**
 * `bridge/config` is a DIRECTORY whose index requires several further modules,
 * so a broken or partial install raises MODULE_NOT_FOUND for a NESTED module
 * with the same `err.code` as a genuinely absent bridge. Wrapping the whole
 * `require` therefore still swallowed a real fault and returned a $HOME path --
 * the exact silent fallback the guard fix exists to close.
 *
 * Runs in a CHILD PROCESS on purpose. In-process, earlier tests in this file
 * have already loaded the bridge, and clearing `require.cache` by hand proved
 * unreliable -- the first version of this test passed against the broken
 * implementation, which is worse than no test. A fresh process has no cache to
 * contaminate, and it is exactly how the behaviour was confirmed by hand.
 */
test('a nested MODULE_NOT_FOUND inside the bridge is NOT mistaken for an absent bridge', () => {
  const pkgRoot = path.resolve(__dirname, '..');
  const projectsPath = path.join(pkgRoot, 'packages', 'jarvos-secondbrain-projects', 'src', 'projects.js');
  const bridgeIndex = path.join(pkgRoot, 'bridge', 'config', 'index.js');
  const nestedSpecifier = './src/paperclip';

  // Confirm the shape this test depends on: the bridge index really does load
  // further modules, so a nested resolution failure is possible at all.
  assert.match(fs.readFileSync(bridgeIndex, 'utf8'), /require\('\.\/src\/paperclip'\)/);

  // Simulated INSIDE the child via a module hook rather than by renaming the
  // real file: `node --test` runs test files in parallel, and briefly deleting
  // a shared bridge module made unrelated suites fail. No shared state moves.
  const probe = [
    'const Module = require("module");',
    'const load = Module._load;',
    'Module._load = function (request) {',
    '  if (request === ' + JSON.stringify(nestedSpecifier) + ') {',
    '    const err = new Error("Cannot find module " + ' + JSON.stringify(nestedSpecifier) + ');',
    '    err.code = "MODULE_NOT_FOUND";',
    '    throw err;',
    '  }',
    '  return load.apply(this, arguments);',
    '};',
    'const projects = require(' + JSON.stringify(projectsPath) + ');',
    'try { console.log("RETURNED:" + projects.resolveProjectsDir()); }',
    'catch (err) { console.log("THREW:" + String(err && err.message).slice(0, 120)); }',
  ].join(String.fromCharCode(10));

  const stdout = cp.execFileSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, JARVOS_PROJECTS_DIR: '' },
  });

  // Assert the NESTED failure specifically. An earlier version pinned
  // JARVOS_REQUIRE_CANONICAL_VAULT/JARVOS_VAULT_DIR so the vault guard threw
  // anyway -- meaning the test stayed green even when the hook stopped
  // intercepting, i.e. it would have testified to nothing. That guard path is
  // already covered by its own test above; this one must fail if the nested
  // require failure ever gets swallowed again.
  assert.match(
    stdout,
    /^THREW:Cannot find module \.\/src\/paperclip/m,
    `expected the nested module failure to propagate, got: ${stdout.trim()}`,
  );
  assert.doesNotMatch(stdout, /RETURNED:/, 'a broken bridge must not yield a projects directory');
});

/**
 * "Absent" must mean the bridge DIRECTORY is missing. A bridge that is present
 * but whose entry point will not resolve -- index.js missing from a partial
 * checkout, a package.json `main` pointing nowhere -- is a BROKEN install, and
 * `require.resolve` reports it with the same MODULE_NOT_FOUND. Tolerating that
 * put the silent $HOME fallback straight back.
 */
test('a present-but-unresolvable bridge is a broken install, not an absent one', () => {
  const pkgRoot = path.resolve(__dirname, '..');
  const projectsPath = path.join(pkgRoot, 'packages', 'jarvos-secondbrain-projects', 'src', 'projects.js');
  const bridgeDir = path.join(pkgRoot, 'bridge', 'config');
  assert.ok(fs.existsSync(bridgeDir), `fixture precondition: expected a bridge directory at ${bridgeDir}`);

  // Force resolution of the top-level specifier to fail exactly as a missing
  // index.js does, leaving the directory itself in place.
  const probe = [
    'const Module = require("module");',
    'const resolve = Module._resolveFilename;',
    'Module._resolveFilename = function (request) {',
    '  if (String(request).endsWith("bridge/config")) {',
    '    const err = new Error("Cannot find module " + request);',
    '    err.code = "MODULE_NOT_FOUND";',
    '    throw err;',
    '  }',
    '  return resolve.apply(this, arguments);',
    '};',
    'const projects = require(' + JSON.stringify(projectsPath) + ');',
    'try { console.log("RETURNED:" + projects.resolveProjectsDir()); }',
    'catch (err) { console.log("THREW:" + String(err && err.message).slice(0, 120)); }',
  ].join(String.fromCharCode(10));

  const stdout = cp.execFileSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, JARVOS_PROJECTS_DIR: '' },
  });

  assert.match(stdout, /^THREW:/m, `expected a broken install to throw, got: ${stdout.trim()}`);
  assert.doesNotMatch(stdout, /RETURNED:/, 'a broken install must not yield a $HOME-derived projects directory');
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
