'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const MODULE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST_PATH = path.join(MODULE_ROOT, 'config', 'curated-import.json');
const DEFAULT_EVAL_PATH = path.join(MODULE_ROOT, 'config', 'eval-questions.json');
const DEFAULT_VAULT_DIR = path.join(os.homedir(), 'Documents', 'ObsidianVault');
const DEFAULT_BRAIN_DIR = path.join(os.homedir(), 'brain');
const DEFAULT_GBRAIN_DIR = path.join(os.homedir(), 'gbrain');

const TYPE_DIRS = Object.freeze({
  person: 'people',
  people: 'people',
  company: 'companies',
  companies: 'companies',
  project: 'projects',
  projects: 'projects',
  concept: 'concepts',
  concepts: 'concepts',
  meeting: 'meetings',
  meetings: 'meetings',
  source: 'sources',
  sources: 'sources',
});

function expandTilde(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function resolveConfig(overrides = {}) {
  const vaultDir = expandTilde(firstString(
    overrides.vaultDir,
    process.env.JARVOS_VAULT_DIR,
    DEFAULT_VAULT_DIR,
  ));
  const notesDir = expandTilde(firstString(
    overrides.notesDir,
    process.env.JARVOS_NOTES_DIR,
    process.env.VAULT_NOTES_DIR,
    path.join(vaultDir, 'Notes'),
  ));
  const brainDir = expandTilde(firstString(
    overrides.brainDir,
    process.env.JARVOS_BRAIN_DIR,
    DEFAULT_BRAIN_DIR,
  ));
  const gbrainDir = expandTilde(firstString(
    overrides.gbrainDir,
    process.env.JARVOS_GBRAIN_DIR,
    DEFAULT_GBRAIN_DIR,
  ));
  const manifestPath = expandTilde(firstString(
    overrides.manifestPath,
    process.env.JARVOS_GBRAIN_IMPORT_MANIFEST,
    DEFAULT_MANIFEST_PATH,
  ));
  const evalPath = expandTilde(firstString(
    overrides.evalPath,
    process.env.JARVOS_GBRAIN_EVAL_QUESTIONS,
    DEFAULT_EVAL_PATH,
  ));
  const gbrainBin = expandTilde(firstString(overrides.gbrainBin, process.env.JARVOS_GBRAIN_BIN, 'gbrain'));

  return {
    vaultDir,
    notesDir,
    brainDir,
    gbrainDir,
    manifestPath,
    evalPath,
    gbrainBin,
  };
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw new Error(`Could not read JSON file ${filePath}: ${error.message}`);
  }
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'untitled';
}

function normalizeType(type) {
  const raw = String(type || 'source').trim().toLowerCase();
  const dir = TYPE_DIRS[raw];
  if (!dir) return null;
  if (dir === 'people') return 'person';
  return dir.endsWith('ies') ? dir.slice(0, -3) + 'y' : dir.replace(/s$/, '');
}

function typeToDir(type) {
  const raw = String(type || 'source').trim().toLowerCase();
  return TYPE_DIRS[raw] || null;
}

