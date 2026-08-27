'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MODULE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST_PATH = path.join(MODULE_ROOT, 'config', 'curated-import.json');
const DEFAULT_EVAL_PATH = path.join(MODULE_ROOT, 'config', 'eval-questions.json');
const DEFAULT_VAULT_DIR = path.join(os.homedir(), 'Documents', 'Vault v3');
const DEFAULT_BRAIN_DIR = path.join(os.homedir(), 'brain');
const DEFAULT_GBRAIN_DIR = path.join(os.homedir(), 'gbrain');
const DEFAULT_QMD_BIN = 'qmd';
const DEFAULT_GBRAIN_BIN_CANDIDATES = [
  'gbrain',
  path.join(os.homedir(), '.bun', 'bin', 'gbrain'),
];
const DEFAULT_RETRIEVAL_LIMIT = 5;
const DEFAULT_EVAL_LIMIT = 10;
const DEFAULT_RETRIEVAL_TIMEOUT_MS = 15000;
const MANAGED_RUNTIME_DESCRIPTOR_SCHEMA = 'jarvos-gbrain-runtime-descriptor/v1';
const MANAGED_GBRAIN_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
// Pinned GBrain v0.46.32.0 accepts these provider routing/storage variables.
// Managed invocation copies only this set (and forces GBRAIN_SWEEP=0); arbitrary
// ambient GBRAIN_* values and all values from provenance/receipts are excluded.
const MANAGED_GBRAIN_PROVIDER_ENV_KEYS = Object.freeze([
  'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE',
  'GBRAIN_SURFACE',
]);
const MANAGED_RUNTIME_DESCRIPTOR_KEYS = new Set([
  'schemaVersion',
  'executablePath',
  'sha256',
  'expectedOwnerUid',
  'expectedOwnerName',
  'version',
  'commit',
  'engineKind',
  'storeIdentity',
  'gbrainHome',
  'gbrainStore',
  'providerEnv',
  'interpreter',
  'skills',
]);
const MANAGED_INTERPRETER_KEYS = new Set([
  'executablePath',
  'sha256',
  'expectedOwnerUid',
  'expectedOwnerName',
]);
const MANAGED_SKILLS_KEYS = new Set([
  'directoryPath',
  'manifestSha256',
  'skillifySha256',
]);
const RETRIEVAL_EVAL_ARTIFACT_SCHEMA = 'jarvos-gbrain-retrieval-eval-artifact/v1';
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
  const gbrainHome = expandTilde(firstString(overrides.gbrainHome, gbrainDir));
  const gbrainStore = expandTilde(firstString(overrides.gbrainStore, overrides.gbrainDatabase, gbrainDir));
  const gbrainSkillsDir = expandTilde(firstString(overrides.gbrainSkillsDir));
  const managedRuntime = overrides.managedRuntime || overrides.managedGbrainRuntime || null;
  const managedProviderEnv = overrides.managedProviderEnv || overrides.providerEnv || managedRuntime?.providerEnv || null;
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
  const gbrainBin = expandTilde(
    firstString(overrides.gbrainBin, process.env.JARVOS_GBRAIN_BIN) || resolveDefaultGbrainBin(),
  );
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
    gbrainHome,
    gbrainStore,
    gbrainSkillsDir,
    managedRuntime,
    managedProviderEnv,
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
    summary ? `> ${summary}` : '> Imported from Obsidian by the jarvOS GBrain integration.',
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
    env: options.replaceEnv ? (options.env || {}) : { ...process.env, ...(options.env || {}) },
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
    errorCode: result.error?.code || null,
  };
}

