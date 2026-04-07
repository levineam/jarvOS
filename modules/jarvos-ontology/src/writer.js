/**
 * writer.js — Append to and update ontology sections safely.
 *
 * All mutations are file-level: read markdown, modify, write back.
 * No database. Human-readable diffs in git.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Section file mapping ──────────────────────────────────────────────────

const SECTION_FILES = {
  'higher-order': '1-higher-order.md',
  'beliefs': '2-beliefs.md',
  'predictions': '3-predictions.md',
  'core-self': '4-core-self.md',
  'goals': '5-goals.md',
  'projects': '6-projects.md',
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Append a dated entry to a section file.
 *
 * Inserts before the "— Written/Edited by" line if present,
 * otherwise appends before the last heading or at end.
 *
 * @param {string} dir - Path to ontology/ directory
 * @param {string} section - Section type: 'beliefs', 'goals', etc.
 * @param {string} content - Content to append (will be prefixed with date if not already)
 * @param {object} [options]
 * @param {string} [options.date] - Date string (YYYY-MM-DD). Defaults to today.
 * @param {boolean} [options.dryRun] - If true, returns new content without writing.
 * @returns {{ written: boolean, filePath: string, entry: string, newContent: string }}
 */
export function appendToSection(dir, section, content, options = {}) {
  const fileName = SECTION_FILES[section];
  if (!fileName) {
    throw new Error(`Unknown section: ${section}. Valid: ${Object.keys(SECTION_FILES).join(', ')}`);
  }

  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`Ontology file not found: ${filePath}`);
  }

  const date = options.date || new Date().toISOString().slice(0, 10);

  // Format entry
  const entry = content.startsWith('- [')
    ? content
    : `- [${date}] ${content}`;

  let fileContent = readFileSync(filePath, 'utf8');

  // Find insertion point: before "— Written/Edited by" attribution line
  const writerMatch = fileContent.match(/\n— (?:Written|Edited) by \w+/);
  let insertIdx;

  if (writerMatch) {
    insertIdx = writerMatch.index;
  } else {
    // Insert before trailing whitespace at end
    insertIdx = fileContent.trimEnd().length;
  }

  const newContent =
    fileContent.slice(0, insertIdx) +
    '\n' + entry + '\n' +
    fileContent.slice(insertIdx);

  if (!options.dryRun) {
    writeFileSync(filePath, newContent, 'utf8');
  }

  return {
    written: !options.dryRun,
    filePath,
    entry,
    newContent,
  };
}

/**
 * Update an existing object's metadata in its section file.
 *
 * Finds the object by ID pattern (e.g., "## B1 —") and replaces
 * specific metadata fields.
 *
 * @param {string} dir - Path to ontology/ directory
 * @param {string} objectId - Object ID (B1, G2, PJ3, etc.)
 * @param {object} updates - Fields to update: { status, confidence, ... }
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - If true, returns new content without writing.
 * @returns {{ written: boolean, filePath: string, updatedFields: string[] }}
 */
export function updateObject(dir, objectId, updates, options = {}) {
  // Determine which file this object lives in
  const prefix = objectId.replace(/\d+$/, '');
  const typeMap = { B: 'beliefs', G: 'goals', PJ: 'projects', HO: 'higher-order', CORE: 'core-self' };
  const section = typeMap[prefix];
  if (!section) {
    throw new Error(`Cannot determine section for object ID: ${objectId}`);
  }

  const fileName = SECTION_FILES[section];
  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`Ontology file not found: ${filePath}`);
  }

  let content = readFileSync(filePath, 'utf8');
  const updatedFields = [];

  // Find the object's section
  const objPattern = new RegExp(`^## ${objectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} —`, 'm');
  const objMatch = content.match(objPattern);
  if (!objMatch) {
    throw new Error(`Object ${objectId} not found in ${filePath}`);
  }

  const objStart = objMatch.index;
  // Find next object heading or end of file
  const nextObj = content.slice(objStart + objMatch[0].length).match(/\n## [A-Z]+\d* —/);
  const objEnd = nextObj
    ? objStart + objMatch[0].length + nextObj.index
    : content.length;

  let objContent = content.slice(objStart, objEnd);

  // Update metadata fields
  const fieldPatterns = {
    status: /(\*\*Status:\*\*\s*).+/i,
    confidence: /(\*\*Confidence:\*\*\s*).+/i,
    timeframe: /(\*\*Timeframe:\*\*\s*).+/i,
  };

  for (const [field, value] of Object.entries(updates)) {
    const pattern = fieldPatterns[field];
    if (pattern && pattern.test(objContent)) {
      objContent = objContent.replace(pattern, `$1${value}`);
      updatedFields.push(field);
    }
  }

  const newContent = content.slice(0, objStart) + objContent + content.slice(objEnd);

  if (!options.dryRun) {
    writeFileSync(filePath, newContent, 'utf8');
  }

  return {
    written: !options.dryRun,
    filePath,
    updatedFields,
    newContent,
  };
}

/**
 * Add a new complete object to a section file.
 *
 * @param {string} dir - Path to ontology/ directory
 * @param {string} section - Section type
 * @param {object} obj - Object to add: { id, name, status, confidence, source, quote, links }
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @returns {{ written: boolean, filePath: string, entry: string }}
 */
export function addObject(dir, section, obj, options = {}) {
  const fileName = SECTION_FILES[section];
  if (!fileName) {
    throw new Error(`Unknown section: ${section}`);
  }

  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`Ontology file not found: ${filePath}`);
  }

  const date = new Date().toISOString().slice(0, 10);

  // Build the object markdown
  const parts = [`\n## ${obj.id} — ${obj.name}`];
  if (obj.description) parts.push(`*${obj.description}*`);
  if (obj.status) parts.push(`- **Status:** ${obj.status}`);
  if (obj.confidence) parts.push(`- **Confidence:** ${obj.confidence}`);
  if (obj.source) parts.push(`- **Source:** ${obj.source}`);
  if (obj.timeframe) parts.push(`- **Timeframe:** ${obj.timeframe}`);
  if (obj.quote) parts.push(`- **Quote:** "${obj.quote}"`);

  if (obj.links && obj.links.length > 0) {
    parts.push('\n### Links');
    for (const link of obj.links) {
      parts.push(`- \`${link.type}\` → ${link.target}`);
    }
  }

  parts.push(`\n### History`);
  parts.push(`- ${date}: Created`);

  const entry = parts.join('\n');

  let content = readFileSync(filePath, 'utf8');

  // Insert before attribution line or at end
  const writerMatch = content.match(/\n— (?:Written|Edited) by \w+/);
  const insertIdx = writerMatch ? writerMatch.index : content.trimEnd().length;

  const newContent = content.slice(0, insertIdx) + '\n' + entry + '\n' + content.slice(insertIdx);

  if (!options.dryRun) {
    writeFileSync(filePath, newContent, 'utf8');
  }

  return {
    written: !options.dryRun,
    filePath,
    entry,
  };
}