function resolveSourcePath(item, config) {
  const sourcePath = firstString(item.sourcePath, item.path);
  if (!sourcePath) return null;
  const expanded = expandTilde(sourcePath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(config.vaultDir, expanded);
}

function targetPathForItem(item, config) {
  const dir = typeToDir(item.type);
  const slug = firstString(item.slug, slugify(item.title || item.sourcePath || item.path));
  return path.join(config.brainDir, dir || 'sources', `${slugify(slug)}.md`);
}

function yamlScalar(value) {
  const text = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${text}"`;
}

function relativeOrAbsolute(filePath, baseDir) {
  if (!filePath) return '';
  const rel = path.relative(baseDir, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return filePath;
}

function renderBrainPage(item, sourceContent, config) {
  const now = new Date().toISOString();
  const sourcePath = resolveSourcePath(item, config);
  const sourceRel = relativeOrAbsolute(sourcePath, config.vaultDir);
  const pageType = normalizeType(item.type) || 'source';
  const title = firstString(item.title, path.basename(sourcePath || 'Untitled.md', '.md'), 'Untitled');
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim()) : [];
  const summary = firstString(item.summary, '');
  const tagBlock = tags.length > 0
    ? tags.map((tag) => `  - ${yamlScalar(tag)}`).join('\n')
    : '  []';

  return [
    '---',
    `title: ${yamlScalar(title)}`,
    `type: ${yamlScalar(pageType)}`,
    'source:',
    '  kind: "obsidian"',
    `  path: ${yamlScalar(sourceRel)}`,
    `  absolutePath: ${yamlScalar(sourcePath || '')}`,
    `  importedAt: ${yamlScalar(now)}`,
    '  importedBy: "jarvos-gbrain"',
    'tags:',
    tagBlock,
    '---',
    '',
    `# ${title}`,
    '',
    '<!-- jarvos-gbrain:generated:start -->',
    summary ? `> ${summary}` : '> Imported from Obsidian by the jarvOS GBrain bridge.',
    '',
    '## Source',
    '',
    `- Source path: \`${sourceRel || sourcePath || 'unknown'}\``,
    `- Page type: \`${pageType}\``,
    '',
    '## Imported Content',
    '',
    sourceContent.trim() || '_Source note was empty at import time._',
    '<!-- jarvos-gbrain:generated:end -->',
    '',
  ].join('\n');
}

function createImportPlan(overrides = {}) {
  const config = resolveConfig(overrides);
  const manifest = readJsonFile(config.manifestPath, { version: 1, items: [] });
  const rawItems = Array.isArray(manifest.items) ? manifest.items : [];
  const warnings = [];
  const items = [];

  for (const [index, item] of rawItems.entries()) {
    if (!item || item.include === false) continue;

    const pageType = normalizeType(item.type);
    const targetDir = typeToDir(item.type);
    if (!pageType || !targetDir) {
      warnings.push(`Item ${index} has unsupported type: ${item.type || '(missing)'}`);
      continue;
    }

    const sourcePath = resolveSourcePath(item, config);
    if (!sourcePath) {
      warnings.push(`Item ${index} is missing sourcePath`);
      continue;
    }
    if (!fs.existsSync(sourcePath)) {
      warnings.push(`Item ${index} source does not exist: ${sourcePath}`);
      continue;
    }

    const targetPath = targetPathForItem(item, config);
    items.push({
      index,
      type: pageType,
      title: firstString(item.title, path.basename(sourcePath, '.md')),
      sourcePath,
      targetPath,
      slug: path.basename(targetPath, '.md'),
      tags: Array.isArray(item.tags) ? item.tags : [],
      summary: firstString(item.summary, ''),
      item,
    });
  }

  return {
    config,
    manifestPath: config.manifestPath,
    itemCount: items.length,
    items,
    warnings,
  };
}

function importToBrain(planOrOverrides = {}, options = {}) {
  const plan = Array.isArray(planOrOverrides.items)
    ? planOrOverrides
    : createImportPlan(planOrOverrides);
  const dryRun = options.dryRun === true;
  const imported = [];
  const warnings = [...(plan.warnings || [])];

  for (const planned of plan.items) {
    let sourceContent;
    try {
      sourceContent = fs.readFileSync(planned.sourcePath, 'utf8');
    } catch (error) {
      warnings.push(`Could not read ${planned.sourcePath}: ${error.message}`);
      continue;
    }

    const body = renderBrainPage(planned.item || planned, sourceContent, plan.config);
    const entry = {
      type: planned.type,
      title: planned.title,
      sourcePath: planned.sourcePath,
      targetPath: planned.targetPath,
      dryRun,
      bytes: Buffer.byteLength(body, 'utf8'),
    };

    if (!dryRun) {
      try {
        fs.mkdirSync(path.dirname(planned.targetPath), { recursive: true });
        fs.writeFileSync(planned.targetPath, body, 'utf8');
      } catch (error) {
        warnings.push(`Could not write ${planned.targetPath}: ${error.message}`);
        continue;
      }
    }

    imported.push(entry);
  }

  return {
    dryRun,
    imported,
    warnings,
  };
}

function runCommand(command, args, options = {}) {
  if (options.dryRun) {
    return { ok: true, dryRun: true, command, args, status: 0, stdout: '', stderr: '' };
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    dryRun: false,
    command,
    args,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

function syncBrain(overrides = {}, options = {}) {
  const config = resolveConfig(overrides);
  const sync = runCommand(config.gbrainBin, ['sync', '--repo', config.brainDir], {
    cwd: config.gbrainDir,
    dryRun: options.dryRun === true,
  });
  const embed = sync.ok
    ? runCommand(config.gbrainBin, ['embed', '--stale'], {
        cwd: config.gbrainDir,
        dryRun: options.dryRun === true,
      })
    : null;
  return { config, sync, embed, ok: sync.ok && (!embed || embed.ok) };
}

function readEvalQuestions(config) {
  const data = readJsonFile(config.evalPath, { version: 1, questions: [] });
  return Array.isArray(data.questions) ? data.questions : [];
}

function asStringList(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

function expectedClauses(expected) {
  if (expected === undefined || expected === null) return null;
  if (typeof expected === 'string' || Array.isArray(expected)) {
    return { all: asStringList(expected), any: [] };
  }
  if (typeof expected !== 'object') return { all: [String(expected)], any: [] };

  return {
    all: [
      ...asStringList(expected.all),
      ...asStringList(expected.contains),
      ...asStringList(expected.mustContain),
      ...asStringList(expected.slug),
      ...asStringList(expected.slugs),
      ...asStringList(expected.title),
      ...asStringList(expected.text),
    ],
    any: [
      ...asStringList(expected.any),
      ...asStringList(expected.anyOf),
    ],
  };
}

function matchExpected(output, expected) {
  const clauses = expectedClauses(expected);
  if (!clauses) return { checked: false, matched: true, missing: [] };

  const haystack = String(output || '').toLowerCase();
  const missingAll = clauses.all.filter((needle) => !haystack.includes(needle.toLowerCase()));
  const anyMatched = clauses.any.length === 0
    || clauses.any.some((needle) => haystack.includes(needle.toLowerCase()));
  const missingAny = anyMatched || clauses.any.length === 0 ? [] : clauses.any;

  return {
    checked: true,
    matched: missingAll.length === 0 && anyMatched,
    missing: [...missingAll, ...missingAny],
  };
}

function runRetrievalEval(overrides = {}, options = {}) {
  const config = resolveConfig(overrides);
  const questions = readEvalQuestions(config);
  const dryRun = options.dryRun === true;
  const results = questions.map((entry, index) => {
    const query = typeof entry === 'string' ? entry : entry.query;
    if (!query) {
      return { index, ok: false, skipped: true, reason: 'missing query' };
    }
    const command = runCommand(config.gbrainBin, ['search', query, '--limit', '5'], {
      cwd: config.gbrainDir,
      dryRun,
    });
    const expected = typeof entry === 'object' ? entry.expected : undefined;
    const expectedMatch = dryRun
      ? { checked: expected !== undefined, matched: null, missing: [] }
      : matchExpected(command.stdout, expected);
    const ok = command.ok && (dryRun || !expectedMatch.checked || expectedMatch.matched);
    return {
      index,
      query,
      ok,
      expected,
      expectedMatched: expectedMatch.checked ? expectedMatch.matched : undefined,
      missingExpected: expectedMatch.missing,
      command,
    };
  });
  return {
    config,
    dryRun,
    questionCount: questions.length,
    results,
    ok: results.every((result) => result.ok || result.skipped),
  };
}

function commandExists(command) {
  const expanded = expandTilde(command);
  if (path.isAbsolute(expanded) || expanded.includes('/') || expanded.includes('\\')) {
    return isExecutable(expanded);
  }
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  return pathDirs.some((dir) => extensions.some((ext) => isExecutable(path.join(dir, `${expanded}${ext}`))));
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function doctor(overrides = {}) {
  const config = resolveConfig(overrides);
  const checks = [
    { name: 'manifest', ok: fs.existsSync(config.manifestPath), detail: config.manifestPath },
    { name: 'evalQuestions', ok: fs.existsSync(config.evalPath), detail: config.evalPath },
    { name: 'brainDir', ok: fs.existsSync(config.brainDir), detail: config.brainDir },
    { name: 'gbrainDir', ok: fs.existsSync(config.gbrainDir), detail: config.gbrainDir },
    { name: 'gbrainBin', ok: commandExists(config.gbrainBin), detail: config.gbrainBin },
  ];
  return {
    config,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

module.exports = {
  TYPE_DIRS,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_EVAL_PATH,
  expandTilde,
  resolveConfig,
  slugify,
  normalizeType,
  createImportPlan,
  importToBrain,
  syncBrain,
  runRetrievalEval,
  doctor,
  renderBrainPage,
};
