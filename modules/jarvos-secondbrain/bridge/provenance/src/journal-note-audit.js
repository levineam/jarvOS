#!/usr/bin/env node
/**
 * Bridge-owned canonical note↔journal link auditor.
 *
 * Detects notes created today (or on a given date) in the vault Notes/
 * directory and checks whether each is already linked in that day's journal
 * preferred ## 🗂️ Notes Created section (falling back to legacy ## 📝 Notes when
 * auditing pre-migration entries). Reports gaps and optionally patches them.
 *
 * Usage:
 *   node jarvos-secondbrain/bridge/provenance/src/journal-note-audit.js
 *   node jarvos-secondbrain/bridge/provenance/src/journal-note-audit.js --dry-run
 *   node jarvos-secondbrain/bridge/provenance/src/journal-note-audit.js --fix
 *   node jarvos-secondbrain/bridge/provenance/src/journal-note-audit.js --date=YYYY-MM-DD
 *   node jarvos-secondbrain/bridge/provenance/src/journal-note-audit.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getVaultNotesDir, getVaultJournalDir } = require('./lib/provenance-config');

const NOTES_DIR = getVaultNotesDir();
const JOURNAL_DIR = getVaultJournalDir();
const NOTES_CREATED_HEADING = '## 🗂️ Notes Created';
const LEGACY_NOTES_HEADING = '## 📝 Notes';
const TRACKED_SECTION_HEADINGS = [NOTES_CREATED_HEADING, LEGACY_NOTES_HEADING];

const EXCLUDE_PATTERNS = [
  /- Project Board\.md$/i,
  /- Project Brief\.md$/i,
  /— Project Board\.md$/i,
  /— Project Brief\.md$/i,
  /— Plan\.md$/i,
  / — Plan\.md$/i,
  /- Plan\.md$/i,
  /^Tasks\.md$/i,
  /^North Star Kanban\.md$/i,
  /^Daily Journal Template\.md$/i,
];

function parseArgs(argv) {
  const opts = {
    dateSpec: 'today',
    dryRun: true,
    fix: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === '--fix') { opts.fix = true; opts.dryRun = false; }
    else if (arg === '--dry-run') { opts.dryRun = true; opts.fix = false; }
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--date=')) opts.dateSpec = arg.split('=').slice(1).join('=');
    else if (arg === '--help' || arg === '-h') printHelpAndExit(0);
  }

  return opts;
}

function printHelpAndExit(code) {
  console.log(`
Usage: node jarvos-secondbrain/bridge/provenance/src/journal-note-audit.js [options]

Options:
  --fix              Patch journal with missing note links (default: dry-run)
  --dry-run          Report gaps without writing (default)
  --date=YYYY-MM-DD  Audit a specific date instead of today
  --json             Output machine-readable JSON
  -h, --help         Show this help

Exit codes:
  0  No gaps, or all gaps patched
  1  Gaps remain (dry-run or patch failed)
  2  Config/usage error
`.trim());
  process.exit(code);
}

function nyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function resolveDate(spec) {
  if (!spec || spec === 'today') return nyToday();
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  throw new Error(`Invalid date spec: "${spec}"`);
}

function noteLinkTargetFromPath(fullPath) {
  return path.relative(NOTES_DIR, fullPath).replace(/\\/g, '/').replace(/\.md$/i, '');
}

function normalizeWikiTarget(target) {
  return String(target || '').trim().split('#')[0].trim().split('|')[0].trim();
}

function isExcluded(filename) {
  return EXCLUDE_PATTERNS.some((re) => re.test(filename));
}

function walkMdFiles(dir) {
  const collected = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read directory "${dir}": ${err.message}`);
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...walkMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      collected.push(fullPath);
    }
  }
  return collected;
}

function createdAtForStat(stat) {
  if (stat && Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) {
    return stat.birthtime;
  }
  return stat.mtime;
}

function findAllNotes() {
  let allFiles;
  try {
    allFiles = walkMdFiles(NOTES_DIR);
  } catch (err) {
    throw new Error(`Cannot read Notes directory: ${err.message}`);
  }

  const results = [];
  for (const fullPath of allFiles) {
    const filename = path.basename(fullPath);
    if (isExcluded(filename)) continue;

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    results.push({
      name: filename,
      title: noteLinkTargetFromPath(fullPath),
      fullPath,
      createdAt: createdAtForStat(stat),
      mtime: stat.mtime,
    });
  }

  return results;
}

function findNotesForDate(dateYmd) {
  const nyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const results = findAllNotes().filter((note) => nyFormatter.format(note.createdAt) === dateYmd);
  results.sort((a, b) => a.createdAt - b.createdAt || a.mtime - b.mtime);
  return results;
}

function formatNoteLinks(notes) {
  return notes.map((note) => `- [[${note.title}]]`).join('\n');
}

function extractWikiLinks(md) {
  const links = new Set();
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const target = normalizeWikiTarget(m[1]);
    if (target) links.add(target);
  }
  return links;
}

function findSectionRange(lines, heading) {
  let sectionLineStart = -1;
  let sectionLineEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) {
      sectionLineStart = i;
      continue;
    }
    if (sectionLineStart !== -1 && i > sectionLineStart && /^##\s/.test(lines[i])) {
      sectionLineEnd = i;
      break;
    }
  }

  return { sectionLineStart, sectionLineEnd };
}

function extractTrackedSection(journalMd) {
  const lines = journalMd.split('\n');

  for (const heading of TRACKED_SECTION_HEADINGS) {
    const { sectionLineStart, sectionLineEnd } = findSectionRange(lines, heading);
    if (sectionLineStart === -1) continue;
    return {
      found: true,
      heading,
      sectionContent: lines.slice(sectionLineStart + 1, sectionLineEnd).join('\n'),
      sectionLineStart,
      sectionLineEnd,
      lines,
    };
  }

  return {
    found: false,
    heading: null,
    sectionContent: '',
    sectionLineStart: -1,
    sectionLineEnd: -1,
    lines,
  };
}

function findMissingLinks(notes, journalMd, allNotes = notes) {
  const parsed = extractTrackedSection(journalMd);
  const existingLinks = extractWikiLinks(parsed.found ? parsed.sectionContent : '');
  const basenameCounts = new Map();

  for (const note of allNotes) {
    const basename = path.posix.basename(note.title);
    basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
  }

  return notes.filter((note) => {
    const basename = path.posix.basename(note.title);
    if (existingLinks.has(note.title)) return false;
    if (basenameCounts.get(basename) !== 1) return true;
    return !existingLinks.has(basename);
  });
}

const EMPTY_PLACEHOLDER_RE = /^\*(?:Links to (?:any )?notes created (?:during|today|on)[\s\S]*|No notes (?:today|yet|created)[\s\S]*|Notes will appear here[\s\S]*)\*$/i;

function injectNoteLinks(journalMd, missingNotes) {
  if (!missingNotes.length) return journalMd;

  const parsed = extractTrackedSection(journalMd);
  const noteLines = formatNoteLinks(missingNotes).split('\n');

  if (!parsed.found || parsed.heading !== NOTES_CREATED_HEADING) {
    const insertion = `${NOTES_CREATED_HEADING}\n${formatNoteLinks(missingNotes)}\n`;
    return journalMd.trimEnd() + `\n\n${insertion}`;
  }

  const { lines, sectionLineStart, sectionLineEnd } = parsed;
  const existingContentLines = lines.slice(sectionLineStart + 1, sectionLineEnd);
  const nonPlaceholderLines = existingContentLines.filter(
    (line) => line.trim() !== '-' && !EMPTY_PLACEHOLDER_RE.test(line.trim()) && line.trim() !== '',
  );
  const newSectionLines = [...nonPlaceholderLines, ...noteLines];
  const finalSectionLines = newSectionLines.length ? newSectionLines : ['-'];

  const rebuilt = [
    ...lines.slice(0, sectionLineStart + 1),
    ...finalSectionLines,
    '',
    ...lines.slice(sectionLineEnd),
  ];

  return rebuilt.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let dateYmd;
  try {
    dateYmd = resolveDate(opts.dateSpec);
  } catch (err) {
    console.error(`[journal-note-audit] Error: ${err.message}`);
    process.exit(2);
  }

  const journalPath = path.join(JOURNAL_DIR, `${dateYmd}.md`);

  let journalMd = '';
  if (fs.existsSync(journalPath)) {
    journalMd = fs.readFileSync(journalPath, 'utf8');
  } else if (opts.fix) {
    const result = {
      date: dateYmd,
      journalPath,
      journalExists: false,
      notesToday: [],
      missingLinks: [],
      patched: false,
      error: 'Journal file does not exist; run journal-maintenance.js first',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.warn(`[journal-note-audit] WARNING: Journal not found at ${journalPath}`);
      console.warn('[journal-note-audit] Run journal-maintenance.js first to create it.');
    }
    process.exit(1);
  }

  let notesToday;
  let allNotes;
  try {
    notesToday = findNotesForDate(dateYmd);
    allNotes = findAllNotes();
  } catch (err) {
    console.error(`[journal-note-audit] Error scanning notes: ${err.message}`);
    process.exit(2);
  }

  const missingLinks = findMissingLinks(notesToday, journalMd, allNotes);
  const trackedSection = extractTrackedSection(journalMd);

  const result = {
    date: dateYmd,
    journalPath,
    journalExists: fs.existsSync(journalPath),
    trackedSection: trackedSection.heading,
    notesToday: notesToday.map((n) => n.title),
    missingLinks: missingLinks.map((n) => n.title),
    patched: false,
  };

  if (opts.fix && missingLinks.length > 0) {
    const updated = injectNoteLinks(journalMd, missingLinks);
    fs.writeFileSync(journalPath, updated, 'utf8');
    result.patched = true;

    if (!opts.json) {
      console.log(`[journal-note-audit] PATCHED ${journalPath}`);
      for (const n of missingLinks) {
        console.log(`  + [[${n.title}]]`);
      }
    }
  } else if (!opts.json) {
    if (notesToday.length === 0) {
      console.log(`[journal-note-audit] No notes found for ${dateYmd}.`);
    } else if (missingLinks.length === 0) {
      console.log(`[journal-note-audit] All ${notesToday.length} note(s) already linked. OK.`);
    } else {
      console.log(`[journal-note-audit] ${missingLinks.length} note(s) NOT linked in journal for ${dateYmd}:`);
      for (const n of missingLinks) {
        console.log(`  MISSING: [[${n.title}]]`);
      }
      if (opts.dryRun) {
        console.log('[journal-note-audit] Run with --fix to patch.');
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  }

  const hasGaps = missingLinks.length > 0 && !result.patched;
  process.exit(hasGaps ? 1 : 0);
}

module.exports = {
  main,
  NOTES_CREATED_HEADING,
  LEGACY_NOTES_HEADING,
  TRACKED_SECTION_HEADINGS,
  extractWikiLinks,
  extractTrackedSection,
  findAllNotes,
  findNotesForDate,
  findMissingLinks,
  formatNoteLinks,
  injectNoteLinks,
  noteLinkTargetFromPath,
  normalizeWikiTarget,
};

if (require.main === module) {
  main();
}
