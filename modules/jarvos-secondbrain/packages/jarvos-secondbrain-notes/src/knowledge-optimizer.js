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
  return value.split(',').map((item) => item.replace(/^[-\s]+/, '').trim()).filter(Boolean);
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
  return process.env.JARVOS_KNOWLEDGE_DIR || path.join(vaultRootFor(notesDir || process.cwd()), '.jarvos', 'knowledge');
}

function sensitivityFor({ filePath, body, frontmatter }) {
  const tags = parseList(frontmatter.tags || frontmatter.tag || '');
  const haystack = [filePath, frontmatter.status, frontmatter.type, frontmatter.project, tags.join(' '), String(body || '')]
    .join('\n')
    .toLowerCase();
  const reasons = [];
  if (frontmatter.private === true || frontmatter.sensitive === true) {
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

function sourcePathFor(filePath, notesDir) {
  const root = vaultRootFor(notesDir || path.dirname(filePath));
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : path.basename(filePath);
}

function buildArtifact({ filePath, notesDir, title, body, frontmatter, created, journal = null }) {
  const wikilinks = extractWikilinks(body);
  const entities = extractEntities(title, body, wikilinks);
  const sensitivity = sensitivityFor({ filePath, body, frontmatter });
  const sourcePath = sourcePathFor(filePath, notesDir);
  const bodyHash = sha256(body);
  const now = new Date().toISOString();
  const queueStatus = sensitivity.excluded ? 'skipped' : 'queued';

  return {
    version: 1,
    generatedAt: now,
    updatedAt: now,
    action: created ? 'note_created' : 'note_updated',
    sourceNote: sourcePath,
    title,
    bodyHash,
    aliases: [...new Set([title, ...parseList(frontmatter.aliases || '')].filter(Boolean))],
    entities,
    concepts: [...new Set([...wikilinks, ...entities].map(slugify))].slice(0, 24),
    relationships: wikilinks.map((link) => ({ type: 'wikilink', target: link, targetSlug: slugify(link) })),
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
    downstreamStatuses: {
      obsidian: 'optimized',
      memoryWiki: queueStatus,
      qmd: 'pending-refresh',
      gbrain: queueStatus,
      losslessClaw: 'continuity-captured',
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
}

function removeBySource(filePath, key) {
  const data = readJson(filePath, { version: 1, entries: {} });
  data.entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
  delete data.entries[key];
  data.updatedAt = new Date().toISOString();
  writeJson(filePath, data);
}

function optimizeNoteKnowledge({ filePath, notesDir, title, body, frontmatter = {}, created = true, journal = null }) {
  if (process.env.JARVOS_NOTE_OPTIMIZATION === '0') {
    return { optimized: false, skipped: true, reason: 'disabled by JARVOS_NOTE_OPTIMIZATION=0' };
  }

  const knowledgeDir = defaultKnowledgeDir(notesDir);
  const sourcePath = sourcePathFor(filePath, notesDir);
  const artifactKey = sha256(`${sourcePath}:${sha256(body)}`).slice(0, 16);
  const artifactPath = path.join(knowledgeDir, 'artifacts', `${slugify(title)}-${artifactKey}.json`);
  const artifact = buildArtifact({ filePath, notesDir, title, body, frontmatter, created, journal });
  writeJson(artifactPath, artifact);

  const queuePath = path.join(knowledgeDir, 'gbrain-import-queue.json');
  const memoryWikiQueuePath = path.join(knowledgeDir, 'memory-wiki-queue.json');
  const qmdPendingPath = path.join(knowledgeDir, 'qmd-refresh-pending.json');
  const continuityPath = path.join(knowledgeDir, 'lossless-continuity.json');

  if (artifact.downstreamStatuses.gbrain === 'queued') {
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
      citations: [{ sourcePath, title, bodySha256: artifact.bodyHash }],
      status: 'queued',
    });
    upsertBySource(memoryWikiQueuePath, sourcePath, {
      queuedAt: artifact.generatedAt,
      sourcePath,
      artifactPath,
      title,
      summary: artifact.summary,
      entities: artifact.entities,
      concepts: artifact.concepts,
      status: 'queued',
    });
  } else {
    removeBySource(queuePath, sourcePath);
    removeBySource(memoryWikiQueuePath, sourcePath);
  }

  upsertBySource(qmdPendingPath, sourcePath, {
    recordedAt: artifact.generatedAt,
    sourcePath,
    artifactPath,
    title,
    bodySha256: artifact.bodyHash,
    status: 'pending-refresh',
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

  return {
    optimized: true,
    artifactPath,
    queuePath,
    memoryWikiQueuePath,
    qmdPendingPath,
    continuityPath,
    gbrainQueued: artifact.downstreamStatuses.gbrain === 'queued',
    memoryWikiQueued: artifact.downstreamStatuses.memoryWiki === 'queued',
    qmdStatus: artifact.downstreamStatuses.qmd,
    excluded: artifact.sensitivity.excluded,
    skippedReasons: artifact.sensitivity.reasons,
    statuses: artifact.downstreamStatuses,
  };
}

module.exports = {
  buildArtifact,
  defaultKnowledgeDir,
  optimizeNoteKnowledge,
  sensitivityFor,
  slugify,
  sourcePathFor,
};
