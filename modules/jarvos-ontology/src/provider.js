'use strict';

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_LAYER_FILES,
  DEFAULT_ONTOLOGY_WARNING,
  DEFAULT_PACKET_MAX_CHARS,
  ONTOLOGY_PACKET_VERSION,
} = require('./provider-types.js');

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function clampPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sourceLabel(filePath, baseDir) {
  if (!filePath) return 'unknown';
  const resolved = path.resolve(filePath);
  if (baseDir) {
    const relative = path.relative(path.resolve(baseDir), resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  }
  return path.basename(resolved);
}

function compactText(markdown, maxLines = 5) {
  const kept = [];
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;
    if (/^<!--/.test(trimmed)) continue;
    if (/^—\s*(Written|Edited)\s+by/i.test(trimmed)) continue;
    if (/^#{1,4}\s+/.test(trimmed)) {
      kept.push(trimmed.replace(/^#{1,4}\s+/, ''));
    } else if (/^[-*]\s+/.test(trimmed) || /^\*\*[^*]+:\*\*/.test(trimmed)) {
      kept.push(trimmed);
    } else if (trimmed.length <= 220) {
      kept.push(trimmed);
    }
    if (kept.length >= maxLines) break;
  }
  return kept.join('\n');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function extractAnchors(markdown, fallbackType, source) {
  const anchors = [];
  const seen = new Set();
  const headingRe = /^(#{2,4})\s+(.+)$/gm;
  let match;
  while ((match = headingRe.exec(String(markdown || ''))) !== null) {
    const title = match[2].trim().replace(/\s+#*$/, '');
    const idMatch = title.match(/\b([A-Z]{1,4}\d+|HO|CORE)\b/);
    const id = idMatch ? idMatch[1] : slugify(title);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    anchors.push({
      id,
      label: title,
      type: fallbackType,
      source,
    });
  }
  return anchors;
}

function readSplitSections(ontologyDir, layerFiles = DEFAULT_LAYER_FILES) {
  const sections = [];
  const missing = [];
  const sources = [];
  let latestMtimeMs = 0;

  for (const layer of layerFiles) {
    const filePath = path.join(ontologyDir, layer.file);
    if (!fs.existsSync(filePath)) {
      missing.push(layer.file);
      continue;
    }
    const stat = fs.statSync(filePath);
    latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
    const content = fs.readFileSync(filePath, 'utf8');
    const source = sourceLabel(filePath, ontologyDir);
    const anchors = extractAnchors(content, layer.type, source);
    sections.push({
      id: layer.id,
      type: layer.type,
      title: layer.title,
      summary: compactText(content),
      anchors,
      source,
    });
    sources.push({ source, kind: 'ontology-layer', modifiedAt: stat.mtime.toISOString() });
  }

  return {
    sections,
    missing,
    sources,
    sourceKind: 'split-markdown',
    sourceRoot: path.basename(path.resolve(ontologyDir)),
    sourceUpdatedAt: latestMtimeMs ? new Date(latestMtimeMs).toISOString() : null,
  };
}

function readMonolith(sourceFile) {
  const content = fs.readFileSync(sourceFile, 'utf8');
  const stat = fs.statSync(sourceFile);
  const source = sourceLabel(sourceFile);
  const parts = [];
  const headingRe = /^##\s+(.+)$/gm;
  const headings = [];
  let match;
  while ((match = headingRe.exec(content)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index });
  }

  if (!headings.length) {
    parts.push({
      id: 'ontology',
      type: 'ontology',
      title: 'Ontology',
      summary: compactText(content, 12),
      anchors: extractAnchors(content, 'ontology', source),
      source,
    });
  } else {
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      const next = headings[index + 1];
      const body = content.slice(heading.index, next ? next.index : content.length);
      const id = slugify(heading.title) || `section-${index + 1}`;
      parts.push({
        id,
        type: id,
        title: heading.title,
        summary: compactText(body),
        anchors: extractAnchors(body, id, source),
        source,
      });
    }
  }

  return {
    sections: parts,
    missing: [],
    sources: [{ source, kind: 'ontology-monolith', modifiedAt: stat.mtime.toISOString() }],
    sourceKind: 'monolith-markdown',
    sourceRoot: source,
    sourceUpdatedAt: stat.mtime.toISOString(),
  };
}

function loadMarkdownSource(options = {}) {
  const sourceFile = firstString(options.sourceFile, options.ontologyFile);
  if (sourceFile) {
    if (!fs.existsSync(sourceFile)) {
      return {
        ok: false,
        sections: [],
        anchors: [],
        sources: [],
        errors: [{ code: 'source_missing', message: `Ontology source file missing: ${sourceLabel(sourceFile)}` }],
      };
    }
    return { ok: true, errors: [], ...readMonolith(sourceFile) };
  }

  const ontologyDir = firstString(options.ontologyDir, options.dir);
  if (!ontologyDir || !fs.existsSync(ontologyDir)) {
    return {
      ok: false,
      sections: [],
      anchors: [],
      sources: [],
      errors: [{ code: 'source_missing', message: 'Ontology source directory is not configured or does not exist' }],
    };
  }

  const loaded = readSplitSections(ontologyDir, options.layerFiles || DEFAULT_LAYER_FILES);
  const errors = loaded.sections.length
    ? []
    : [{ code: 'source_empty', message: 'Ontology source has no readable sections' }];
  return { ok: errors.length === 0, errors, ...loaded };
}

function normalizePacketSource(sourceResult) {
  const anchors = sourceResult.sections.flatMap((section) => section.anchors || []);
  return {
    ...sourceResult,
    anchors,
    freshness: {
      loadedAt: new Date().toISOString(),
      sourceUpdatedAt: sourceResult.sourceUpdatedAt || null,
      missingSources: sourceResult.missing || [],
    },
  };
}

function renderPacketMarkdown(packet, maxChars) {
  const lines = [
    '# jarvOS Ontology Context',
    '',
    packet.warning,
    '',
    '## Freshness',
    `- Loaded: ${packet.freshness.loadedAt}`,
    `- Source updated: ${packet.freshness.sourceUpdatedAt || 'unknown'}`,
    `- Source kind: ${packet.sourceKind || 'unknown'}`,
    '',
    '## Sections',
  ];

  for (const section of packet.sections) {
    lines.push('', `### ${section.title}`, `Source: ${section.source}`);
    if (section.summary) lines.push('', section.summary);
    if (section.anchors?.length) {
      lines.push('', 'Anchors:');
      for (const anchor of section.anchors.slice(0, 8)) {
        lines.push(`- ${anchor.id}: ${anchor.label}`);
      }
    }
  }

  if (packet.freshness.missingSources?.length) {
    lines.push('', '## Missing Sources');
    for (const missing of packet.freshness.missingSources) lines.push(`- ${missing}`);
  }

  const original = lines.join('\n').trim();
  const budget = clampPositiveNumber(maxChars, DEFAULT_PACKET_MAX_CHARS);
  if (original.length <= budget) return { markdown: `${original}\n`, truncated: false, originalChars: original.length };
  const suffix = `\n\n[ontology context trimmed to ${budget} characters]\n`;
  return {
    markdown: `${original.slice(0, Math.max(0, budget - suffix.length)).trimEnd()}${suffix}`,
    truncated: true,
    originalChars: original.length,
  };
}

function createPacket(sourceResult, options = {}) {
  const normalized = normalizePacketSource(sourceResult);
  const packet = {
    ok: sourceResult.ok !== false,
    type: 'jarvos-ontology-context',
    version: ONTOLOGY_PACKET_VERSION,
    warning: firstString(options.warning, DEFAULT_ONTOLOGY_WARNING),
    sourceKind: sourceResult.sourceKind || 'unknown',
    sourceRoot: sourceResult.sourceRoot || null,
    sections: normalized.sections,
    anchors: normalized.anchors,
    sources: normalized.sources,
    errors: sourceResult.errors || [],
    freshness: normalized.freshness,
    budget: {
      maxChars: clampPositiveNumber(options.maxChars, DEFAULT_PACKET_MAX_CHARS),
      originalChars: 0,
      truncated: false,
    },
  };
  const rendered = renderPacketMarkdown(packet, packet.budget.maxChars);
  packet.markdown = rendered.markdown;
  packet.budget.originalChars = rendered.originalChars;
  packet.budget.truncated = rendered.truncated;
  return packet;
}

function createOntologyProvider(options = {}) {
  function loadOntologyContext(loadOptions = {}) {
    const merged = { ...options, ...loadOptions };
    return normalizePacketSource(loadMarkdownSource(merged));
  }

  function validateSource(validateOptions = {}) {
    const source = loadMarkdownSource({ ...options, ...validateOptions });
    return {
      ok: source.ok,
      errors: source.errors || [],
      missingSources: source.missing || [],
      sectionCount: source.sections.length,
      sources: source.sources || [],
    };
  }

  function renderAgentPacket(packetOptions = {}) {
    const merged = { ...options, ...packetOptions };
    return createPacket(loadMarkdownSource(merged), merged);
  }

  function listAnchors(anchorOptions = {}) {
    return loadOntologyContext(anchorOptions).anchors;
  }

  function proposeUpdate(update = {}) {
    return {
      ok: true,
      status: 'candidate-required',
      candidate: {
        type: 'ontology-candidate',
        proposed_target: firstString(update.proposedTarget, update.target, update.section, 'review'),
        signal_type: firstString(update.signalType, update.type, 'unspecified'),
        confidence: update.confidence == null ? null : Number(update.confidence),
        source: update.source || null,
        evidence: update.evidence || null,
        content: firstString(update.content, update.text, update.summary, ''),
      },
      message: 'Ontology updates must be written as source-backed candidates and reviewed before promotion.',
    };
  }

  return {
    loadOntologyContext,
    validateSource,
    renderAgentPacket,
    listAnchors,
    proposeUpdate,
  };
}

function createFixtureOntologyProvider(fixture = {}) {
  const provider = {
    loadOntologyContext() {
      const sections = Array.isArray(fixture.sections) ? fixture.sections : [];
      return normalizePacketSource({
        ok: fixture.ok !== false,
        sections: sections.map((section, index) => ({
          id: section.id || `section-${index + 1}`,
          type: section.type || 'ontology',
          title: section.title || section.id || `Section ${index + 1}`,
          summary: section.summary || '',
          anchors: Array.isArray(section.anchors) ? section.anchors : [],
          source: section.source || 'fixture',
        })),
        sources: fixture.sources || [{ source: 'fixture', kind: 'fixture', modifiedAt: fixture.sourceUpdatedAt || null }],
        sourceKind: 'fixture',
        sourceRoot: 'fixture',
        sourceUpdatedAt: fixture.sourceUpdatedAt || null,
        missing: [],
        errors: [],
      });
    },
    validateSource() {
      const context = provider.loadOntologyContext();
      return { ok: true, errors: [], missingSources: [], sectionCount: context.sections.length, sources: context.sources };
    },
    renderAgentPacket(options = {}) {
      const context = provider.loadOntologyContext();
      return createPacket(context, options);
    },
    listAnchors() {
      return provider.loadOntologyContext().anchors;
    },
    proposeUpdate(update = {}) {
      return createOntologyProvider().proposeUpdate(update);
    },
  };
  return provider;
}

module.exports = {
  createFixtureOntologyProvider,
  createOntologyProvider,
  createPacket,
  DEFAULT_LAYER_FILES,
  DEFAULT_ONTOLOGY_WARNING,
  DEFAULT_PACKET_MAX_CHARS,
  ONTOLOGY_PACKET_VERSION,
};
