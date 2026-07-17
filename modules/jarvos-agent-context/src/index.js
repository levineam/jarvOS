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
const DEFAULT_SESSION_THREAD_PREFIX = 'JarvOS Session Thread';
const DEFAULT_SESSION_THREAD_SECTION = DEFAULT_NOTES_SECTION;
const DEFAULT_SESSION_THREAD_LOCK_RETRY_DELAY_MS = 25;
const DEFAULT_SESSION_THREAD_LOCK_STALE_MS = 30000;
const DEFAULT_SESSION_THREAD_LOCK_TIMEOUT_MS = 30000;

function loadControlPlaneManager() {
  return require('@jarvos/control-plane/manager');
}

function controlPlane(operation, input = {}) {
  return loadControlPlaneManager().createControlPlaneService(input.service || {}).execute(operation, input);
}

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

// WS7 cross-tool unification: let every runtime (OpenClaw / Claude / Codex) share
// ONE canonical jarvos-secondbrain pipeline, so fixes apply to notes from any tool.
// Defaults to the bundled modules copy; set JARVOS_SECONDBRAIN_DIR to an absolute
// path (e.g. the canonical clawd mirror) to point all note-creation through it.
function secondbrainDir() {
  return expandTilde(process.env.JARVOS_SECONDBRAIN_DIR)
    || path.join(JARVOS_ROOT, 'modules', 'jarvos-secondbrain');
}

function loadJarvosPaths() {
  return loadModule(
    '@jarvos/secondbrain/bridge/config/jarvos-paths.js',
    path.join(secondbrainDir(), 'bridge', 'config', 'jarvos-paths.js'),
  );
}

function loadNoteWriter() {
  return require(path.join(
    secondbrainDir(),
    'packages',
    'jarvos-secondbrain-notes',
    'src',
    'write-to-vault.js',
  ));
}

function loadJournalLinker() {
  return require(path.join(
    secondbrainDir(),
    'bridge',
    'provenance',
    'src',
    'link-to-journal.js',
  ));
}

function loadGbrain() {
  return loadModule('@jarvos/gbrain', path.join(JARVOS_ROOT, 'modules', 'jarvos-gbrain', 'src', 'index.js'));
}

