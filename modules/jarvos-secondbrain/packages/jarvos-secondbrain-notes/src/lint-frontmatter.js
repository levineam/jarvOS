#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getVaultNotesDir } = require('./lib/notes-config');

const DEFAULT_NOTES_DIR = getVaultNotesDir();
const REQUIRED_FIELDS = ['status', 'type', 'project', 'created', 'updated', 'author'];

const ALLOWED_STATUS = new Set(['active', 'draft', 'archived', 'abandoned']);
const ALLOWED_TYPE = new Set(['project-note', 'draft', 'research', 'decision', 'reference', 'article', 'chapter']);
const ALLOWED_AUTHOR = new Set(['jarvis', 'andrew', 'both']);

// Mapping tables from normalization pass + common drift variants.
const STATUS_MAP = {
  draft: 'draft',
  Draft: 'draft',
  pending: 'draft',
  planning: 'draft',
  planned: 'draft',
  paused: 'draft',
  someday: 'draft',
  active: 'active',
  current: 'active',
  inprogress: 'active',
  'in-progress': 'active',
  published: 'active',
  shipped: 'active',
  archived: 'archived',
  archive: 'archived',
  superseded: 'archived',
  completed: 'archived',
  abandoned: 'abandoned',
  canceled: 'abandoned',
  cancelled: 'abandoned',
};

const TYPE_MAP = {
  'project note': 'project-note',
  projectnote: 'project-note',
  'project management': 'project-note',
  'product planning': 'project-note',
  'execution plan': 'project-note',
  'event planning': 'project-note',
  'website strategy': 'project-note',
  chapter: 'chapter',
  Chapter: 'chapter',
  'decision document': 'decision',
  'research project': 'research',
  'feasibility study': 'research',
  'technical evaluation': 'research',
  strategy: 'research',
  persona: 'research',
  checklist: 'reference',
  template: 'reference',
  Template: 'reference',
  implementation: 'reference',
  'technical setup': 'reference',
  security: 'reference',
  'customer deployment': 'reference',
  'strategy document': 'reference',
};

const AUTHOR_MAP = {
  jarvis: 'jarvis',
  andrew: 'andrew',
  both: 'both',
  assistant: 'jarvis',
  chatgpt: 'jarvis',
  codex: 'jarvis',
  ai: 'jarvis',
  'andrew levine': 'andrew',
  coauthored: 'both',
  'co-authored': 'both',
  collaborative: 'both',
};