function normalizedSha256(value) {
  const normalized = String(value || '').trim().replace(/^sha256:/i, '');
  return /^[a-f0-9]{64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function managedRuntimeEntry(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const entry = firstString(descriptor.executablePath, descriptor.sourceEntryPath, descriptor.entryPath);
  return entry && path.isAbsolute(entry) ? entry : null;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runtimeOwnerName(stat) {
  if (typeof process.getuid === 'function' && stat.uid === process.getuid()) {
    try {
      return os.userInfo().username || null;
    } catch {
      return null;
    }
  }
  return null;
}

function validateManagedRuntime(descriptor) {
  const entry = managedRuntimeEntry(descriptor);
  const expectedDigest = normalizedSha256(descriptor?.sha256 || descriptor?.expectedSha256);
  if (!entry || !expectedDigest) return { ok: false, failureClass: 'runtime-invalid-descriptor' };

  let executablePath;
  let stat;
  try {
    executablePath = fs.realpathSync(entry);
    stat = fs.statSync(executablePath);
  } catch {
    return { ok: false, failureClass: 'runtime-realpath-failed' };
  }
  if (!stat.isFile() || !isExecutable(executablePath)) return { ok: false, failureClass: 'runtime-not-executable' };
  if ((stat.mode & 0o022) !== 0) return { ok: false, failureClass: 'runtime-mode-unsafe' };

  const expectedUid = descriptor.expectedOwnerUid ?? descriptor.ownerUid;
  if (expectedUid !== undefined && Number(expectedUid) !== stat.uid) {
    return { ok: false, failureClass: 'runtime-owner-mismatch' };
  }
  const expectedOwnerName = firstString(descriptor.expectedOwnerName, descriptor.ownerName);
  if (expectedOwnerName) {
    const actualOwnerName = runtimeOwnerName(stat);
    if (!actualOwnerName) return { ok: false, failureClass: 'runtime-owner-unverified' };
    if (actualOwnerName !== expectedOwnerName) return { ok: false, failureClass: 'runtime-owner-mismatch' };
  }

  try {
    if (sha256File(executablePath) !== expectedDigest) {
      return { ok: false, failureClass: 'runtime-digest-mismatch' };
    }
  } catch {
    return { ok: false, failureClass: 'runtime-digest-unavailable' };
  }
  let interpreter = null;
  if (descriptor.interpreter !== undefined) {
    if (!descriptor.interpreter || typeof descriptor.interpreter !== 'object' || Array.isArray(descriptor.interpreter)
      || Object.keys(descriptor.interpreter).some((key) => !MANAGED_INTERPRETER_KEYS.has(key))) {
      return { ok: false, failureClass: 'runtime-interpreter-invalid-descriptor' };
    }
    interpreter = validateManagedRuntime({
      ...descriptor.interpreter,
      interpreter: undefined,
      storeIdentity: undefined,
      engineKind: undefined,
    });
    if (!interpreter.ok) {
      return { ok: false, failureClass: `runtime-interpreter-${interpreter.failureClass.replace(/^runtime-/, '')}` };
    }
  }
  const storeIdentity = descriptor.storeIdentity === undefined
    ? { ok: true, digest: null }
    : storeIdentityDigestFor(descriptor.engineKind, descriptor.storeIdentity);
  if (!storeIdentity.ok) return { ok: false, failureClass: 'runtime-store-identity-invalid' };
  return {
    ok: true,
    executablePath,
    launchCommand: interpreter?.executablePath || executablePath,
    launchArgsPrefix: interpreter ? [executablePath] : [],
    provenance: {
      ...managedRuntimeProvenance(descriptor, true, `sha256:${expectedDigest}`, storeIdentity.digest),
      interpreterDigest: interpreter?.provenance?.sourceDigest || null,
    },
  };
}

function neutralGbrainCwd() {
  try {
    return fs.realpathSync(os.tmpdir());
  } catch {
    return path.resolve(os.tmpdir());
  }
}

function managedGbrainEnv(config) {
  const supplied = config.managedProviderEnv || config.providerEnv || config.managedRuntime?.providerEnv || {};
  const env = {
    PATH: MANAGED_GBRAIN_PATH,
    HOME: process.env.HOME || os.homedir(),
    LANG: 'C',
    LC_ALL: 'C',
    GBRAIN_HOME: config.gbrainHome,
    GBRAIN_STORE: config.gbrainStore,
    // The pinned provider starts a maintenance sweep unless this kill switch is set.
    GBRAIN_SWEEP: '0',
  };
  if (path.isAbsolute(config.gbrainSkillsDir || '')) env.GBRAIN_SKILLS_DIR = config.gbrainSkillsDir;
  for (const key of MANAGED_GBRAIN_PROVIDER_ENV_KEYS) {
    const value = supplied[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  return env;
}

function validateManagedSkills(skills, expectedOwnerUid) {
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)
    || Object.keys(skills).some((key) => !MANAGED_SKILLS_KEYS.has(key))
    || !path.isAbsolute(skills.directoryPath || '')) {
    return { ok: false, failureClass: 'runtime-skills-invalid-descriptor' };
  }
  const expectedManifestDigest = normalizedSha256(skills.manifestSha256);
  const expectedSkillifyDigest = normalizedSha256(skills.skillifySha256);
  if (!expectedManifestDigest || !expectedSkillifyDigest) {
    return { ok: false, failureClass: 'runtime-skills-invalid-descriptor' };
  }

  let directoryPath;
  try {
    const directoryStat = fs.lstatSync(skills.directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o022) !== 0) {
      return { ok: false, failureClass: 'runtime-skills-mode-unsafe' };
    }
    if (expectedOwnerUid !== undefined && Number(expectedOwnerUid) !== directoryStat.uid) {
      return { ok: false, failureClass: 'runtime-skills-owner-mismatch' };
    }
    directoryPath = fs.realpathSync(skills.directoryPath);
  } catch {
    return { ok: false, failureClass: 'runtime-skills-unreadable' };
  }

  const manifestPath = path.join(directoryPath, 'manifest.json');
  const skillifyPath = path.join(directoryPath, 'skillify', 'SKILL.md');
  const validatedContents = new Map();
  for (const [filePath, expectedDigest] of [[manifestPath, expectedManifestDigest], [skillifyPath, expectedSkillifyDigest]]) {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
        return { ok: false, failureClass: 'runtime-skills-mode-unsafe' };
      }
      if (expectedOwnerUid !== undefined && Number(expectedOwnerUid) !== stat.uid) {
        return { ok: false, failureClass: 'runtime-skills-owner-mismatch' };
      }
      const contents = fs.readFileSync(filePath);
      if (crypto.createHash('sha256').update(contents).digest('hex') !== expectedDigest) {
        return { ok: false, failureClass: 'runtime-skills-digest-mismatch' };
      }
      validatedContents.set(filePath, contents);
    } catch {
      return { ok: false, failureClass: 'runtime-skills-unreadable' };
    }
  }
  try {
    const manifest = JSON.parse(validatedContents.get(manifestPath).toString('utf8'));
    const skillify = Array.isArray(manifest?.skills)
      ? manifest.skills.find((entry) => entry?.name === 'skillify')
      : null;
    if (skillify?.path !== 'skillify/SKILL.md') {
      return { ok: false, failureClass: 'runtime-skillify-unresolved' };
    }
  } catch {
    return { ok: false, failureClass: 'runtime-skills-manifest-invalid' };
  }
  return {
    ok: true,
    directoryPath,
    manifestDigest: `sha256:${expectedManifestDigest}`,
    skillifyDigest: `sha256:${expectedSkillifyDigest}`,
  };
}

function legacyGbrainProvenance() {
  return {
    managed: false,
    verified: false,
    continuityClaimed: false,
    selectedRuntimeVersion: null,
    selectedRuntimeCommit: null,
    sourceDigest: null,
    engineKind: null,
    canonicalStoreIdentityDigest: null,
  };
}

function managedRuntimeProvenance(descriptor, verified = false, sourceDigest = null, storeIdentityDigest = null) {
  return {
    managed: true,
    verified,
    continuityClaimed: false,
    selectedRuntimeVersion: firstString(descriptor?.version, descriptor?.runtimeVersion) || null,
    selectedRuntimeCommit: firstString(descriptor?.commit, descriptor?.runtimeCommit) || null,
    sourceDigest: sourceDigest || (normalizedSha256(descriptor?.sha256 || descriptor?.expectedSha256)
      ? `sha256:${normalizedSha256(descriptor.sha256 || descriptor.expectedSha256)}` : null),
    engineKind: firstString(descriptor?.engineKind) || null,
    canonicalStoreIdentityDigest: storeIdentityDigest || runtimeStoreIdentityDigest(descriptor),
    failureClass: null,
  };
}

