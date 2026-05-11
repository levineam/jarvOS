#!/usr/bin/env node
// Bridge-owned canonical note→journal linker.
// Input (stdin): { "noteTitle": "...", "section": "📝 Notes" }
// Finds today's journal, adds [[noteTitle]] under the specified section if not present.
// Output: { "linked": true, "journalPath": "...", "alreadyPresent": false }

'use strict';

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { basename, dirname, join } = require('path');
const { getVaultJournalDir } = require('./lib/provenance-config');
const { getTimeZone } = require('../../config/jarvos-paths');

function todayPath() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: getTimeZone() });
  return join(getVaultJournalDir(), `${today}.md`);
}

function linkNoteToJournal({ noteTitle, section = '📝 Notes', journalPath = todayPath(), createIfMissing = false }) {
  if (!noteTitle) {
    throw new Error('noteTitle is required');
  }

  if (!existsSync(journalPath)) {
    if (!createIfMissing) throw new Error(`Journal not found: ${journalPath}`);
    mkdirSync(dirname(journalPath), { recursive: true });
    const date = basename(journalPath, '.md');
    writeFileSync(journalPath, `# ${date}\n\n## ${section}\n`, 'utf8');
  }

  let content = readFileSync(journalPath, 'utf8');
  const linkText = `- [[${noteTitle}]]`;

  if (content.includes(`[[${noteTitle}]]`)) {
    return { linked: true, journalPath, alreadyPresent: true };
  }

  const sectionRegex = new RegExp(`(## ${escapeRegex(section)}[^\n]*\n)`, 'm');
  const match = sectionRegex.exec(content);

  if (match) {
    const insertAt = match.index + match[0].length;
    content = content.slice(0, insertAt) + linkText + '\n' + content.slice(insertAt);
  } else {
    content = content.trimEnd() + `\n\n## ${section}\n${linkText}\n`;
  }

  writeFileSync(journalPath, content, 'utf8');
  return { linked: true, journalPath, alreadyPresent: false };
}

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(input.trim());
    } catch (e) {
      console.error(JSON.stringify({ error: 'Invalid JSON input', detail: e.message }));
      process.exit(1);
    }

    try {
      console.log(JSON.stringify(linkNoteToJournal(parsed)));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { main, todayPath, escapeRegex, linkNoteToJournal };

if (require.main === module) {
  main();
}
