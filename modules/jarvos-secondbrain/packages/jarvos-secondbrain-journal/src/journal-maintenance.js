#!/usr/bin/env node
/**
 * jarvos-secondbrain-journal/src/journal-maintenance.js
 *
 * Package-owned journal maintenance entrypoint.
 *
 * Responsibilities:
 * - create missing daily journal entries from config
 * - enforce structure lock for required + enabled optional sections
 * - remove legacy ## ✅ Tasks drift by migrating content into Notes
 * - keep auto sections source-specific (calendar, reminders, Paperclip, notes created)
 * - preserve human-written content while repairing order/shape drift
 *
 * Usage:
 *   node jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js
 *   node ... --dry-run
 *   node ... --date=today|yesterday|YYYY-MM-DD
 *   node ... --dates=today,yesterday,YYYY-MM-DD
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { resolveConfig } = require('../../../bridge/config');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLAWD_ROOT = path.resolve(__dirname, '../../../..');
const CONFIG_PATH = path.join(PACKAGE_ROOT, 'config', 'journal-module.json');
const PAPERCLIP_BRIDGE_SCRIPT = path.join(CLAWD_ROOT, 'scripts', 'journal-paperclip-inbox.js');
const PROJECTS_PROJECTION_MODULE = path.join(
  PACKAGE_ROOT,
  '..',
  'jarvos-secondbrain-projects',
  'src',
  'journal-projection.js',
);
const SIGNATURE = '— Edited by Jarvis';
const DEFAULT_TIMEZONE = 'America/New_York';
const LEGACY_SALIENCE_LINE_RE = /^-\s*📌\s*\*\(([^,]+),\s*(\d+)%\)\*\s*(.+)$/i;
const JOURNAL_STATE_DIR = 'journal-maintenance';

function parseArgs(argv) {
  const out = {
    dateSpecs: ['today'],
    createIfMissing: false,
    dryRun: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--create-if-missing') out.createIfMissing = true;
    else if (arg === '--yesterday') out.dateSpecs = ['yesterday'];
    else if (arg.startsWith('--date=')) out.dateSpecs = [arg.split('=').slice(1).join('=')];
    else if (arg.startsWith('--dates=')) {
      out.dateSpecs = arg.split('=').slice(1).join('=').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
  }

  return out;
}

function printHelpAndExit(code) {
  console.log([
    'Usage: node jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js [options]',
    '',
    'Options:',
    '  --date=today|yesterday|YYYY-MM-DD',
    '  --dates=today,yesterday,YYYY-MM-DD',
    '  --yesterday',
    '  --dry-run',
    '  --json',
    '  -h, --help',
  ].join('\n'));
  process.exit(code);
}

function loadConfig() {
  try {
    return readConfig();
  } catch (err) {
    console.error(`Failed to load journal config: ${err.message}`);
    process.exit(1);
  }
}

// Library callers (including the MCP server) need a throwable read rather
// than a process exit; the CLI wrapper above keeps its historical exit code.
function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function nyDate(offsetDays = 0) {
  const now = new Date();
  const localYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const [y, m, d] = localYmd.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + offsetDays));
  const y2 = utc.getUTCFullYear();
  const m2 = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const d2 = String(utc.getUTCDate()).padStart(2, '0');
  return `${y2}-${m2}-${d2}`;
}

function today() {
  return nyDate(0);
}

function resolveDateSpec(spec) {
  if (!spec || spec === 'today') return nyDate(0);
  if (spec === 'yesterday') return nyDate(-1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  throw new Error(`Invalid date spec: ${spec}`);
}

function unique(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const normalized = String(item || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function trimOuterBlankLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function stripSignature(md) {
  return String(md || '')
    .replace(new RegExp(`^${escapeRegex(SIGNATURE)}\\s*$`, 'gm'), '')
    .replace(/\n{3,}/g, '\n\n');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitFrontmatter(md) {
  const text = String(md || '');
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return { frontmatter: '', body: text };
  return {
    frontmatter: trimOuterBlankLines(match[0]),
    body: text.slice(match[0].length),
  };
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function journalStateRoot(journalDir) {
  const configured = process.env.JARVOS_JOURNAL_STATE_DIR;
  if (configured) return path.resolve(resolveTilde(configured));

  // Recovery snapshots contain the complete journal and must not live inside
  // the vault, where sync/index/export tools can retain text the user deleted.
  // Scope the local state by vault path so multiple vaults do not collide.
  const stateHome = process.env.XDG_STATE_HOME
    ? path.resolve(resolveTilde(process.env.XDG_STATE_HOME))
    : path.join(process.env.HOME || os.homedir(), '.local', 'state');
  const vaultId = contentHash(path.resolve(path.dirname(journalDir))).slice(0, 16);
  return path.join(stateHome, 'jarvos', JOURNAL_STATE_DIR, vaultId);
}

function migrateLegacyJournalSnapshots(journalDir) {
  const legacyRoot = path.join(path.dirname(journalDir), '.jarvos', JOURNAL_STATE_DIR);
  const stateRoot = journalStateRoot(journalDir);
  if (path.resolve(legacyRoot) === path.resolve(stateRoot) || !fs.existsSync(legacyRoot)) return;

  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (const name of ['state.json', 'known-good', 'audit-backups']) {
    const source = path.join(legacyRoot, name);
    const destination = path.join(stateRoot, name);
    if (!fs.existsSync(source)) continue;
    if (!fs.existsSync(destination)) fs.cpSync(source, destination, { recursive: true });
    const secure = (candidate) => {
      const stat = fs.statSync(candidate);
      fs.chmodSync(candidate, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) fs.readdirSync(candidate).forEach((entry) => secure(path.join(candidate, entry)));
    };
    secure(destination);
    // Always remove the synced copy, including when local state already exists.
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function journalStatePath(journalDir) {
  return path.join(journalStateRoot(journalDir), 'state.json');
}

function knownGoodPath(journalDir, date) {
  return path.join(journalStateRoot(journalDir), 'known-good', `${date}.md`);
}

function auditBackupPath(journalDir, date, reason, timestamp = safeTimestamp()) {
  const safeReason = String(reason || 'update').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return path.join(journalStateRoot(journalDir), 'audit-backups', `${date}.${timestamp}.${safeReason}.md`);
}

function loadJournalState(journalDir) {
  const statePath = journalStatePath(journalDir);
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { version: 1, dates: {} };
  }
}

function writeJournalState(journalDir, state) {
  const statePath = journalStatePath(journalDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(statePath, 0o600);
}

/**
 * Sections whose entire body is machine-rendered on every maintenance pass.
 *
 * Nothing under these headings is evidence that the user's own writing is
 * still intact, so they are excluded wholesale from `meaningfulBodyChars`.
 * Excluding only their empty-state placeholder is not enough: a populated
 * Projects list would otherwise make a journal whose Notes, Ideas, and
 * Journal Entry had been wiped still look populated, and suppress the
 * known-good restore that exists to catch exactly that.
 */
