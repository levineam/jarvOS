'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function resolvePath(value, cwd, home) {
  if (typeof value !== 'string' || !value) throw new Error('Missing path');
  value = value.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, home);
  return path.resolve(cwd, value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
}

// Resolve existing ancestors too: a new file can be reached through a symlink.
function realPath(value) {
  try { return fs.realpathSync(value); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const parent = path.dirname(value);
    if (parent === value) return value;
    return path.join(realPath(parent), path.basename(value));
  }
}

function inside(value, directories, canonicalize) {
  const target = canonicalize(value);
  return directories.some((directory) => {
    const relative = path.relative(canonicalize(directory), target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

// shortcut: simple shell commands only; use a shell parser if compound syntax is needed.
function tokenize(source) {
  const tokens = [];
  let word = '', started = false, quote = null;
  const flush = () => {
    if (started) tokens.push({ value: word });
    word = ''; started = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "'" && quote !== '"') { quote = quote ? null : "'"; started = true; continue; }
    if (char === '"' && quote !== "'") { quote = quote ? null : '"'; started = true; continue; }
    if (char === '\\' && quote !== "'") {
      if (++i >= source.length) throw new Error('Incomplete escape');
      if (source[i] !== '\n') { word += source[i]; started = true; }
      continue;
    }
    if (quote) { word += char; continue; }
    // ${NAME} stays one word. Command substitution and grouping split segments,
    // so the commands inside them are still checked.
    if (char === '$' && source[i + 1] === '{') {
      const end = source.indexOf('}', i);
      if (end === -1) throw new Error('Unclosed parameter expansion');
      word += source.slice(i, end + 1); started = true; i = end; continue;
    }
    if (char === '#' && !started) {
      while (i < source.length && source[i] !== '\n') i++;
      if (i < source.length) { flush(); tokens.push({ op: '\n' }); }
      continue;
    }
    if (char === '\n') { flush(); tokens.push({ op: '\n' }); continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if ('()'.includes(char)) { flush(); tokens.push({ op: char }); continue; }
    if ('{}`'.includes(char)) { flush(); tokens.push({ op: ';' }); continue; }
    const operator = source.slice(i).match(/^(?:\d*(?:>>|>&|>\||>|<<-|<<|<&|<)|&&|\|\||[;|&])/);
    if (operator && (!/^\d/.test(char) || !started)) {
      flush(); tokens.push({ op: operator[0] }); i += operator[0].length - 1; continue;
    }
    word += char; started = true;
  }
  if (quote) throw new Error('Unclosed quote');
  flush();
  return tokens;
}

// Heredoc bodies are data, not commands. Found by pattern rather than by the
// tokenizer, because a heredoc often opens inside a multi-line quoted string,
// as in git commit -m "$(cat <<'EOF' ... EOF)".
function stripHeredocs(source) {
  const lines = source.split('\n'), result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result.push(line);
    // Several heredocs on one line have bodies in order, one after another.
    for (const match of line.matchAll(/<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z_0-9]*))/g)) {
      const delimiter = match[2] || match[3] || match[4];
      let found = false;
      while (++i < lines.length) {
        if ((match[1] ? lines[i].replace(/^\t+/, '') : lines[i]).trim() === delimiter) { found = true; break; }
      }
      if (!found) throw new Error('Unclosed heredoc');
    }
  }
  return result.join('\n');
}

function unwrap(args) {
  args = [...args];
  for (;;) {
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(args[0] || '')) { args.shift(); continue; }
    const name = path.basename(args[0] || '');
    if (!['env', 'sudo', 'command', 'time', 'nohup'].includes(name)) return args;
    args.shift();
    while (args[0]?.startsWith('-')) {
      const flag = args.shift();
      if (['-u', '-g', '-h', '-C', '--user', '--group', '--unset'].includes(flag)) args.shift();
      if (flag === '--') break;
    }
  }
}

function gitCommand(args, cwd, home) {
  let directory = cwd, i = 1;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-C') directory = resolvePath(args[++i], directory, home);
    else if (arg.startsWith('-C')) directory = resolvePath(arg.slice(2), directory, home);
    else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(arg)) {
      if (!args[++i]) throw new Error('Missing git option value');
    } else if (arg === '--') { i++; break; }
    else if (!arg.startsWith('-')) break;
  }
  return { directory, subcommand: args[i] };
}

