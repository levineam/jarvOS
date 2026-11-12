'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'runtimes/claude/jarvos-coordinator-guard-hook.js');
const { evaluate, realPath, stripHeredocs } = require(SCRIPT);
const HOME = '/home/example';
const SESSION = '00000000-test-coordinator';
const options = { home: HOME, tmpdir: '/synthetic-temp', uid: 501, config: { allowWrite: ['/records', '~/state'] } };
const coordinator = { HOME, JARVOS_COORDINATOR: '1' };
const input = (tool_name, tool_input) => ({ session_id: SESSION, cwd: '/product', hook_event_name: 'PreToolUse', tool_name, tool_input });
const bash = (command, env = coordinator, overrides = {}) => evaluate(input('Bash', { command }), env, { ...options, ...overrides });
const isDenied = (result) => {
  assert.equal(result?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /sessions:/);
  assert.ok(result.hookSpecificOutput.permissionDecisionReason.length <= 900);
};
function temporary(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-coordinator-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function childEnv(home, extra = {}) {
  return { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, ...extra };
}
function invoke(home, args = [], stdin = '', extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: childEnv(home, extra), input: stdin, encoding: 'utf8' });
}
function silent(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

for (const value of ['1', 'true', 'yes']) {
  test(`coordinator env ${value} denies product edits`, () => isDenied(evaluate(input('Edit', { file_path: '/product/x.js' }), { ...coordinator, JARVOS_COORDINATOR: value }, options)));
}
test('config session marks a coordinator and ignores other sessions', () => {
  const config = { ...options.config, coordinatorSessions: [SESSION] };
  isDenied(bash('npm test', {}, { config }));
  assert.equal(bash('npm test', {}, { config: { ...config, coordinatorSessions: ['00000000-test-other'] } }), null);
});
test('invalid config shape uses empty config without disabling env marking', () => {
  for (const config of [[], null, { allowWrite: '/records' }, { allowGit: [null] }, { coordinatorSessions: [123] }]) {
    isDenied(bash('npm test', coordinator, { config }));
    isDenied(evaluate(input('Edit', { file_path: '/product/f' }), coordinator, { ...options, config }));
    assert.equal(bash('npm test', {}, { config }), null);
  }
});
test('non-coordinators never parse commands or probe paths', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    assert.equal(evaluate(input(tool, { file_path: '/product/x', command: 'git push; npm test' }), {}, { ...options, realpath: () => { throw new Error('Must not probe'); } }), null);
  }
});
for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
  test(`${tool} respects relative paths and allowlist boundaries`, () => {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    assert.equal(evaluate(input(tool, { [key]: '../records/plan.md' }), coordinator, options), null);
    assert.equal(evaluate(input(tool, { [key]: '~/state/plan.md' }), coordinator, options), null);
    isDenied(evaluate(input(tool, { [key]: './x.js' }), coordinator, options));
    isDenied(evaluate(input(tool, { [key]: '/records-other/x' }), coordinator, options));
  });
}
test('default write directories and projects env are allowed', () => {
  for (const file of ['~/.claude/plans/a', '~/.claude/projects/a', '/tmp/claude-501/a', '/private/tmp/claude-501/s/a', '/synthetic-temp/a']) {
    assert.equal(evaluate(input('Edit', { file_path: file }), coordinator, options), null, file);
  }
  assert.equal(bash('git -C /env-records commit -m ok', { ...coordinator, JARVOS_PROJECTS_DIR: '/env-records' }), null);
  assert.equal(evaluate(input('Edit', { file_path: '/env-records/a' }), { ...coordinator, JARVOS_PROJECTS_DIR: '/env-records' }, options), null);
  isDenied(bash('git -C /tmp commit -m nope'));
});
test('canonical paths allow aliases and reject symlink escapes', (t) => {
  const dir = temporary(t), link = path.join(dir, 'product-link');
  fs.symlinkSync(ROOT, link, 'dir');
  // Existing and not-yet-created files under a symlink out of the allowed temp tree.
  for (const file of [path.join(link, 'package.json'), path.join(link, 'new-file.js')]) {
    isDenied(evaluate(input('Edit', { file_path: file }), coordinator, { ...options, realpath: realPath }));
  }
  const records = path.join(dir, 'records'), alias = path.join(dir, 'alias');
  fs.mkdirSync(records); fs.symlinkSync(records, alias, 'dir');
  assert.equal(bash(`git -C '${alias}' commit`, coordinator, { config: { allowGit: [records] }, realpath: realPath }), null);
  assert.equal(realPath(path.join(alias, 'new', 'file')), path.join(records, 'new', 'file'));
});
test('explicit allowGit overrides allowWrite fallback', () => {
  isDenied(bash('git -C /records commit', coordinator, { config: { allowWrite: ['/records'], allowGit: [] } }));
});

