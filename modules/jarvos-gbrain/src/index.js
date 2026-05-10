'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const MODULE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST_PATH = path.join(MODULE_ROOT, 'config', 'curated-import.json');
const DEFAULT_EVAL_PATH = path.join(MODULE_ROOT, 'config', 'eval-questions.json');
const DEFAULT_VAULT_DIR = path.join(os.homedir(), 'Documents', 'Vault v3');
const DEFAULT_BRAIN_DIR = path.join(os.homedir(), 'brain');
const DEFAULT_GBRAIN_DIR = path.join(os.homedir(), 'gbrain');
const DEFAULT_QMD_BIN = 'qmd';
const DEFAULT_RETRIEVAL_LIMIT = 5;
const DEFAULT_RETRIEVAL_TIMEOUT_MS = 15000;
const JARVOS_PATHS_PACKAGE = '@jarvos/secondbrain/bridge/config/jarvos-paths.js';
const JARVOS_PATHS_SOURCE_MODULE = path.resolve(
  MODULE_ROOT,
  '..',
  'jarvos-secondbrain',
  'bridge',
  'config',
  'jarvos-paths.js',
);

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
const GRAPH_FRONTMATTER_FIELDS = Object.freeze([
  'aliases',
  'company',
  'companies',
  'founded',
  'key_people',
  'partner',
  'investors',
  'lead',
  'attendees',
  'related',
  'see_also',
  'source',
  'sources',
]);
const GRAPH_LIST_FIELDS = new Set([
  'aliases',
  'companies',
  'founded',
  'key_people',
  'investors',
  'attendees',
  'related',
  'see_also',
  'sources',
]);

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

function loadJarvosPaths() {
  try {
    const packagePath = require.resolve(JARVOS_PATHS_PACKAGE, {
      paths: [process.cwd(), MODULE_ROOT],
    });
    return require(packagePath);
  } catch {
    // Fall through to the monorepo source path for local development.
  }

  try {
    return require(JARVOS_PATHS_SOURCE_MODULE);
  } catch {
    return null;
  }
}

function sharedPathOrFallback(jarvosPaths, getterName, fallback) {
  if (jarvosPaths && typeof jarvosPaths[getterName] === 'function') {
    return jarvosPaths[getterName]();
  }
  return fallback;
}

