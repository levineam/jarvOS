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
const SIGNATURE = '— Edited by Jarvis';
const DEFAULT_TIMEZONE = 'America/New_York';
const LEGACY_SALIENCE_LINE_RE = /^-\s*📌\s*\*\(([^,]+),\s*(\d+)%\)\*\s*(.+)$/i;
const JOURNAL_STATE_DIR = '.jarvos/journal-maintenance';

function parseArgs(argv) {
  const out = {
    dateSpecs: ['today'],
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
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
    '  -h, --help',
  ].join('\n'));
  process.exit(code);
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`Failed to load journal config: ${err.message}`);
    process.exit(1);
  }
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
  return path.join(path.dirname(journalDir), JOURNAL_STATE_DIR);
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
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function journalMetrics(markdown) {
  const text = String(markdown || '');
  const { body } = splitFrontmatter(text);
  const sections = parseSections(body).sections.map((section) => section.heading);
  const hasBodyText = trimOuterBlankLines(body).length > 0;
  const meaningfulBodyChars = trimOuterBlankLines(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== SIGNATURE && line !== '-' && !/^##\s+/.test(line))
    .filter((line) => !isGeneratedPlaceholderLine(line))
    .join('\n').length;
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
  return /^-\s+(?:No events today|No reminders due today|No blocked Paperclip issues|No notes created(?: on .*)?|No notes today|No notes yet|\((?:calendar unavailable|reminders unavailable|Paperclip inbox script not found|Paperclip API unavailable)\))$/i.test(line);
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

function classifyJournalHealth({ existed, markdown, knownGood }) {
  if (!existed) {
    return {
      status: 'missing',
      degraded: false,
      reason: 'Journal file is missing',
      metrics: journalMetrics(''),
    };
  }

  const metrics = journalMetrics(markdown);
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

function buildSourceFetchers() {
  return {
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
  const fetchers = opts.fetchers || buildSourceFetchers();
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
      const fetched = fetcher ? fetcher({ date, isToday, config, section }) : null;
      if (isToday) {
        content = fetched || existingContent || '-';
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
  const journalPath = path.join(journalDir, `${date}.md`);
  const existed = fs.existsSync(journalPath);
  const original = existed ? fs.readFileSync(journalPath, 'utf8') : '';
  const state = loadJournalState(journalDir);
  const knownGood = state.dates?.[date];
  const healthBefore = classifyJournalHealth({ existed, markdown: original, knownGood });
  const restoreSource = (healthBefore.status === 'missing'
    || healthBefore.status === 'stub'
    || (healthBefore.status === 'stale' && isCatastrophicJournalShrink(healthBefore.metrics, knownGood)))
    ? readKnownGoodContent(journalDir, date, knownGood)
    : null;
  const source = restoreSource || original;
  const normalized = normalizeSections(source, date, config, {
    fetchers: opts.fetchers,
    sectionTransforms: opts.sectionTransforms,
  });
  const updated = renderJournal(date, config, normalized);
  const changed = updated !== original;
  const backupReason = restoreSource ? 'stub-restore' : healthBefore.status;
  let backupPath = null;

  if (changed && !opts.dryRun) {
    fs.mkdirSync(journalDir, { recursive: true });
    if (existed) {
      backupPath = auditBackupPath(journalDir, date, backupReason);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, original, 'utf8');
    }
    fs.writeFileSync(journalPath, updated, 'utf8');
  }

  let healthAfter = classifyJournalHealth({
    existed: true,
    markdown: changed ? updated : original,
    knownGood,
  });

  // Intentional opt-in section transforms may shrink content (e.g. scaffold strip).
  // That shrink is the new known-good, not a stale regression against prior state.
  const intentionalTransformWrite = Boolean(
    !opts.dryRun
    && changed
    && Array.isArray(opts.sectionTransforms)
    && opts.sectionTransforms.length > 0,
  );
  if (intentionalTransformWrite && healthAfter.status === 'stale') {
    healthAfter = {
      status: 'healthy',
      degraded: false,
      reason: 'Journal updated via intentional section transform',
      metrics: journalMetrics(updated),
    };
  }

  if (!opts.dryRun && healthAfter.status === 'healthy') {
    const updatedKnownGoodPath = knownGoodPath(journalDir, date);
    fs.mkdirSync(path.dirname(updatedKnownGoodPath), { recursive: true });
    fs.writeFileSync(updatedKnownGoodPath, changed ? updated : original, 'utf8');
    const metrics = journalMetrics(changed ? updated : original);
    state.version = 1;
    state.dates = state.dates || {};
    state.dates[date] = {
      date,
      size: metrics.size,
      hash: metrics.hash,
      sectionCount: metrics.sectionCount,
      sections: metrics.sections,
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
    written: Boolean(changed && !opts.dryRun),
    writeStatus: opts.dryRun ? 'dry-run' : (changed ? 'written' : 'unchanged'),
    healthBefore,
    healthAfter,
    backupPath,
    restoredKnownGood: Boolean(restoreSource),
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadConfig();
  const dates = unique(args.dateSpecs.map(resolveDateSpec));
  const results = dates.map((date) => syncOneDate(date, config, args));

  const reportable = results.filter((result) => result.changed || result.healthBefore.degraded || result.healthAfter.degraded);
  if (reportable.length === 0) {
    console.log('NO_REPLY');
    return;
  }

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
  console.log(lines.join('\n'));
}

module.exports = {
  applySectionTransforms,
  main,
  classifyJournalHealth,
  isCatastrophicJournalShrink,
  detectConflictingJournalWriters,
  journalMetrics,
  loadConfig,
  normalizeSections,
  renderJournal,
  resolveDateSpec,
  resolveJournalDir,
  stripLeadingRecoveryScaffold,
  syncOneDate,
  today,
};

if (require.main === module) {
  main();
}
