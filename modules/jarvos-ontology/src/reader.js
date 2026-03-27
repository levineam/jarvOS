/**
 * reader.js — Load and query ontology data from markdown files.
 *
 * Reads the canonical split-file ontology (ontology/*.md) and returns
 * structured objects with links. No database, no server — just markdown parsing.
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// ─── Constants ─────────────────────────────────────────────────────────────

const LAYER_FILES = [
  { layer: 1, file: '1-higher-order.md', type: 'higher-order' },
  { layer: 2, file: '2-beliefs.md', type: 'belief' },
  { layer: 3, file: '3-predictions.md', type: 'prediction' },
  { layer: 4, file: '4-core-self.md', type: 'core-self' },
  { layer: 5, file: '5-goals.md', type: 'goal' },
  { layer: 6, file: '6-projects.md', type: 'project' },
];

const LINK_TYPES = [
  'serves', 'supports', 'contradicts', 'relates-to',
  'depends-on', 'served-by', 'supported-by', 'evolved-from',
];

const LINK_RE = new RegExp(
  '`(' + LINK_TYPES.join('|') + ')`\\s*→\\s*(.+)',
  'i'
);

// ─── Parsers ───────────────────────────────────────────────────────────────

/**
 * Parse a single ontology layer file into objects.
 * Each ## heading with an ID pattern (B1, G2, PJ3, etc.) becomes an object.
 */
function parseLayerFile(content, layerType) {
  const objects = [];
  const lines = content.split('\n');

  // For higher-order and core-self, there's no ID-based objects — treat them as single objects
  if (layerType === 'higher-order') {
    return [parseHigherOrder(content)];
  }
  if (layerType === 'core-self') {
    return [parseCoreSelf(content)];
  }

  // For beliefs, predictions, goals, projects: extract ## ID — Name objects
  const idPatterns = {
    'belief': /^## (B\d+)\s*—\s*(.+)$/,
    'prediction': /^### (.+)$/,  // Predictions use ### headings
    'goal': /^## (G\d+)\s*—\s*(.+)$/,
    'project': /^## (PJ\d+)\s*—\s*(.+)$/,
  };

  const pattern = idPatterns[layerType];
  if (!pattern) return objects;

  let currentObj = null;
  let currentLines = [];

  const flush = () => {
    if (currentObj) {
      currentObj.body = currentLines.join('\n').trim();
      currentObj.links = parseLinks(currentObj.body);
      currentObj.metadata = parseMetadata(currentObj.body);
      objects.push(currentObj);
      currentLines = [];
    }
  };

  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      flush();
      if (layerType === 'prediction') {
        // Predictions don't have standard IDs — generate from name
        const name = match[1].trim();
        currentObj = {
          id: slugify(name),
          name,
          type: layerType,
        };
      } else {
        currentObj = {
          id: match[1],
          name: match[2].trim(),
          type: layerType,
        };
      }
      currentLines = [];
    } else if (currentObj) {
      currentLines.push(line);
    }
  }
  flush();

  return objects;
}

function parseHigherOrder(content) {
  const lines = content.split('\n');
  let statement = '';
  let notes = '';
  let inNotes = false;
  const linkLines = [];
  let inLinks = false;

  for (const line of lines) {
    if (line.startsWith('## My Higher Order')) continue;
    if (line.startsWith('## Notes')) { inNotes = true; inLinks = false; continue; }
    if (line.startsWith('## Links')) { inLinks = true; inNotes = false; continue; }
    if (line.startsWith('## History')) { inLinks = false; inNotes = false; continue; }

    if (inNotes) notes += line + '\n';
    else if (inLinks) linkLines.push(line);
    else if (!line.startsWith('## ') && !line.startsWith('---') && !line.startsWith('*')) {
      if (line.trim()) statement += (statement ? ' ' : '') + line.trim();
    }
  }

  return {
    id: 'HO',
    name: 'Higher Order',
    type: 'higher-order',
    body: content,
    statement: statement.trim(),
    notes: notes.trim(),
    links: parseLinks(linkLines.join('\n')),
    metadata: {},
  };
}

