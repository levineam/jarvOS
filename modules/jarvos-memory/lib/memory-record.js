'use strict';

const fs = require('fs');
const path = require('path');
const { CORE_MEMORY_CLASSES, SCHEMA_VERSION } = require('./memory-schema');
const { getClawdRoot: getWorkspaceRoot } = require('./memory-config');

/**
 * Create a compact memory record from a capture event.
 *
 * @param {object} params
 * @param {string} params.class - Memory class: fact, preference, decision, lesson, project-state
 * @param {string} params.content - Compact human-readable statement
 * @param {string} [params.rationale] - Why this matters
 * @param {string} [params.source] - Source reference (journal date, note path, session)
 * @param {string} [params.noteRef] - Link to full note if one was created
 * @param {number} [params.confidence] - 0.0-1.0
 * @param {string} [params.supersedes] - ID of prior memory this replaces
 * @returns {{ record: object, written: boolean, path: string|null, error: string|null }}
 */
function createMemoryRecord(params = {}) {
  const memoryClass = params.class;
  const classDef = CORE_MEMORY_CLASSES[memoryClass];

  if (!classDef) {
    return {
      record: null,
      written: false,
      path: null,
      error: `Unknown memory class: ${memoryClass}`,
    };
  }

  const content = String(params.content || '').trim();
  if (!content) {
    return {
      record: null,
      written: false,
      path: null,
      error: 'Memory record content is required',
    };
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  const record = {
    schema: SCHEMA_VERSION,
    class: memoryClass,
    content,
    rationale: params.rationale || undefined,
    source: params.source || undefined,
    noteRef: params.noteRef || undefined,
    created: now.toISOString(),
    confidence: typeof params.confidence === 'number' ? params.confidence : undefined,
    supersedes: params.supersedes || undefined,
    status: 'active',
  };

  // Clean undefined fields
  Object.keys(record).forEach((key) => {
    if (record[key] === undefined) delete record[key];
  });

  const workspace = getWorkspaceRoot();

  // Route to correct storage based on class definition
  if (classDef.storageMode === 'record-file') {
    // decision, lesson → write as markdown file
    const slug = slugify(content.slice(0, 60));
    const filename = `${dateStr}-${slug}.md`;
    const dir = memoryClass === 'decision'
      ? path.join(workspace, 'memory', 'decisions')
      : path.join(workspace, 'memory', 'lessons');

    const filePath = path.join(dir, filename);

    // Don't overwrite existing files
    if (fs.existsSync(filePath)) {
      return {
        record,
        written: false,
        path: filePath,
        error: `File already exists: ${filename}`,
      };
    }

    const frontmatter = [
      '---',
      `class: ${memoryClass}`,
      `created: ${dateStr}`,
      'status: active',
      record.source ? `source: ${record.source}` : null,
      record.noteRef ? `note_ref: "${record.noteRef}"` : null,
      record.supersedes ? `supersedes: "${record.supersedes}"` : null,
      record.confidence != null ? `confidence: ${record.confidence}` : null,
      '---',
    ].filter(Boolean).join('\n');

    const body = [
      `# ${content}`,
      '',
      record.rationale ? `## Rationale\n\n${record.rationale}` : null,
      record.source ? `\n## Source\n\n${record.source}` : null,
    ].filter(Boolean).join('\n');

    const fileContent = `${frontmatter}\n\n${body}\n`;

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, fileContent, 'utf8');
      return { record, written: true, path: filePath, error: null };
    } catch (err) {
      return { record, written: false, path: filePath, error: err.message };
    }
  }

  if (classDef.storageMode === 'registry-section') {
    // fact, preference → append to MEMORY.md
    const memoryPath = path.join(workspace, 'MEMORY.md');
    const entry = formatRegistryEntry(record);

    try {
      if (!fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, `# MEMORY.md\n\n${entry}\n`, 'utf8');
      } else {
        const current = fs.readFileSync(memoryPath, 'utf8');
        // Check for duplicate content
        if (current.includes(content)) {
          return {
            record,
            written: false,
            path: memoryPath,
            error: 'Duplicate content already exists in MEMORY.md',
          };
        }
        fs.appendFileSync(memoryPath, `\n${entry}\n`, 'utf8');
      }
      return { record, written: true, path: memoryPath, error: null };
    } catch (err) {
      return { record, written: false, path: memoryPath, error: err.message };
    }
  }

  // project-state or unknown storage mode — return record without writing
  return { record, written: false, path: null, error: `Storage mode '${classDef.storageMode}' not handled by capture flow` };
}

/**
 * Check if a memory record would duplicate an existing one.
 *
 * @param {string} content - The content to check
 * @param {string} memoryClass - The memory class
 * @returns {{ isDuplicate: boolean, existingPath: string|null, action: 'skip'|'supersede'|'reinforce'|null }}
 */
function checkMemoryDedup(content, memoryClass) {
  const classDef = CORE_MEMORY_CLASSES[memoryClass];
  if (!classDef) return { isDuplicate: false, existingPath: null, action: null };

  const workspace = getWorkspaceRoot();
  const normalizedContent = content.toLowerCase().trim();

  if (classDef.storageMode === 'registry-section') {
    const memoryPath = path.join(workspace, 'MEMORY.md');
    if (!fs.existsSync(memoryPath)) return { isDuplicate: false, existingPath: null, action: null };

    const current = fs.readFileSync(memoryPath, 'utf8');
    if (current.toLowerCase().includes(normalizedContent)) {
      return { isDuplicate: true, existingPath: memoryPath, action: 'skip' };
    }
  }

  if (classDef.storageMode === 'record-file') {
    const dir = memoryClass === 'decision'
      ? path.join(workspace, 'memory', 'decisions')
      : path.join(workspace, 'memory', 'lessons');

    if (!fs.existsSync(dir)) return { isDuplicate: false, existingPath: null, action: null };

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const fileContent = fs.readFileSync(filePath, 'utf8').toLowerCase();
      if (fileContent.includes(normalizedContent)) {
        return { isDuplicate: true, existingPath: filePath, action: 'reinforce' };
      }
    }
  }

  return { isDuplicate: false, existingPath: null, action: null };
}

function formatRegistryEntry(record) {
  const parts = [`- **[${record.created.slice(0, 10)}]**`];
  parts.push(`*(${record.class})*`);
  parts.push(record.content);
  if (record.source) parts.push(`— source: ${record.source}`);
  return parts.join(' ');
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'untitled';
}

module.exports = {
  createMemoryRecord,
  checkMemoryDedup,
  formatRegistryEntry,
  slugify,
};
