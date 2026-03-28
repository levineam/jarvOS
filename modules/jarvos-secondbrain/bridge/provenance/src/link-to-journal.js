#!/usr/bin/env node
// Bridge-owned canonical note→journal linker.
// Input (stdin): { "noteTitle": "...", "section": "📝 Notes" }
// Finds today's journal, adds [[noteTitle]] under the specified section if not present.
// Output: { "linked": true, "journalPath": "...", "alreadyPresent": false }

'use strict';

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const { getVaultJournalDir } = require('./lib/provenance-config');

const JOURNAL_DIR = getVaultJournalDir();

function todayPath() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return join(JOURNAL_DIR, `${today}.md`);
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

    const { noteTitle, section = '📝 Notes' } = parsed;
    if (!noteTitle) {
      console.error(JSON.stringify({ error: 'noteTitle is required' }));
      process.exit(1);
    }

    const journalPath = todayPath();
    if (!existsSync(journalPath)) {
      console.error(JSON.stringify({ error: `Journal not found: ${journalPath}` }));
      process.exit(1);
    }

    let content = readFileSync(journalPath, 'utf8');
    const linkText = `- [[${noteTitle}]]`;

    if (content.includes(`[[${noteTitle}]]`)) {
      console.log(JSON.stringify({ linked: true, journalPath, alreadyPresent: true }));
      return;
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
    console.log(JSON.stringify({ linked: true, journalPath, alreadyPresent: false }));
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { main, todayPath, escapeRegex };

if (require.main === module) {
  main();
}
