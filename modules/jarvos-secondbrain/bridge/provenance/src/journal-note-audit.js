#!/usr/bin/env node
/**
 * Bridge-owned canonical note↔journal link auditor.
 *
 * Detects notes created today (or on a given date) in the vault Notes/
 * directory and checks whether each is already linked in that day's journal
 * preferred ## 📝 Notes section (falling back to legacy ## 🗂️ Notes Created when
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
const { getSectionHeading, getJournalSections } = require('../../../packages/jarvos-secondbrain-journal/src/section-config');
const { migrateLegacyNotesCreatedSection } = require('./notes-section-normalizer');

const NOTES_DIR = getVaultNotesDir();
const JOURNAL_DIR = getVaultJournalDir();
// Resolve from journal-module.json so a renamed Notes heading is honored (WS0).
const NOTES_HEADING = getSectionHeading('notes', { fallback: '## 📝 Notes' });
const NOTES_CREATED_HEADING = '## 🗂️ Notes Created';
const TRACKED_SECTION_HEADINGS = [NOTES_HEADING, NOTES_CREATED_HEADING];
const LEGACY_NOTES_CREATED_CUTOFF = '2026-05-14';

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

// Read the frontmatter `updated:` date (YYYY-MM-DD) if present. If a manually
// edited note has no updated frontmatter, the audit falls back to file mtime so
// external/Obsidian edits still get a daily journal backlink.
function readUpdatedDate(fullPath) {
  let text;
  try {
    text = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^\s*updated\s*:\s*["']?(\d{4}-\d{2}-\d{2})/m);
  return m ? m[1] : null;
}

// A note belongs in a given day's journal Notes section if it was CREATED that day
// or UPDATED that day (per the journal-module contract: "created or updated that day").
function noteMatchesDate(note, dateYmd, fmt) {
  return (
    fmt(note.createdAt) === dateYmd ||
    note.updated === dateYmd ||
    (!note.updated && note.mtime && fmt(note.mtime) === dateYmd)
  );
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
      updated: readUpdatedDate(fullPath),
    });
  }

  return results;
}

function findNotesForDate(dateYmd) {
  const nyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const fmt = (d) => nyFormatter.format(d);
  const results = findAllNotes().filter((note) => noteMatchesDate(note, dateYmd, fmt));
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

function extractTrackedSection(journalMd, opts = {}) {
  const { allowLegacy = true } = opts;
  const lines = journalMd.split('\n');
  const headings = allowLegacy ? TRACKED_SECTION_HEADINGS : [NOTES_HEADING];

  for (const heading of headings) {
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

function findMissingLinks(notes, journalMd, allNotes = notes, opts = {}) {
  const parsed = extractTrackedSection(journalMd, opts);
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

  if (!parsed.found || parsed.heading !== NOTES_HEADING) {
    const insertion = `${NOTES_HEADING}\n${formatNoteLinks(missingNotes)}\n`;
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

// --- Structural health (SUP-1941) -----------------------------------------
// The note↔link audit alone cannot distinguish a healthy journal from a
// ~50-byte frontmatter-only stub: a stub simply reports "no notes today" and
// exits 0, masking a broken journal. This is exactly what happened on
// 2026-05-21 — the journal-maintenance cron failed silently and the Obsidian
// Journals plugin auto-created a bare frontmatter shell that went unnoticed.
// So we also verify the journal carries its required section scaffold per
// journal-module.json, and (under --fix) scaffold any missing required
// headings. Scaffolding is purely ADDITIVE — it never deletes content — and a
// full repopulate of auto-fetch sections (calendar/reminders/paperclip)
// remains journal-maintenance.js's job.

function getRequiredHeadings() {
  return getJournalSections()
    .filter((s) => s.enabled !== false)
    .map((s) => String(s.heading).trim());
}

function stripFrontmatter(md) {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

// Returns { healthy, isStub, present, missing }. A "stub" is a journal whose
// body (after frontmatter) carries no '## ' section at all — the bare
// auto-created shell, not a real entry.
function checkJournalStructure(journalMd, requiredHeadings = getRequiredHeadings()) {
  const lines = String(journalMd).split('\n');
  const present = requiredHeadings.filter((h) => lines.some((l) => l.trim() === h));
  const missing = requiredHeadings.filter((h) => !present.includes(h));
  const body = stripFrontmatter(String(journalMd)).trim();
  const isStub = body.length === 0 || !/^##\s/m.test(body);
  return { healthy: !isStub && missing.length === 0, isStub, present, missing };
}

// Append any missing required headings (in config order) with an empty
// placeholder. Additive only; structure-lock's drift pass will reorder/fill.
function scaffoldMissingSections(journalMd, missingHeadings) {
  if (!missingHeadings.length) return journalMd;
  const additions = missingHeadings.map((h) => `${h}\n-`).join('\n\n');
  return `${String(journalMd).trimEnd()}\n\n${additions}\n`;
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

  const legacyMigration = migrateLegacyNotesCreatedSection(journalMd);
  const shouldMigrateLegacy = legacyMigration.migrated;
  const auditMd = opts.fix && shouldMigrateLegacy ? legacyMigration.content : journalMd;
  const allowLegacy = dateYmd < LEGACY_NOTES_CREATED_CUTOFF && !shouldMigrateLegacy;
  const missingLinks = findMissingLinks(notesToday, auditMd, allNotes, { allowLegacy });
  const trackedSection = extractTrackedSection(auditMd, { allowLegacy });

  const structure = checkJournalStructure(auditMd);

  const result = {
    date: dateYmd,
    journalPath,
    journalExists: fs.existsSync(journalPath),
    trackedSection: trackedSection.heading,
    notesToday: notesToday.map((n) => n.title),
    missingLinks: missingLinks.map((n) => n.title),
    structure: {
      healthy: structure.healthy,
      isStub: structure.isStub,
      missingSections: structure.missing,
    },
    legacyNotesCreated: {
      present: shouldMigrateLegacy,
      migrated: false,
      movedLines: legacyMigration.movedLines,
      duplicateLinks: legacyMigration.duplicateLinks,
    },
    patched: false,
    structureRepaired: false,
  };

  // Apply structural scaffold and note-link injection in a single write.
  let working = journalMd;
  let mutated = false;

  if (opts.fix && shouldMigrateLegacy) {
    working = legacyMigration.content;
    result.legacyNotesCreated.migrated = true;
    mutated = true;
  }
  if (opts.fix && fs.existsSync(journalPath) && structure.missing.length > 0) {
    working = scaffoldMissingSections(working, structure.missing);
    result.structureRepaired = true;
    mutated = true;
  }
  if (opts.fix && missingLinks.length > 0) {
    working = injectNoteLinks(working, missingLinks);
    result.patched = true;
    mutated = true;
  }
  if (mutated) {
    fs.writeFileSync(journalPath, working, 'utf8');
  }

  // Re-evaluate structure post-repair so the exit code reflects the final file.
  const structureAfter = result.structureRepaired ? checkJournalStructure(working) : structure;
  result.structure.healthy = structureAfter.healthy;
  result.structure.isStub = structureAfter.isStub;
  result.structure.missingSections = structureAfter.missing;

  if (!opts.json) {
    // Structural health first — a stub/missing-section journal is the more
    // serious problem and would otherwise be masked by "no notes today".
    if (result.structureRepaired) {
      console.log(`[journal-note-audit] SCAFFOLDED missing required section(s) in ${journalPath}: ${structure.missing.join(', ')}`);
      console.log('[journal-note-audit] NOTE: run journal-maintenance.js to repopulate auto-fetch sections (calendar/reminders/paperclip).');
    } else if (!structureAfter.healthy) {
      const what = structureAfter.isStub ? 'is a stub (no sections)' : `is missing required section(s): ${structureAfter.missing.join(', ')}`;
      console.warn(`[journal-note-audit] STRUCTURE: journal for ${dateYmd} ${what}.`);
      if (opts.dryRun) console.warn('[journal-note-audit] Run with --fix to scaffold the missing required sections.');
    }

    if (result.legacyNotesCreated.migrated) {
      console.log(`[journal-note-audit] MIGRATED legacy Notes Created section into ${NOTES_HEADING} (${result.legacyNotesCreated.movedLines} line(s), ${result.legacyNotesCreated.duplicateLinks} duplicate link(s) skipped).`);
    } else if (result.legacyNotesCreated.present && opts.dryRun) {
      console.warn(`[journal-note-audit] LEGACY: journal for ${dateYmd} still has ${NOTES_CREATED_HEADING}; run with --fix to migrate it into ${NOTES_HEADING}.`);
    }

    // Note-link status.
    if (result.patched) {
      console.log(`[journal-note-audit] PATCHED ${journalPath}`);
      for (const n of missingLinks) console.log(`  + [[${n.title}]]`);
    } else if (notesToday.length === 0) {
      console.log(`[journal-note-audit] No notes found for ${dateYmd}.`);
    } else if (missingLinks.length === 0) {
      console.log(`[journal-note-audit] All ${notesToday.length} note(s) already linked. OK.`);
    } else {
      console.log(`[journal-note-audit] ${missingLinks.length} note(s) NOT linked in journal for ${dateYmd}:`);
      for (const n of missingLinks) console.log(`  MISSING: [[${n.title}]]`);
      if (opts.dryRun) console.log('[journal-note-audit] Run with --fix to patch.');
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  const hasGaps = missingLinks.length > 0 && !result.patched;
  const structurallyUnhealthy = !structureAfter.healthy;
  const legacyUnmigrated = result.legacyNotesCreated.present && !result.legacyNotesCreated.migrated;
  process.exit((hasGaps || structurallyUnhealthy || legacyUnmigrated) ? 1 : 0);
}

module.exports = {
  main,
  NOTES_CREATED_HEADING,
  NOTES_HEADING,
  LEGACY_NOTES_CREATED_CUTOFF,
  TRACKED_SECTION_HEADINGS,
  extractWikiLinks,
  extractTrackedSection,
  findAllNotes,
  findNotesForDate,
  noteMatchesDate,
  findMissingLinks,
  formatNoteLinks,
  injectNoteLinks,
  noteLinkTargetFromPath,
  normalizeWikiTarget,
  migrateLegacyNotesCreatedSection,
  getRequiredHeadings,
  stripFrontmatter,
  checkJournalStructure,
  scaffoldMissingSections,
};

if (require.main === module) {
  main();
}