const VERCEL_VALUE_OPTIONS = ['--scope', '-S', '--team', '-T', '--token', '-t', '--cwd', '--local-config', '-A', '--global-config', '-Q'];
const VERCEL_READ = ['--version', '-v', '--help', '-h', 'help', 'whoami', 'ls', 'list', 'logs', 'inspect', 'login', 'logout', 'switch', 'pull', 'link'];
const VERCEL_LISTABLE = ['project', 'projects', 'env', 'domains', 'domain', 'dns', 'certs', 'teams', 'team', 'alias', 'aliases'];

function vercelDeploys(args) {
  const rest = [];
  for (let i = 1; i < args.length; i++) {
    if (VERCEL_VALUE_OPTIONS.includes(args[i])) { i++; continue; }
    if (/^--(?:scope|team|token|cwd|local-config|global-config)=/.test(args[i]) || args[i] === '--debug' || args[i] === '-d') continue;
    rest.push(args[i]);
  }
  const [action, next] = rest;
  if (VERCEL_READ.includes(action)) return false;
  if (VERCEL_LISTABLE.includes(action) && ['ls', 'list', 'inspect', undefined].includes(next)) return false;
  return true;
}

function deployCommand(args) {
  const [name, action] = args;
  if (name === 'vercel') return vercelDeploys(args);
  return (name === 'netlify' && action === 'deploy') ||
    (name === 'wrangler' && ['deploy', 'publish'].includes(action)) ||
    (['fly', 'flyctl', 'firebase'].includes(name) && action === 'deploy') ||
    (name === 'railway' && action === 'up');
}

function inPlaceTargets(args) {
  const perl = args[0] === 'perl';
  if (!args.slice(1).some((arg) => perl ? /^-[^-]*i/.test(arg) : arg === '--in-place' || arg.startsWith('--in-place=') || arg.startsWith('-i'))) return [];
  const files = [];
  let expression = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { files.push(...args.slice(i + 1)); break; }
    if (arg === '-i') { if (args[i + 1] === '') i++; continue; }
    if (['-e', '-f', '--expression', '--file'].includes(arg) || (perl && /^-[np]*[eE]$/.test(arg))) {
      if (args[++i] === undefined) throw new Error('Missing expression');
      expression = true; continue;
    }
    if (/^-(?:e|f).+/.test(arg) || /^--(?:expression|file)=/.test(arg)) { expression = true; continue; }
    if (arg.startsWith('-')) continue;
    if (!perl && !expression) { expression = true; continue; }
    files.push(arg);
  }
  return files;
}

