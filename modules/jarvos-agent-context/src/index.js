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

function renderIssuesMarkdown(issues, { maxItems = 8 } = {}) {
  if (!issues.length) return 'No active Paperclip issues found.';
  return issues.slice(0, maxItems).map((issue) => {
    const priority = issue.priority && issue.priority !== 'none' ? ` ${issue.priority}` : '';
    return `- ${issueIdentifier(issue)} [${issue.status}${priority}]: ${issue.title}`;
  }).join('\n');
}

async function currentWork(options = {}) {
  const auth = loadPaperclipAuth(options.paperclip || {});
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
    .filter((issue) => ['in_progress', 'todo', 'blocked'].includes(issue.status))
    .filter((issue) => {
      if (!options.includeAllAgents && auth.agentId) {
        return !issue.assigneeAgentId || issue.assigneeAgentId === auth.agentId;
      }
      return true;
    })
    .sort((a, b) => {
      const statusRank = { in_progress: 0, blocked: 1, todo: 2 };
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
  loadPaperclipAuth,
  recall,
  startupBrief,
  verifyNoteCaptureContract,
};