function gbrainStatusConfig(config) {
  return {
    managedRuntime: Boolean(config.managedRuntime || config.managedGbrainRuntime),
    gbrainHomeConfigured: Boolean(config.gbrainHome),
    gbrainStoreConfigured: Boolean(config.gbrainStore),
    retrievalTimeoutMs: config.retrievalTimeoutMs,
  };
}

function runtimeStoreIdentityDigest(descriptor) {
  const supplied = normalizedSha256(descriptor?.canonicalStoreIdentityDigest || descriptor?.storeIdentityDigest);
  if (supplied) return `sha256:${supplied}`;
  if (descriptor?.storeIdentity === undefined) return null;
  return storeIdentityDigestFor(descriptor?.engineKind, descriptor.storeIdentity).digest || null;
}

function runGbrainCommand(config, args, options = {}) {
  const descriptor = config.managedRuntime || config.managedGbrainRuntime;
  if (!descriptor) {
    return {
      ...runCommand(config.gbrainBin, args, options),
      provenance: legacyGbrainProvenance(),
    };
  }
  if (!path.isAbsolute(config.gbrainHome || '') || !path.isAbsolute(config.gbrainStore || '')) {
    return redactManagedCommand({
      ok: false, dryRun: Boolean(options.dryRun), command: null, args, status: null, signal: null,
      timedOut: false, stdout: '', stderr: '', error: null, errorCode: null,
      failureClass: 'runtime-config-invalid', provenance: { ...managedRuntimeProvenance(descriptor), failureClass: 'runtime-config-invalid' },
    });
  }
  // This validation deliberately occurs on every invocation immediately before spawn.
  const runtime = validateManagedRuntime(descriptor);
  if (!runtime.ok) {
    return redactManagedCommand({
      ok: false, dryRun: Boolean(options.dryRun), command: null, args, status: null, signal: null,
      timedOut: false, stdout: '', stderr: '', error: null, errorCode: null,
      failureClass: runtime.failureClass, provenance: { ...managedRuntimeProvenance(descriptor), failureClass: runtime.failureClass },
    });
  }
  const result = runCommand(runtime.launchCommand, [...runtime.launchArgsPrefix, ...args], {
    ...options,
    cwd: neutralGbrainCwd(),
    env: managedGbrainEnv(config),
    replaceEnv: true,
  });
  const failureClass = result.ok ? null : (result.timedOut ? 'runtime-timeout' : 'runtime-command-failed');
  return redactManagedCommand({
    ...result,
    // Provider stderr and spawn errors can contain credentials, source paths, or config.
    stderr: '',
    error: null,
    provenance: { ...runtime.provenance, failureClass },
    ...(failureClass ? { failureClass } : {}),
  });
}

function loadManagedRuntimeDescriptor(descriptorPath) {
  if (typeof descriptorPath !== 'string' || !path.isAbsolute(descriptorPath)) {
    return { ok: false, failureClass: 'descriptor-path-invalid' };
  }
  let stat;
  let raw;
  try {
    stat = fs.lstatSync(descriptorPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, failureClass: 'descriptor-file-invalid' };
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return { ok: false, failureClass: 'descriptor-owner-mismatch' };
    }
    if ((stat.mode & 0o077) !== 0) return { ok: false, failureClass: 'descriptor-mode-unsafe' };
    if (stat.size < 2 || stat.size > 64 * 1024) return { ok: false, failureClass: 'descriptor-size-invalid' };
    raw = fs.readFileSync(descriptorPath, 'utf8');
  } catch {
    return { ok: false, failureClass: 'descriptor-unreadable' };
  }
  let descriptor;
  try {
    descriptor = JSON.parse(raw);
  } catch {
    return { ok: false, failureClass: 'descriptor-json-invalid' };
  }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || Object.keys(descriptor).some((key) => !MANAGED_RUNTIME_DESCRIPTOR_KEYS.has(key))
    || descriptor.schemaVersion !== MANAGED_RUNTIME_DESCRIPTOR_SCHEMA) {
    return { ok: false, failureClass: 'descriptor-schema-invalid' };
  }
  if (!path.isAbsolute(descriptor.gbrainHome || '') || !path.isAbsolute(descriptor.gbrainStore || '')) {
    return { ok: false, failureClass: 'descriptor-config-invalid' };
  }
  if (!descriptor.interpreter) return { ok: false, failureClass: 'descriptor-interpreter-required' };
  const providerEnv = descriptor.providerEnv === undefined ? {} : descriptor.providerEnv;
  if (!providerEnv || typeof providerEnv !== 'object' || Array.isArray(providerEnv)
    || Object.keys(providerEnv).some((key) => !MANAGED_GBRAIN_PROVIDER_ENV_KEYS.includes(key))
    || Object.values(providerEnv).some((value) => typeof value !== 'string' || !value)) {
    return { ok: false, failureClass: 'descriptor-provider-env-invalid' };
  }
  const runtime = validateManagedRuntime(descriptor);
  if (!runtime.ok) return { ok: false, failureClass: runtime.failureClass };
  const skills = validateManagedSkills(descriptor.skills, descriptor.expectedOwnerUid);
  if (!skills.ok) return skills;
  return { ok: true, descriptor, runtime, skills };
}

function prepareManagedGbrainProvider(descriptorPath) {
  const loaded = loadManagedRuntimeDescriptor(descriptorPath);
  if (!loaded.ok) return loaded;
  const config = resolveConfig({
    managedRuntime: loaded.descriptor,
    managedProviderEnv: loaded.descriptor.providerEnv || {},
    gbrainHome: loaded.descriptor.gbrainHome,
    gbrainStore: loaded.descriptor.gbrainStore,
    gbrainSkillsDir: loaded.skills.directoryPath,
  });
  return {
    ok: true,
    command: loaded.runtime.launchCommand,
    args: [...loaded.runtime.launchArgsPrefix, 'serve'],
    cwd: neutralGbrainCwd(),
    env: managedGbrainEnv(config),
    provenance: {
      ...loaded.runtime.provenance,
      skillsManifestDigest: loaded.skills.manifestDigest,
      skillifyDigest: loaded.skills.skillifyDigest,
    },
  };
}