const GENERATED_SECTION_HEADINGS = new Set([
  '## 🚀 Projects',
  "## 📅 Today's Calendar",
  '## 🔔 Apple Reminders',
  '## 📎 Paperclip Inbox',
  '## 🗂️ Notes Created',
]);

/**
 * Headings whose content is machine-rendered, resolved from the live config
 * rather than only the literals above.
 *
 * Headings are a configurable contract — renaming the Projects heading in
 * journal-module.json is a supported edit. If the exclusion matched literals
 * only, a renamed generated section would start counting as authored content
 * and a populated project list would once again mask a wiped journal. The
 * literal set is retained for retired headings, which are no longer in config.
 */
function generatedHeadings(config) {
  const out = new Set(GENERATED_SECTION_HEADINGS);
  const declared = [
    ...((config && config.sections && config.sections.required) || []),
    ...((config && config.sections && config.sections.optional) || []),
  ];
  for (const section of declared) {
    if (section && section.heading && section.source && section.source !== 'manual') {
      out.add(String(section.heading).trim());
    }
  }
  return out;
}

/** Body lines that could be the user's own writing — generated sections excluded. */
function authoredBodyLines(body, config) {
  const generatedSet = generatedHeadings(config);
  const lines = [];
  let generated = false;
  for (const raw of trimOuterBlankLines(body).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^##\s+/.test(line)) {
      generated = generatedSet.has(line);
      continue;
    }
    if (generated) continue;
    if (!line || line === SIGNATURE || line === '-') continue;
    if (isGeneratedPlaceholderLine(line)) continue;
    lines.push(line);
  }
  return lines;
}

function journalMetrics(markdown, config) {
  const text = String(markdown || '');
  const { body } = splitFrontmatter(text);
  const sections = parseSections(body).sections.map((section) => section.heading);
  const hasBodyText = trimOuterBlankLines(body).length > 0;
  const meaningfulBodyChars = authoredBodyLines(body, config).join('\n').length;
  return {
    size: Buffer.byteLength(text, 'utf8'),
    hash: contentHash(text),
    sections,
    sectionCount: sections.length,
    hasBodyText,
    meaningfulBodyChars,
    isFrontmatterOnly: Boolean(text.trim()) && sectionCountFromBody(body) === 0 && !hasMeaningfulBodyText(body),
  };
}

function isGeneratedPlaceholderLine(line) {
  return /^-\s+(?:No events today|No reminders due today|No blocked Paperclip issues|No notes created(?: on .*)?|No notes today|No notes yet|No ongoing projects|No projects touched today|\((?:calendar unavailable|reminders unavailable|projects unavailable(?:\s+—\s+[^)]+)?|Paperclip inbox script not found|Paperclip API unavailable)\))$/i.test(line);
}

/**
 * A fetcher result that means "I could not read the source", as opposed to a
 * positive claim about it.
 *
 * The distinction matters because the two read identically as strings but are
 * opposite in evidential weight. `- No ongoing projects` asserts something the
 * fetcher actually observed; `- (projects unavailable)` asserts only that the
 * fetcher failed. A degraded marker must therefore never be written over
 * content that is already in the entry -- the existing list is better evidence
 * about the world than a marker saying we couldn't look.
 *
 * The Projects projection documents exactly this contract ("the journal treats [it] as a
 * degraded source and will not write over existing content") and the journal
 * never implemented it, so one unmounted volume or permissions blip would
 * rewrite a populated Projects section down to a single placeholder line.
 */
function isDegradedSourceMarker(content) {
  const trimmed = trimOuterBlankLines(String(content == null ? '' : content));
  if (!trimmed || trimmed.includes('\n')) return false;
  return /^-\s+\((?:calendar unavailable|reminders unavailable|projects unavailable(?:\s+—\s+[^)]+)?|Paperclip inbox script not found|Paperclip API unavailable)\)$/i.test(trimmed);
}

/** Does a section body carry anything beyond the empty `-` placeholder? */
function hasRenderedContent(content) {
  const trimmed = trimOuterBlankLines(String(content == null ? '' : content));
  return Boolean(trimmed) && trimmed !== '-';
}

function sectionCountFromBody(body) {
  return parseSections(body).sections.length;
}

function hasMeaningfulBodyText(body) {
  return trimOuterBlankLines(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line !== SIGNATURE && line !== '-');
}

/**
 * Fingerprint of the configured section contract.
 *
 * The known-good shrink guard compares a journal against its own past self.
 * That comparison is only meaningful while the section contract is unchanged:
 * the moment a section is added or retired, every entry legitimately changes
 * size and section count, and a shrink is expected rather than suspicious.
 *
 * Without this, retiring a section wedges the guard permanently. The first pass
 * after the change reports `stale` (fewer sections than known-good), the
 * known-good refresh is skipped because it only runs on `healthy`, and every
 * later pass repeats the same comparison against the same frozen snapshot. The
 * restore path then holds pre-migration content indefinitely, so a genuine
 * truncation later restores a stale entry over the user's newer writing — the
 * exact loss this machinery exists to prevent.
 */
function contractSignature(config) {
  const headings = buildDesiredSections(config || {}).map((section) => section.heading);
  return contentHash(headings.join('\u0000'));
}

/**
 * True when an entry's headings are exactly the currently-configured contract,
 * in order.
 *
 * This is what makes the guard safe for snapshots written before signatures
 * existed — i.e. every snapshot already on disk when this shipped, which is the
 * only population the migration wedge could ever affect. A signature cannot be
 * compared against a snapshot that has none, so the shape of the entry is used
 * instead: if it holds precisely the sections the contract now asks for, then a
 * shrink against the older snapshot is explained by the contract change and the
 * snapshot should be refreshed. If the entry is missing configured sections it
 * is genuinely damaged, and the shrink guard and restore path must still fire.
 */
function structureMatchesContract(sections, config) {
  const desired = buildDesiredSections(config || {}).map((section) => String(section.heading).trim());
  if (!desired.length) return false;
  const have = (sections || []).map((heading) => String(heading).trim());
  if (have.length !== desired.length) return false;
  return desired.every((heading, index) => have[index] === heading);
}

