#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getVaultSourceMaterialDir } = require('./lib/notes-config');

const DEFAULT_SOURCE_DIR = getVaultSourceMaterialDir();
const REQUIRED_FIELDS = ['authorship', 'source_type', 'authors', 'importer'];
const ORIGINAL_FIELDS = ['original_file', 'original_url'];
const ORIGINAL_ALIASES = ['source_file', 'source_path', 'source_url', 'url', 'canonical_url'];
const ALLOWED_AUTHORSHIP = new Set(['external', 'mixed', 'andrew', 'jarvis']);
const ALLOWED_SOURCE_TYPES = new Set([
  'article',
  'book',
  'dataset',
  'newsletter',
  'paper',
  'podcast',
  'reference',
  'transcript',
  'video',
  'web',
  'webpage',
  'x-post',
  'other',
]);
const PLACEHOLDERS = new Set([
  '',
  'n/a',
  'na',
  'none',
  'null',
  'tbd',
  'todo',
  'unknown',
  'unspecified',
]);
const INTERNAL_AUTHOR_VALUES = new Set(['andrew', 'andrew levine', 'jarvis', 'ai', 'assistant', 'codex', 'chatgpt']);

function parseArgs(argv) {
  const args = {
    json: false,
    sourceDir: DEFAULT_SOURCE_DIR,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') {
      args.json = true;
    } else if (token === '--source-dir') {
      const next = argv[i + 1];
      if (!next) throw new Error('--source-dir requires a value');
      args.sourceDir = next;
      i += 1;
    } else if (token === '-h' || token === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`lint-source-material.js

Usage:
  node scripts/lint-source-material.js [--json] [--source-dir <path>]

Options:
  --json          Output machine-readable JSON.
  --source-dir    Override Source Material path (default: ${DEFAULT_SOURCE_DIR}).
`);
}

function walkMarkdownFiles(rootDir) {
  const out = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(fullPath);
      }
    }
  }

  walk(rootDir);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;

  const lines = match[1].split(/\r?\n/);
  const fields = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rawValue = m[2] || '';
    if (rawValue.trim() !== '') {
      fields.set(key, rawValue);
      continue;
    }

    const listValues = [];
    let j = i + 1;
    while (j < lines.length) {
      const item = lines[j].match(/^\s*-\s+(.+)$/);
      if (!item) break;
      listValues.push(item[1]);
      j += 1;
    }
    fields.set(key, listValues.length ? listValues : rawValue);
  }

  return fields;
}

function stripQuotes(value) {
  const v = String(value ?? '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function scalar(frontmatter, key) {
  const value = frontmatter?.get(key);
  if (Array.isArray(value)) return value.map(stripQuotes).join(', ');
  return stripQuotes(value);
}

function parseListValue(value) {
  if (Array.isArray(value)) return value.map(stripQuotes).filter(Boolean);
  const raw = stripQuotes(value);
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(stripQuotes).filter(Boolean);
  }
  return raw.split(/[,;]\s*/).map(stripQuotes).filter(Boolean);
}