function parseCoreSelf(content) {
  const sections = { mission: '', values: '', strengths: '' };
  let current = null;
  const lines = content.split('\n');
  const allLinks = [];

  for (const line of lines) {
    if (line.startsWith('### Mission')) { current = 'mission'; continue; }
    if (line.startsWith('### Values')) { current = 'values'; continue; }
    if (line.startsWith('### Strengths')) { current = 'strengths'; continue; }
    if (line.startsWith('### Links') || line.startsWith('## Links')) {
      current = 'links'; continue;
    }
    if (line.startsWith('---')) continue;

    if (current === 'links') allLinks.push(line);
    else if (current) sections[current] += line + '\n';
  }

  return {
    id: 'CORE',
    name: 'Core Self',
    type: 'core-self',
    body: content,
    mission: sections.mission.trim(),
    values: sections.values.trim(),
    strengths: sections.strengths.trim(),
    links: parseLinks(allLinks.join('\n')),
    metadata: parseMetadata(content),
  };
}

/**
 * Extract links from body text.
 * Matches patterns like: `serves` → Target Name
 */
function parseLinks(text) {
  const links = [];
  for (const line of text.split('\n')) {
    const match = line.match(LINK_RE);
    if (!match) continue;

    const linkType = match[1].trim();
    let target = match[2].trim();

    // Clean up markdown formatting from target
    target = target
      .replace(/\[\[#?/g, '')
      .replace(/\]\]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^[-*]\s*/, '')
      .trim();

    // Try to extract target ID
    const idMatch = target.match(/^([A-Z]+\d+)\b/);
    const targetId = idMatch ? idMatch[1] : null;

    links.push({
      type: linkType,
      target,
      targetId,
    });
  }
  return links;
}

/**
 * Extract metadata fields: Status, Confidence, Source, Timeframe, etc.
 */
function parseMetadata(text) {
  const meta = {};
  const patterns = [
    [/\*\*Status:\*\*\s*(.+)/i, 'status'],
    [/\*\*Confidence:\*\*\s*(.+)/i, 'confidence'],
    [/\*\*Source:\*\*\s*(.+)/i, 'source'],
    [/\*\*Timeframe:\*\*\s*(.+)/i, 'timeframe'],
    [/\*\*Quote:\*\*\s*"?(.+?)"?\s*$/im, 'quote'],
    [/\*\*Reason:\*\*\s*(.+)/i, 'reason'],
  ];

  for (const line of text.split('\n')) {
    for (const [re, key] of patterns) {
      const m = line.match(re);
      if (m) meta[key] = m[1].trim();
    }
  }
  return meta;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Load the full ontology from a directory of markdown files.
 * @param {string} [dir] - Path to ontology/ directory. Defaults to ./ontology relative to package root.
 * @returns {Ontology} Parsed ontology with objects and links.
 */
export function loadOntology(dir) {
  const ontologyDir = dir || resolve(new URL('.', import.meta.url).pathname, '..', 'ontology');

  const objects = [];
  const missingFiles = [];

  for (const layer of LAYER_FILES) {
    const filePath = join(ontologyDir, layer.file);
    if (!existsSync(filePath)) {
      missingFiles.push(layer.file);
      continue;
    }
    const content = readFileSync(filePath, 'utf8');
    const parsed = parseLayerFile(content, layer.type);
    objects.push(...parsed);
  }

  // Flatten all links with source info
  const links = [];
  for (const obj of objects) {
    if (obj.links) {
      for (const link of obj.links) {
        links.push({
          sourceId: obj.id,
          ...link,
        });
      }
    }
  }

  return {
    dir: ontologyDir,
    objects,
    links,
    missingFiles,
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Get all objects of a specific type.
 */
export function getByType(ontology, type) {
  return ontology.objects.filter(o => o.type === type);
}

/** Get all goals. */
export function getGoals(ontology) {
  return getByType(ontology, 'goal');
}

/** Get all beliefs. */
export function getBeliefs(ontology) {
  return getByType(ontology, 'belief');
}

/** Get all projects. */
export function getProjects(ontology) {
  return getByType(ontology, 'project');
}

/** Get all predictions. */
export function getPredictions(ontology) {
  return getByType(ontology, 'prediction');
}

/** Get all links. */
export function getLinks(ontology) {
  return ontology.links;
}

/** Get a single object by ID. */
export function getById(ontology, id) {
  return ontology.objects.find(o => o.id === id) || null;
}

/**
 * Find orphan objects — those with no inbound or outbound links.
 */
export function findOrphans(ontology) {
  const linkedIds = new Set();
  for (const link of ontology.links) {
    linkedIds.add(link.sourceId);
    if (link.targetId) linkedIds.add(link.targetId);
  }

  // Higher-order and core-self are structural — not orphans even if unlinked
  return ontology.objects.filter(
    o => !linkedIds.has(o.id) && o.type !== 'higher-order' && o.type !== 'core-self'
  );
}