function loadOntologyProviderModule() {
  return loadModule('@jarvos/ontology/provider', path.join(JARVOS_ROOT, 'modules', 'jarvos-ontology', 'src', 'provider.js'));
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

function sleepSync(ms) {
  const delay = Number(ms || 0);
  if (!Number.isFinite(delay) || delay <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function acquireLockFile(lockPath, options = {}) {
  const retryDelayMs = numberOption(options.lockRetryDelayMs, DEFAULT_SESSION_THREAD_LOCK_RETRY_DELAY_MS);
  const staleMs = numberOption(options.lockStaleMs, DEFAULT_SESSION_THREAD_LOCK_STALE_MS);
  const timeoutMs = numberOption(
    options.lockTimeoutMs,
    numberOption(options.lockRetries, 0) * retryDelayMs || DEFAULT_SESSION_THREAD_LOCK_TIMEOUT_MS,
  );
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let fd = null;
  let lastError = null;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (Date.now() <= deadline) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }));
      return () => {
        try {
          if (fd !== null) fs.closeSync(fd);
        } finally {
          fd = null;
          try {
            fs.unlinkSync(lockPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      };
    } catch (error) {
      lastError = error;
      if (error.code !== 'EEXIST') throw error;

      if (staleMs > 0) {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
        }
      }

      sleepSync(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  throw new Error(`Timed out acquiring session thread lock: ${lockPath}${lastError ? ` (${lastError.message})` : ''}`);
}

function normalizeThreadKey(input = {}) {
  const raw = firstString(
    input.threadId,
    input.threadKey,
    input.sessionId,
    input.issueIdentifier,
    input.artifact,
    input.project,
    process.env.PAPERCLIP_TASK_ID,
    process.env.JARVOS_SESSION_THREAD_ID,
    'default',
  );
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'default';
}

function sessionThreadTitle(input = {}) {
  const explicit = firstString(input.title, input.noteTitle);
  if (explicit) return sanitizeTitle(explicit);
  return sanitizeTitle(`${DEFAULT_SESSION_THREAD_PREFIX} - ${normalizeThreadKey(input)}`);
}

function stripFrontmatter(markdown) {
  return String(markdown || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

function boundedMarkdown(markdown, maxChars = 4000) {
  const text = redactObviousSecrets(String(markdown || '').trim());
  const budget = Number(maxChars || 4000);
  if (!Number.isFinite(budget) || budget <= 0 || text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - 80)).trimEnd()}\n\n[session thread trimmed to ${budget} characters]`;
}

function resolveSessionThread(input = {}) {
  const noteWriter = loadNoteWriter();
  const title = sessionThreadTitle(input);
  const notePath = noteWriter.noteFilePath(title);
  return {
    threadKey: normalizeThreadKey(input),
    title,
    notePath,
  };
}

function formatThreadEntry(input = {}, timestamp = new Date().toISOString()) {
  const actor = firstString(input.actor, input.host, input.persona, 'agent');
  const event = firstString(input.event, input.kind, 'checkpoint');
  const artifact = firstString(input.artifact, input.issueIdentifier, input.path, input.url);
  const summary = firstString(input.summary, input.content, input.body, input.text);
  const nextStep = firstString(input.nextStep, input.next);
  const decision = firstString(input.decision, input.lastDecision);
  if (!summary && !nextStep && !decision) {
    throw new Error('session thread write requires summary, nextStep, or decision');
  }

  const lines = [
    `## ${timestamp} - ${actor} - ${event}`,
  ];
  if (artifact) lines.push('', `Artifact: ${artifact}`);
  if (decision) lines.push('', 'Decision:', redactObviousSecrets(decision));
  if (summary) lines.push('', 'Summary:', redactObviousSecrets(summary));
  if (nextStep) lines.push('', 'Next:', redactObviousSecrets(nextStep));
  return `${lines.join('\n')}\n`;
}

function sessionThreadFrontmatter(input = {}, thread) {
  return {
    status: 'active',
    type: 'note',
    subtype: 'session-thread',
    project: firstString(input.project, 'jarvOS'),
    thread_key: thread.threadKey,
    artifact: firstString(input.artifact, input.issueIdentifier, input.path, input.url, ''),
    host: firstString(input.host, ''),
    updated_by: firstString(input.actor, input.persona, ''),
    tags: ['jarvos', 'session-thread'].concat(input.project ? [String(input.project)] : []),
    ...(input.frontmatter && typeof input.frontmatter === 'object' && !Array.isArray(input.frontmatter) ? input.frontmatter : {}),
  };
}

function renderSessionThreadRead(result) {
  if (!result.found) {
    return [
      '# jarvOS Session Thread',
      '',
      `No session thread found for ${result.title}.`,
      `Note path: ${result.notePath}`,
    ].join('\n');
  }
  return [
    '# jarvOS Session Thread',
    '',
    `- Thread: [[${result.title}]]`,
    `- Note: ${result.notePath}`,
    '',
    result.content,
  ].join('\n');
}

function readSessionThread(input = {}) {
  const thread = resolveSessionThread(input);
  const raw = readIfExists(thread.notePath);
  const content = raw === null ? '' : boundedMarkdown(stripFrontmatter(raw), Number(input.maxChars || 4000));
  const result = {
    ok: true,
    found: raw !== null,
    ...thread,
    content,
  };
  return {
    ...result,
    markdown: renderSessionThreadRead(result),
  };
}

function writeSessionThread(input = {}) {
  const thread = resolveSessionThread(input);
  const noteWriter = loadNoteWriter();
  const releaseLock = acquireLockFile(`${thread.notePath}.lock`, input);

  let noteResult;
  let readBack;
  try {
    const existing = readIfExists(thread.notePath);
    const existingBody = existing ? stripFrontmatter(existing) : '';
    const timestamp = firstString(input.timestamp) || new Date().toISOString();
    const entry = formatThreadEntry(input, timestamp);
    const header = [
      `# ${thread.title}`,
      '',
      'Rolling live working thread for cross-host AI continuity. Hosts should read this note on entry and append checkpoints at task switches, decisions, artifact changes, and pre-compaction flushes.',
    ].join('\n');
    const content = existingBody
      ? `${existingBody.trimEnd()}\n\n${entry}`
      : `${header}\n\n${entry}`;
    noteResult = noteWriter.writeNoteFile({
      title: thread.title,
      content,
      frontmatter: sessionThreadFrontmatter(input, thread),
      section: firstString(input.section, DEFAULT_SESSION_THREAD_SECTION),
      createJournalIfMissing: input.createJournalIfMissing !== false,
    });
    readBack = readSessionThread({ ...input, title: thread.title, maxChars: input.maxChars });
  } finally {
    releaseLock();
  }

  return {
    ok: true,
    status: 'written',
    ...thread,
    note: noteResult,
    journal: noteResult.journal,
    readOnEntry: readBack.markdown,
    markdown: [
      '# jarvOS Session Thread Written',
      '',
      `- Thread: [[${thread.title}]]`,
      `- Note: ${noteResult.path}`,
      `- Journal: ${noteResult.journal?.journalPath || 'not linked'}`,
      `- Event: ${firstString(input.event, input.kind, 'checkpoint')}`,
    ].join('\n'),
  };
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
    expandTilde(process.env.JARVOS_ONTOLOGY_DIR),
    path.join(JARVOS_ROOT, 'modules', 'jarvos-ontology', 'ontology'),
  ].filter(Boolean);
}

function collectOntologyPacket(options = {}, report) {
  const ontologyProvider = loadOntologyProviderModule();
  const candidateDirs = ontologyCandidateDirs(options);
  const configuredFile = firstString(options.sourceFile, options.ontologyFile);

  if (configuredFile) {
    const provider = ontologyProvider.createOntologyProvider({ sourceFile: expandTilde(configuredFile) });
    const packet = provider.renderAgentPacket({ maxChars: Number(options.maxChars || options.packetMaxChars || 2200) });
    if (packet.ok) {
      return { ok: true, dir: null, sources: packet.sources.map((source) => source.source), markdown: packet.markdown, packet };
    }
    report.omissions.push(`jarvos-ontology provider unavailable: ${packet.errors.map((error) => error.message).join('; ')}`);
    return { ok: false, dir: null, sources: [], markdown: packet.markdown, packet };
  }

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const provider = ontologyProvider.createOntologyProvider({ ontologyDir: dir });
    const packet = provider.renderAgentPacket({ maxChars: Number(options.maxChars || options.packetMaxChars || 2200) });
    if (packet.ok) {
      return {
        ok: true,
        dir,
        sources: packet.sources.map((source) => source.source),
        markdown: packet.markdown,
        packet,
      };
    }
  }

  const provider = ontologyProvider.createOntologyProvider({ ontologyDir: candidateDirs[0] || '' });
  const packet = provider.renderAgentPacket({ maxChars: Number(options.maxChars || options.packetMaxChars || 2200) });
  report.omissions.push('jarvos-ontology provider unavailable');
  return { ok: false, dir: null, sources: [], markdown: packet.markdown, packet };
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

function refreshFinalSize(markdown, report) {
  let next = markdown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const beforeLength = next.length;
    const refreshed = next.replace(/Final size: \d+ chars/, `Final size: ${beforeLength} chars`);
    next = refreshed;
    report.finalChars = next.length;
    if (report.finalChars === beforeLength) return next;
  }
  return next;
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

  if (options.sessionThread !== false) {
    try {
      const threadOptions = typeof options.sessionThread === 'object' ? options.sessionThread : {};
      const thread = readSessionThread({
        ...threadOptions,
        maxChars: Number(options.sessionThreadMaxChars || threadOptions.maxChars || 2200),
      });
      if (thread.found) {
        parts.push('', '# Live Session Thread', '', thread.markdown);
        report.sources.push(thread.notePath);
        report.handles.push(`Session thread: ${thread.notePath}`);
      }
    } catch (error) {
      report.omissions.push(`session thread unavailable: ${error.message}`);
    }
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

  const ontology = collectOntologyPacket(options.ontology || {}, report);
  parts.push('', '# jarvOS Ontology Context Packet', '', truncateText(ontology.markdown, Number(options.ontologyMaxChars || 2200), 'jarvos-ontology context packet', report));
  for (const source of ontology.sources) report.sources.push(source);
  if (ontology.dir) report.handles.push(`Ontology provider: ${ontology.dir}`);
  else if (ontology.packet?.sourceKind) report.handles.push(`Ontology provider: ${ontology.packet.sourceKind}`);

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
  markdown = refreshFinalSize(markdown, report);
  if (markdown.length > maxChars) {
    const before = markdown.length;
    report.omissions.push(`final packet forcibly trimmed from ${before} to ${maxChars} chars`);
    const finalReport = renderHydrationReport(report, maxChars, maxChars);
    const bodyLimit = maxChars - finalReport.length - 2;
    markdown = bodyLimit > 0
      ? `${body.slice(0, bodyLimit).trimEnd()}\n\n${finalReport}`
      : finalReport.slice(0, maxChars);
    markdown = refreshFinalSize(markdown, report);
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
  if (options.synthesize === true || options.mode === 'synthesis') {
    return synthesizeRecall(options);
  }

  const gbrain = loadGbrain();
  const bundle = gbrain.recallBundle(options.config || {}, {
    query,
    includeQmd: options.includeQmd !== false,
    autoGraph: options.autoGraph !== false,
    seeds: Array.isArray(options.seeds) ? options.seeds : undefined,
    dryRun: options.dryRun === true,
  });
  return {
    ok: true,
    markdown: gbrain.renderRecallMarkdown(bundle),
    bundle,
  };
}

function statusLine(name, engine) {
  if (!engine) return `- ${name}: unavailable`;
  return `- ${name}: ${engine.ok ? 'ok' : 'failed'}`;
}

function extractEvidenceLines(text, limit = 6) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(Status:|Query:|#|```)/.test(line))
    .slice(0, limit);
}

function synthesizeRecall(options = {}) {
  const query = firstString(options.query);
  if (!query) throw new Error('query is required');

  const gbrain = loadGbrain();
  const bundle = gbrain.recallBundle(options.config || {}, {
    query,
    includeQmd: options.includeQmd !== false,
    autoGraph: options.autoGraph !== false,
    seeds: Array.isArray(options.seeds) ? options.seeds : undefined,
    limit: options.limit,
    maxChars: options.maxChars,
    dryRun: options.dryRun === true,
  });

  const evidence = [
    ...extractEvidenceLines(bundle.engines?.gbrain?.text),
    ...extractEvidenceLines(bundle.engines?.qmd?.text),
  ].slice(0, Number(options.evidenceLimit || 8));

  const graphSeeds = (bundle.graph?.results || [])
    .flatMap((result) => (result.nodes || []).map((node) => node.title || node.slug))
    .filter(Boolean)
    .slice(0, 8);

  const lines = [
    '# jarvOS Retrieval Synthesis',
    '',
    `Query: ${query}`,
    '',
    '## Retrieval Status',
    '',
    statusLine('GBrain', bundle.engines?.gbrain),
    statusLine('QMD', bundle.engines?.qmd),
    `- Graph: ${bundle.graph ? (bundle.graph.ok ? 'ok' : 'failed') : 'not requested or no seeds found'}`,
    '',
    '## Synthesis',
    '',
  ];

  if (evidence.length === 0 && graphSeeds.length === 0) {
    lines.push('No usable retrieval evidence was returned. Treat the answer as unproven until indexes are refreshed or the query is narrowed.');
  } else {
    lines.push('The strongest retrieved signals are:');
    for (const item of evidence) lines.push(`- ${item}`);
    for (const item of graphSeeds) lines.push(`- Related graph node: ${item}`);
  }

  lines.push('', '## Source Bundle', '', bundle.markdown.trim());

  return {
    ok: bundle.ok,
    markdown: `${lines.join('\n').trim()}\n`,
    bundle,
    evidence,
    graphSeeds,
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
    section,
    createJournalIfMissing: input.createJournalIfMissing !== false,
  });
  const linkResult = noteResult.journal?.linked
    ? noteResult.journal
    : journalLinker.linkNoteToJournal({
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
      `- Knowledge: ${noteResult.knowledge?.optimized ? noteResult.knowledge.qmdStatus : 'not optimized'}`,
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
  controlPlane,
  createNote,
  currentWork,
  defaultFrontmatter,
  expandTilde,
  hydrate,
  loadPaperclipAuth,
  recall,
  redactObviousSecrets,
  readSessionThread,
  startupBrief,
  synthesizeRecall,
  verifyNoteCaptureContract,
  writeSessionThread,
};