function bashReason(command, initialCwd, home, writeAllowed, gitAllowed) {
  if (typeof command !== 'string') throw new Error('Missing command');
  const tokens = tokenize(stripHeredocs(command));
  // A segment is a simple command; '(' and ')' markers scope cd to a subshell.
  const segments = [[]];
  for (const token of tokens) {
    if (['&&', '||', ';', '|', '\n', '&'].includes(token.op)) segments.push([]);
    else if (token.op === '(' || token.op === ')') segments.push(token.op, []);
    else segments.at(-1).push(token);
  }
  let cwd = initialCwd;
  const scopes = [];
  for (const segment of segments) {
    if (segment === '(') { scopes.push(cwd); continue; }
    if (segment === ')') { if (scopes.length) cwd = scopes.pop(); continue; }
    const words = [];
    for (let i = 0; i < segment.length; i++) {
      const token = segment[i];
      if (!token.op) { words.push(token.value); continue; }
      const target = segment[++i]?.value;
      if (target === undefined) throw new Error('Missing redirect target');
      if (!/^\d*>/.test(token.op)) continue;
      if (token.op.endsWith('>&') && /^(?:\d+|-)$/.test(target)) continue;
      if (['/dev/null', '/dev/stderr', '/dev/stdout'].includes(target)) continue;
      if (!writeAllowed(resolvePath(target, cwd, home))) return `shell redirect to ${target}`;
    }
    const args = unwrap(words);
    if (!args.length) continue;
    const name = path.basename(args[0]);
    args[0] = name;
    const action = args[1];
    if (name === 'cd') {
      const target = action === '--' ? args[2] : action || home;
      if (target === '-' || args.length > (action === '--' ? 3 : 2)) throw new Error('Unsupported cd');
      cwd = resolvePath(target, cwd, home); continue;
    }
    if (name === 'git') {
      const git = gitCommand(args, cwd, home);
      // Listing only: explicit -l/--list, or no tag names and no creation/deletion
      // flags. Values of filter options (--contains HEAD) are not tag names.
      const rest = [];
      for (let i = args.indexOf(git.subcommand) + 1; i < args.length; i++) {
        rest.push(args[i]);
        if (['--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--sort', '--format'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('-')) i++;
      }
      const listsTags = git.subcommand === 'tag' && !rest.some((arg) => /^-[asmfdu]|^--(?:annotate|sign|message|force|delete|local-user|file)/.test(arg)) &&
        (rest.some((arg) => arg === '-l' || arg === '--list') || !rest.some((arg) => !arg.startsWith('-')));
      if (['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'am', 'tag'].includes(git.subcommand) && !listsTags && !gitAllowed(git.directory)) return `git ${git.subcommand} outside the project-records repo`;
      // Inspection only when every argument is an inspection flag or a patch file
      // (git accepts abbreviated options, so any other flag may mean --apply).
      const inspectFlags = ['--check', '--stat', '--numstat', '--summary'];
      const inspectsPatch = rest.some((arg) => inspectFlags.includes(arg)) && rest.every((arg) => inspectFlags.includes(arg) || !arg.startsWith('-'));
      if (git.subcommand === 'apply' && !inspectsPatch && !writeAllowed(git.directory)) return 'git apply outside coordination files';
    }
    if (name === 'gh') {
      const gh = [];
      for (let i = 1; i < args.length; i++) {
        if (['-R', '--repo', '--hostname'].includes(args[i])) { i++; continue; }
        if (!/^--(?:repo|hostname)=/.test(args[i])) gh.push(args[i]);
      }
      const [group, verb] = gh;
      if ((group === 'pr' && ['create', 'merge', 'ready'].includes(verb)) || (group === 'release' && verb === 'create') || (group === 'workflow' && verb === 'run')) return `gh ${group} ${verb}`;
    }
    const PM_VALUE_OPTIONS = ['--prefix', '-C', '--dir', '--filter', '-F', '--cwd', '--workspace', 'workspace'];
    const pmWords = [], pmIndexes = [];
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
      // Option values (--prefix dir, --filter pkg, workspace names) are skipped,
      // so the remaining positional words are the verb and script.
      for (let i = 1; i < args.length && args[i] !== '--'; i++) {
        if (PM_VALUE_OPTIONS.includes(args[i])) { i++; continue; }
        if (!args[i].startsWith('-')) { pmWords.push(args[i]); pmIndexes.push(i); }
      }
    }
    const pmExec = ['dlx', 'exec', 'x'].includes(pmWords[0]);
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && !pmExec) {
      const words = pmWords;
      // Package names given to install-style verbs are not scripts.
      const scriptIndex = words.findIndex((arg) => /^(?:build|test|deploy)(?:[:._-][\w:.-]*)?$/.test(arg) || arg === 'publish');
      const installs = ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'view', 'info', 'why', 'outdated'].includes(words[0]);
      const script = scriptIndex >= 0 && !installs ? words[scriptIndex] : (name === 'npm' && words[0] === 't' ? 't' : null);
      if (script) return `${name} ${script}`;
    }
    let deployArgs = args;
    if (['npx', 'bunx'].includes(name) || pmExec) {
      deployArgs = args.slice(pmExec ? pmIndexes[0] + 1 : 1);
      while (deployArgs[0]?.startsWith('-')) {
        const flag = deployArgs.shift();
        if (flag === '--') break;
        if (['--package', '-p', ...PM_VALUE_OPTIONS].includes(flag)) deployArgs.shift();
      }
      if (deployArgs[0]) deployArgs[0] = path.basename(deployArgs[0].replace(/(.)@[^@/]*$/, '$1'));
    }
    if (deployCommand(deployArgs)) return deployArgs.slice(0, 3).join(' ');
    // JavaScript build tools and test runners, run directly or through npx.
    const [tool, toolAction] = deployArgs;
    const asksVersion = deployArgs.length === 2 && ['--version', '-v', '-V', '--help', '-h'].includes(deployArgs[1]);
    if ((['jest', 'vitest', 'mocha', 'ava', 'cypress', 'webpack', 'electron-builder', 'rollup', 'esbuild', 'tsc'].includes(tool) && !asksVersion) ||
        (['vite', 'next', 'nuxt', 'astro', 'turbo', 'nx', 'playwright', 'remix', 'svelte-kit'].includes(tool) && (['build', 'test', 'deploy', 'export'].includes(toolAction) || (toolAction === 'run' && /(?:^|:)(?:build|test|deploy)/.test(deployArgs[2] || '')))) ||
        (tool === 'node' && deployArgs.includes('--test'))) return deployArgs.slice(0, 2).join(' ');
    const xcodeInspects = name === 'xcodebuild' && !args.some((arg) => ['build', 'test', 'archive', 'build-for-testing', 'test-without-building', 'install', '-exportArchive'].includes(arg)) && args.some((arg) => ['-list', '-showBuildSettings', '-version', '-showsdks', '-showdestinations', '-help', '-usage'].includes(arg));
    if ((['make', 'pytest', 'xcodebuild', 'gradle', 'gradlew', 'mvn'].includes(name) && !xcodeInspects) ||
        (['cargo', 'go', 'swift'].includes(name) && ['build', 'test'].includes(action))) return args.slice(0, 2).join(' ');
    // Container builds and pushes, and Python test runners started as modules.
    const dockerWords = name === 'docker' || name === 'podman' ? args.slice(1).filter((arg) => !arg.startsWith('-')) : [];
    if (['build', 'push'].includes(dockerWords[0]) || (['buildx', 'compose', 'image'].includes(dockerWords[0]) && ['build', 'bake', 'push'].includes(dockerWords[1]))) return `${name} ${dockerWords.slice(0, 2).join(' ')}`;
    if (/^python(?:\d(?:\.\d+)?)?$/.test(name) && args[1] === '-m' && ['pytest', 'unittest', 'tox', 'build'].includes(args[2])) return `${name} -m ${args[2]}`;
    if (name === 'patch' && !writeAllowed(cwd)) return 'patch outside coordination files';
    const targets = name === 'tee' ? args.slice(1).filter((arg) => !arg.startsWith('-')) : ['sed', 'perl'].includes(name) ? inPlaceTargets(args) : [];
    for (const target of targets) {
      if (target !== '-' && !writeAllowed(resolvePath(target, cwd, home))) return `${name} write to ${target}`;
    }
  }
  return null;
}