function resolveConfig(overrides = {}) {
  const jarvosPaths = loadJarvosPaths();
  const vaultDir = expandTilde(
    firstString(overrides.vaultDir)
      || sharedPathOrFallback(jarvosPaths, 'getVaultDir', firstString(process.env.JARVOS_VAULT_DIR, DEFAULT_VAULT_DIR)),
  );
  const notesDir = expandTilde(
    firstString(overrides.notesDir)
      || (firstString(overrides.vaultDir)
        ? firstString(process.env.JARVOS_NOTES_DIR, process.env.VAULT_NOTES_DIR, path.join(vaultDir, 'Notes'))
        : sharedPathOrFallback(
          jarvosPaths,
          'getNotesDir',
          firstString(process.env.JARVOS_NOTES_DIR, process.env.VAULT_NOTES_DIR, path.join(vaultDir, 'Notes')),
        )),
  );
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
  const qmdBin = expandTilde(firstString(overrides.qmdBin, process.env.JARVOS_QMD_BIN, DEFAULT_QMD_BIN));
  const qmdMode = firstString(overrides.qmdMode, process.env.JARVOS_QMD_MODE, 'search');
  const qmdCollection = firstString(overrides.qmdCollection, process.env.JARVOS_QMD_COLLECTION);
  const qmdIndex = firstString(overrides.qmdIndex, process.env.JARVOS_QMD_INDEX);
  const retrievalTimeoutMs = positiveInteger(
    overrides.retrievalTimeoutMs || process.env.JARVOS_RETRIEVAL_TIMEOUT_MS,
    DEFAULT_RETRIEVAL_TIMEOUT_MS,
  );

  return {
    vaultDir,
    notesDir,
    brainDir,
    gbrainDir,
    manifestPath,
    evalPath,
    gbrainBin,
    qmdBin,
    qmdMode,
    qmdCollection,
    qmdIndex,
    retrievalTimeoutMs,
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

function graphFieldValue(item, field) {
  if (!item || typeof item !== 'object') return undefined;
  if (item.graph && typeof item.graph === 'object' && item.graph[field] !== undefined) {
    return item.graph[field];
  }
  if (item.relationships && typeof item.relationships === 'object' && item.relationships[field] !== undefined) {
    return item.relationships[field];
  }
  return item[field];
}

function graphFieldEntries(item) {
  const entries = [];
  for (const field of GRAPH_FRONTMATTER_FIELDS) {
    const values = asStringList(graphFieldValue(item, field));
    if (values.length > 0) entries.push({ field, values });
  }
  return entries;
}

function renderGraphFrontmatter(item) {
  return graphFieldEntries(item).flatMap(({ field, values }) => {
    if (!GRAPH_LIST_FIELDS.has(field) && values.length === 1) {
      return [`${field}: ${yamlScalar(values[0])}`];
    }
    return [
      `${field}:`,
      ...values.map((value) => `  - ${yamlScalar(value)}`),
    ];
  });
}

function wikilinkTarget(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith('[[') && text.endsWith(']]')) return text;
  return `[[${text}]]`;
}

function renderGraphBodySection(item) {
  const entries = graphFieldEntries(item).filter(({ field }) => field !== 'aliases');
  if (entries.length === 0) return [];

  const lines = ['## Graph Links', ''];
  for (const { field, values } of entries) {
    const label = field.replace(/_/g, ' ');
    lines.push(`- ${label}: ${values.map(wikilinkTarget).filter(Boolean).join(', ')}`);
  }
  lines.push('');
  return lines;
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
  const graphFrontmatter = renderGraphFrontmatter(item);

  return [
    '---',
    `title: ${yamlScalar(title)}`,
    `type: ${yamlScalar(pageType)}`,
    'provenance:',
    '  kind: "obsidian"',
    `  path: ${yamlScalar(sourceRel)}`,
    `  absolutePath: ${yamlScalar(sourcePath || '')}`,
    `  importedAt: ${yamlScalar(now)}`,
    '  importedBy: "jarvos-gbrain"',
    'tags:',
    tagBlock,
    ...graphFrontmatter,
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
    ...renderGraphBodySection(item),
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
    return { ok: true, dryRun: true, command, args, status: 0, signal: null, timedOut: false, stdout: '', stderr: '', error: null };
  }
  const timeout = positiveInteger(options.timeoutMs, 0);
  const spawnOptions = {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  };
  if (timeout > 0) {
    spawnOptions.timeout = timeout;
    spawnOptions.killSignal = 'SIGKILL';
  }

  const result = spawnSync(command, args, spawnOptions);
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  return {
    ok: result.status === 0 && !timedOut,
    dryRun: false,
    command,
    args,
    status: result.status,
    signal: result.signal || null,
    timedOut: !!timedOut,
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
  return Array.isArray(data.questions)
    ? data.questions.filter((question) => !(question && typeof question === 'object' && question.include === false))
    : [];
}

function asStringList(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => (typeof item === 'string' && item.trim()) || (typeof item === 'number' && Number.isFinite(item)))
    .map((item) => String(item).trim());
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

function expectedForEngine(entry, engineName) {
  if (!entry || typeof entry !== 'object') return undefined;
  const directKey = `${engineName}Expected`;
  if (entry[directKey] !== undefined) return entry[directKey];
  if (entry.expected && typeof entry.expected === 'object' && !Array.isArray(entry.expected)) {
    if (entry.expected[engineName] !== undefined) return entry.expected[engineName];
  }
  return entry.expected;
}

function queryForEngine(entry, engineName, fallback) {
  if (!entry || typeof entry !== 'object') return fallback;
  const directKey = `${engineName}Query`;
  if (typeof entry[directKey] === 'string' && entry[directKey].trim()) return entry[directKey].trim();
  if (entry.queries && typeof entry.queries === 'object') {
    const query = entry.queries[engineName];
    if (typeof query === 'string' && query.trim()) return query.trim();
  }
  return fallback;
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

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function qmdSearchArgs(config, query, limit) {
  const mode = ['search', 'query', 'vsearch'].includes(config.qmdMode) ? config.qmdMode : 'search';
  const args = [mode];
  if (config.qmdIndex) args.push('--index', config.qmdIndex);
  args.push(query, '-n', String(limit), '--json');
  if (config.qmdCollection) args.push('--collection', config.qmdCollection);
  return args;
}

function evalCommandResult(command, expected, dryRun) {
  const expectedMatch = dryRun
    ? { checked: expected !== undefined, matched: null, missing: [] }
    : matchExpected(`${command.stdout || ''}\n${command.stderr || ''}`, expected);
  return {
    ok: command.ok && (dryRun || !expectedMatch.checked || expectedMatch.matched),
    expected,
    expectedMatched: expectedMatch.checked ? expectedMatch.matched : undefined,
    missingExpected: expectedMatch.missing,
    command,
  };
}

function runGbrainEval(config, query, expected, dryRun, limit) {
  const command = runCommand(config.gbrainBin, ['search', query, '--limit', String(limit)], {
    cwd: config.gbrainDir,
    dryRun,
    timeoutMs: config.retrievalTimeoutMs,
  });
  return evalCommandResult(command, expected, dryRun);
}

function runQmdEval(config, query, expected, dryRun, limit) {
  const command = runCommand(config.qmdBin, qmdSearchArgs(config, query, limit), {
    dryRun,
    timeoutMs: config.retrievalTimeoutMs,
  });
  return evalCommandResult(command, expected, dryRun);
}

function parseJsonOutput(output) {
  try {
    return { ok: true, value: JSON.parse(output), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error.message };
  }
}

function parseGraphQueryOutput(output, seed) {
  const json = parseJsonOutput(output);
  if (json.ok && Array.isArray(json.value)) return json;

  const nodes = [];
  const stack = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const rootMatch = line.match(/^\[depth\s+(\d+)\]\s+(\S+)/);
    if (rootMatch) {
      const node = { slug: rootMatch[2], depth: Number.parseInt(rootMatch[1], 10), links: [] };
      nodes.push(node);
      stack[node.depth] = node;
      continue;
    }

    const edgeMatch = line.match(/^\s+--([a-z0-9_-]+)->\s+(\S+)\s+\(depth\s+(\d+)\)/i);
    if (!edgeMatch) continue;
    const depth = Number.parseInt(edgeMatch[3], 10);
    const parent = stack[depth - 1] || null;
    const node = {
      slug: edgeMatch[2],
      depth,
      links: parent ? [{
        from_slug: parent.slug,
        to_slug: edgeMatch[2],
        link_type: edgeMatch[1],
      }] : [],
    };
    nodes.push(node);
    stack[depth] = node;
  }

  if (nodes.length > 0) return { ok: true, value: nodes, error: null };
  if (/No edges found/i.test(String(output || '')) && seed) {
    return { ok: true, value: [{ slug: seed, depth: 0, links: [] }], error: null };
  }
  return { ok: false, value: null, error: json.error || 'Expected gbrain graph-query output' };
}

function summarizeCommand(command) {
  return {
    ok: command.ok,
    dryRun: command.dryRun,
    command: command.command,
    args: command.args,
    status: command.status,
    signal: command.signal,
    timedOut: command.timedOut,
    stdoutBytes: Buffer.byteLength(command.stdout || '', 'utf8'),
    stderrBytes: Buffer.byteLength(command.stderr || '', 'utf8'),
    stdoutSample: command.stdout ? command.stdout.slice(0, 500) : '',
    stderrSample: command.stderr ? command.stderr.slice(0, 1000) : '',
    error: command.error,
  };
}

function graphRecall(overrides = {}, options = {}) {
  const config = resolveConfig(overrides);
  const depth = positiveInteger(options.depth || overrides.depth, 2);
  const dryRun = options.dryRun === true;
  const seedValues = options.seeds || overrides.seeds || options.seed || overrides.seed;
  const seeds = asStringList(seedValues);
  const results = seeds.map((seed) => {
    const command = runCommand(config.gbrainBin, ['graph-query', seed, '--depth', String(depth)], {
      cwd: config.gbrainDir,
      dryRun,
      timeoutMs: config.retrievalTimeoutMs,
    });
    const parsed = dryRun ? { ok: true, value: [], error: null } : parseGraphQueryOutput(command.stdout || '', seed);
    const nodes = Array.isArray(parsed.value) ? parsed.value : [];
    const parseOk = parsed.ok && Array.isArray(parsed.value);
    return {
      seed,
      ok: command.ok && parseOk,
      depth,
      nodeCount: nodes.length,
      nodes,
      parseError: parseOk ? null : parsed.error || 'Expected gbrain graph-query output',
      command: summarizeCommand(command),
    };
  });

  return {
    config,
    dryRun,
    depth,
    seedCount: seeds.length,
    results,
    ok: seeds.length > 0 && results.every((result) => result.ok),
  };
}

function graphSeedsForEntry(entry) {
  if (!entry || typeof entry !== 'object') return [];
  return asStringList(
    entry.graphSeeds
      || entry.graphSeed
      || entry.gbrainGraphSeeds
      || (entry.graph && entry.graph.seeds)
      || (entry.graph && entry.graph.seed),
  );
}

function graphDepthForEntry(entry, fallback) {
  if (!entry || typeof entry !== 'object') return fallback;
  return positiveInteger(
    entry.graphDepth
      || entry.gbrainGraphDepth
      || (entry.graph && entry.graph.depth),
    fallback,
  );
}

function expectedForGraph(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  if (entry.graphExpected !== undefined) return entry.graphExpected;
  if (entry.gbrainGraphExpected !== undefined) return entry.gbrainGraphExpected;
  if (entry.expected && typeof entry.expected === 'object' && !Array.isArray(entry.expected)) {
    if (entry.expected.graph !== undefined) return entry.expected.graph;
    if (entry.expected.gbrainGraph !== undefined) return entry.expected.gbrainGraph;
    if (entry.expected.gbrain_graph !== undefined) return entry.expected.gbrain_graph;
  }
  return undefined;
}

function graphRecallText(recall) {
  return (recall.results || []).flatMap((result) => [
    `seed ${result.seed} nodes ${result.nodeCount}`,
    ...result.nodes.map((node) => {
      const links = Array.isArray(node.links)
        ? node.links.flatMap((link) => [
            link.from_slug,
            link.to_slug,
            link.link_type,
          ]).filter(Boolean)
        : [];
      return [
        node.slug,
        node.title,
        node.type,
        `depth:${node.depth}`,
        ...links,
      ].filter(Boolean).join(' ');
    }),
  ]).join('\n');
}

function runGraphEval(config, seeds, expected, dryRun, depth) {
  const recall = graphRecall(config, { seeds, depth, dryRun });
  const expectedMatch = dryRun
    ? { checked: expected !== undefined, matched: null, missing: [] }
    : matchExpected(graphRecallText(recall), expected);
  return {
    ok: recall.ok && (dryRun || !expectedMatch.checked || expectedMatch.matched),
    expected,
    expectedMatched: expectedMatch.checked ? expectedMatch.matched : undefined,
    missingExpected: expectedMatch.missing,
    recall,
  };
}

function summarizeEvalResults(results) {
  const summary = { overall: { passed: 0, failed: 0, skipped: 0 }, engines: {} };
  for (const result of results) {
    if (result.skipped) {
      summary.overall.skipped += 1;
    } else if (result.ok) {
      summary.overall.passed += 1;
    } else {
      summary.overall.failed += 1;
    }

    for (const [engineName, engineResult] of Object.entries(result.engines || {})) {
      if (!summary.engines[engineName]) summary.engines[engineName] = { passed: 0, failed: 0 };
      if (engineResult.ok) summary.engines[engineName].passed += 1;
      else summary.engines[engineName].failed += 1;
    }
  }
  return summary;
}

function runRetrievalEval(overrides = {}, options = {}) {
  const config = resolveConfig(overrides);
  const questions = readEvalQuestions(config);
  const dryRun = options.dryRun === true;
  const compareQmd = options.compareQmd === true;
  const compareGraph = options.compareGraph === true;
  const limit = positiveInteger(options.limit || overrides.limit || process.env.JARVOS_GBRAIN_EVAL_LIMIT, DEFAULT_RETRIEVAL_LIMIT);
  const graphDepth = positiveInteger(
    options.graphDepth || overrides.graphDepth || process.env.JARVOS_GBRAIN_GRAPH_DEPTH,
    2,
  );
  const results = questions.map((entry, index) => {
    const query = typeof entry === 'string' ? entry : entry.query;
    if (!query) {
      return { index, ok: false, skipped: true, reason: 'missing query' };
    }

    const gbrainQuery = typeof entry === 'object' ? queryForEngine(entry, 'gbrain', query) : query;
    const gbrainExpected = typeof entry === 'object' ? expectedForEngine(entry, 'gbrain') : undefined;
    const gbrainResult = runGbrainEval(config, gbrainQuery, gbrainExpected, dryRun, limit);
    const engines = { gbrain: gbrainResult };
    const engineQueries = { gbrain: gbrainQuery };
    let ok = gbrainResult.ok;

    if (compareQmd) {
      const qmdQuery = typeof entry === 'object' ? queryForEngine(entry, 'qmd', query) : query;
      const qmdExpected = typeof entry === 'object' ? expectedForEngine(entry, 'qmd') : undefined;
      const qmdResult = runQmdEval(config, qmdQuery, qmdExpected, dryRun, limit);
      engines.qmd = qmdResult;
      engineQueries.qmd = qmdQuery;
      ok = ok && qmdResult.ok;
    }

    if (compareGraph && typeof entry === 'object') {
      const graphSeeds = graphSeedsForEntry(entry);
      const graphExpected = expectedForGraph(entry);
      if (graphSeeds.length > 0 || graphExpected !== undefined) {
        const depth = graphDepthForEntry(entry, graphDepth);
        const graphResult = runGraphEval(config, graphSeeds, graphExpected, dryRun, depth);
        engines.gbrain_graph = graphResult;
        engineQueries.gbrain_graph = graphSeeds;
        ok = ok && graphResult.ok;
      }
    }

    return {
      index,
      query,
      ok,
      bucket: typeof entry === 'object' ? entry.bucket : undefined,
      engineQueries,
      expected: gbrainExpected,
      expectedMatched: gbrainResult.expectedMatched,
      missingExpected: gbrainResult.missingExpected,
      command: gbrainResult.command,
      engines,
    };
  });
  return {
    config,
    dryRun,
    compareQmd,
    compareGraph,
    limit,
    graphDepth,
    questionCount: questions.length,
    summary: summarizeEvalResults(results),
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
    { name: 'vaultDir', ok: fs.existsSync(config.vaultDir), detail: config.vaultDir },
    { name: 'notesDir', ok: fs.existsSync(config.notesDir), detail: config.notesDir },
    { name: 'manifest', ok: fs.existsSync(config.manifestPath), detail: config.manifestPath },
    { name: 'evalQuestions', ok: fs.existsSync(config.evalPath), detail: config.evalPath },
    { name: 'brainDir', ok: fs.existsSync(config.brainDir), detail: config.brainDir },
    { name: 'gbrainDir', ok: fs.existsSync(config.gbrainDir), detail: config.gbrainDir },
    { name: 'gbrainBin', ok: commandExists(config.gbrainBin), detail: config.gbrainBin },
    { name: 'qmdBin', ok: commandExists(config.qmdBin), detail: config.qmdBin, optional: true },
  ];
  return {
    config,
    checks,
    ok: checks.every((check) => check.ok || check.optional),
  };
}

module.exports = {
  TYPE_DIRS,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_EVAL_PATH,
  DEFAULT_QMD_BIN,
  DEFAULT_RETRIEVAL_TIMEOUT_MS,
  expandTilde,
  resolveConfig,
  slugify,
  normalizeType,
  createImportPlan,
  importToBrain,
  syncBrain,
  runRetrievalEval,
  graphRecall,
  doctor,
  renderBrainPage,
};