const deniedCommands = [
  'git commit -m change', 'git push', 'git merge topic', 'git rebase main', 'git cherry-pick abc', 'git am change.patch', 'git tag v1',
  'cd /product && git push', 'cd /records; cd ../product\ngit commit', 'git -C /records -C ../product -c color.ui=false push',
  'env MODE=test sudo -u example command time nohup git push', 'MODE=test git -c color.ui=false commit',
  'gh pr create', 'gh pr merge 1', 'gh pr ready 1', 'gh release create v1', 'gh workflow run ci',
  'npm run build', 'pnpm test', 'npm test', 'npm t', 'npm publish', 'npm run test:unit', 'yarn deploy', 'bun run build:web',
  'vercel', 'vercel --prod', 'vercel deploy', 'vercel promote x', 'vercel alias x', 'netlify deploy', 'wrangler deploy', 'wrangler publish',
  'fly deploy', 'flyctl deploy', 'firebase deploy', 'railway up', 'npx --yes vercel --prod', 'pnpm dlx netlify deploy', 'bunx wrangler deploy', 'npx vercel@latest --prod',
  'make', 'make clean', 'cargo build', 'cargo test', 'go build', 'go test ./...', 'pytest', 'xcodebuild', 'swift build', 'swift test', 'gradle test', './gradlew test', 'mvn test',
  'echo hi > /product/x.js', 'echo hi >>x.js', 'cat x | tee -a /product/x', "sed -i '' s/a/b/ /product/f", 'sed -i.bak -e s/a/b/ /product/f',
  'perl -pi -e s/a/b/ /product/f', 'perl -i -pe s/a/b/ /product/f', 'git apply change.patch', 'patch -p1 < change.patch',
  "cat > /product/x.js <<'EOF'\ngit push\nEOF", 'echo ok 2>/product/errors', 'echo ok >& /product/x',
  // Command substitution, grouping and background jobs are still inspected.
  `git commit -m "$(cat <<'EOF'\nfeat: change\n\nbody\nEOF\n)"`, 'echo $(git push)', '(git push)', '{ npm test; }',
  'echo `npm run build`', 'npm run build &', 'echo hi > $HOME/product/x',
  // Option values before the script, flag placement, runners via npx, subshell cd scope.
  'npm --prefix apps/desktop run build', 'pnpm --filter desktop build', 'pnpm -r test', 'yarn workspace desktop build',
  'gh --repo example/product pr merge 1', 'gh pr --repo example/product create', 'gh -R example/product release create v1',
  'npx vite build', 'pnpm exec vitest', 'npx jest', 'node --test tests/example.test.js', 'npx playwright test', 'turbo run build', 'nx run app:build',
  '(cd /records && git status); git push', '(cd /records); npm run build && git commit -m x',
  'npm run build-storybook', 'npm run test-e2e', 'pnpm --filter list build', 'npm run build -- install', 'npm run build install', 'pnpm --filter add build',
  'npm exec -- vercel --prod', 'npm exec -- vite build', 'npx --package vite vite build', 'pnpm exec --filter app vitest',
  'npx webpack --mode production', 'npx electron-builder --mac', 'xcodebuild -scheme App build', 'xcodebuild -list build', 'npx jest --help --ci', 'npx webpack --mode production -v', 'pnpm --filter exec exec vite build', 'npx tsc -p tsconfig.json', 'docker build -t app .', 'docker buildx build .', 'docker compose build', 'docker push example/app', 'python3 -m pytest', 'python -m unittest', 'git apply --check --apply p', 'git apply --check --app p', 'echo hi > /tmp/product/x', 'cd /tmp/product-worktree && npm test', 'pnpm build_web', 'git tag -a v1 -m release', 'git tag v1 abc', 'git tag -d v1', 'git tag -l -d v1', 'git tag --color v1',
];
for (const command of deniedCommands) test(`Bash denies ${JSON.stringify(command)}`, () => isDenied(bash(command)));
const allowedCommands = [
  'git -C /records commit -m ok', 'cd /records && git push', 'git -c color.ui=false -C /records commit', 'git -C/records commit',
  'git status', 'git log', 'git diff', 'git fetch', 'git add .', 'git show', 'git worktree list',
  'npm install', 'pnpm install', 'yarn install', 'bun install', 'npm run lint', 'node scripts/example.js', 'codex exec "npm test"',
  'vercel --version', 'vercel whoami', 'vercel ls', 'vercel logs', 'vercel inspect', 'vercel env ls', 'npx vercel whoami',
  'cat f', 'rg test .', 'echo "git push && npm test; make | pytest"', "echo 'git push\nmake'", 'echo hi > /tmp/claude-501/x', 'ls 2>&1', 'echo hi >&2',
  'echo hi > /dev/null', 'echo hi > /dev/stderr', 'echo hi > /dev/stdout', 'echo hi >> /records/log',
  'tee -a /records/log', "sed -i '' s/a/b/ /records/f", 'perl -pi -e s/a/b/ /records/f', 'cd /records && git apply p', 'cd /records && patch < p',
  "cat > /synthetic-temp/x <<'EOF'\ngit push\nEOF", "cat <<'EOF'\nnpm test\n' unbalanced quotes\nEOF\ngit status",
  'cat <<-EOF\n\tgit push\n\tEOF', "cat <<ONE <<'TWO'\nmake\nONE\nnpm test\nTWO",
  `cd /records && git commit -m "$(cat <<'EOF'\nrecords: update\n\ngit push in the body is text\nEOF\n)"`,
  'echo ${HOME}/x', 'ls $HOME', 'echo hi > $HOME/.claude/plans/p.md', 'echo hi > ${HOME}/state/s.md',
  'vercel project list', 'vercel projects ls', 'vercel --scope example-team ls', 'vercel --scope=example-team logs x', 'vercel domains ls',
  'git tag', 'git tag --list', 'git tag -l "v*"', 'git tag --list --contains abc', 'git tag --sort=-v:refname', 'git tag --contains HEAD', 'git tag --points-at HEAD',
  'npm --prefix test run lint', 'pnpm --filter test lint', 'yarn workspace test lint', 'npx webpack --version',
  'xcodebuild -list', 'xcodebuild -showBuildSettings', 'git apply --check /tmp/change.patch', 'git apply --stat /tmp/change.patch', 'docker ps', 'docker compose logs', 'python3 -m json.tool f', 'npx tsc --version', 'npm exec -- eslint .',
  'npm install test-utils', 'pnpm --filter desktop lint', 'npx vite --version', 'turbo run lint', 'node scripts/build-notes.js',
  'cd /product && (cd /records && git commit -m ok)', 'gh pr view 1', 'gh --repo example/product pr list',
];
for (const command of allowedCommands) test(`Bash allows ${JSON.stringify(command)}`, () => assert.equal(bash(command), null));
test('heredoc body is stripped but commands after it are checked', () => {
  assert.equal(stripHeredocs("cat <<'EOF'\ngit push\nEOF\ngit status"), "cat <<'EOF'\ngit status");
  isDenied(bash("cat <<'EOF'\nreading\nEOF\ngit push"));
  assert.match(bash("cat > /product/x <<'EOF'\ngit push\nEOF").hookSpecificOutput.permissionDecisionReason, /shell redirect/);
});
test('unexpected syntax or failed path inspection fails open', () => {
  for (const command of ['echo "unterminated', 'cat <<EOF\nmissing terminator', 'echo hi >', 'git -C']) assert.equal(bash(command), null);
  assert.equal(evaluate(input('Edit', { file_path: '/product/f' }), coordinator, { ...options, realpath: () => { throw new Error('Unavailable'); } }), null);
});
for (const value of ['off', '0', 'false']) test(`escape hatch ${value}`, () => assert.equal(bash('npm test', { ...coordinator, JARVOS_COORDINATOR_GUARD: value }), null));
test('missing input fields and malformed stdin fail open', (t) => {
  assert.equal(evaluate(null, coordinator, options), null);
  assert.equal(evaluate(input('Edit', {}), coordinator, options), null);
  const home = temporary(t);
  for (const stdin of ['', '{bad json', 'null', '[]']) silent(invoke(home, [], stdin, { JARVOS_COORDINATOR: 'yes' }));
});
test('real hook: missing/invalid config, env and config marking, disable file', (t) => {
  const home = temporary(t), config = path.join(home, '.claude/jarvos-coordinator-guard.json');
  const build = JSON.stringify(input('Bash', { command: 'npm test' }));
  silent(invoke(home, [], build));
  const deny = invoke(home, [], build, { JARVOS_COORDINATOR: 'true' });
  assert.equal(deny.status, 0, deny.stderr); assert.equal(deny.stderr, ''); isDenied(JSON.parse(deny.stdout));
  silent(invoke(home, [], JSON.stringify(input('Bash', { command: 'git status' })), { JARVOS_COORDINATOR: '1' }));
  fs.mkdirSync(path.dirname(config)); fs.writeFileSync(config, '{bad');
  silent(invoke(home, [], build));
  isDenied(JSON.parse(invoke(home, [], build, { JARVOS_COORDINATOR: '1' }).stdout));
  fs.writeFileSync(config, JSON.stringify({ coordinatorSessions: [SESSION] }));
  isDenied(JSON.parse(invoke(home, [], build).stdout));
  fs.writeFileSync(path.join(home, '.claude/coordinator-guard.disabled'), '');
  silent(invoke(home, [], build));
});
test('CLI creates private config, preserves keys, and round trips mark/unmark/status', (t) => {
  const home = temporary(t), config = path.join(home, 'custom/config.json');
  const env = { JARVOS_COORDINATOR_GUARD_CONFIG: config };
  const run = (...args) => {
    const result = invoke(home, args, '', env); assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1); return result.stdout;
  };
  run('mark', SESSION);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  const initial = JSON.parse(fs.readFileSync(config)); initial.allowWrite = ['~/notes/projects']; initial.custom = { preserve: true };
  fs.writeFileSync(config, JSON.stringify(initial));
  run('mark', SESSION); assert.match(run('status', SESSION), /: coordinator/); assert.match(run('status'), new RegExp(SESSION));
  isDenied(JSON.parse(invoke(home, [], JSON.stringify(input('Bash', { command: 'npm test' })), env).stdout));
  assert.deepEqual(JSON.parse(fs.readFileSync(config)), initial);
  run('unmark', SESSION); assert.match(run('status', SESSION), /not coordinator/);
  assert.deepEqual(JSON.parse(fs.readFileSync(config)), { ...initial, coordinatorSessions: [] });
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(config)), ['config.json']);
  fs.writeFileSync(config, '{broken');
  assert.equal(invoke(home, ['mark', SESSION], '', env).status, 1);
  assert.equal(fs.readFileSync(config, 'utf8'), '{broken');
});