function deny(reason) {
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `Coordinator guard: this session is marked as a coordinator, so it routes build work instead of doing it. Blocked: ${reason.length > 140 ? `${reason.slice(0, 30)}…${reason.slice(-100)}` : reason}. Hand it off: open the project's file in the project records folder, find the owner in its sessions: list, and send that session a task (what, why, done-when). If there is no owner, start a lead session with a short brief. Coordination files in the allowlist remain editable. If this must be done here, ask the user to turn the guard off for this session (JARVOS_COORDINATOR_GUARD=off, or touch ~/.claude/coordinator-guard.disabled).`,
  } };
}

function normalizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  for (const key of ['coordinatorSessions', 'allowWrite', 'allowGit']) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== 'string' || !value))) return {};
  }
  return config;
}

// Pure decision layer: filesystem facts are supplied by the hook runner/tests.
function evaluate(input, env = {}, options = {}) {
  try {
    const config = normalizeConfig(options.config);
    if (!['1', 'true', 'yes'].includes(String(env.JARVOS_COORDINATOR).toLowerCase()) &&
        !(typeof input?.session_id === 'string' && Array.isArray(config.coordinatorSessions) && config.coordinatorSessions.includes(input.session_id))) return null;
    if (['off', '0', 'false'].includes(String(env.JARVOS_COORDINATOR_GUARD).toLowerCase()) || options.disabled) return null;
    const home = options.home || env.HOME || os.homedir();
    const cwd = resolvePath(input.cwd, home, home);
    const canonicalize = options.realpath || ((value) => value);
    // Claude Code's own scratch folder and the system temp dir, but not all of
    // /tmp: product worktrees are often created there.
    const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
    const scratch = uid === null ? [] : [`/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`];
    const writes = ['~/.claude/plans', '~/.claude/projects', options.tmpdir || os.tmpdir(), ...scratch, ...(config.allowWrite || [])];
    const git = [...(config.allowGit === undefined ? config.allowWrite || [] : config.allowGit)];
    if (env.JARVOS_PROJECTS_DIR) { writes.push(env.JARVOS_PROJECTS_DIR); git.push(env.JARVOS_PROJECTS_DIR); }
    const dirs = (values) => values.map((value) => resolvePath(value, home, home));
    const writeDirs = dirs(writes), gitDirs = dirs(git);
    const writeAllowed = (value) => inside(value, writeDirs, canonicalize);
    const gitAllowed = (value) => inside(value, gitDirs, canonicalize);
    let reason = null;
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) {
      const target = resolvePath(input.tool_input?.file_path || input.tool_input?.notebook_path, cwd, home);
      if (!writeAllowed(target)) reason = `${input.tool_name} of ${target}`;
    } else if (input.tool_name === 'Bash') reason = bashReason(input.tool_input?.command, cwd, home, writeAllowed, gitAllowed);
    return reason ? deny(reason) : null;
  } catch { return null; }
}