/**
 * True when every authored line in `priorMarkdown` still appears in
 * `currentMarkdown`.
 *
 * This is the safety property that makes refreshing the known-good snapshot
 * across a contract migration sound. Checking the entry's *structure* is
 * useless here: the candidate is always freshly rendered output, which by
 * construction carries exactly the configured sections, so a structure check is
 * vacuously true on every write path.
 *
 * Content is what actually distinguishes the two cases. A contract migration
 * drops machine-rendered sections, which `authoredBodyLines` already ignores,
 * so every authored line survives. Real damage — a bad mobile sync gutting
 * Notes and Journal Entry — loses authored lines, and must leave the old
 * snapshot untouched so the restore path can still recover it.
 */
function authoredContentPreserved(currentMarkdown, priorMarkdown, config) {
  const prior = authoredBodyLines(splitFrontmatter(String(priorMarkdown || '')).body, config);
  if (!prior.length) return true;
  const current = new Set(authoredBodyLines(splitFrontmatter(String(currentMarkdown || '')).body, config));
  return prior.every((line) => current.has(line));
}

function classifyJournalHealth({ existed, markdown, knownGood, config }) {
  if (!existed) {
    return {
      status: 'missing',
      degraded: false,
      reason: 'Journal file is missing',
      metrics: journalMetrics('', config),
    };
  }

  const metrics = journalMetrics(markdown, config);
  if (metrics.isFrontmatterOnly) {
    return {
      status: 'stub',
      degraded: true,
      reason: 'Journal is a frontmatter-only stub',
      metrics,
    };
  }

  if (
    knownGood
    && knownGood.size
    && knownGood.sectionCount
    && metrics.hash !== knownGood.hash
    && (metrics.size < knownGood.size || metrics.sectionCount < knownGood.sectionCount)
  ) {
    return {
      status: 'stale',
      degraded: true,
      reason: 'Journal shrank compared with the prior known-good state',
      metrics,
    };
  }

  return {
    status: 'healthy',
    degraded: false,
    reason: 'Journal has body sections',
    metrics,
  };
}

function readKnownGoodContent(journalDir, date, knownGood) {
  const candidate = knownGood?.knownGoodPath || knownGoodPath(journalDir, date);
  try {
    const content = fs.readFileSync(candidate, 'utf8');
    const metrics = journalMetrics(content);
    if (metrics.sectionCount > 0 && !metrics.isFrontmatterOnly) return content;
  } catch {
    // Missing state snapshots are non-fatal; normalization can still scaffold.
  }
  return null;
}

function isCatastrophicJournalShrink(metrics, knownGood) {
  if (!knownGood?.size || !knownGood?.sectionCount) return false;
  return metrics.size <= Math.floor(knownGood.size * 0.25)
    && metrics.meaningfulBodyChars === 0;
}

function parseFrontmatterEntries(frontmatter) {
  const trimmed = trimOuterBlankLines(frontmatter || '');
  if (!trimmed.startsWith('---')) return [];
  const lines = trimmed.split(/\r?\n/).slice(1, -1);
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (!match) continue;
    entries.push({ key: match[1].trim(), value: match[2] });
  }
  return entries;
}

function renderFrontmatter(date, config, existingFrontmatter) {
  const requiredEntries = Object.entries(config.frontmatter || {}).map(([key, value]) => ({
    key,
    value: String(value).replace('{{YYYY-MM-DD}}', date),
  }));
  const existingEntries = parseFrontmatterEntries(existingFrontmatter);
  const existingMap = new Map(existingEntries.map((entry) => [entry.key, entry.value]));
  const rendered = ['---'];
  const seen = new Set();

  for (const entry of requiredEntries) {
    rendered.push(`${entry.key}: ${entry.value}`);
    seen.add(entry.key);
  }

  for (const entry of existingEntries) {
    if (seen.has(entry.key)) continue;
    rendered.push(`${entry.key}: ${existingMap.get(entry.key)}`);
    seen.add(entry.key);
  }

  rendered.push('---');
  return rendered.join('\n');
}

function parseSections(body) {
  const lines = String(body || '').split(/\r?\n/);
  const sections = [];
  let currentHeading = null;
  let buffer = [];
  const stray = [];

  function flush() {
    const content = trimOuterBlankLines(buffer.join('\n'));
    if (!currentHeading) {
      if (content) stray.push(content);
    } else {
      sections.push({ heading: currentHeading, content });
    }
    buffer = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s+/.test(line)) {
      flush();
      currentHeading = line;
      continue;
    }
    buffer.push(rawLine);
  }
  flush();

  return {
    sections,
    strayText: trimOuterBlankLines(stray.join('\n\n')),
  };
}

function buildDesiredSections(config) {
  return [
    ...(config.sections?.required || []),
    ...((config.sections?.optional || []).filter((section) => section.enabled)),
  ];
}

function buildConfiguredHeadingMap(config) {
  const map = new Map();
  for (const section of config.sections?.required || []) map.set(section.heading, section);
  for (const section of config.sections?.optional || []) map.set(section.heading, section);
  return map;
}

