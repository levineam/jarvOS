'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_FRONTMATTER = ['status', 'type', 'project', 'created', 'updated', 'author'];
const DEFAULT_NOTES_SECTION = '📝 Notes';
const DEPRECATED_SECTIONS = ['🗂️ Notes Created', 'Notes Created'];

function sanitizeTitle(title) {
  return String(title || '').trim().replace(/[/\\:*?"<>|]/g, '-');
}

function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(String(content || ''));
  if (!match) return null;

  const fields = {};
  for (const line of match[1].split('\n')) {
    const item = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (item) fields[item[1]] = item[2].trim();
  }
  return fields;
}

function sectionBody(content, heading) {
  const lines = String(content || '').split('\n');
  const target = `## ${heading}`.trim();
  const start = lines.findIndex((line) => line.trim() === target);
  if (start === -1) return null;

  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body.join('\n');
}

function isSameOrChild(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

function verifyNoteCaptureContract({
  notePath,
  noteTitle,
  notesDir,
  journalPath,
  section = DEFAULT_NOTES_SECTION,
  requireJournalLink = true,
} = {}) {
  if (!notePath) throw new Error('notePath is required');
  if (!notesDir) throw new Error('notesDir is required');
  if (!fs.existsSync(notePath)) throw new Error(`note not found: ${notePath}`);
  if (!isSameOrChild(notesDir, notePath)) {
    throw new Error(`note is outside Notes directory: ${notePath}`);
  }

  const noteContent = fs.readFileSync(notePath, 'utf8');
  const frontmatter = parseFrontmatter(noteContent);
  if (!frontmatter) throw new Error(`note missing YAML frontmatter: ${notePath}`);

  const missingFrontmatter = REQUIRED_FRONTMATTER.filter((field) => !(field in frontmatter));
  if (missingFrontmatter.length > 0) {
    throw new Error(`note missing required frontmatter fields: ${missingFrontmatter.join(', ')}`);
  }

  const safeTitle = sanitizeTitle(noteTitle || path.basename(notePath, '.md'));
  const link = `[[${safeTitle}]]`;

  if (requireJournalLink) {
    if (!journalPath) throw new Error('journalPath is required when requireJournalLink is true');
    if (!fs.existsSync(journalPath)) throw new Error(`journal not found: ${journalPath}`);

    const journal = fs.readFileSync(journalPath, 'utf8');
    const notesBody = sectionBody(journal, section);
    if (notesBody === null) throw new Error(`journal section not found: ${section}`);
    if (!notesBody.includes(link)) {
      throw new Error(`note link missing from journal ${section} section: ${link}`);
    }

    const deprecatedHits = DEPRECATED_SECTIONS.filter((deprecated) => {
      const body = sectionBody(journal, deprecated);
      return body && body.includes(link);
    });
    if (deprecatedHits.length > 0) {
      throw new Error(`note link found under deprecated journal section: ${deprecatedHits.join(', ')}`);
    }
  }

  return {
    ok: true,
    notePath,
    journalPath: journalPath || null,
    section,
    link,
    frontmatter,
  };
}

module.exports = {
  DEFAULT_NOTES_SECTION,
  DEPRECATED_SECTIONS,
  REQUIRED_FRONTMATTER,
  parseFrontmatter,
  sanitizeTitle,
  sectionBody,
  verifyNoteCaptureContract,
};
