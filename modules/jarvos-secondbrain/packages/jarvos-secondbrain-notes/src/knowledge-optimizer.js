#!/usr/bin/env node
/**
 * Lossless KB sidecars for notes created through any jarvOS runtime.
 *
 * The note remains the source of truth. This module writes deterministic local
 * artifacts that WS4 retrieval and WS5 synthesis surfaces can consume without
 * making OpenClaw, Claude, Codex, or Hermes each maintain a separate pipeline.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_TERMS = [
  'password',
  'secret',
  'credential',
  'api key',
  'oauth',
  'access token',
  'private key',
  'medical',
  'financial',
  'tax',
];

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return slug || 'note';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    } catch {
      // Fall through to comma parsing.
    }
  }
  return trimmed.split(',').map((item) => item.replace(/^[-\s]+/, '').trim()).filter(Boolean);
}

function extractWikilinks(body) {
  const links = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = re.exec(String(body || ''))) !== null) {
    if (match[1]) links.push(match[1].trim());
  }
  return [...new Set(links)];
}

function extractEntities(title, body, wikilinks = []) {
  const entities = new Set(wikilinks);
  const text = `${title}\n${body}`;
  const re = /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,4})\b/g;
  let match;
  while ((match = re.exec(text)) !== null && entities.size < 24) {
    const candidate = match[1].trim();
    if (candidate.length >= 3 && !/^(The|This|That|Notes|Project|Status)$/.test(candidate)) {
      entities.add(candidate);
    }
  }
  return [...entities].slice(0, 24);
}

function extractClaims(body) {
  const sentences = String(body || '')
    .replace(/^#\s+.+$/gm, '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24 && sentence.length <= 280)
    .slice(0, 6);
  return sentences.map((text, index) => ({ id: `claim-${index + 1}`, text, evidence: 'source-note-body' }));
}

function summarize(body) {
  const clean = String(body || '')
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/^#\s+.+$/m, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const words = clean.split(/\s+/).slice(0, 48).join(' ');
  return words.length < clean.length ? `${words}...` : words;
}

function vaultRootFor(notesDir) {
  const base = path.basename(notesDir || '');
  return base.toLowerCase() === 'notes' ? path.dirname(notesDir) : notesDir;
}

function defaultKnowledgeDir(notesDir) {
  const vaultRoot = vaultRootFor(notesDir || process.cwd());
  return process.env.JARVOS_KNOWLEDGE_DIR || path.join(vaultRoot, '.jarvos', 'knowledge');
}

function booleanish(value) {
  if (typeof value === 'boolean') return value;
  return /^(true|yes|1)$/i.test(String(value || '').trim());
}

function sensitivityFor({ filePath, body, frontmatter }) {
  const tags = parseList(frontmatter.tags || frontmatter.tag || '');
  const haystack = [filePath, frontmatter.status, frontmatter.type, frontmatter.project, tags.join(' '), String(body || '')]
    .join('\n')
    .toLowerCase();
  const reasons = [];
  if (booleanish(frontmatter.private) || booleanish(frontmatter.sensitive)) {
    reasons.push('frontmatter marks note private/sensitive');
  }
  if (tags.some((tag) => /^(private|sensitive|secret|credentials?|medical|financial|tax)$/i.test(tag))) {
    reasons.push('frontmatter tags exclude automatic import');
  }
  for (const term of SECRET_TERMS) {
    if (haystack.includes(term)) reasons.push(`contains excluded term: ${term}`);
  }
  return {
    privacyTier: reasons.length ? 'sensitive' : 'local-private',
    excluded: reasons.length > 0,
    reasons: [...new Set(reasons)],
  };
}

function exclusionReasons(args) {
  return sensitivityFor(args).reasons;
}

function sourcePathFor(filePath, notesDir) {
  const root = vaultRootFor(notesDir || path.dirname(filePath));
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : path.basename(filePath);
}

function buildArtifact({ filePath, notesDir, title, body, frontmatter, created, journal = null }) {
  const aliases = [...new Set([title, ...parseList(frontmatter.aliases || '')].filter(Boolean))];
  const wikilinks = extractWikilinks(body);
  const entities = extractEntities(title, body, wikilinks);
  const concepts = [...new Set([...wikilinks, ...entities].map((value) => slugify(value)).filter(Boolean))].slice(0, 24);
  const sensitivity = sensitivityFor({ filePath, body, frontmatter });
  const sourcePath = sourcePathFor(filePath, notesDir);
  const bodyHash = sha256(body);
  const now = new Date().toISOString();
  const claims = extractClaims(body);
  const gbrainStatus = sensitivity.excluded ? 'skipped' : 'queued';
  const memoryWikiStatus = sensitivity.excluded ? 'skipped' : 'queued';

  return {
    version: 1,
    generatedAt: now,
    updatedAt: now,
    action: created ? 'note_created' : 'note_updated',
    sourceNote: sourcePath,
    title,
    bodyHash,
    aliases,
    entities,
    concepts,
    relationships: wikilinks.map((link) => ({ type: 'wikilink', target: link, targetSlug: slugify(link) })),
    claims,
    privacyTier: sensitivity.privacyTier,
    sensitivity: { excluded: sensitivity.excluded, reasons: sensitivity.reasons },
    provenance: {
      sourcePath,
      absolutePath: filePath,
      bodySha256: bodyHash,
      bodyBytes: Buffer.byteLength(String(body || ''), 'utf8'),
      citation: `[[${title}]]`,
      journalBacklink: journal || null,
    },
    summary: summarize(body),
    gbrain: { status: gbrainStatus, slug: sensitivity.excluded ? null : slugify(title), skippedReasons: sensitivity.reasons },
    memoryWiki: { status: memoryWikiStatus, skippedReasons: sensitivity.reasons },
    qmd: { status: 'pending-refresh', reason: 'note optimized after write; refresh/index should run before treating search as fresh' },
    obsidian: { status: 'optimized', evidence: ['readable markdown source', 'stable markdown path', 'Dataview-friendly frontmatter'] },
    losslessClaw: {
      status: 'continuity-captured',
      note: 'continuity artifact records the note action; lossless-claw is not treated as the primary vault note knowledge base',
    },
    downstreamStatuses: {
      obsidian: 'optimized',
      memoryWiki: memoryWikiStatus,
      qmd: 'pending-refresh',
      gbrain: gbrainStatus,
      losslessClaw: 'continuity-captured',
    },
    derivative: {
      summary: summarize(body),
      aliases,
      entities,
      concepts,
      relationships: {
        wikilinks,
        related: wikilinks.map((link) => slugify(link)),
      },
      claims,
    },
    stack: {
      obsidian: { optimized: true, status: 'optimized' },
      memoryWiki: { optimized: true, status: memoryWikiStatus, skippedReasons: sensitivity.reasons },
      qmd: { optimized: true, status: 'pending-refresh' },
      gbrain: { eligible: !sensitivity.excluded, queued: !sensitivity.excluded, status: gbrainStatus, skippedReasons: sensitivity.reasons },
      losslessClaw: { continuityCaptured: true, status: 'continuity-captured' },
    },
  };
}

function upsertBySource(filePath, key, entry) {
  const data = readJson(filePath, { version: 1, entries: {} });
  data.version = 1;
  data.updatedAt = new Date().toISOString();
  data.entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
  data.entries[key] = entry;
  writeJson(filePath, data);
  return data.entries[key];
}

function removeBySource(filePath, key) {
  const data = readJson(filePath, { version: 1, entries: {} });
  data.entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
  delete data.entries[key];
  data.updatedAt = new Date().toISOString();
  writeJson(filePath, data);
}

function recordAudit(knowledgeDir, artifact) {
  const auditPath = path.join(knowledgeDir, 'optimization-audit.json');
  const audit = readJson(auditPath, { version: 1, entries: {}, counts: {} });
  audit.version = 1;
  audit.updatedAt = artifact.updatedAt;
  audit.entries = audit.entries && typeof audit.entries === 'object' ? audit.entries : {};
  audit.entries[artifact.sourceNote] = {
    sourceNote: artifact.sourceNote,
    title: artifact.title,
    bodyHash: artifact.bodyHash,
    updatedAt: artifact.updatedAt,
    statuses: artifact.downstreamStatuses,
    sensitivity: artifact.sensitivity,
  };
  const entries = Object.values(audit.entries);
  audit.counts = {
    optimized: entries.filter((entry) => entry.statuses?.obsidian === 'optimized').length,
    queued: entries.filter((entry) => ['queued', 'pending-refresh'].includes(entry.statuses?.gbrain) || ['queued', 'pending-refresh'].includes(entry.statuses?.memoryWiki)).length,
    skipped: entries.filter((entry) => entry.statuses?.gbrain === 'skipped' || entry.statuses?.memoryWiki === 'skipped').length,
    pending: entries.filter((entry) => entry.statuses?.qmd === 'pending-refresh').length,
    imported: entries.filter((entry) => entry.statuses?.gbrain === 'imported' || entry.statuses?.memoryWiki === 'imported').length,
  };
  writeJson(auditPath, audit);
  return { auditPath, counts: audit.counts };
}

function optimizeNoteKnowledge({ filePath, notesDir, knowledgeDir: providedKnowledgeDir = null, title, body, frontmatter = {}, created = true, journal = null }) {
  if (process.env.JARVOS_NOTE_OPTIMIZATION === '0') {
    return { optimized: false, skipped: true, reason: 'disabled by JARVOS_NOTE_OPTIMIZATION=0' };
  }

  const knowledgeDir = path.resolve(providedKnowledgeDir || defaultKnowledgeDir(notesDir));
  const sourcePath = sourcePathFor(filePath, notesDir);
  const bodyHash = sha256(body);
  const artifactKey = sha256(`${sourcePath}:${bodyHash}`).slice(0, 16);
  const artifactPath = path.join(knowledgeDir, 'artifacts', `${slugify(title)}-${artifactKey}.json`);
  const artifact = buildArtifact({ filePath, notesDir, title, body, frontmatter, created, journal });
  writeJson(artifactPath, artifact);

  const queuePath = path.join(knowledgeDir, 'gbrain-import-queue.json');
  const memoryWikiQueuePath = path.join(knowledgeDir, 'memory-wiki-queue.json');
  const qmdPendingPath = path.join(knowledgeDir, 'qmd-refresh-pending.json');
  const continuityPath = path.join(knowledgeDir, 'lossless-continuity.json');

  if (artifact.gbrain.status === 'queued') {
    upsertBySource(queuePath, sourcePath, {
      queuedAt: artifact.generatedAt,
      sourcePath,
      artifactPath,
      title,
      summary: artifact.summary,
      aliases: artifact.aliases,
      entities: artifact.entities,
      concepts: artifact.concepts,
      relationships: artifact.relationships,
      claims: artifact.claims,
      citations: [{ sourcePath, title, bodySha256: artifact.bodyHash }],
      bodySha256: artifact.bodyHash,
      status: 'queued',
      policy: 'safe-note-auto-queue',
      sync: { status: 'pending', reason: 'gbrain sync/embed not run inline by note writer' },
    });
  } else {
    removeBySource(queuePath, sourcePath);
  }

  if (artifact.memoryWiki.status === 'queued') {
    upsertBySource(memoryWikiQueuePath, sourcePath, {
      queuedAt: artifact.generatedAt,
      sourcePath,
      artifactPath,
      title,
      summary: artifact.summary,
      aliases: artifact.aliases,
      entities: artifact.entities,
      concepts: artifact.concepts,
      claims: artifact.claims,
      evidence: [{ sourcePath, citation: artifact.provenance.citation }],
      status: 'queued',
    });
  } else {
    removeBySource(memoryWikiQueuePath, sourcePath);
  }

  upsertBySource(qmdPendingPath, sourcePath, {
    recordedAt: artifact.generatedAt,
    sourcePath,
    artifactPath,
    title,
    bodySha256: artifact.bodyHash,
    status: 'pending-refresh',
    reason: 'QMD/search freshness should be refreshed after note optimization',
  });
  upsertBySource(continuityPath, sourcePath, {
    capturedAt: artifact.generatedAt,
    action: artifact.action,
    sourcePath,
    title,
    bodySha256: artifact.bodyHash,
    artifactPath,
    status: 'continuity-captured',
  });

  const audit = recordAudit(knowledgeDir, artifact);

  return {
    optimized: true,
    artifactPath,
    queuePath,
    memoryWikiQueuePath,
    qmdPendingPath,
    continuityPath,
    auditPath: audit.auditPath,
    auditCounts: audit.counts,
    gbrainQueued: artifact.gbrain.status === 'queued',
    memoryWikiQueued: artifact.memoryWiki.status === 'queued',
    qmdStatus: artifact.qmd.status,
    excluded: artifact.sensitivity.excluded,
    skippedReasons: artifact.sensitivity.reasons,
    statuses: artifact.downstreamStatuses,
    stack: artifact.stack,
  };
}

module.exports = {
  buildArtifact,
  defaultKnowledgeDir,
  exclusionReasons,
  optimizeNoteKnowledge,
  sensitivityFor,
  slugify,
  sourcePathFor,
};