function appendBlock(existing, block) {
  const a = trimOuterBlankLines(existing || '');
  const b = trimOuterBlankLines(block || '');
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n${b}`;
}

function formatMigratedBlock(label, content) {
  const trimmed = trimOuterBlankLines(content || '');
  if (!trimmed || trimmed === '-') return '';
  return `**${label}**\n${trimmed}`;
}

/**
 * Strip the exact one-shot recovery scaffold from section content:
 * optional leading `**Recovered content**` marker and optional leading H1
 * exactly matching `# <date>`. Leaves all other content/headings untouched.
 */
function stripLeadingRecoveryScaffold(content, date) {
  const expectedDate = String(date || '').trim();
  const expectedH1 = expectedDate ? `# ${expectedDate}` : null;
  const lines = String(content || '').split(/\r?\n/);
  let i = 0;

  while (i < lines.length && lines[i].trim() === '') i += 1;

  if (i < lines.length && lines[i].trim() === '**Recovered content**') {
    i += 1;
    while (i < lines.length && lines[i].trim() === '') i += 1;
  }

  if (expectedH1 && i < lines.length && lines[i].trim() === expectedH1) {
    i += 1;
    while (i < lines.length && lines[i].trim() === '') i += 1;
  }

  return trimOuterBlankLines(lines.slice(i).join('\n')) || '-';
}

/**
 * Opt-in section content transforms applied to already-normalized sections.
 * Ordinary maintenance leaves transforms unset so behavior is unchanged.
 *
 * Each transform: { sectionId?: string, heading?: string, transform(content, ctx) }
 */
function applySectionTransforms(normalized, transforms, context = {}) {
  if (!Array.isArray(transforms) || transforms.length === 0) return normalized;
  if (!normalized || !Array.isArray(normalized.sections)) return normalized;

  const sections = normalized.sections.map((section) => {
    const match = transforms.find((entry) => {
      if (!entry || typeof entry.transform !== 'function') return false;
      if (entry.sectionId && section.id && entry.sectionId === section.id) return true;
      if (entry.heading && entry.heading === section.heading) return true;
      return false;
    });
    if (!match) return section;

    const next = match.transform(section.content, {
      ...context,
      sectionId: section.id,
      heading: section.heading,
      date: context.date,
    });
    return {
      ...section,
      content: trimOuterBlankLines(String(next ?? '')) || '-',
    };
  });

  return {
    ...normalized,
    sections,
  };
}

function appendUniqueLines(existing, additions) {
  const lines = String(existing || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== '-');
  const seen = new Set(lines);

  for (const addition of additions || []) {
    const trimmed = String(addition || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    lines.push(trimmed);
    seen.add(trimmed);
  }

  return trimOuterBlankLines(lines.join('\n')) || '-';
}

function migrateLegacySalienceEntries(notesContent) {
  const noteLines = [];
  const ideaLines = [];

  for (const line of String(notesContent || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(LEGACY_SALIENCE_LINE_RE);
    if (!match) {
      noteLines.push(line);
      continue;
    }

    const salienceClass = match[1].trim().toLowerCase();
    const text = match[3].trim();
    if (salienceClass === 'idea' && text) {
      ideaLines.push(`- ${text}`);
    }
  }

  return {
    notesContent: trimOuterBlankLines(noteLines.join('\n')),
    ideaLines,
  };
}

function filterLegacyNotesCreatedContent(content) {
  return trimOuterBlankLines(
    String(content || '').split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^-\s+(?:No notes created(?: on .*)?|No notes today|No notes yet)$/i.test(line))
      .join('\n'),
  );
}

function loadProjectsProjection() {
  // The Journal package depends on the public projection contract only. The
  // host selects the reader over registry/activity state; this module never
  // reads Beads, Paperclip, or private state roots itself.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(PROJECTS_PROJECTION_MODULE);
}

function activityReceiptForProjection(activity) {
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return null;
  if (activity.receipt && typeof activity.receipt === 'object') {
    return { ...activity.receipt, trust: activity.receipt.trust || 'verified', accepted: true };
  }
  if (activity.trust === 'verified' || activity.accepted === true) return { ...activity, trust: 'verified', accepted: true };
  return null;
}

function normalizeProjectsActivityResult(result, { date, timeZone, maxItems = 25 } = {}) {
  const projection = loadProjectsProjection();
  if (result && result.contract === projection.JOURNAL_PROJECTION_CONTRACT) return result;

  const value = result && typeof result === 'object' ? result : {};
  const state = value.activityProviderState || value.providerState || value.state
    || (value.status === 'ok' ? 'fresh' : 'unavailable');
  const packet = value.packet && typeof value.packet === 'object' ? value.packet : value;
  const projects = Array.isArray(value.projects)
    ? value.projects
    : (Array.isArray(packet.projects) ? packet.projects : (Array.isArray(packet.canonical?.records) ? packet.canonical.records : []));
  const rawActivities = Array.isArray(value.activities)
    ? value.activities
    : (Array.isArray(value.activityReceipts) ? value.activityReceipts : (Array.isArray(packet.activities) ? packet.activities : []));
  let activities = rawActivities.map(activityReceiptForProjection).filter(Boolean);

  // A verified Projects context packet exposes bounded activity summaries
  // rather than receipt envelopes. They are safe for navigation only when the
  // host explicitly marks the activity provider as fresh; context reads are
  // not activity and therefore never reach this fallback.
  if (!activities.length && value.status === 'ok' && state === 'fresh' && Array.isArray(packet.activity)) {
    activities = packet.activity
      .filter((summary) => summary && summary.category === 'activity' && summary.occurredAt)
      .map((summary) => ({
        canonicalId: summary.canonicalId,
        occurredAt: summary.occurredAt,
        trust: 'verified',
        accepted: true,
      }));
  }

  return projection.buildJournalProjection({
    date,
    timeZone,
    projects,
    activities,
    activityProviderState: state,
    coverageWatermark: value.coverageWatermark || value.watermark || packet.watermark || null,
    generator: value.generator || 'projects-activity-v1',
    maxItems,
  });
}

function buildProjectsActivityFetcher({ reader, timeZone = DEFAULT_TIMEZONE, onProjection = null } = {}) {
  return ({ date, config, section }) => {
    if (typeof reader !== 'function' && !(reader && typeof reader.read === 'function')) {
      return '- (projects unavailable — activity reader not configured)';
    }
    try {
      const read = typeof reader === 'function' ? reader : reader.read.bind(reader);
      const result = read({
        profile: 'recent-activity',
        date,
        timeZone: timeZone || config?.timeZone || DEFAULT_TIMEZONE,
        maxItems: Number(config?.journal?.maxItems || 25),
        section,
      });
      if (result && typeof result.then === 'function') {
        throw new Error('asynchronous Projects activity readers are not supported by synchronous journal maintenance');
      }
      const projection = normalizeProjectsActivityResult(result, {
        date,
        timeZone: timeZone || config?.timeZone || DEFAULT_TIMEZONE,
        maxItems: Number(config?.journal?.maxItems || 25),
      });
      if (typeof onProjection === 'function') onProjection(projection);
      if (projection.preserve) return '- (projects unavailable — activity evidence degraded)';
      return projection.content || '- No projects touched today';
    } catch {
      return '- (projects unavailable — activity reader failed)';
    }
  };
}

function buildSourceFetchers({ projectsActivityReader = null, timeZone = DEFAULT_TIMEZONE, onProjectProjection = null } = {}) {
  return {
    // Projects is now a touched-parent navigation projection. The host must
    // supply a reader over admitted activity; there is no all-project
    // filesystem fallback here.
    projects: buildProjectsActivityFetcher({
      reader: projectsActivityReader,
      timeZone,
      onProjection: onProjectProjection,
    }),

    'google-calendar': ({ isToday }) => {
      if (!isToday) return null;
      try {
        const out = execSync(
          'icalBuddy -ic "Andrew Levine,Family,Home,Shared Calendar" eventsToday 2>/dev/null',
          { encoding: 'utf8', timeout: 10000 },
        ).trim();
        if (!out) return '- No events today';
        const lines = out.split('\n').filter((line) => line.trim());
        const events = [];
        let current = null;
        for (const line of lines) {
          if (line.startsWith('•') || line.startsWith('*')) {
            if (current) events.push(current);
            current = line.replace(/^[•*]\s*/, '').trim();
          } else if (current && /^\d{1,2}:\d{2}/.test(line.trim())) {
            current += ` — ${line.trim()}`;
          }
        }
        if (current) events.push(current);
        return events.length ? events.map((event) => `- ${event}`).join('\n') : '- No events today';
      } catch {
        return '- (calendar unavailable)';
      }
    },

    'apple-reminders': ({ isToday }) => {
      if (!isToday) return null;
      try {
        const raw = execSync('remindctl today --json 2>/dev/null', {
          encoding: 'utf8',
          timeout: 10000,
        }).trim();
        if (!raw || raw === '[]') return '- No reminders due today';
        const items = JSON.parse(raw);
        if (!Array.isArray(items) || items.length === 0) return '- No reminders due today';
        return items.map((reminder) => {
          const title = reminder.title || '(untitled)';
          const list = reminder.listName || '';
          let due = '';
          if (reminder.dueDate) {
            const date = new Date(reminder.dueDate);
            due = date.toLocaleTimeString('en-US', {
              timeZone: DEFAULT_TIMEZONE,
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            });
          }
          let line = `- ${title}`;
          if (due) line += ` — ${due}`;
          if (list) line += ` [${list}]`;
          return line;
        }).join('\n');
      } catch {
        return '- (reminders unavailable)';
      }
    },

    'paperclip': ({ isToday }) => {
      if (!isToday) return null;
      try {
        if (!fs.existsSync(PAPERCLIP_BRIDGE_SCRIPT)) {
          return '- (Paperclip inbox script not found)';
        }
        const out = execSync(`node "${PAPERCLIP_BRIDGE_SCRIPT}"`, {
          encoding: 'utf8',
          timeout: 15000,
        }).trim();
        return out || '- No blocked Paperclip issues';
      } catch {
        return '- (Paperclip API unavailable)';
      }
    },

    manual: () => null,
  };
}

function readJsonOptional(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function folderMatchesJournal(vaultRoot, configuredFolder, journalDir) {
  const raw = String(configuredFolder || '').trim();
  if (!raw) return false;
  const resolved = path.isAbsolute(raw) ? raw : path.join(vaultRoot, raw);
  return path.resolve(resolved) === path.resolve(journalDir);
}

function detectConflictingJournalWriters(journalDir) {
  const resolvedJournalDir = path.resolve(journalDir);
  const vaultRoot = path.dirname(resolvedJournalDir);
  const obsidianDir = path.join(vaultRoot, '.obsidian');
  const conflicts = [];
  const communityPlugins = readJsonOptional(path.join(obsidianDir, 'community-plugins.json'), []);
  const corePlugins = readJsonOptional(path.join(obsidianDir, 'core-plugins.json'), {});

  if (Array.isArray(communityPlugins) && communityPlugins.includes('journals')) {
    conflicts.push('"journals" is enabled and can overwrite jarvOS-managed daily journals');
  }

  if (corePlugins?.['daily-notes']) {
    const dailyNotes = readJsonOptional(path.join(obsidianDir, 'daily-notes.json'), {});
    if (folderMatchesJournal(vaultRoot, dailyNotes.folder, resolvedJournalDir)) {
      conflicts.push('daily-notes is configured to write into the jarvOS Journal folder');
    }
  }

  if (Array.isArray(communityPlugins) && communityPlugins.includes('periodic-notes')) {
    const periodicNotes = readJsonOptional(path.join(obsidianDir, 'plugins', 'periodic-notes', 'data.json'), {});
    if (periodicNotes?.daily?.enabled && folderMatchesJournal(vaultRoot, periodicNotes.daily.folder, resolvedJournalDir)) {
      conflicts.push('periodic-notes daily notes are configured to write into the jarvOS Journal folder');
    }
  }

  return conflicts;
}

function normalizeSections(original, date, config, opts = {}) {
  const desiredSections = buildDesiredSections(config);
  const desiredByHeading = new Map(desiredSections.map((section) => [section.heading, section]));
  const configuredHeadingMap = buildConfiguredHeadingMap(config);
  const configuredById = new Map(desiredSections.map((section) => [section.id, section]));
  const fetchers = {
    ...buildSourceFetchers({
      projectsActivityReader: opts.projectsActivityReader,
      timeZone: opts.timeZone || config.timeZone || DEFAULT_TIMEZONE,
      onProjectProjection: opts.onProjectProjection,
    }),
    ...(opts.fetchers || {}),
  };
  const isToday = date === today();

  const withoutSignature = stripSignature(original);
  const { frontmatter, body } = splitFrontmatter(withoutSignature);
  const { sections, strayText } = parseSections(body);

  const contentByHeading = new Map();
  const migratedBlocks = [];

  const legacySections = Object.values(config.migration?.legacySections || {});
  const legacyHeadingSet = new Set(legacySections.map((section) => section.heading));

  if (strayText) {
    migratedBlocks.push(formatMigratedBlock('Recovered content', strayText));
  }

  for (const section of sections) {
    const existing = contentByHeading.get(section.heading);
    if (desiredByHeading.has(section.heading)) {
      contentByHeading.set(section.heading, appendBlock(existing, section.content));
      continue;
    }

    const configuredSection = configuredHeadingMap.get(section.heading);
    const legacySection = legacySections.find((entry) => entry.heading === section.heading);

    if (legacySection) {
      // 'drop' discards the section outright. Reserved for sections whose
      // content was a regenerated daily snapshot (calendar, reminders, tracker
      // inbox) — preserving those under Notes would bury real notes under
      // stale machine output. Never use it for anything the user typed.
      if (legacySection.action === 'drop') continue;

      const targetSection = configuredById.get(legacySection.migrateContentTo || 'notes');
      if (legacySection.action === 'rename' && targetSection) {
        const filteredContent = filterLegacyNotesCreatedContent(section.content);
        if (filteredContent) {
          const targetExisting = contentByHeading.get(targetSection.heading);
          contentByHeading.set(targetSection.heading, appendBlock(targetExisting, filteredContent));
        }
        continue;
      }

      const materialLines = trimOuterBlankLines(section.content)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line !== '-');
      if (materialLines.length === 0) continue;

      const label = `${section.heading.replace(/^##\s+/, '')} (migrated)`;
      if (targetSection) migratedBlocks.push(formatMigratedBlock(label, section.content));
      continue;
    }

    if (configuredSection && !desiredByHeading.has(section.heading)) {
      migratedBlocks.push(formatMigratedBlock(`${section.heading.replace(/^##\s+/, '')} (disabled section)`, section.content));
      continue;
    }

    if (!legacyHeadingSet.has(section.heading)) {
      migratedBlocks.push(formatMigratedBlock(section.heading.replace(/^##\s+/, ''), section.content));
    }
  }

  const notesSection = desiredSections.find((section) => section.id === 'notes');
  const ideasSection = desiredSections.find((section) => section.id === 'ideas');
  if (notesSection) {
    const existingNotes = contentByHeading.get(notesSection.heading) || '';
    const migratedSalience = migrateLegacySalienceEntries(existingNotes);
    contentByHeading.set(notesSection.heading, migratedSalience.notesContent);

    if (ideasSection && migratedSalience.ideaLines.length) {
      const existingIdeas = contentByHeading.get(ideasSection.heading) || '';
      contentByHeading.set(ideasSection.heading, appendUniqueLines(existingIdeas, migratedSalience.ideaLines));
    }
  }

  const renderedSections = [];
  for (const section of desiredSections) {
    const existingContent = trimOuterBlankLines(contentByHeading.get(section.heading) || '');
    let content = existingContent;

    if (section.id === 'notes') {
      for (const block of migratedBlocks.filter(Boolean)) {
        content = appendBlock(content, block);
      }
      if (!trimOuterBlankLines(content)) content = '-';
    } else if (section.source !== 'manual') {
      const fetcher = fetchers[section.source];
      // A source that throws must cost its own section, never the whole entry.
      // The bundled fetchers catch internally, but an injected or future one
      // may not — and losing a day's journal to a flaky data source is exactly
      // the silent loss this package exists to prevent.
      let fetched = null;
      if (fetcher) {
        try {
          fetched = fetcher({ date, isToday, config, section });
        } catch {
          fetched = null;
        }
      }
      // Most sources are a snapshot of *that day* and must never be
      // back-written onto an older entry. The activity projection is explicitly
      // date-scoped, so it renders a backfilled date from that date's evidence.
      if (isToday || section.source === 'projects') {
        // ...but a DEGRADED read is not a fact about the world, only about our
        // ability to read it, so it must never overwrite content already in
        // the entry. Without this, one unavailable activity source could
        // rewrite a populated navigation list and burn an audit backup.
        content = isDegradedSourceMarker(fetched) && hasRenderedContent(existingContent)
          ? existingContent
          : (fetched || existingContent || '-');
      } else {
        content = existingContent || '-';
      }
    } else if (!trimOuterBlankLines(content)) {
      content = '-';
    }

    renderedSections.push({
      id: section.id,
      heading: section.heading,
      content: trimOuterBlankLines(content) || '-',
    });
  }

  const base = {
    frontmatter: renderFrontmatter(date, config, frontmatter),
    sections: renderedSections,
  };

  // Opt-in only: ordinary callers never pass sectionTransforms.
  if (opts.sectionTransforms) {
    return applySectionTransforms(base, opts.sectionTransforms, {
      date,
      config,
      isToday,
    });
  }

  return base;
}

function renderJournal(date, config, normalized) {
  const parts = [normalized.frontmatter, ''];
  for (const section of normalized.sections) {
    parts.push(section.heading);
    parts.push(section.content || '-');
    parts.push('');
  }
  parts.push(SIGNATURE);
  parts.push('');
  return trimOuterBlankLines(parts.join('\n')) + '\n';
}

function resolveTilde(p) {
  if (p && p.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), p.slice(2));
  return p;
}

function resolveJournalDir(config) {
  if (process.env.JARVOS_JOURNAL_DIR || process.env.JOURNAL_DIR || process.env.JARVOS_VAULT_DIR) {
    return resolveConfig().paths.journal;
  }

  const configPath = process.env.JARVOS_CONFIG_PATH
    || process.env.JARVOS_CONFIG_FILE
    || (process.env.JARVOS_CLAWD_DIR ? path.join(process.env.JARVOS_CLAWD_DIR, 'jarvos.config.json') : null)
    || (process.env.CLAWD_DIR ? path.join(process.env.CLAWD_DIR, 'jarvos.config.json') : null);
  if (configPath && fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed?.paths?.journal || parsed?.paths?.vault) return resolveConfig().paths.journal;
    } catch {
      // Malformed optional config falls through to the legacy package fallback.
    }
  }

  const resolved = resolveConfig();
  if (resolved.paths?.journal && !config.vault?.journalDir) return resolved.paths.journal;
  if (config.vault?.journalDir) return resolveTilde(config.vault.journalDir);
  return path.join(process.env.HOME || os.homedir(), 'Vaults', 'Vault v3', 'Journal');
}

function syncOneDate(date, config, opts = {}) {
  const journalDir = resolveJournalDir(config);
  if (!opts.dryRun) migrateLegacyJournalSnapshots(journalDir);
  const journalPath = path.join(journalDir, `${date}.md`);
  const existed = fs.existsSync(journalPath);
  const original = existed ? fs.readFileSync(journalPath, 'utf8') : '';
  const state = loadJournalState(journalDir);
  const knownGood = state.dates?.[date];
  const healthBefore = classifyJournalHealth({ existed, markdown: original, knownGood, config });
  const restoreSource = (healthBefore.status === 'missing'
    || healthBefore.status === 'stub'
    || (healthBefore.status === 'stale' && isCatastrophicJournalShrink(healthBefore.metrics, knownGood)))
    ? readKnownGoodContent(journalDir, date, knownGood)
    : null;
  const source = restoreSource || original;
  let projectProjection = null;
  const normalized = normalizeSections(source, date, config, {
    fetchers: opts.fetchers,
    projectsActivityReader: opts.projectsActivityReader,
    timeZone: opts.timeZone,
    onProjectProjection: (projection) => {
      projectProjection = projection;
      if (typeof opts.onProjectProjection === 'function') opts.onProjectProjection(projection);
    },
    sectionTransforms: opts.sectionTransforms,
  });
  const updated = renderJournal(date, config, normalized);
  const changed = updated !== original;
  const backupReason = restoreSource ? 'stub-restore' : healthBefore.status;
  let backupPath = null;
  let mutationReceipt = null;

  if (changed && !opts.dryRun) {
    const mutate = existed ? opts.applyMarkdownMutation : opts.createMarkdownFile;
    if (typeof mutate !== 'function') {
      throw new Error('Canonical vault mutation composition is required; journal maintenance cannot modify Markdown directly');
    }
    if (existed) {
      backupPath = auditBackupPath(journalDir, date, backupReason);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(backupPath, original, { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(backupPath, 0o600);
    }
    mutationReceipt = mutate({
      filePath: journalPath,
      expectedContent: original,
      nextContent: updated,
      projectionReceipt: projectProjection,
    });
  }

  const persisted = !changed || opts.dryRun || [
    'committed',
    'already_satisfied',
    'saved_locally_sync_pending',
  ].includes(mutationReceipt?.status);
  const acknowledged = !changed || ['committed', 'already_satisfied'].includes(mutationReceipt?.status);
  const effectiveContent = changed && persisted ? updated : original;

  let healthAfter = classifyJournalHealth({
    existed: existed || persisted,
    markdown: effectiveContent,
    knownGood,
    config,
  });

  // Intentional opt-in section transforms may shrink content (e.g. scaffold strip).
  // That shrink is the new known-good, not a stale regression against prior state.
  const intentionalTransformWrite = Boolean(
    !opts.dryRun
    && changed
    && acknowledged
    && Array.isArray(opts.sectionTransforms)
    && opts.sectionTransforms.length > 0,
  );
  if (intentionalTransformWrite && healthAfter.status === 'stale') {
    healthAfter = {
      status: 'healthy',
      degraded: false,
      reason: 'Journal updated via intentional section transform',
      metrics: journalMetrics(updated, config),
    };
  }

  // The known-good snapshot must refresh on more than `healthy`, or it freezes.
  //
  // A journal entry legitimately SHRINKS for reasons that are not damage, and
  // `classifyJournalHealth` reads any shrink as `stale`
  // (metrics.size < knownGood.size). Two ways that happens:
  //
  //   1. A section-contract change. Retiring a section shrinks every entry, so
  //      the first pass after the change reports `stale` against the old
  //      snapshot.
  //   2. Ordinary generated-section churn. Generated sections are projections,
  //      and a late activity receipt may legitimately change a backfilled date.
  //
  // In both cases, refusing to refresh pins the entry to an older, larger
  // snapshot PERMANENTLY: the next pass makes the same comparison and reaches
  // the same answer. The run then reports `STALE detected` for that date
  // forever, and — worse — a genuine truncation later would restore that stale
  // snapshot over everything authored since.
  //
  // The gate is authored content surviving, NOT the entry's structure: the
  // candidate here is freshly rendered output, so a structure check would be
  // true on every write path and this would become a blanket bypass that
  // overwrites a good snapshot with a damaged entry. Authored survival is also
  // exactly the condition the snapshot exists to protect — if every authored
  // line is still present there is nothing catastrophic left to restore, while
  // a truncated or gutted entry drops authored lines, fails this check, and
  // correctly keeps its old snapshot for the restore path.
  const knownGoodMarkdown = knownGood ? readKnownGoodContent(journalDir, date, knownGood) : null;
  const authoredContentIntact = Boolean(
    knownGood
    && knownGoodMarkdown
    && authoredContentPreserved(effectiveContent, knownGoodMarkdown, config)
  );

  if (!opts.dryRun && acknowledged && (healthAfter.status === 'healthy' || authoredContentIntact)) {
    const updatedKnownGoodPath = knownGoodPath(journalDir, date);
    fs.mkdirSync(path.dirname(updatedKnownGoodPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(updatedKnownGoodPath, effectiveContent, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(updatedKnownGoodPath, 0o600);
    const metrics = journalMetrics(effectiveContent, config);
    state.version = 1;
    state.dates = state.dates || {};
    state.dates[date] = {
      date,
      size: metrics.size,
      hash: metrics.hash,
      sectionCount: metrics.sectionCount,
      sections: metrics.sections,
      contractSignature: contractSignature(config),
      knownGoodPath: updatedKnownGoodPath,
      updatedAt: new Date().toISOString(),
    };
    writeJournalState(journalDir, state);
  }

  return {
    date,
    journalPath,
    existed,
    changed,
    written: Boolean(changed && !opts.dryRun && acknowledged),
    savedLocally: mutationReceipt?.status === 'saved_locally_sync_pending',
    writeStatus: opts.dryRun ? 'dry-run' : (changed ? (mutationReceipt?.status || 'failed') : 'unchanged'),
    mutationReceipt,
    healthBefore,
    healthAfter,
    backupPath,
    restoredKnownGood: Boolean(restoreSource),
    projectProjection,
  };
}

function deferredBacklinkFlush() {
  // This stays lazy to avoid a require cycle: the provenance linker imports
  // this module for journal rendering, while maintenance invokes recovery only
  // after the journal sync has completed.
  return require('../../../bridge/provenance/src/link-to-journal.js').flushDeferredBacklinks;
}

function readDeferredBacklinkFlushMetadata(journalDir) {
  const deferredPath = require('../../../bridge/provenance/src/link-to-journal.js')
    .deferredQueuePathForJournalDir(journalDir);
  try {
    const queue = JSON.parse(fs.readFileSync(deferredPath, 'utf8'));
    return {
      lastFlushAt: typeof queue.lastFlushAt === 'string' ? queue.lastFlushAt : null,
      summary: queue.lastFlushSummary && typeof queue.lastFlushSummary === 'object'
        ? queue.lastFlushSummary
        : null,
      entries: queue.entries && typeof queue.entries === 'object'
        ? Object.entries(queue.entries).map(([key, entry]) => ({ key, ...entry }))
        : [],
    };
  } catch {
    return { lastFlushAt: null, summary: null, entries: [] };
  }
}

function flushSummary(summary = {}) {
  const entries = Array.isArray(summary.entries) ? summary.entries : [];
  const number = (field) => Number.isFinite(summary[field]) ? summary[field] : 0;
  return {
    checked: number('checked'),
    linked: number('linked'),
    pending: number('pending'),
    unresolved: number('unresolved'),
    superseded: number('superseded'),
    // Linker failures remain pending for retry. Keeping this distinct from
    // `pending` makes the retry health visible without changing queue states.
    failed: Number.isFinite(summary.failed)
      ? summary.failed
      : entries.filter((entry) => entry && entry.status === 'pending' && entry.error).length,
    ...(summary.queuePath ? { queuePath: summary.queuePath } : {}),
    ...(entries.length ? { entries } : {}),
  };
}

function requiresDeferredBacklinkAttention(summary) {
  return summary.pending > 0
    || summary.unresolved > 0
    || summary.superseded > 0
    || summary.failed > 0;
}

function mergeDeferredBacklinkQueueState(summary, entries) {
  const queueState = {
    pending: 0,
    unresolved: 0,
    superseded: 0,
    failed: 0,
  };
  for (const entry of entries || []) {
    if (!entry || !Object.hasOwn(queueState, entry.status)) continue;
    queueState[entry.status] += 1;
    if (entry.status === 'pending' && entry.lastError) queueState.failed += 1;
  }
  return {
    ...summary,
    pending: Math.max(summary.pending, queueState.pending),
    unresolved: Math.max(summary.unresolved, queueState.unresolved),
    superseded: Math.max(summary.superseded, queueState.superseded),
    failed: Math.max(summary.failed, queueState.failed),
  };
}

function formatDeferredBacklinkStatus(lastFlushAt, summary) {
  return [
    `Deferred backlinks${lastFlushAt ? ` (last flush: ${lastFlushAt})` : ''}:`,
    `checked=${summary.checked}`,
    `linked=${summary.linked}`,
    `pending=${summary.pending}`,
    `unresolved=${summary.unresolved}`,
    `superseded=${summary.superseded}`,
    `failed=${summary.failed}`,
  ].join(' ');
}

function creationOnlyReportWithDeferredStatus(report, args, opts) {
  const result = report.results?.[0];
  const journalDir = result?.journalPath ? path.dirname(result.journalPath) : null;
  if (!journalDir) return report;

  const readFlushMetadata = opts.readDeferredBacklinkFlushMetadata || readDeferredBacklinkFlushMetadata;
  const queueMetadata = readFlushMetadata(journalDir);
  const summary = mergeDeferredBacklinkQueueState(
    flushSummary(queueMetadata.summary || {}),
    queueMetadata.entries,
  );
  const lastFlushAt = queueMetadata.lastFlushAt || null;
  const attention = requiresDeferredBacklinkAttention(summary);
  const status = report.status === 'failed' || attention ? 'failed' : report.status;
  const output = args.json
    ? JSON.stringify({
      ...report,
      lastFlushAt,
      summary,
      lastFlushSummary: summary,
      deferredBacklinks: summary,
      status,
    })
    : [report.output, ...(attention ? [formatDeferredBacklinkStatus(lastFlushAt, summary)] : [])]
      .filter(Boolean)
      .join('\n');
  return {
    ...report,
    lastFlushAt,
    summary,
    lastFlushSummary: summary,
    deferredBacklinks: summary,
    status,
    output,
  };
}

function runMaintenance(argv = process.argv.slice(2), opts = {}) {
  const args = parseArgs(argv);
  if (args.createIfMissing) {
    const lifecycle = require('./journal-lifecycle.js');
    const create = opts.runCreationMaintenance || lifecycle.runCreationMaintenance;
    const report = create(args, opts);
    // Creation remains creation-only: do not mutate authored journals while
    // flushing backlinks. Surface queued work so a host can alert or run the
    // separate human-approved reconciliation command.
    return creationOnlyReportWithDeferredStatus(report, args, opts);
  }
  const config = (opts.loadConfig || loadConfig)();
  const sync = opts.syncOneDate || syncOneDate;
  const flush = opts.flushDeferredBacklinks || deferredBacklinkFlush();
  const readFlushMetadata = opts.readDeferredBacklinkFlushMetadata || readDeferredBacklinkFlushMetadata;
  const dates = unique(args.dateSpecs.map(resolveDateSpec));
  const mutationOptions = {
    ...args,
    ...(opts.applyMarkdownMutation ? { applyMarkdownMutation: opts.applyMarkdownMutation } : {}),
    ...(opts.createMarkdownFile ? { createMarkdownFile: opts.createMarkdownFile } : {}),
    ...(opts.projectsActivityReader ? { projectsActivityReader: opts.projectsActivityReader } : {}),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.onProjectProjection ? { onProjectProjection: opts.onProjectProjection } : {}),
  };
  const results = dates.map((date) => sync(date, config, mutationOptions));
  const journalDir = path.dirname(results[0].journalPath);
  const rawFlushSummary = flush({
    journalDir,
    vaultRoot: path.dirname(journalDir),
    notesDir: path.join(path.dirname(journalDir), 'Notes'),
    dryRun: args.dryRun,
  });
  const queueMetadata = readFlushMetadata(journalDir);
  const summary = mergeDeferredBacklinkQueueState(
    flushSummary(rawFlushSummary || queueMetadata.summary || {}),
    queueMetadata.entries,
  );
  const lastFlushAt = rawFlushSummary?.lastFlushAt || queueMetadata.lastFlushAt;

  const reportable = results.filter((result) => result.changed || result.healthBefore.degraded || result.healthAfter.degraded);
  const lines = reportable.map((result) => {
    let verb = result.existed ? 'UPDATED' : 'CREATED';
    if (result.healthBefore.status === 'missing') verb = 'MISSING -> CREATED';
    if (result.healthBefore.status === 'stub') verb = result.restoredKnownGood ? 'STUB -> REPAIRED restored known-good' : 'STUB -> REPAIRED scaffolded';
    if (result.healthBefore.status === 'stale') {
      verb = result.healthAfter.status === 'healthy' ? 'STALE -> REPAIRED normalized' : 'STALE detected';
    }
    if (!result.changed && result.healthBefore.degraded) {
      verb = `${verb} without write`;
    }
    const suffixes = [];
    if (args.dryRun) suffixes.push('dry run');
    if (result.backupPath) suffixes.push(`audit backup: ${result.backupPath}`);
    return `${verb} ${result.journalPath}${suffixes.length ? ` (${suffixes.join('; ')})` : ''}`;
  });
  const backlinkAttention = requiresDeferredBacklinkAttention(summary);
  if (backlinkAttention) lines.push(formatDeferredBacklinkStatus(lastFlushAt, summary));

  const status = lines.length ? 'reported' : 'NO_REPLY';
  const report = {
    dates,
    results,
    lastFlushAt,
    summary,
    // Match the queue's persisted naming for callers that poll freshness.
    lastFlushSummary: summary,
    status,
  };
  report.output = args.json ? JSON.stringify(report) : (lines.join('\n') || 'NO_REPLY');
  return report;
}

function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  const report = runMaintenance(argv, { env, ...options });
  console.log(report.output);
  return report;
}

module.exports = {
  applySectionTransforms,
  buildSourceFetchers,
  buildProjectsActivityFetcher,
  main,
  classifyJournalHealth,
  contractSignature,
  structureMatchesContract,
  authoredContentPreserved,
  isCatastrophicJournalShrink,
  detectConflictingJournalWriters,
  journalMetrics,
  loadConfig,
  readConfig,
  normalizeSections,
  normalizeProjectsActivityResult,
  requiresDeferredBacklinkAttention,
  renderJournal,
  resolveDateSpec,
  resolveJournalDir,
  runMaintenance,
  stripLeadingRecoveryScaffold,
  syncOneDate,
  today,
};

if (require.main === module) {
  const report = main();
  if (report?.status === 'failed') process.exitCode = 1;
}