function parseArgs(argv) {
  const args = {
    fix: false,
    json: false,
    notesDir: DEFAULT_NOTES_DIR,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--fix') {
      args.fix = true;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--notes-dir') {
      const next = argv[i + 1];
      if (!next) throw new Error('--notes-dir requires a value');
      args.notesDir = next;
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
  console.log(`lint-frontmatter.js\n\nUsage:\n  node scripts/lint-frontmatter.js [--fix] [--json] [--notes-dir <path>]\n\nOptions:\n  --fix         Auto-correct obvious violations using normalization mappings\n  --json        Output machine-readable JSON\n  --notes-dir   Override Notes path (default: ${DEFAULT_NOTES_DIR})`);
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

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function parseFrontmatter(text) {
  const match = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return null;

  const eol = match[1] || '\n';
  const raw = match[2] || '';
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const keyIndex = new Map();
  const keyValueRaw = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (!keyIndex.has(key)) keyIndex.set(key, i);
    keyValueRaw.set(key, m[2] || '');
  }

  return {
    eol,
    lines,
    keyIndex,
    keyValueRaw,
    remainder: text.slice(match[0].length),
    hadPostFenceNewline: match[3] !== '',
  };
}

function stringifyFrontmatter(parsed, updatedLines) {
  const eol = parsed.eol || '\n';
  const body = updatedLines.join(eol);
  const afterFence = parsed.hadPostFenceNewline ? eol : '';
  return `---${eol}${body}${eol}---${afterFence}${parsed.remainder}`;
}

function stripQuotes(value) {
  const v = String(value ?? '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function normalizeKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\- ]/g, '');
}

function isValidDateYYYYMMDD(value) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() + 1 === month && dt.getUTCDate() === day;
}

function toLocalDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeDate(value) {
  const raw = stripQuotes(value);
  if (!raw) return null;
  if (isValidDateYYYYMMDD(raw)) return raw;

  let m = raw.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
  if (m) {
    const candidate = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    if (isValidDateYYYYMMDD(candidate)) return candidate;
  }

  m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const candidate = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    if (isValidDateYYYYMMDD(candidate)) return candidate;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const candidate = `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
    if (isValidDateYYYYMMDD(candidate)) return candidate;
  }

  return null;
}

function formatFieldLine(key, value) {
  if (key === 'project') {
    return `project: ${JSON.stringify(String(value ?? ''))}`;
  }
  return `${key}: ${String(value ?? '').trim()}`;
}

function findProjectNames(files) {
  const names = new Set();
  const rx = /^(.*?)(?:\s+[—-]\s+|\s+-\s+|\s+—\s+)?Project Board$/i;
  for (const file of files) {
    const stem = path.basename(file, '.md');
    const m = stem.match(rx);
    if (m && m[1] && m[1].trim()) names.add(m[1].trim());
  }
  return [...names].sort((a, b) => (b.length - a.length) || a.localeCompare(b));
}

function inferAuthor(content) {
  const lc = content.toLowerCase();
  if (lc.includes('edited by jarvis')) return 'both';
  if (lc.includes('written by jarvis')) return 'jarvis';
  return 'andrew';
}

function inferStatus(filePath, content) {
  const stem = path.basename(filePath, '.md').toLowerCase();
  const lc = content.toLowerCase();
  const explicit = lc.match(/^status\s*:\s*(active|draft|archived|abandoned)\b/m);
  if (explicit) return explicit[1];

  if (/abandoned|cancelled|canceled/.test(stem)) return 'abandoned';
  if (/archived|archive|superseded/.test(stem)) return 'archived';
  if (/\b(draft|wip|todo|in progress|planned|planning|pending)\b/.test(`${stem}\n${lc}`) || lc.includes('- [ ]')) return 'draft';
  return 'active';
}

function inferType(filePath, content, status) {
  const stem = path.basename(filePath, '.md').toLowerCase();
  const lc = content.toLowerCase();
  const text = `${stem}\n${lc}`;

  if (stem.includes('project board') || stem.includes('project brief')) return 'project-note';
  if (stem.includes('chapter')) return 'chapter';
  if (/\b(research|analysis|lastxdays|literature review|market scan|feasibility|evaluation)\b/.test(text)) return 'research';
  if (text.includes('decision')) return 'decision';
  if (/\b(newsletter|x post|blog|article|essay)\b/.test(text)) return 'article';
  if (status === 'draft') return 'draft';
  return 'reference';
}

function inferProject(filePath, projectNames) {
  const stem = path.basename(filePath, '.md');
  const boardMatch = stem.match(/^(.*?)(?:\s+[—-]\s+|\s+-\s+|\s+—\s+)?Project (?:Board|Brief)$/i);
  if (boardMatch && boardMatch[1]) return boardMatch[1].trim();

  for (const name of projectNames) {
    if (stem === name || stem.startsWith(`${name} `) || stem.startsWith(`${name}-`) || stem.startsWith(`${name}—`)) {
      return name;
    }
  }
  return '';
}

function inferCreated(content, stats) {
  const m = content.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (m && isValidDateYYYYMMDD(m[1])) return m[1];
  const birth = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
  return toLocalDate(birth);
}

function inferUpdated(stats) {
  return toLocalDate(stats.mtimeMs);
}

function defaultFields(filePath, content, projectNames, stats) {
  const status = inferStatus(filePath, content);
  const type = inferType(filePath, content, status);

  return {
    status: ALLOWED_STATUS.has(status) ? status : 'active',
    type: ALLOWED_TYPE.has(type) ? type : 'reference',
    project: inferProject(filePath, projectNames),
    created: inferCreated(content, stats),
    updated: inferUpdated(stats),
    author: (() => {
      const a = inferAuthor(content);
      return ALLOWED_AUTHOR.has(a) ? a : 'andrew';
    })(),
  };
}

function normalizeEnum(field, value) {
  const raw = stripQuotes(value);
  const lowered = raw.toLowerCase();

  if (field === 'status') {
    if (ALLOWED_STATUS.has(lowered)) return lowered;
    return STATUS_MAP[raw] || STATUS_MAP[normalizeKey(raw)] || null;
  }
  if (field === 'type') {
    if (ALLOWED_TYPE.has(lowered)) return lowered;
    return TYPE_MAP[raw] || TYPE_MAP[normalizeKey(raw)] || null;
  }
  if (field === 'author') {
    if (ALLOWED_AUTHOR.has(lowered)) return lowered;
    return AUTHOR_MAP[raw] || AUTHOR_MAP[normalizeKey(raw)] || null;
  }

  return null;
}

function validateOneFile(filePath, content, defaults, opts) {
  const violations = [];
  let updatedText = content;
  let changed = false;
  let fixedCount = 0;

  const fm = parseFrontmatter(content);

  if (!fm) {
    violations.push({
      file: filePath,
      field: 'frontmatter',
      current: '(missing)',
      expected: 'YAML frontmatter block with required fields',
      fixable: true,
    });

    if (opts.fix) {
      const eol = detectEol(content);
      const lines = REQUIRED_FIELDS.map((key) => formatFieldLine(key, defaults[key]));
      updatedText = `---${eol}${lines.join(eol)}${eol}---${eol}${eol}${content}`;
      changed = true;
      fixedCount += 1;
    }

    return { violations, updatedText, changed, fixedCount };
  }

  const lines = [...fm.lines];
  const updates = new Map();

  for (const key of REQUIRED_FIELDS) {
    const idx = fm.keyIndex.has(key) ? fm.keyIndex.get(key) : -1;
    const rawValue = fm.keyValueRaw.has(key) ? fm.keyValueRaw.get(key) : null;

    if (idx < 0) {
      violations.push({
        file: filePath,
        field: key,
        current: '(missing)',
        expected: 'required field present',
        fixable: true,
      });

      if (opts.fix) {
        updates.set(key, defaults[key]);
      }
      continue;
    }

    const current = stripQuotes(rawValue);

    if (key === 'status') {
      if (!ALLOWED_STATUS.has(current)) {
        const mapped = normalizeEnum('status', current);
        violations.push({
          file: filePath,
          field: 'status',
          current,
          expected: 'active | draft | archived | abandoned',
          fixable: Boolean(mapped),
        });
        if (opts.fix && mapped) updates.set('status', mapped);
      }
      continue;
    }

    if (key === 'type') {
      if (!ALLOWED_TYPE.has(current)) {
        const mapped = normalizeEnum('type', current);
        violations.push({
          file: filePath,
          field: 'type',
          current,
          expected: 'project-note | draft | research | decision | reference | article | chapter',
          fixable: Boolean(mapped),
        });
        if (opts.fix && mapped) updates.set('type', mapped);
      }
      continue;
    }

    if (key === 'author') {
      if (!ALLOWED_AUTHOR.has(current)) {
        const mapped = normalizeEnum('author', current);
        violations.push({
          file: filePath,
          field: 'author',
          current,
          expected: 'jarvis | andrew | both',
          fixable: Boolean(mapped),
        });
        if (opts.fix && mapped) updates.set('author', mapped);
      }
      continue;
    }

    if (key === 'created' || key === 'updated') {
      if (!isValidDateYYYYMMDD(current)) {
        const normalized = normalizeDate(current);
        violations.push({
          file: filePath,
          field: key,
          current,
          expected: 'valid YYYY-MM-DD date',
          fixable: Boolean(normalized),
        });
        if (opts.fix && normalized) updates.set(key, normalized);
      }
      continue;
    }

  }

  if (opts.fix && updates.size > 0) {
    for (const [key, value] of updates.entries()) {
      if (fm.keyIndex.has(key)) {
        const idx = fm.keyIndex.get(key);
        lines[idx] = formatFieldLine(key, value);
      } else {
        lines.push(formatFieldLine(key, value));
      }
    }

    const nextText = stringifyFrontmatter(fm, lines);
    if (nextText !== content) {
      updatedText = nextText;
      changed = true;
      fixedCount = updates.size;
    }
  }

  return { violations, updatedText, changed, fixedCount };
}

function collectViolations(files, opts) {
  const projectNames = findProjectNames(files);
  const allViolations = [];
  let fixedIssues = 0;
  let filesChanged = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const stats = fs.statSync(file);
    const defaults = defaultFields(file, content, projectNames, stats);

    const result = validateOneFile(file, content, defaults, opts);
    allViolations.push(...result.violations);

    if (opts.fix && result.changed) {
      fs.writeFileSync(file, result.updatedText, 'utf8');
      filesChanged += 1;
      fixedIssues += result.fixedCount;
    }
  }

  return { allViolations, fixedIssues, filesChanged };
}

function buildSummary(files, violations) {
  const filesWithViolations = new Set(violations.map((v) => v.file));
  return {
    notesChecked: files.length,
    compliant: files.length - filesWithViolations.size,
    violations: violations.length,
  };
}

function printHuman(summary, violations, fixStats, notesDir, usedFix) {
  if (usedFix) {
    console.log(`Auto-fix: ${fixStats.filesChanged} files changed, ${fixStats.fixedIssues} field updates applied.`);
  }

  console.log(`Summary: ${summary.notesChecked} notes checked, ${summary.compliant} compliant, ${summary.violations} violations`);
  if (summary.violations === 0) return;

  console.log('Violations:');
  for (const v of violations) {
    const rel = path.relative(notesDir, v.file) || v.file;
    console.log(`- ${rel} | ${v.field} | current=${JSON.stringify(v.current)} | expected=${v.expected}`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }

  if (!fs.existsSync(args.notesDir) || !fs.statSync(args.notesDir).isDirectory()) {
    const msg = `Notes directory does not exist or is not a directory: ${args.notesDir}`;
    if (args.json) {
      console.log(JSON.stringify({ error: msg }, null, 2));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  const files = walkMarkdownFiles(args.notesDir);

  // First pass (and optional fix pass).
  const firstPass = collectViolations(files, { fix: args.fix });

  // Final pass should always reflect post-fix state for exit code/reporting.
  const finalPass = collectViolations(files, { fix: false });
  const summary = buildSummary(files, finalPass.allViolations);

  if (args.json) {
    const payload = {
      summary,
      notesDir: args.notesDir,
      fixed: {
        enabled: args.fix,
        filesChanged: firstPass.filesChanged,
        fieldUpdates: firstPass.fixedIssues,
      },
      violations: finalPass.allViolations.map((v) => ({
        file: v.file,
        field: v.field,
        current: v.current,
        expected: v.expected,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printHuman(summary, finalPass.allViolations, {
      filesChanged: firstPass.filesChanged,
      fixedIssues: firstPass.fixedIssues,
    }, args.notesDir, args.fix);
  }

  process.exit(summary.violations === 0 ? 0 : 1);
}

module.exports = { main };

if (require.main === module) {
  main();
}