function redactManagedCommand(command) {
  return { ...command, command: null, args: [] };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function canonicalStoreIdentity(engineKind, value) {
  const engine = firstString(engineKind)?.toLowerCase();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  if (engine === 'postgres') {
    const allowed = new Set(['host', 'port', 'database', 'pageCount', 'chunkCount', 'documentCount']);
    if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false };
    if (typeof value.host !== 'string' || !/^[a-z0-9.-]+$/i.test(value.host)
      || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.database !== 'string' || !/^[a-z0-9_-]+$/i.test(value.database)) return { ok: false };
    return { ok: true, value: { host: value.host.toLowerCase(), port: value.port, database: value.database } };
  }
  if (engine === 'pglite') {
    const allowed = new Set(['storePathDigest', 'pageCount', 'chunkCount', 'documentCount']);
    if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false };
    const storePathDigest = normalizedSha256(value.storePathDigest);
    return storePathDigest ? { ok: true, value: { storePathDigest: `sha256:${storePathDigest}` } } : { ok: false };
  }
  return { ok: false };
}

function storeIdentityDigestFor(engineKind, storeIdentity) {
  const engine = firstString(engineKind)?.toLowerCase();
  const canonical = canonicalStoreIdentity(engine, storeIdentity);
  if (!engine || !canonical.ok) return { ok: false, digest: null };
  return {
    ok: true,
    digest: `sha256:${crypto.createHash('sha256')
      .update(stableJson({ engineKind: engine, storeIdentity: canonical.value }))
      .digest('hex')}`,
  };
}

function deriveStableBrainIdentity({ engineKind, storeIdentity, sentinelDigest } = {}) {
  const engine = firstString(engineKind);
  const sentinel = firstString(sentinelDigest);
  if (!engine || !sentinel || !storeIdentity || typeof storeIdentity !== 'object') {
    return { ok: false, failureClass: 'identity-input-invalid' };
  }
  const store = storeIdentityDigestFor(engine, storeIdentity);
  if (!store.ok) return { ok: false, failureClass: 'store-identity-invalid' };
  const logicalBrainDigest = `sha256:${crypto.createHash('sha256')
    .update(stableJson({ namespace: 'jarvos/gbrain/logical-brain/v1', sentinelDigest: sentinel }))
    .digest('hex')}`;
  return {
    ok: true,
    engineKind: engine,
    storeIdentityDigest: store.digest,
    sentinelDigest: sentinel,
    logicalBrainDigest,
  };
}

function syncBrain(overrides = {}, options = {}) {
  const config = resolveConfig(overrides);
  const sync = runGbrainCommand(config, ['sync', '--repo', config.brainDir], {
    cwd: config.gbrainDir,
    dryRun: options.dryRun === true,
  });
  const embed = sync.ok
    ? runGbrainCommand(config, ['embed', '--stale'], {
        cwd: config.gbrainDir,
        dryRun: options.dryRun === true,
      })
    : null;
  return { config: gbrainStatusConfig(config), sync, embed, ok: sync.ok && (!embed || embed.ok) };
}

function readEvalQuestions(config) {
  const data = readJsonFile(config.evalPath, { version: 1, questions: [] });
  return Array.isArray(data.questions)
    ? data.questions.filter((question) => !(question && typeof question === 'object' && question.include === false))
    : [];
}

function digest(value) {
  const serialized = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(value);
  return `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`;
}

function stableQuestionId(entry, index) {
  const ordinal = String(index + 1).padStart(2, '0');
  return `question-${ordinal}-${digest(entry).slice(7, 19)}`;
}

function commandCandidateDigests(command, engine) {
  const output = String(command?.stdout || command?.stdoutSample || '').trim();
  if (!output) return [];
  const parsed = parseJsonOutput(output);
  const parsedRows = parsed.ok
    ? Array.isArray(parsed.value)
      ? parsed.value
      : Array.isArray(parsed.value?.results)
        ? parsed.value.results
        : Array.isArray(parsed.value?.items)
          ? parsed.value.items
          : Array.isArray(parsed.value?.matches)
            ? parsed.value.matches
            : parsed.value && typeof parsed.value === 'object' ? [parsed.value] : []
    : [];
  const rows = parsedRows.length ? parsedRows : output.split(/\r?\n/).filter(Boolean);
  return rows.slice(0, 50).map((row, index) => {
    const identity = row && typeof row === 'object'
      ? {
        file: row.file || row.path || row.uri || null,
        title: row.title || null,
        docid: row.docid || row.id || null,
        slug: row.slug || null,
      }
      : String(row);
    return { rank: index + 1, candidateDigest: digest({ engine, identity }) };
  });
}

function graphCandidateDigests(graph) {
  return (graph?.results || []).flatMap((result) => (result.nodes || []).map((node, index) => ({
    rank: index + 1,
    candidateDigest: digest({
      engine: 'gbrain_graph',
      seed: result.seed || null,
      slug: node.slug || null,
      title: node.title || null,
      type: node.type || null,
      depth: node.depth ?? null,
    }),
  })));
}

function actualCandidateDigests(engineName, engineResult) {
  if (!engineResult || typeof engineResult !== 'object') return [];
  if (engineName === 'gbrain_graph') return graphCandidateDigests(engineResult.recall);
  if (engineName === 'gbrain_recall') {
    const bundle = engineResult.bundle || {};
    return [
      ...commandCandidateDigests(bundle.engines?.gbrain?.command, 'gbrain'),
      ...commandCandidateDigests(bundle.engines?.qmd?.command, 'qmd'),
      ...graphCandidateDigests(bundle.graph),
    ];
  }
  return commandCandidateDigests(engineResult.command, engineName);
}

function expectedCandidateDigests(engineName, engineResult) {
  if (!engineResult || typeof engineResult !== 'object') return [];
  const values = engineName === 'gbrain_recall'
    ? engineResult.expectedCandidates
    : engineResult.expected === undefined ? [] : [engineResult.expected];
  return (values || []).map((value) => digest(value));
}

