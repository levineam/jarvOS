#!/usr/bin/env node
/**
 * Bridge-owned notes section normalizer for SUP-1139.
 *
 * Processes flexible human-authored content under `## 📝 Notes`, creates
 * canonical notes when needed, and rewrites the section to stable wikilinks
 * without data loss.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { writeNoteFile, noteFilePath } = require('../../../packages/jarvos-secondbrain-notes/src/write-to-vault.js');
const { getVaultJournalDir } = require('./lib/provenance-config');

const NOTES_HEADING = '## 📝 Notes';
const LEGACY_NOTES_CREATED_HEADING = '## 🗂️ Notes Created';
const EMPTY_PLACEHOLDER_RE = /^-\s*(?:No notes(?: today| yet)?|Notes will appear here)?\s*$/i;
const ITALIC_PLACEHOLDER_RE = /^\*(?:Links to (?:any )?notes created (?:during|today|on)[\s\S]*|No notes (?:today|yet|created)[\s\S]*|Notes will appear here[\s\S]*)\*$/i;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

function inferTitleFromText(text) {
  const firstLine = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  return firstLine.replace(/[.!?。]+$/g, '').slice(0, 80).trim() || null;
}

function findSection(lines, heading) {
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === heading) {
      start = i;
      continue;
    }
    if (start !== -1 && i > start && /^##\s/.test(trimmed)) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function findNotesSection(lines) {
  return findSection(lines, NOTES_HEADING);
}

function stripBulletPrefix(line) {
  return String(line || '').replace(/^\s*[-*+]\s+/, '').trim();
}

function extractWikiTargets(text) {
  const targets = [];
  const seen = new Set();
  let match;
  while ((match = WIKILINK_RE.exec(String(text || ''))) !== null) {
    const target = String(match[1] || '').trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

function textWithoutWikilinks(text) {
  return String(text || '').replace(WIKILINK_RE, ' ').replace(/\s+/g, ' ').trim();
}

function parseNoteEntries(sectionLines) {
  const entries = [];

  for (const rawLine of sectionLines) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    if (!trimmed || trimmed === '-' || EMPTY_PLACEHOLDER_RE.test(trimmed)) continue;

    const bulletText = stripBulletPrefix(line);
    const targets = extractWikiTargets(bulletText);

    if (targets.length > 0) {
      const context = textWithoutWikilinks(bulletText);
      const explicitBullet = /^\s*[-*+]\s+/.test(line);
      for (const target of targets) {
        entries.push({
          sourceLine: line,
          title: target,
          content: context || target,
          kind: explicitBullet ? 'link-bullet' : 'inline-link',
        });
      }
      continue;
    }

    entries.push({
      sourceLine: line,
      title: inferTitleFromText(bulletText),
      content: bulletText,
      kind: 'raw-text',
    });
  }

  return entries.filter((entry) => entry.title && entry.content);
}

function buildCanonicalSection(entries) {
  if (!entries.length) return ['-'];

  const seen = new Set();
  const lines = [];
  for (const entry of entries) {
    const link = `- [[${entry.title}]]`;
    if (seen.has(link)) continue;
    seen.add(link);
    lines.push(link);
  }

  return lines.length ? lines : ['-'];
}

function isPlaceholderLine(line) {
  const trimmed = String(line || '').trim();
  return !trimmed || trimmed === '-' || EMPTY_PLACEHOLDER_RE.test(trimmed) || ITALIC_PLACEHOLDER_RE.test(trimmed);
}

function canonicalLinkTarget(line) {
  const text = stripBulletPrefix(line);
  const match = text.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
  return match ? String(match[1] || '').trim() : null;
}

function mergeNotesSectionLines(existingLines, incomingLines) {
  const usefulExisting = existingLines.filter((line) => !isPlaceholderLine(line));
  const usefulIncoming = incomingLines.filter((line) => !isPlaceholderLine(line));
  const result = [];
  const linkTargets = new Set();
  let duplicateLinks = 0;

  for (const line of [...usefulExisting, ...usefulIncoming]) {
    const target = canonicalLinkTarget(line);
    if (target) {
      if (linkTargets.has(target)) {
        duplicateLinks += 1;
        continue;
      }
      linkTargets.add(target);
    }
    result.push(line);
  }

  return {
    lines: result.length ? result : ['-'],
    duplicateLinks,
    movedLines: usefulIncoming.length,
  };
}

function migrateLegacyNotesCreatedSection(journalContent) {
  const original = String(journalContent || '');
  const lines = original.split(/\r?\n/);
  const legacy = findSection(lines, LEGACY_NOTES_CREATED_HEADING);

  if (legacy.start === -1) {
    return {
      content: original,
      migrated: false,
      movedLines: 0,
      duplicateLinks: 0,
    };
  }

  const legacyLines = lines.slice(legacy.start + 1, legacy.end);
  const withoutLegacy = [
    ...lines.slice(0, legacy.start),
    ...lines.slice(legacy.end),
  ];
  const canonical = findNotesSection(withoutLegacy);

  let nextLines;
  let merged;

  if (canonical.start === -1) {
    merged = mergeNotesSectionLines([], legacyLines);
    nextLines = [
      ...lines.slice(0, legacy.start),
      NOTES_HEADING,
      ...merged.lines,
      ...lines.slice(legacy.end),
    ];
  } else {
    const existingLines = withoutLegacy.slice(canonical.start + 1, canonical.end);
    merged = mergeNotesSectionLines(existingLines, legacyLines);
    nextLines = [
      ...withoutLegacy.slice(0, canonical.start + 1),
      ...merged.lines,
      ...withoutLegacy.slice(canonical.end),
    ];
  }

  return {
    content: nextLines.join('\n'),
    migrated: true,
    movedLines: merged.movedLines,
    duplicateLinks: merged.duplicateLinks,
  };
}

function defaultNoteExists(title) {
  return fs.existsSync(noteFilePath(title));
}

function normalizeJournalNotes({
  journalContent,
  date,
  writeNote = writeNoteFile,
  noteExists = defaultNoteExists,
  dryRun = false,
}) {
  const legacyMigration = migrateLegacyNotesCreatedSection(journalContent);
  const lines = legacyMigration.content.split(/\r?\n/);
  const { start, end } = findNotesSection(lines);
  if (start === -1) {
    return { normalizedContent: legacyMigration.content, changes: [] };
  }

  const sectionLines = lines.slice(start + 1, end);
  const entries = parseNoteEntries(sectionLines);
  const changes = legacyMigration.migrated ? [{
    type: 'legacy-notes-created-migrated',
    movedLines: legacyMigration.movedLines,
    duplicateLinks: legacyMigration.duplicateLinks,
  }] : [];

  for (const entry of entries) {
    if (noteExists(entry.title)) {
      continue;
    }

    if (dryRun) {
      changes.push({
        type: 'note-created',
        title: entry.title,
        path: path.join('would-create', `${entry.title.replace(/[/\\:*?"<>|]/g, '-')}.md`),
      });
      continue;
    }

    const result = writeNote({
      title: entry.title,
      content: entry.content,
      frontmatter: {
        type: 'draft',
        source: 'notes-normalizer',
        created_from: date ? `journal/${date}` : 'journal',
      },
    });

    if (result.created) {
      changes.push({
        type: 'note-created',
        title: entry.title,
        path: result.path || noteFilePath(entry.title),
      });
    }
  }

  const canonicalLines = buildCanonicalSection(entries);
  const nextLines = [
    ...lines.slice(0, start + 1),
    ...canonicalLines,
    ...lines.slice(end),
  ];

  return {
    normalizedContent: nextLines.join('\n'),
    changes,
  };
}

function parseArgs(argv) {
  const options = {
    date: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--date=')) options.date = arg.split('=').slice(1).join('=');
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node jarvos-secondbrain/bridge/provenance/src/notes-section-normalizer.js [options]',
        '',
        'Options:',
        '  --date=YYYY-MM-DD   Journal date to normalize (default: today)',
        '  --dry-run           Report changes without writing notes or journal',
      ].join('\n'));
      process.exit(0);
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const journalPath = path.join(getVaultJournalDir(), `${options.date}.md`);
  if (!fs.existsSync(journalPath)) {
    console.error(JSON.stringify({ error: `Journal not found: ${journalPath}` }));
    process.exit(1);
  }

  const journalContent = fs.readFileSync(journalPath, 'utf8');
  const result = normalizeJournalNotes({
    journalContent,
    date: options.date,
    dryRun: options.dryRun,
  });

  if (!options.dryRun) {
    fs.writeFileSync(journalPath, result.normalizedContent, 'utf8');
  }

  console.log(JSON.stringify({
    journalPath,
    dryRun: options.dryRun,
    changes: result.changes,
  }, null, 2));
}

module.exports = {
  NOTES_HEADING,
  LEGACY_NOTES_CREATED_HEADING,
  defaultNoteExists,
  extractWikiTargets,
  inferTitleFromText,
  migrateLegacyNotesCreatedSection,
  normalizeJournalNotes,
  parseNoteEntries,
  textWithoutWikilinks,
};

if (require.main === module) {
  main();
}
