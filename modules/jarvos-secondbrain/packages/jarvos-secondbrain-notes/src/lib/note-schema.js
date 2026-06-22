'use strict';

const REQUIRED_FIELDS = ['status', 'type', 'project', 'created', 'updated', 'author'];

const ALLOWED_STATUS = new Set(['active', 'draft', 'archived', 'abandoned']);
const ALLOWED_TYPE = new Set(['project-note', 'draft', 'research', 'decision', 'reference', 'article', 'chapter']);
const ALLOWED_AUTHOR = new Set(['jarvis', 'andrew', 'both']);

const STATUS_MAP = {
  draft: 'draft',
  Draft: 'draft',
  pending: 'draft',
  planning: 'draft',
  planned: 'draft',
  paused: 'draft',
  someday: 'draft',
  raw: 'draft',
  active: 'active',
  current: 'active',
  inprogress: 'active',
  'in-progress': 'active',
  published: 'active',
  approved: 'active',
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
  // The jarvos-agent-context MCP (Claude/Codex) defaults created notes to type:'note';
  // accept it as a draft so the canonical pipeline tolerates MCP-created notes (WS7).
  note: 'draft',
  Note: 'draft',
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
  idea: 'draft',
  'x-post': 'article',
  xpost: 'article',
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

function detectEol(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n';
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return null;

  const eol = match[1] || '\n';
  const raw = match[2] || '';
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const keyIndex = new Map();
  const keyValueRaw = new Map();

  let currentKey = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      if (!keyIndex.has(currentKey)) keyIndex.set(currentKey, i);
      keyValueRaw.set(currentKey, m[2] || '');
    } else if (currentKey !== null) {
      // Continuation line for a multiline YAML value (list items, block scalars, etc.)
      const prev = keyValueRaw.get(currentKey);
      keyValueRaw.set(currentKey, prev + '\n' + line);
    }
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
  const eol = parsed?.eol || '\n';
  const body = updatedLines.join(eol);
  const afterFence = parsed?.hadPostFenceNewline ? eol : '';
  return `---${eol}${body}${eol}---${afterFence}${parsed?.remainder || ''}`;
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

function formatFieldLine(key, value) {
  if (Array.isArray(value)) {
    return `${key}: ${JSON.stringify(value)}`;
  }
  // Render non-array objects as indented YAML mappings to preserve structure
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${key}: {}`;
    const lines = entries.map(([k, v]) => {
      if (v === null) return `  ${k}: null`;
      if (typeof v === 'number' || typeof v === 'boolean') return `  ${k}: ${v}`;
      const s = String(v);
      const needsQ = s === '' || /[:#{}\[\],&*?|<>=!%@]/.test(s) ||
        s.startsWith("'") || s.startsWith('"') || s.startsWith(' ') || s.endsWith(' ') ||
        /^[-+]?\d/.test(s) || s === 'true' || s === 'false' || s === 'null' || s === '~';
      return needsQ ? `  ${k}: ${JSON.stringify(s)}` : `  ${k}: ${s}`;
    });
    return `${key}:\n${lines.join('\n')}`;
  }
  // Preserve native YAML types without string coercion
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${key}: ${value}`;
  }
  if (value === null) {
    return `${key}: null`;
  }
  const str = String(value ?? '').trim();
  // Handle multiline string values as YAML literal block scalars
  if (str.includes('\n')) {
    const indented = str.split('\n').map(l => `  ${l}`).join('\n');
    return `${key}: |\n${indented}`;
  }
  // Always quote project field (may be empty string or contain special chars)
  if (key === 'project') {
    return `project: ${JSON.stringify(str)}`;
  }
  // Date strings in YYYY-MM-DD format are valid YAML unquoted
  const isDateString = /^\d{4}-\d{2}-\d{2}$/.test(str);
  if (isDateString) {
    return `${key}: ${str}`;
  }
  // Quote strings that contain YAML-significant characters to avoid parsing issues
  const needsQuoting = str === '' ||
    /[:#{}\[\],&*?|<>=!%@]/.test(str) ||
    str.startsWith("'") || str.startsWith('"') ||
    str.startsWith(' ') || str.endsWith(' ') ||
    /^[-+]?\d/.test(str) || // looks like a number
    str === 'true' || str === 'false' || str === 'null' || str === '~';
  if (needsQuoting) {
    return `${key}: ${JSON.stringify(str)}`;
  }
  return `${key}: ${str}`;
}

function parseScalarValue(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';

  // Detect multiline YAML list values (e.g. "\n  - a\n  - b")
  if (/\n\s*-\s/.test(raw)) {
    const items = [];
    for (const line of String(raw).split('\n')) {
      const m = line.match(/^\s*-\s+(.*)$/);
      if (m) items.push(m[1].trim());
    }
    if (items.length) return items;
  }

  // Detect multiline non-list continuation lines
  if (raw != null && String(raw).includes('\n') && !/\n\s*-\s/.test(raw)) {
    // Try to parse as a YAML-style mapping (e.g. "meta:\n  owner: andrew\n  score: 5")
    const rawLines = String(raw).split('\n');
    const mappingEntries = [];
    for (const line of rawLines) {
      const kvMatch = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kvMatch) {
        const v = kvMatch[2].trim();
        // Parse typed values (numbers, booleans, null)
        if (/^-?\d+(?:\.\d+)?$/.test(v)) mappingEntries.push([kvMatch[1], Number(v)]);
        else if (v === 'true') mappingEntries.push([kvMatch[1], true]);
        else if (v === 'false') mappingEntries.push([kvMatch[1], false]);
        else if (v === 'null' || v === '~') mappingEntries.push([kvMatch[1], null]);
        else mappingEntries.push([kvMatch[1], stripQuotes(v)]);
      }
    }
    // If all indented lines parsed as key:value, treat as mapping object
    const indentedLines = rawLines.filter(l => l.trim().length > 0);
    if (mappingEntries.length > 0 && mappingEntries.length === indentedLines.length) {
      return Object.fromEntries(mappingEntries);
    }
    // Otherwise fall back to block scalar string
    return rawLines.map(l => l.trim()).filter(Boolean).join('\n');
  }

  if (
    trimmed.startsWith('[') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('"') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      // Fall through.
    }
  }
  return stripQuotes(trimmed);
}

