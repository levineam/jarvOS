'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  DEFAULT_NOTES_SECTION,
  sanitizeTitle,
  verifyNoteCaptureContract,
} = require('./note-contract');

const MODULE_ROOT = path.resolve(__dirname, '..');
const JARVOS_ROOT = path.resolve(MODULE_ROOT, '..', '..');
const DEFAULT_PAPERCLIP_PROJECT_ID = '3ba24079-15f4-48a5-aef3-24aa742d1177';
const DEFAULT_HYDRATION_MAX_CHARS = 12000;
const DEFAULT_HYDRATION_STATUSES = ['in_progress', 'in_review'];
const DEFAULT_CURRENT_WORK_STATUSES = ['in_progress', 'todo', 'blocked'];
const ONTOLOGY_FILES = [
  '1-higher-order.md',
  '4-core-self.md',
  '5-goals.md',
  '6-projects.md',
];

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

function loadModule(packageName, fallbackPath) {
  try {
    return require(require.resolve(packageName, { paths: [process.cwd(), MODULE_ROOT] }));
  } catch {
    return require(fallbackPath);
  }
}

function loadJarvosPaths() {
  return loadModule(
    '@jarvos/secondbrain/bridge/config/jarvos-paths.js',
    path.join(JARVOS_ROOT, 'modules', 'jarvos-secondbrain', 'bridge', 'config', 'jarvos-paths.js'),
  );
}

function loadNoteWriter() {
  return require(path.join(
    JARVOS_ROOT,
    'modules',
    'jarvos-secondbrain',
    'packages',
    'jarvos-secondbrain-notes',
    'src',
    'write-to-vault.js',
  ));
}

function loadJournalLinker() {
  return require(path.join(
    JARVOS_ROOT,
    'modules',
    'jarvos-secondbrain',
    'bridge',
    'provenance',
    'src',
    'link-to-journal.js',
  ));
}

function loadGbrain() {
  return loadModule('@jarvos/gbrain', path.join(JARVOS_ROOT, 'modules', 'jarvos-gbrain', 'src', 'index.js'));
}

function readShellExports(filePath) {
  const out = {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^export\s+(\w+)=(.*)$/);
      if (!match) continue;
      let value = String(match[2] || '').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[match[1]] = value;
    }
  } catch {
    // Missing local Paperclip config is allowed.
  }
  return out;
}

function loadPaperclipAuth(overrides = {}) {
  const envFile = expandTilde(firstString(
    overrides.envFile,
    process.env.JARVOS_PAPERCLIP_ENV_FILE,
    path.join(os.homedir(), 'clawd', 'config', 'paperclip-env.sh'),
  ));
  const fileEnv = readShellExports(envFile);
  const merged = { ...fileEnv, ...process.env, ...overrides };
  return {
    apiUrl: String(firstString(merged.PAPERCLIP_API_URL, 'http://127.0.0.1:3100')).replace(/\/$/, ''),
    apiKey: firstString(merged.PAPERCLIP_API_KEY, merged.PAPERCLIP_TOKEN),
    companyId: firstString(merged.PAPERCLIP_COMPANY_ID),
    agentId: firstString(merged.PAPERCLIP_AGENT_ID),
    defaultProjectId: firstString(merged.PAPERCLIP_DEFAULT_PROJECT_ID, DEFAULT_PAPERCLIP_PROJECT_ID),
  };
}