for (const managed of [false, true]) test(`setup registers direct node once, preserves hooks, skips and rolls back (${managed ? 'managed' : 'unmanaged'})`, (t) => {
  const dir = temporary(t), install = path.join(dir, "example's install"), home = path.join(dir, 'home');
  for (const relative of ['runtimes/claude/setup.sh', 'runtimes/claude/jarvos-coordinator-guard-hook.js', 'modules/jarvos-runtime-kit/src/trusted-native-command.js', 'modules/jarvos-instruction-projection/content/durable-orientation.md']) {
    const target = path.join(install, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(ROOT, relative), target);
  }
  for (const relative of ['modules/jarvos-agent-context/scripts/jarvos-mcp.js', 'runtimes/claude/jarvos-session-start-hook.js', 'runtimes/claude/jarvos-session-turn-hook.js', 'runtimes/claude/jarvos-precompact-hook.js']) {
    const target = path.join(install, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '// fixture\n');
  }
  fs.mkdirSync(home);
  const settings = path.join(home, 'settings.json');
  const unrelated = { matcher: 'Bash', hooks: [{ type: 'command', command: 'unrelated-check', timeout: 7 }] };
  const staged = path.join(dir, 'staged');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [unrelated, { matcher: 'Edit', hooks: [
    { type: 'command', command: `node '${staged}/runtimes/claude/jarvos-coordinator-guard-hook.js'` },
    { type: 'command', command: 'keep-mixed-hook' },
  ] }] } }));
  const env = childEnv(home, {
    CLAUDE_SETTINGS: settings, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_SKIP_CLAUDE_CODE_MCP: '1', JARVOS_SKIP_CLAUDE_MD: '1',
    JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
  });
  if (managed) {
    const stable = path.join(dir, 'stable'); fs.mkdirSync(stable, { mode: 0o700 });
    const dispatcher = path.join(stable, 'jarvos-stewardship-dispatcher');
    fs.writeFileSync(dispatcher, '#!/bin/sh\nprintf \'{"actions":[]}\'\n', { mode: 0o700 });
    env.JARVOS_MANAGED_REPOSITORIES = '/synthetic/repositories'; env.JARVOS_STEWARDSHIP_STABLE_ROOT = stable;
  }
  const setup = (extra = {}) => {
    const result = spawnSync('/bin/bash', [path.join(install, 'runtimes/claude/setup.sh')], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(fs.readFileSync(settings)).hooks.PreToolUse;
  };
  const first = setup(), second = setup(); assert.deepEqual(second, first);
  assert.deepEqual(first[0], unrelated); assert.equal(first[1].hooks[0].command, 'keep-mixed-hook'); assert.equal(first.length, 3);
  const guard = first[2]; assert.equal(guard.matcher, 'Write|Edit|MultiEdit|NotebookEdit|Bash');
  assert.equal(guard.hooks[0].timeout, 10); assert.match(guard.hooks[0].command, /^node /); assert.doesNotMatch(guard.hooks[0].command, /dispatcher/);
  const executed = spawnSync('/bin/sh', ['-c', guard.hooks[0].command], { env: { ...env, JARVOS_COORDINATOR: '1' }, input: JSON.stringify(input('Bash', { command: 'npm test' })), encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr); isDenied(JSON.parse(executed.stdout));
  const retained = first.slice(0, 2);
  assert.deepEqual(setup({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' }), retained);
  assert.deepEqual(setup({ JARVOS_SKIP_COORDINATOR_GUARD: '1' }), retained);
  setup(); assert.deepEqual(setup({ JARVOS_SKIP_COORDINATOR_GUARD: '1' }), retained);
});
test('package test glob picks up this suite', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.includes('node --test modules/jarvos-runtime-kit/test/*.test.js'));
});