function frontmatterToObject(parsed) {
  const out = {};
  if (!parsed?.keyValueRaw) return out;
  for (const [key, raw] of parsed.keyValueRaw.entries()) {
    out[key] = parseScalarValue(raw);
  }
  return out;
}

function defaultRequiredFields(today) {
  return {
    status: 'active',
    type: 'reference',
    project: '',
    created: today,
    updated: today,
    author: 'jarvis',
  };
}

function normalizeRequiredFields({ incoming = {}, existing = {}, today }) {
  const errors = [];
  const defaults = defaultRequiredFields(today);
  const normalized = { ...defaults };

  const resolveEnum = (field) => {
    const incomingValue = incoming[field];
    const existingValue = existing[field];

    if (incomingValue !== undefined) {
      const candidate = normalizeEnum(field, incomingValue);
      if (!candidate) {
        errors.push(`${field} must be one of the canonical values or a known legacy alias`);
        return defaults[field];
      }
      return candidate;
    }

    if (existingValue !== undefined) {
      // Strip inline YAML comments before normalization (e.g., "archived # done" → "archived")
      const commentStripped = stripQuotes(String(existingValue).split('#')[0].trim());
      const candidate = normalizeEnum(field, commentStripped);
      if (candidate) return candidate;
      // Also try the raw value in case the # was part of the actual value
      const candidateRaw = normalizeEnum(field, existingValue);
      if (candidateRaw) return candidateRaw;
      // If normalization still fails, preserve the existing value to avoid destructive state changes
      const allowedSet = field === 'status' ? ALLOWED_STATUS : field === 'type' ? ALLOWED_TYPE : ALLOWED_AUTHOR;
      if (allowedSet.has(commentStripped.toLowerCase())) {
        return commentStripped.toLowerCase();
      }
      // If still not recognized, preserve the original value rather than resetting to default
      return commentStripped || stripQuotes(String(existingValue).trim());
    }

    return defaults[field];
  };

  normalized.status = resolveEnum('status');
  normalized.type = resolveEnum('type');
  normalized.author = resolveEnum('author');

  const projectValue = incoming.project !== undefined ? incoming.project : existing.project;
  normalized.project = projectValue === undefined || projectValue === null ? '' : String(projectValue);

  const createdInput = incoming.created !== undefined ? incoming.created : existing.created;
  if (createdInput !== undefined) {
    const created = normalizeDate(createdInput);
    if (!created) {
      errors.push('created must be a valid YYYY-MM-DD date');
    } else {
      normalized.created = created;
    }
  }

  normalized.updated = today;
  if (incoming.updated !== undefined) {
    const updated = normalizeDate(incoming.updated);
    if (!updated) {
      errors.push('updated must be a valid YYYY-MM-DD date');
    }
  } else if (existing.updated !== undefined) {
    const updated = normalizeDate(existing.updated);
    if (!updated) {
      // ignore existing drift; normalize to today on write
    }
  }

  return { normalized, errors };
}

function splitIncomingFrontmatter(frontmatter) {
  if (frontmatter === undefined) return { required: {}, optional: {} };
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { error: 'frontmatter must be an object when provided' };
  }

  const required = {};
  const optional = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (REQUIRED_FIELDS.includes(key)) required[key] = value;
    else optional[key] = value;
  }
  return { required, optional };
}

function canonicalizeFrontmatter({ incomingFrontmatter = {}, existingFrontmatter = {}, today }) {
  const split = splitIncomingFrontmatter(incomingFrontmatter);
  if (split.error) return { errors: [split.error] };

  const existingRequired = {};
  const existingOptional = {};
  for (const [key, value] of Object.entries(existingFrontmatter || {})) {
    if (REQUIRED_FIELDS.includes(key)) existingRequired[key] = value;
    else existingOptional[key] = value;
  }

  const { normalized, errors } = normalizeRequiredFields({
    incoming: split.required,
    existing: existingRequired,
    today,
  });

  const optional = { ...existingOptional, ...split.optional };
  for (const key of REQUIRED_FIELDS) delete optional[key];

  return {
    errors,
    required: normalized,
    optional,
    frontmatter: { ...normalized, ...optional },
  };
}

function renderFrontmatter(frontmatter) {
  const lines = [];
  for (const key of REQUIRED_FIELDS) {
    lines.push(formatFieldLine(key, frontmatter[key]));
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (REQUIRED_FIELDS.includes(key)) continue;
    lines.push(formatFieldLine(key, value));
  }
  return `---\n${lines.join('\n')}\n---\n\n`;
}

module.exports = {
  REQUIRED_FIELDS,
  ALLOWED_STATUS,
  ALLOWED_TYPE,
  ALLOWED_AUTHOR,
  STATUS_MAP,
  TYPE_MAP,
  AUTHOR_MAP,
  detectEol,
  parseFrontmatter,
  stringifyFrontmatter,
  stripQuotes,
  normalizeKey,
  isValidDateYYYYMMDD,
  normalizeDate,
  normalizeEnum,
  formatFieldLine,
  frontmatterToObject,
  defaultRequiredFields,
  splitIncomingFrontmatter,
  canonicalizeFrontmatter,
  renderFrontmatter,
};