async function paperclipJson(pathname, auth) {
  if (!auth.apiUrl || !auth.apiKey) {
    throw new Error('Paperclip API is not configured');
  }
  const response = await fetch(`${auth.apiUrl}${pathname.startsWith('/api') ? pathname : `/api${pathname}`}`, {
    headers: { Authorization: `Bearer ${auth.apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Paperclip request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return response.json();
}

function issueIdentifier(issue) {
  return issue.identifier || (issue.issueNumber ? `SUP-${issue.issueNumber}` : issue.id);
}

function normalizeIssueList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function normalizeStatusList(value, fallback) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return fallback.slice();
}

function issueHasConcreteReviewSignal(issue = {}) {
  if (issue.status !== 'in_review') return true;
  const fields = [
    issue.pullRequestUrl,
    issue.prUrl,
    issue.githubPullRequestUrl,
    issue.reviewUrl,
    issue.ciUrl,
    issue.branchUrl,
    issue.description,
    issue.title,
  ].map((value) => String(value || '')).join('\n');

  return /https?:\/\/\S*(?:pull|pulls|compare|actions|checks|ci)\S*/i.test(fields)
    || /\bPR\s*#?\d+\b/i.test(fields)
    || /\b(pull request|awaiting review|ci|review automation)\b/i.test(fields);
}

function renderIssuesMarkdown(issues, { maxItems = 8 } = {}) {
  if (!issues.length) return 'No active Paperclip issues found.';
  return issues.slice(0, maxItems).map((issue) => {
    const priority = issue.priority && issue.priority !== 'none' ? ` ${issue.priority}` : '';
    return `- ${issueIdentifier(issue)} [${issue.status}${priority}]: ${issue.title}`;
  }).join('\n');
}

async function currentWork(options = {}) {
  const auth = loadPaperclipAuth(options.paperclip || {});
  const statuses = normalizeStatusList(options.statuses, DEFAULT_CURRENT_WORK_STATUSES);
  if (!auth.companyId || !auth.apiKey) {
    return {
      ok: false,
      markdown: 'Paperclip is not configured for jarvOS current-work lookup.',
      issues: [],
    };
  }

  const limit = Number(options.limit || 200);
  const payload = await paperclipJson(`/companies/${auth.companyId}/issues?limit=${limit}`, auth);
  const issues = normalizeIssueList(payload)
    .filter((issue) => !issue.hiddenAt)
    .filter((issue) => statuses.includes(issue.status))
    .filter((issue) => options.allowUnbackedInReview || issueHasConcreteReviewSignal(issue))
    .filter((issue) => {
      if (!options.includeAllAgents && auth.agentId) {
        return !issue.assigneeAgentId || issue.assigneeAgentId === auth.agentId;
      }
      return true;
    })
    .sort((a, b) => {
      const statusRank = { in_progress: 0, in_review: 1, blocked: 2, todo: 3 };
      const aRank = statusRank[a.status] ?? 9;
      const bRank = statusRank[b.status] ?? 9;
      if (aRank !== bRank) return aRank - bRank;
      return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
    });

  const markdown = [
    '# jarvOS Current Work',
    '',
    renderIssuesMarkdown(issues, { maxItems: Number(options.maxItems || 8) }),
  ].join('\n');

  return { ok: true, markdown, issues };
}

function localDateString(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function redactObviousSecrets(input) {
  return String(input || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{16,})\b/g, '[REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"']{8,}\3/gi, '$1$2$3[REDACTED]$3')
    .replace(/("?(?:apiKey|api_key|token|secret|password|authorization)"?\s*:\s*")([^"]{8,})(")/gi, '$1[REDACTED]$3');
}

function truncateText(text, maxChars, label, report) {
  const value = redactObviousSecrets(String(text || '').trim());
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value;
  report.omissions.push(`${label} truncated from ${value.length} to ${maxChars} chars`);
  return `${value.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n\n[${label} trimmed to ${maxChars} characters]`;
}

function readIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function findTodayJournal(jarvosPaths, options = {}) {
  const journalDir = expandTilde(firstString(options.journalDir, jarvosPaths.getJournalDir()));
  const timeZone = firstString(options.timeZone, jarvosPaths.getTimeZone(), 'UTC');
  const date = firstString(options.date, localDateString(timeZone));
  const candidates = [
    path.join(journalDir, `${date}.md`),
    path.join(journalDir, `${date}.markdown`),
  ];
  for (const filePath of candidates) {
    const content = readIfExists(filePath);
    if (content !== null) return { ok: true, date, path: filePath, content };
  }
  return { ok: false, date, path: candidates[0], content: '' };
}

function extractWikilinks(markdown) {
  const links = [];
  const seen = new Set();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = re.exec(String(markdown || ''))) !== null) {
    const title = match[1].trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    links.push(title);
  }
  return links;
}

function walkMarkdownFiles(root, maxFiles = 2000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

function isPathInside(parentDir, candidatePath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWikilink(notesDir, title, searchIndex) {
  const normalized = title.replace(/[\\/]/g, path.sep);
  const direct = path.resolve(notesDir, `${normalized}.md`);
  if (!isPathInside(notesDir, direct)) return null;
  if (fs.existsSync(direct)) return direct;

  const basename = `${path.basename(normalized).toLowerCase()}.md`;
  const found = searchIndex.find((filePath) => path.basename(filePath).toLowerCase() === basename);
  return found || null;
}

function collectLinkedNotes(journalContent, jarvosPaths, options = {}, report) {
  const notesDir = expandTilde(firstString(options.notesDir, jarvosPaths.getNotesDir()));
  const titles = extractWikilinks(journalContent).slice(0, Number(options.maxLinkedNotes || 6));
  const searchIndex = titles.length ? walkMarkdownFiles(notesDir, Number(options.maxNoteSearchFiles || 2000)) : [];
  const notes = [];

  for (const title of titles) {
    const filePath = resolveWikilink(notesDir, title, searchIndex);
    if (!filePath) {
      report.omissions.push(`linked note not found: [[${title}]]`);
      continue;
    }
    const content = readIfExists(filePath);
    if (content === null) {
      report.omissions.push(`linked note unreadable: ${filePath}`);
      continue;
    }
    notes.push({ title, path: filePath, content });
  }
  return notes;
}

function ontologyCandidateDirs(options = {}) {
  return [
    expandTilde(options.ontologyDir),
    path.join(os.homedir(), 'clawd', 'jarvos-ontology', 'ontology'),
    path.join(JARVOS_ROOT, 'jarvos-ontology', 'ontology'),
    path.join(JARVOS_ROOT, 'modules', 'jarvos-ontology', 'ontology'),
  ].filter(Boolean);
}

function compactOntologyFile(content) {
  const lines = String(content || '').split(/\r?\n/);
  const kept = [];
  let bodyLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;
    if (/^#{1,3}\s+/.test(trimmed)) {
      kept.push(trimmed);
      bodyLines = 0;
      continue;
    }
    if (/^\*\*(?:Status|Mission|Values|Strengths|Quote|Reason|Timeframe|Confidence):\*\*/i.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) && bodyLines < 2) {
      kept.push(trimmed);
      bodyLines += 1;
      continue;
    }
    if (bodyLines < 1 && trimmed.length < 180) {
      kept.push(trimmed);
      bodyLines += 1;
    }
  }
  return kept.join('\n');
}

function collectOntologySpine(options = {}, report) {
  for (const dir of ontologyCandidateDirs(options)) {
    if (!fs.existsSync(dir)) continue;
    const parts = [];
    const sources = [];
    for (const file of ONTOLOGY_FILES) {
      const filePath = path.join(dir, file);
      const content = readIfExists(filePath);
      if (content === null) continue;
      parts.push(`## ${file.replace(/^\d-/, '').replace(/\.md$/, '')}\n${compactOntologyFile(content)}`);
      sources.push(filePath);
    }
    if (parts.length) return { ok: true, dir, sources, markdown: parts.join('\n\n') };
  }
  report.omissions.push('jarvos-ontology spine unavailable');
  return { ok: false, dir: null, sources: [], markdown: 'jarvos-ontology spine unavailable.' };
}

function renderHydrationReport(report, maxChars, finalChars = report.finalChars || 0) {
  const sources = report.sources.length
    ? report.sources.map((source) => `- ${source}`).join('\n')
    : '- none';
  const omissions = report.omissions.length
    ? report.omissions.map((item) => `- ${item}`).join('\n')
    : '- none';
  const handles = report.handles.length
    ? report.handles.map((item) => `- ${item}`).join('\n')
    : '- none';

  return [
    '# Hydration Report',
    '',
    `- Target budget: ${maxChars} chars`,
    `- Final size: ${finalChars} chars`,
    `- Redaction: obvious secrets/API tokens redacted before injection`,
    '',
    '## Included Sources',
    sources,
    '',
    '## Omissions / Stale or Missing Data',
    omissions,
    '',
    '## Retrieval Handles',
    handles,
  ].join('\n');
}

async function hydrate(options = {}) {
  const maxChars = Number(options.maxChars || DEFAULT_HYDRATION_MAX_CHARS);
  const report = { sources: [], omissions: [], handles: [], finalChars: 0 };
  const jarvosPaths = loadJarvosPaths();
  const parts = ['# jarvOS Working Context Packet', ''];

  try {
    const work = await currentWork({
      ...options.currentWork,
      includeAllAgents: options.includeAllAgents,
      maxItems: Number(options.maxItems || options.currentWork?.maxItems || 8),
      statuses: normalizeStatusList(options.statuses || options.currentWork?.statuses, DEFAULT_HYDRATION_STATUSES),
    });
    parts.push(truncateText(work.markdown, Number(options.workMaxChars || 3200), 'Paperclip current work', report));
    report.sources.push(`Paperclip issues (${work.issues.length} included)`);
    report.handles.push('MCP: jarvos_current_work / jarvos_hydrate');
  } catch (error) {
    report.omissions.push(`Paperclip current work unavailable: ${error.message}`);
    parts.push('## Paperclip Current Work\nUnavailable.');
  }

  const journal = findTodayJournal(jarvosPaths, options.journal || {});
  if (journal.ok) {
    parts.push('', '# Today Journal', '', truncateText(journal.content, Number(options.journalMaxChars || 3200), 'today journal', report));
    report.sources.push(journal.path);
    report.handles.push(`Journal: ${journal.path}`);
  } else {
    report.omissions.push(`today journal missing: ${journal.path}`);
    parts.push('', '# Today Journal', '', `No journal entry found for ${journal.date}.`);
  }

  try {
    const linkedNotes = journal.ok ? collectLinkedNotes(journal.content, jarvosPaths, options.linkedNotes || {}, report) : [];
    if (linkedNotes.length) {
      parts.push('', '# Notes Linked From Today');
      for (const note of linkedNotes) {
        parts.push('', `## [[${note.title}]]`, truncateText(note.content, Number(options.linkedNoteMaxChars || 900), `linked note [[${note.title}]]`, report));
        report.sources.push(note.path);
        report.handles.push(`Note: ${note.path}`);
      }
    } else {
      parts.push('', '# Notes Linked From Today', '', 'No linked notes included.');
    }
  } catch (error) {
    report.omissions.push(`linked-note collection unavailable: ${error.message}`);
  }

  const ontology = collectOntologySpine(options.ontology || {}, report);
  parts.push('', '# jarvos-ontology Meaning Spine', '', truncateText(ontology.markdown, Number(options.ontologyMaxChars || 2200), 'jarvos-ontology spine', report));
  for (const source of ontology.sources) report.sources.push(source);
  if (ontology.dir) report.handles.push(`Ontology: ${ontology.dir}`);

  let body = redactObviousSecrets(parts.join('\n'));
  const reservedReportChars = 1800;
  if (body.length > maxChars - reservedReportChars) {
    report.omissions.push(`body trimmed from ${body.length} to fit final budget`);
    body = `${body.slice(0, Math.max(0, maxChars - reservedReportChars - 80)).trimEnd()}\n\n[hydration body trimmed to preserve report]`;
  }

  let markdown = `${body}\n\n${renderHydrationReport(report, maxChars)}`;
  if (markdown.length > maxChars) {
    report.omissions.push(`final packet trimmed from ${markdown.length} to ${maxChars} chars`);
    const finalReport = renderHydrationReport(report, maxChars);
    markdown = `${body.slice(0, Math.max(0, maxChars - finalReport.length - 20)).trimEnd()}\n\n${finalReport}`;
  }
  report.finalChars = markdown.length;
  markdown = markdown.replace(/Final size: \d+ chars/, `Final size: ${report.finalChars} chars`);
  if (markdown.length > maxChars) {
    const before = markdown.length;
    report.omissions.push(`final packet forcibly trimmed from ${before} to ${maxChars} chars`);
    const finalReport = renderHydrationReport(report, maxChars, maxChars);
    const bodyLimit = maxChars - finalReport.length - 2;
    markdown = bodyLimit > 0
      ? `${body.slice(0, bodyLimit).trimEnd()}\n\n${finalReport}`
      : finalReport.slice(0, maxChars);
    report.finalChars = markdown.length;
    markdown = markdown.replace(/Final size: \d+ chars/, `Final size: ${report.finalChars} chars`);
    if (markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars);
      report.finalChars = markdown.length;
    }
  }

  return { ok: true, markdown, report };
}

function recall(options = {}) {
  const query = firstString(options.query);
  if (!query) throw new Error('query is required');

  const gbrain = loadGbrain();
  const bundle = gbrain.recallBundle(options.config || {}, {
    query,
    includeQmd: options.includeQmd !== false,
    autoGraph: options.autoGraph !== false,
    seeds: Array.isArray(options.seeds) ? options.seeds : undefined,
  });
  return {
    ok: true,
    markdown: gbrain.renderRecallMarkdown(bundle),
    bundle,
  };
}

function defaultFrontmatter(frontmatter = {}) {
  return {
    status: 'draft',
    type: 'note',
    project: 'jarvOS',
    ...frontmatter,
  };
}

function createNote(input = {}) {
  const title = firstString(input.title);
  const content = input.content;
  if (!title) throw new Error('title is required');
  if (content === undefined || content === null) throw new Error('content is required');

  const jarvosPaths = loadJarvosPaths();
  const noteWriter = loadNoteWriter();
  const journalLinker = loadJournalLinker();
  const section = firstString(input.section, DEFAULT_NOTES_SECTION);
  const safeTitle = sanitizeTitle(title);
  const frontmatter = defaultFrontmatter(input.frontmatter || {});

  const noteResult = noteWriter.writeNoteFile({
    title,
    content,
    frontmatter,
  });
  const linkResult = journalLinker.linkNoteToJournal({
    noteTitle: noteResult.title || safeTitle,
    section,
    createIfMissing: input.createJournalIfMissing !== false,
  });
  const verification = verifyNoteCaptureContract({
    notePath: noteResult.path,
    noteTitle: noteResult.title || safeTitle,
    notesDir: jarvosPaths.getNotesDir(),
    journalPath: linkResult.journalPath,
    section,
  });

  return {
    ok: true,
    note: noteResult,
    journal: linkResult,
    verification,
    markdown: [
      '# jarvOS Note Created',
      '',
      `- Note: ${noteResult.path}`,
      `- Journal: ${linkResult.journalPath}`,
      `- Link: ${verification.link}`,
    ].join('\n'),
  };
}

async function startupBrief(options = {}) {
  const parts = ['# jarvOS Startup Brief', ''];
  const budget = Number(options.maxChars || 5000);

  try {
    const work = await currentWork({ maxItems: Number(options.maxItems || 6), ...options.currentWork });
    parts.push(work.markdown);
  } catch (error) {
    parts.push(`Current work unavailable: ${error.message}`);
  }

  const query = firstString(options.query);
  if (query) {
    try {
      const result = recall({ query, includeQmd: options.includeQmd, autoGraph: options.autoGraph });
      parts.push('', result.markdown);
    } catch (error) {
      parts.push('', `Recall unavailable: ${error.message}`);
    }
  }

  let markdown = parts.join('\n');
  if (markdown.length > budget) {
    markdown = `${markdown.slice(0, Math.max(0, budget - 80)).trimEnd()}\n\n[trimmed to ${budget} characters]`;
  }
  return { ok: true, markdown };
}

module.exports = {
  createNote,
  currentWork,
  defaultFrontmatter,
  expandTilde,
  hydrate,
  loadPaperclipAuth,
  recall,
  redactObviousSecrets,
  startupBrief,
  verifyNoteCaptureContract,
};