function canonical(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isPlaceholder(value) {
  return PLACEHOLDERS.has(canonical(stripQuotes(value)));
}

function hasUsefulValue(value) {
  if (Array.isArray(value)) return value.some((item) => hasUsefulValue(item));
  return !isPlaceholder(value);
}

function addViolation(violations, file, field, current, expected) {
  violations.push({
    file,
    field,
    current,
    expected,
  });
}

function validateSourceMaterialFile(filePath, content) {
  const violations = [];
  const fm = parseFrontmatter(content);

  if (!fm) {
    addViolation(
      violations,
      filePath,
      'frontmatter',
      '(missing)',
      'YAML frontmatter with source-material provenance fields',
    );
    return violations;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fm.has(field) || !hasUsefulValue(fm.get(field))) {
      addViolation(violations, filePath, field, '(missing)', 'required source-material provenance field');
    }
  }

  const authorship = canonical(scalar(fm, 'authorship'));
  if (fm.has('authorship') && hasUsefulValue(fm.get('authorship')) && !ALLOWED_AUTHORSHIP.has(authorship)) {
    addViolation(violations, filePath, 'authorship', scalar(fm, 'authorship'), 'external | mixed | andrew | jarvis');
  }

  const sourceType = canonical(scalar(fm, 'source_type')).replace(/\s+/g, '-');
  if (fm.has('source_type') && hasUsefulValue(fm.get('source_type')) && !ALLOWED_SOURCE_TYPES.has(sourceType)) {
    addViolation(violations, filePath, 'source_type', scalar(fm, 'source_type'), [...ALLOWED_SOURCE_TYPES].join(' | '));
  }

  const authors = parseListValue(fm.get('authors'));
  const usefulAuthors = authors.filter((author) => !isPlaceholder(author));
  if (fm.has('authors') && hasUsefulValue(fm.get('authors')) && authors.length > 0 && usefulAuthors.length === 0) {
    addViolation(violations, filePath, 'authors', authors.join(', '), 'one or more named source author(s)');
  }
  if ((authorship === 'external' || authorship === 'mixed') && usefulAuthors.length > 0) {
    const hasOnlyInternalAuthors = usefulAuthors.every((author) => INTERNAL_AUTHOR_VALUES.has(canonical(author)));
    if (hasOnlyInternalAuthors) {
      addViolation(
        violations,
        filePath,
        'authors',
        usefulAuthors.join(', '),
        'external or mixed source material must name the original source author(s), not only Andrew/Jarvis',
      );
    }
  }
  if (!fm.has('authors') && fm.has('author')) {
    addViolation(
      violations,
      filePath,
      'authors',
      `author: ${scalar(fm, 'author')}`,
      'canonical Source Material uses authors; Notes author is not source provenance',
    );
  }

  const hasOriginal = ORIGINAL_FIELDS.some((field) => fm.has(field) && hasUsefulValue(fm.get(field)));
  if (!hasOriginal) {
    const aliases = ORIGINAL_ALIASES.filter((field) => fm.has(field) && hasUsefulValue(fm.get(field)));
    addViolation(
      violations,
      filePath,
      'original_file|original_url',
      aliases.length ? `(canonical field missing; saw ${aliases.join(', ')})` : '(missing)',
      'at least one canonical original_file or original_url value',
    );
  }

  return violations;
}

function collectViolations(files) {
  const violations = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    violations.push(...validateSourceMaterialFile(file, content));
  }
  return violations;
}

function buildSummary(files, violations) {
  const filesWithViolations = new Set(violations.map((v) => v.file));
  const missingOriginal = violations.filter((v) => v.field === 'original_file|original_url').length;
  const ambiguousAuthors = violations.filter((v) => v.field === 'authors').length;
  return {
    sourceMaterialsChecked: files.length,
    compliant: files.length - filesWithViolations.size,
    violations: violations.length,
    filesWithViolations: filesWithViolations.size,
    missingOriginal,
    ambiguousAuthors,
  };
}

function runLint({ sourceDir = DEFAULT_SOURCE_DIR } = {}) {
  if (!fs.existsSync(sourceDir)) {
    return {
      sourceDir,
      missingSourceDir: true,
      files: [],
      violations: [],
      summary: buildSummary([], []),
    };
  }
  if (!fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Source Material path is not a directory: ${sourceDir}`);
  }
  const files = walkMarkdownFiles(sourceDir);
  const violations = collectViolations(files);
  return {
    sourceDir,
    missingSourceDir: false,
    files,
    violations,
    summary: buildSummary(files, violations),
  };
}

function printHuman(result) {
  if (result.missingSourceDir) {
    console.log(`Summary: Source Material directory missing, 0 files checked, 0 violations (${result.sourceDir})`);
    return;
  }
  console.log(`Summary: ${result.summary.sourceMaterialsChecked} Source Material files checked, ${result.summary.compliant} compliant, ${result.summary.violations} violations`);
  if (result.summary.violations === 0) return;
  console.log('Violations:');
  for (const v of result.violations) {
    const rel = path.relative(result.sourceDir, v.file) || v.file;
    console.log(`- ${rel} | ${v.field} | current=${JSON.stringify(v.current)} | expected=${v.expected}`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
    const result = runLint({ sourceDir: args.sourceDir });
    if (args.json) {
      console.log(JSON.stringify({
        summary: result.summary,
        sourceDir: result.sourceDir,
        missingSourceDir: result.missingSourceDir,
        violations: result.violations.map((v) => ({
          file: v.file,
          field: v.field,
          current: v.current,
          expected: v.expected,
        })),
      }, null, 2));
    } else {
      printHuman(result);
    }
    process.exit(result.summary.violations === 0 ? 0 : 1);
  } catch (err) {
    if (args?.json) {
      console.log(JSON.stringify({ error: err.message || String(err) }, null, 2));
    } else {
      console.error(`Error: ${err.message || err}`);
    }
    process.exit(1);
  }
}

module.exports = {
  ALLOWED_AUTHORSHIP,
  ALLOWED_SOURCE_TYPES,
  ORIGINAL_FIELDS,
  REQUIRED_FIELDS,
  buildSummary,
  parseFrontmatter,
  runLint,
  validateSourceMaterialFile,
  main,
};

if (require.main === module) {
  main();
}