function engineFailureReason(engineName, engineResult) {
  if (!engineResult || typeof engineResult !== 'object') return 'missing-engine';
  if (engineResult.failureReason) return engineResult.failureReason;
  if (engineName === 'gbrain_recall') {
    const nestedReason = engineResult.bundle?.engines?.gbrain?.failureReason
      || engineResult.bundle?.engines?.qmd?.failureReason;
    if (nestedReason) return nestedReason;
  }
  const commands = engineName === 'gbrain_recall'
    ? [engineResult.bundle?.engines?.gbrain?.command, engineResult.bundle?.engines?.qmd?.command]
    : engineName === 'gbrain_graph'
      ? (engineResult.recall?.results || []).map((result) => result.command)
      : [engineResult.command];
  if (commands.some((command) => command?.errorCode === 'ENOENT')) return 'missing-engine';
  if (commands.some((command) => command?.timedOut)) return 'timeout';
  if (commands.some((command) => command && command.ok === false)) return 'engine-command-failed';
  if (engineResult.parseError || engineResult.recall?.results?.some((result) => result.parseError)) return 'malformed-result';
  if (actualCandidateDigests(engineName, engineResult).length === 0) return 'empty-candidate-set';
  if (engineResult.expectedMatched === false) return 'expected-candidate-missing';
  return 'engine-failed';
}

function healthBearingEngines(result, { compareQmd, compareGraph, compareRecall }) {
  if (compareRecall) {
    return [
      'gbrain_recall',
      ...(compareQmd ? ['qmd'] : []),
      ...(compareGraph && result.engines?.gbrain_graph ? ['gbrain_graph'] : []),
    ];
  }
  return ['gbrain', ...(compareQmd ? ['qmd'] : []), ...(compareGraph && result.engines?.gbrain_graph ? ['gbrain_graph'] : [])];
}

function sourceRevision() {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: path.resolve(MODULE_ROOT, '../..'),
    encoding: 'utf8',
    timeout: 10_000,
  });
  const revision = String(result.stdout || '').trim().toLowerCase();
  return result.status === 0 && /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}

function buildRetrievalEvalArtifact({ questions, results, summary, compareQmd, compareGraph, compareRecall, now = new Date(), publicRevision = null, runtimeRevision = null }) {
  const failures = [];
  for (const [index, result] of results.entries()) {
    if (result.skipped || !result.query) {
      failures.push({
        questionId: stableQuestionId(questions[index], index),
        engine: 'evaluation',
        failureReason: result.reason || 'missing-query',
        expectedCandidateDigests: [],
        actualCandidateDigests: [],
      });
      continue;
    }
    for (const engine of healthBearingEngines(result, { compareQmd, compareGraph, compareRecall })) {
      const engineResult = result.engines?.[engine];
      if (engineResult?.ok === true) continue;
      failures.push({
        questionId: stableQuestionId(questions[index], index),
        engine,
        failureReason: engineFailureReason(engine, engineResult),
        expectedCandidateDigests: expectedCandidateDigests(engine, engineResult),
        actualCandidateDigests: actualCandidateDigests(engine, engineResult),
      });
    }
  }
  const artifact = {
    schema: RETRIEVAL_EVAL_ARTIFACT_SCHEMA,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    corpusDigest: digest({ questions }),
    questionCount: questions.length,
    publicRevision,
    runtimeRevision,
    compareQmd,
    compareGraph,
    compareRecall,
    summary,
    failures,
  };
  return { ...artifact, artifactDigest: digest(artifact) };
}