function configPath(env, home) {
  return resolvePath(env.JARVOS_COORDINATOR_GUARD_CONFIG || '~/.claude/jarvos-coordinator-guard.json', home, home);
}

function readConfig(file) {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { return {}; }
}

function runHook(input, env = process.env) {
  try {
    const home = env.HOME || os.homedir();
    const config = readConfig(configPath(env, home));
    // Keep unmarked sessions cheap: no path probes or shell parsing.
    if (!['1', 'true', 'yes'].includes(String(env.JARVOS_COORDINATOR).toLowerCase()) &&
        !(Array.isArray(config.coordinatorSessions) && config.coordinatorSessions.includes(input?.session_id))) return null;
    return evaluate(input, env, { home, config, realpath: realPath, disabled: fs.existsSync(path.join(home, '.claude/coordinator-guard.disabled')) });
  } catch { return null; }
}

function cli(args, env = process.env) {
  const [action, session] = args;
  if (!['mark', 'unmark', 'status'].includes(action) || args.length > 2 || (action !== 'status' && !session)) throw new Error('Usage: mark <session-id> | unmark <session-id> | status [<session-id>]');
  const home = env.HOME || os.homedir(), file = configPath(env, home);
  // CLI edits refuse corrupt files rather than silently discarding other keys.
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid config object');
  const sessions = Array.isArray(config.coordinatorSessions) ? config.coordinatorSessions.filter((value) => typeof value === 'string') : [];
  if (action === 'status') return session ? `${session}: ${sessions.includes(session) ? 'coordinator' : 'not coordinator'}` : `Coordinator sessions: ${sessions.join(', ') || '(none)'}`;
  config.coordinatorSessions = action === 'mark' ? [...new Set([...sessions, session])] : sessions.filter((value) => value !== session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return `${session}: ${action === 'mark' ? 'coordinator' : 'not coordinator'}`;
}

module.exports = { evaluate, runHook, tokenize, stripHeredocs, realPath, cli };

if (require.main === module) {
  if (process.argv.length > 2) {
    try { console.log(cli(process.argv.slice(2))); } catch { console.error('Coordinator guard: could not read or update config; use mark <session-id>, unmark <session-id>, or status [<session-id>].'); process.exitCode = 1; }
  } else {
    try {
      const result = runHook(JSON.parse(fs.readFileSync(0, 'utf8')));
      if (result) process.stdout.write(JSON.stringify(result));
    } catch { /* Hook errors always allow, without output. */ }
  }
}
