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
 *
 * Path resolution (all optional):
 *   JARVOS_JOURNAL_DIR / JOURNAL_DIR env vars override journal directory
 *   JARVOS_VAULT_DIR or jarvos.config.json paths.* drive shared defaults
 *   config/journal-module.json vault.journalDir is legacy fallback only
 *   JARVOS_CLAWD_DIR (or CLAWD_DIR) overrides clawd/workspace root
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const {
  findNotesForDate,
  formatNoteLinks,
} = require('../../../bridge/provenance/src/journal-note-audit.js');
const {
  getJournalDir,
  loadConfig: loadSharedPathConfig,
  getClawdDir,
  getTimeZone,
} = require('../../../bridge/config/jarvos-paths.js');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PACKAGE_ROOT, 'config', 'journal-module.json');
const PAPERCLIP_BRIDGE_SCRIPT = path.join(getClawdDir(), 'scripts', 'journal-paperclip-inbox.js');
const SIGNATURE = '— Edited by Jarvis';

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

function localDate(offsetDays = 0, timeZone = getTimeZone()) {
  const now = new Date();
  const localYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
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
  return localDate(0);
}

function resolveDateSpec(spec) {
  if (!spec || spec === 'today') return localDate(0);
  if (spec === 'yesterday') return localDate(-1);
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

function buildSourceFetchers() {
  return {
    'google-calendar': ({ isToday, section }) => {
      if (!isToday) return null;
      try {
        const calFilter = section?.calendarFilter;
        const args = Array.isArray(calFilter) && calFilter.length
          ? ['-ic', calFilter.join(','), 'eventsToday']
          : ['eventsToday'];
        const out = execFileSync('icalBuddy', args, {
          encoding: 'utf8',
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
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
              timeZone: getTimeZone(),
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
        return out || '- No open Paperclip issues';
      } catch {
        return '- (Paperclip API unavailable)';
      }
    },

    'notes-created': ({ date }) => {
      try {
        const notes = findNotesForDate(date);
        if (!notes.length) return `- No notes created on ${date}`;
        return formatNoteLinks(notes);
      } catch {
        return '- (notes provenance unavailable)';
      }
    },

    manual: () => null,
  };
}

function normalizeSections(original, date, config) {
  const desiredSections = buildDesiredSections(config);
  const desiredByHeading = new Map(desiredSections.map((section) => [section.heading, section]));
  const configuredHeadingMap = buildConfiguredHeadingMap(config);
  const configuredById = new Map(desiredSections.map((section) => [section.id, section]));
  const fetchers = buildSourceFetchers();
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
        const targetExisting = contentByHeading.get(targetSection.heading);
        contentByHeading.set(targetSection.heading, appendBlock(targetExisting, section.content));
        continue;
      }
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
      if (section.source === 'notes-created') {
        content = fetched || existingContent || '-';
      } else if (isToday) {
        content = fetched || existingContent || '-';
      } else {
        content = existingContent || '-';
      }
    } else if (!trimOuterBlankLines(content)) {
      content = '-';
    }

    renderedSections.push({
      heading: section.heading,
      content: trimOuterBlankLines(content) || '-',
    });
  }

  return {
    frontmatter: renderFrontmatter(date, config, frontmatter),
    sections: renderedSections,
  };
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
  // Shared resolver owns canonical precedence:
  // JARVOS_JOURNAL_DIR → JOURNAL_DIR → jarvos.config.json paths.journal →
  // JARVOS_VAULT_DIR / jarvos.config.json paths.vault / default vault root.
  const sharedJournalDir = getJournalDir();
  const sharedConfig = loadSharedPathConfig();
  const hasSharedPathInput = Boolean(
    process.env.JARVOS_JOURNAL_DIR ||
      process.env.JOURNAL_DIR ||
      process.env.JARVOS_VAULT_DIR ||
      sharedConfig.paths?.journal ||
      sharedConfig.paths?.vault ||
      sharedConfig.vaultPath
  );

  // Legacy journal-module.json fallback only applies when no shared path input
  // was provided. This preserves old installs without overriding the shared
  // vault contract.
  if (!hasSharedPathInput && config.vault && config.vault.journalDir) {
    return resolveTilde(config.vault.journalDir);
  }

  return sharedJournalDir;
}

function syncOneDate(date, config, opts) {
  const journalDir = resolveJournalDir(config);
  const journalPath = path.join(journalDir, `${date}.md`);
  const existed = fs.existsSync(journalPath);
  const original = existed ? fs.readFileSync(journalPath, 'utf8') : '';
  const normalized = normalizeSections(original, date, config);
  const updated = renderJournal(date, config, normalized);
  const changed = updated !== original;

  if (changed && !opts.dryRun) {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(journalPath, updated, 'utf8');
  }

  return {
    date,
    journalPath,
    existed,
    changed,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadConfig();
  const dates = unique(args.dateSpecs.map(resolveDateSpec));
  const results = dates.map((date) => syncOneDate(date, config, args));

  const changed = results.filter((result) => result.changed);
  if (changed.length === 0) {
    console.log('NO_REPLY');
    return;
  }

  const lines = changed.map((result) => {
    const verb = result.existed ? 'UPDATED' : 'CREATED';
    return `${verb} ${result.journalPath}${args.dryRun ? ' (dry run)' : ''}`;
  });
  console.log(lines.join('\n'));
}

module.exports = {
  main,
  loadConfig,
  normalizeSections,
  renderJournal,
  resolveDateSpec,
  localDate,
  resolveJournalDir,
  today,
};

if (require.main === module) {
  main();
}