function writePrivateArtifact(filePath, artifact, fsImpl = fs) {
  const resolved = path.resolve(filePath);
  fsImpl.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  try {
    if (fsImpl.lstatSync(resolved).isSymbolicLink()) throw new Error('artifact-target-symlinked');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    fsImpl.chmodSync?.(temporary, 0o600);
    fsImpl.renameSync(temporary, resolved);
    fsImpl.chmodSync?.(resolved, 0o600);
  } catch (error) {
    try { fsImpl.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
  return resolved;
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

function hasGenericExpectedClauses(expected) {
  const clauses = expectedClauses(expected);
  return !!clauses && (clauses.all.length > 0 || clauses.any.length > 0);
}

function expectedForEngine(entry, engineName) {
  if (!entry || typeof entry !== 'object') return undefined;
  const directKey = `${engineName}Expected`;
  if (entry[directKey] !== undefined) return entry[directKey];
  if (entry.expected && typeof entry.expected === 'object' && !Array.isArray(entry.expected)) {
    if (entry.expected[engineName] !== undefined) return entry.expected[engineName];
    if (hasEngineSpecificExpected(entry.expected) && !hasGenericExpectedClauses(entry.expected)) return undefined;
  }
  return entry.expected;
}

function hasEngineSpecificExpected(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  return [
    'gbrain',
    'qmd',
    'graph',
    'gbrainGraph',
    'gbrain_graph',
    'recall',
    'gbrainRecall',
    'gbrain_recall',
  ].some((key) => expected[key] !== undefined);
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
  const canonicalHaystack = canonicalMatchText(output);
  const includesNeedle = (needle) => {
    const rawNeedle = String(needle || '').toLowerCase();
    if (rawNeedle && haystack.includes(rawNeedle)) return true;
    const canonicalNeedle = canonicalMatchText(needle);
    return Boolean(canonicalNeedle) && canonicalHaystack.includes(canonicalNeedle);
  };
  const missingAll = clauses.all.filter((needle) => !includesNeedle(needle));
  const anyMatched = clauses.any.length === 0
    || clauses.any.some((needle) => includesNeedle(needle));
  const missingAny = anyMatched || clauses.any.length === 0 ? [] : clauses.any;

  return {
    checked: true,
    matched: missingAll.length === 0 && anyMatched,
    missing: [...missingAll, ...missingAny],
  };
}

function canonicalMatchText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
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
  const command = runGbrainCommand(config, ['search', query, '--limit', String(limit)], {
    cwd: config.gbrainDir,
    dryRun,
    timeoutMs: config.retrievalTimeoutMs,
  });
  const result = {
    ...evalCommandResult(command, expected, dryRun),
    command: summarizeCommand(command, { sanitized: true }),
    provenance: command.provenance || legacyGbrainProvenance(),
    answeredByGbrain: command.ok && (dryRun || Boolean(String(command.stdout || '').trim())),
  };
  if (!dryRun && command.ok && !String(command.stdout || '').trim()) {
    return { ...result, ok: false, failureReason: 'empty-candidate-set' };
  }
  if (!command.ok) return { ...result, failureReason: gbrainFailureClass(command) };
  return result;
}

function runQmdEval(config, query, expected, dryRun, limit) {
  const command = runCommand(config.qmdBin, qmdSearchArgs(config, query, limit), {
    dryRun,
    timeoutMs: config.retrievalTimeoutMs,
  });
  const result = evalCommandResult(command, expected, dryRun);
  const admission = qmdCommandAdmission(command, dryRun);
  return { ...result, ...admission, ok: result.ok && admission.ok };
}

function parseJsonOutput(output) {
  try {
    return { ok: true, value: JSON.parse(output), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error.message };
  }
}

function qmdCommandAdmission(command, dryRun = false) {
  if (dryRun) return { ok: true, resultCount: null };
  if (!command.ok) return { ok: false, failureReason: command.errorCode === 'ENOENT' ? 'missing-engine' : command.timedOut ? 'timeout' : 'engine-command-failed', resultCount: 0 };
  if (!String(command.stdout || '').trim()) return { ok: false, failureReason: 'empty-candidate-set', resultCount: 0 };
  if (/^No results found\.?$/i.test(String(command.stdout).trim())) return { ok: false, failureReason: 'empty-candidate-set', resultCount: 0 };
  const parsed = parseJsonOutput(command.stdout);
  if (!parsed.ok) return { ok: false, failureReason: 'malformed-result', resultCount: 0 };
  const rows = Array.isArray(parsed.value)
    ? parsed.value
    : Array.isArray(parsed.value?.results)
      ? parsed.value.results
      : Array.isArray(parsed.value?.items)
        ? parsed.value.items
        : Array.isArray(parsed.value?.matches)
          ? parsed.value.matches
          : parsed.value && typeof parsed.value === 'object' ? [parsed.value] : [];
  return rows.length > 0
    ? { ok: true, resultCount: rows.length }
    : { ok: false, failureReason: 'empty-candidate-set', resultCount: 0 };
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

function summarizeCommand(command, options = {}) {
  const sanitized = options.sanitized === true;
  return {
    ok: command.ok,
    dryRun: command.dryRun,
    command: sanitized ? null : command.command,
    args: sanitized ? [] : command.args,
    status: command.status,
    signal: command.signal,
    timedOut: command.timedOut,
    stdoutBytes: Buffer.byteLength(command.stdout || '', 'utf8'),
    stderrBytes: sanitized ? 0 : Buffer.byteLength(command.stderr || '', 'utf8'),
    stdoutSample: sanitized ? '' : (command.stdout ? command.stdout.slice(0, 500) : ''),
    stderrSample: sanitized ? '' : (command.stderr ? command.stderr.slice(0, 1000) : ''),
    error: sanitized ? null : command.error,
    errorCode: sanitized ? null : (command.errorCode || null),
    ...(command.provenance ? { provenance: command.provenance } : {}),
    ...(command.failureClass ? { failureClass: command.failureClass } : {}),
  };
}

function gbrainFailureClass(command) {
  if (command.failureClass) return command.failureClass;
  if (command.errorCode === 'ENOENT') return 'missing-engine';
  if (command.timedOut) return 'timeout';
  return 'engine-command-failed';
}

function graphRecall(overrides = {}, options = {}) {
  const config = resolveConfig(overrides);
  const depth = positiveInteger(options.depth || overrides.depth, 2);
  const dryRun = options.dryRun === true;
  const seedValues = options.seeds || overrides.seeds || options.seed || overrides.seed;
  const seeds = asStringList(seedValues);
  const results = seeds.map((seed) => {
    const command = runGbrainCommand(config, ['graph-query', seed, '--depth', String(depth)], {
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
      command: summarizeCommand(command, { sanitized: true }),
      provenance: command.provenance || legacyGbrainProvenance(),
      ...(command.ok ? {} : { failureClass: gbrainFailureClass(command) }),
    };
  });

  return {
    config: gbrainStatusConfig(config),
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

function expectedForRecall(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  if (entry.recallExpected !== undefined) return entry.recallExpected;
  if (entry.gbrainRecallExpected !== undefined) return entry.gbrainRecallExpected;
  if (entry.expected && typeof entry.expected === 'object' && !Array.isArray(entry.expected)) {
    if (entry.expected.recall !== undefined) return entry.expected.recall;
    if (entry.expected.gbrainRecall !== undefined) return entry.expected.gbrainRecall;
    if (entry.expected.gbrain_recall !== undefined) return entry.expected.gbrain_recall;
  }
  return undefined;
}

function recallExpectedCandidates(entry) {
  const explicit = expectedForRecall(entry);
  if (explicit !== undefined) return [explicit];
  if (!entry || typeof entry !== 'object') return [];

  const candidates = [];
  const gbrainExpected = expectedForEngine(entry, 'gbrain');
  const qmdExpected = expectedForEngine(entry, 'qmd');
  const graphExpected = expectedForGraph(entry);
  for (const expected of [gbrainExpected, qmdExpected, graphExpected]) {
    if (expected !== undefined) candidates.push(expected);
  }
  return candidates;
}

function matchAnyExpected(output, expectedCandidates) {
  const candidates = Array.isArray(expectedCandidates)
    ? expectedCandidates.filter((expected) => expected !== undefined)
    : [];
  if (candidates.length === 0) return { checked: false, matched: true, missing: [] };

  const matches = candidates.map((expected) => matchExpected(output, expected));
  const checked = matches.some((match) => match.checked);
  if (!checked) return { checked: false, matched: true, missing: [] };

  const matched = matches.some((match) => match.checked && match.matched);
  return {
    checked: true,
    matched,
    missing: matched ? [] : [...new Set(matches.flatMap((match) => match.missing || []))],
  };
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

function truncateText(value, maxChars) {
  const text = String(value || '').trim();
  const limit = positiveInteger(maxChars, 4000);
  if (text.length <= limit) return text;
  const headLength = Math.max(1, limit - 20);
  return `${text.slice(0, headLength).trimEnd()}\n... [truncated]`;
}

function uniqueStrings(values) {
  return [...new Set(asStringList(values))];
}

function extractGbrainSearchSlugs(output, limit) {
  const slugs = [];
  const max = positiveInteger(limit, 2);
  const slugPattern = /\b(?:people|companies|projects|concepts|meetings|sources|notes)\/[a-z0-9][a-z0-9_-]*\b/ig;
  for (const line of String(output || '').split(/\r?\n/)) {
    const matches = line.match(slugPattern) || [];
    for (const match of matches) {
      slugs.push(match);
      if (uniqueStrings(slugs).length >= max) return uniqueStrings(slugs).slice(0, max);
    }
  }
  return uniqueStrings(slugs).slice(0, max);
}

function markdownFenceFor(text) {
  const runs = String(text || '').match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function pushFencedText(lines, info, text) {
  const fence = markdownFenceFor(text);
  lines.push('', `${fence}${info}`, text, fence);
}

function renderRecallMarkdown(bundle) {
  const lines = [
    '# jarvOS Recall Bundle',
    '',
    `Query: ${bundle.query || '(missing)'}`,
    '',
    '## Direct GBrain Search',
    '',
  ];

  const gbrain = bundle.engines?.gbrain;
  lines.push(`Status: ${gbrain?.ok ? 'ok' : 'failed'}`);
  if (gbrain?.text) {
    pushFencedText(lines, 'text', gbrain.text);
  }

  if (bundle.engines?.qmd) {
    lines.push('', '## QMD Broad Lookup', '', `Status: ${bundle.engines.qmd.ok ? 'ok' : 'failed'}`);
    if (bundle.engines.qmd.text) {
      pushFencedText(lines, 'text', bundle.engines.qmd.text);
    }
  }

  if (bundle.graph) {
    lines.push('', '## GBrain Graph Sidecar', '', `Status: ${bundle.graph.ok ? 'ok' : 'failed'}`);
    for (const result of bundle.graph.results || []) {
      lines.push('', `Seed: ${result.seed} (${result.nodeCount} nodes)`);
      for (const node of result.nodes || []) {
        lines.push(`- ${node.slug}${node.title ? ` - ${node.title}` : ''}${node.depth !== undefined ? ` (depth ${node.depth})` : ''}`);
      }
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

function recallBundle(overrides = {}, options = {}) {
  const config = resolveConfig(overrides);
  const query = firstString(options.query, overrides.query);
  const dryRun = options.dryRun === true;
  const limit = positiveInteger(options.limit || overrides.limit || process.env.JARVOS_RECALL_LIMIT, DEFAULT_RETRIEVAL_LIMIT);
  const includeQmd = options.includeQmd !== false && overrides.includeQmd !== false;
  const autoGraph = options.autoGraph !== false && overrides.autoGraph !== false;
  const graphDepth = positiveInteger(
    options.graphDepth || overrides.graphDepth || process.env.JARVOS_GBRAIN_GRAPH_DEPTH,
    2,
  );
  const graphSeedLimit = positiveInteger(
    options.graphSeedLimit || overrides.graphSeedLimit || process.env.JARVOS_GBRAIN_GRAPH_SEED_LIMIT,
    2,
  );
  const maxChars = positiveInteger(options.maxChars || overrides.maxChars || process.env.JARVOS_RECALL_MAX_CHARS, 4000);

  if (!query) {
    return {
      config,
      ok: false,
      dryRun,
      error: 'missing query',
      query: null,
      engines: {},
      graph: null,
      markdown: renderRecallMarkdown({ query: null, engines: {}, graph: null }),
    };
  }

  const gbrainCommand = runGbrainCommand(config, ['search', query, '--limit', String(limit)], {
    cwd: config.gbrainDir,
    dryRun,
    timeoutMs: config.retrievalTimeoutMs,
  });
  const engines = {
    gbrain: {
      ok: gbrainCommand.ok && (dryRun || Boolean(String(gbrainCommand.stdout || '').trim())),
      text: gbrainCommand.ok ? truncateText(gbrainCommand.stdout || '', maxChars) : '',
      command: summarizeCommand(gbrainCommand, { sanitized: true }),
      provenance: gbrainCommand.provenance || legacyGbrainProvenance(),
      answeredByGbrain: gbrainCommand.ok && (dryRun || Boolean(String(gbrainCommand.stdout || '').trim())),
      ...(!dryRun && gbrainCommand.ok && !String(gbrainCommand.stdout || '').trim() ? { failureReason: 'empty-candidate-set' } : {}),
      ...(!gbrainCommand.ok ? { failureReason: gbrainFailureClass(gbrainCommand), failureClass: gbrainFailureClass(gbrainCommand) } : {}),
    },
  };

  if (includeQmd) {
    const qmdCommand = runCommand(config.qmdBin, qmdSearchArgs(config, query, limit), {
      dryRun,
      timeoutMs: config.retrievalTimeoutMs,
    });
    const qmdAdmission = qmdCommandAdmission(qmdCommand, dryRun);
    engines.qmd = {
      ok: qmdAdmission.ok,
      text: truncateText(`${qmdCommand.stdout || ''}\n${qmdCommand.stderr || ''}`, maxChars),
      command: summarizeCommand(qmdCommand),
      resultCount: qmdAdmission.resultCount,
      ...(qmdAdmission.failureReason ? { failureReason: qmdAdmission.failureReason } : {}),
    };
  }

  const explicitSeeds = asStringList(options.seeds || overrides.seeds || options.seed || overrides.seed);
  const discoveredSeeds = autoGraph && gbrainCommand.ok
    ? extractGbrainSearchSlugs(gbrainCommand.stdout, graphSeedLimit)
    : [];
  const seeds = uniqueStrings([...explicitSeeds, ...discoveredSeeds]).slice(0, graphSeedLimit);
  const graph = seeds.length > 0
    ? graphRecall(config, { seeds, depth: graphDepth, dryRun })
    : null;

  const bundle = {
    config: gbrainStatusConfig(config),
    ok: engines.gbrain.ok
      && (!includeQmd || engines.qmd.ok || engines.qmd.failureReason === 'empty-candidate-set')
      && (!graph || graph.ok),
    dryRun,
    query,
    limit,
    includeQmd,
    autoGraph,
    graphDepth,
    graphSeedLimit,
    graphSeeds: seeds,
    engines,
    graph,
    provenance: {
      gbrain: {
        ...(gbrainCommand.provenance || legacyGbrainProvenance()),
        answeredByGbrain: engines.gbrain.answeredByGbrain,
        failureClass: engines.gbrain.failureClass || null,
      },
    },
  };
  return {
    ...bundle,
    markdown: renderRecallMarkdown(bundle),
  };
}

function runRecallEval(config, entry, query, expectedCandidates, dryRun, limit, graphDepth, graphSeedLimit) {
  const seeds = typeof entry === 'object' ? graphSeedsForEntry(entry) : [];
  const depth = typeof entry === 'object' ? graphDepthForEntry(entry, graphDepth) : graphDepth;
  const bundle = recallBundle(config, {
    dryRun,
    query,
    includeQmd: true,
    autoGraph: true,
    seeds,
    graphDepth: depth,
    graphSeedLimit: Math.max(positiveInteger(graphSeedLimit, 2), seeds.length || 0),
    limit,
  });
  const expectedMatch = dryRun
    ? { checked: expectedCandidates.length > 0, matched: null, missing: [] }
    : matchAnyExpected(bundle.markdown, expectedCandidates);
  return {
    ok: bundle.ok && (dryRun || !expectedMatch.checked || expectedMatch.matched),
    expectedCandidates,
    expectedMatched: expectedMatch.checked ? expectedMatch.matched : undefined,
    missingExpected: expectedMatch.missing,
    bundle,
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
  const compareRecall = options.compareRecall === true;
  const limit = positiveInteger(options.limit || overrides.limit || process.env.JARVOS_GBRAIN_EVAL_LIMIT, DEFAULT_EVAL_LIMIT);
  const graphDepth = positiveInteger(
    options.graphDepth || overrides.graphDepth || process.env.JARVOS_GBRAIN_GRAPH_DEPTH,
    2,
  );
  const graphSeedLimit = positiveInteger(
    options.graphSeedLimit || overrides.graphSeedLimit || process.env.JARVOS_GBRAIN_GRAPH_SEED_LIMIT,
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

    if (compareRecall) {
      const recallQuery = typeof entry === 'object' ? queryForEngine(entry, 'recall', query) : query;
      const expectedCandidates = recallExpectedCandidates(entry);
      const recallResult = runRecallEval(
        config,
        entry,
        recallQuery,
        expectedCandidates,
        dryRun,
        limit,
        graphDepth,
        graphSeedLimit,
      );
      engines.gbrain_recall = recallResult;
      engineQueries.gbrain_recall = recallQuery;
      ok = recallResult.ok;
      if (engines.qmd) ok = ok && engines.qmd.ok;
      if (engines.gbrain_graph) ok = ok && engines.gbrain_graph.ok;
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
  const summary = summarizeEvalResults(results);
  const evaluationOk = results.every((result) => result.ok || result.skipped);
  const artifactPath = firstString(options.artifactPath, overrides.artifactPath);
  const publicRevision = firstString(options.publicRevision, overrides.publicRevision) || sourceRevision();
  const runtimeRevision = firstString(options.runtimeRevision, overrides.runtimeRevision, process.env.OPENCLAW_RUNTIME_REVISION);
  let artifact = null;
  if (artifactPath) {
    if (!/^[0-9a-f]{40}$/i.test(String(publicRevision || '')) || !/^[0-9a-f]{40}$/i.test(String(runtimeRevision || ''))) {
      artifact = { ok: false, path: path.resolve(artifactPath), reason: 'artifact-revision-unavailable' };
    } else {
      const record = buildRetrievalEvalArtifact({
        questions,
        results,
        summary,
        compareQmd,
        compareGraph,
        compareRecall,
        now: options.now || new Date(),
        publicRevision: publicRevision.toLowerCase(),
        runtimeRevision: runtimeRevision.toLowerCase(),
      });
      try {
        const writtenPath = writePrivateArtifact(artifactPath, record, options.fsImpl || fs);
        artifact = { ok: true, path: writtenPath, digest: record.artifactDigest, failureCount: record.failures.length };
      } catch (_) {
        artifact = { ok: false, path: path.resolve(artifactPath), reason: 'artifact-write-failed' };
      }
    }
  }
  return {
    config: gbrainStatusConfig(config),
    dryRun,
    compareQmd,
    compareGraph,
    compareRecall,
    limit,
    graphDepth,
    graphSeedLimit,
    questionCount: questions.length,
    corpusDigest: digest({ questions }),
    publicRevision,
    runtimeRevision,
    summary,
    results,
    artifact,
    ok: evaluationOk && (!artifact || artifact.ok),
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

// The `gbrain` CLI is commonly installed via `bun install -g`, which places
// it under ~/.bun/bin. That directory is not on PATH in every process that
// runs this doctor check (e.g. cron/agent sessions with a minimal PATH), so
// a bare PATH lookup for 'gbrain' spuriously reports the CLI as missing.
// Fall back to the known bun-link location before giving up.
function resolveDefaultGbrainBin() {
  return DEFAULT_GBRAIN_BIN_CANDIDATES.find((candidate) => commandExists(candidate))
    || DEFAULT_GBRAIN_BIN_CANDIDATES[0];
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
  DEFAULT_EVAL_LIMIT,
  DEFAULT_RETRIEVAL_TIMEOUT_MS,
  RETRIEVAL_EVAL_ARTIFACT_SCHEMA,
  expandTilde,
  resolveConfig,
  slugify,
  normalizeType,
  createImportPlan,
  importToBrain,
  syncBrain,
  validateManagedRuntime,
  loadManagedRuntimeDescriptor,
  prepareManagedGbrainProvider,
  runGbrainCommand,
  deriveStableBrainIdentity,
  runRetrievalEval,
  graphRecall,
  recallBundle,
  renderRecallMarkdown,
  doctor,
  renderBrainPage,
};
