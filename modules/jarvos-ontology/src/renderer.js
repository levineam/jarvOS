/**
 * renderer.js — Visualize ontology as Mermaid diagram or combined markdown.
 *
 * Rewritten as ES module from personal-ontology/scripts/render-ontology.js.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Constants ─────────────────────────────────────────────────────────────

const LAYER_FILES = [
  '1-higher-order.md',
  '2-beliefs.md',
  '3-predictions.md',
  '4-core-self.md',
  '5-goals.md',
  '6-projects.md',
];

// ─── Mermaid renderer ──────────────────────────────────────────────────────

/**
 * Render ontology as a Mermaid graph definition.
 *
 * @param {Ontology} ontology - Parsed ontology from reader.loadOntology()
 * @returns {string} Mermaid graph source
 */
export function renderMermaid(ontology) {
  const lines = ['graph TD'];

  // Group objects by type for subgraphs
  const byType = {};
  for (const obj of ontology.objects) {
    if (!byType[obj.type]) byType[obj.type] = [];
    byType[obj.type].push(obj);
  }

  const typeLabels = {
    'higher-order': 'Layer 1: Higher Order',
    'belief': 'Layer 2: Beliefs',
    'prediction': 'Layer 3: Predictions',
    'core-self': 'Layer 4: Core Self',
    'goal': 'Layer 5: Goals',
    'project': 'Layer 6: Projects',
  };

  // Add nodes grouped by type
  for (const [type, label] of Object.entries(typeLabels)) {
    const objs = byType[type] || [];
    if (objs.length === 0) continue;

    lines.push(`    subgraph ${type.replace('-', '')}["${label}"]`);
    for (const obj of objs) {
      const name = (obj.name || '').slice(0, 35).replace(/"/g, "'");
      const shape = type === 'core-self' ? `(("${name}"))` : `["${name}"]`;
      lines.push(`        ${obj.id}${shape}`);
    }
    lines.push('    end');
    lines.push('');
  }

  // Add links
  for (const link of ontology.links) {
    if (!link.targetId) continue;
    const arrow = link.type === 'contradicts' ? '-.->|contradicts|'
      : link.type === 'supports' ? '-->|supports|'
      : link.type === 'serves' ? '-->|serves|'
      : link.type === 'depends-on' ? '-.->|depends-on|'
      : '-->';
    lines.push(`    ${link.sourceId} ${arrow} ${link.targetId}`);
  }

  // Style definitions
  lines.push('');
  lines.push('    classDef coreSelf fill:#f9f,stroke:#333,stroke-width:2px');
  lines.push('    classDef belief fill:#bbf,stroke:#333');
  lines.push('    classDef goal fill:#bfb,stroke:#333');
  lines.push('    classDef project fill:#fbb,stroke:#333');

  return lines.join('\n');
}

// ─── Combined markdown renderer ───────────────────────────────────────────

/**
 * Render all ontology files as a single combined markdown document.
 * This produces output equivalent to the original ONTOLOGY.md monolith.
 *
 * @param {string} dir - Path to ontology/ directory
 * @returns {string} Combined markdown
 */
export function renderCombined(dir) {
  const parts = ['# ONTOLOGY.md — Personal Ontology\n'];

  for (const file of LAYER_FILES) {
    const filePath = join(dir, file);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf8').trim();
    parts.push(content);
  }

  return parts.join('\n\n');
}

/**
 * Render a summary table of the ontology.
 *
 * @param {Ontology} ontology
 * @returns {string}
 */
export function renderSummary(ontology) {
  const lines = [];
  lines.push('# Ontology Summary\n');

  const byType = {};
  for (const obj of ontology.objects) {
    if (!byType[obj.type]) byType[obj.type] = [];
    byType[obj.type].push(obj);
  }

  const typeOrder = ['higher-order', 'belief', 'prediction', 'core-self', 'goal', 'project'];
  for (const type of typeOrder) {
    const objs = byType[type] || [];
    if (objs.length === 0) continue;
    lines.push(`## ${type} (${objs.length})`);
    for (const obj of objs) {
      const status = obj.metadata?.status ? ` [${obj.metadata.status}]` : '';
      lines.push(`- **${obj.id}** — ${obj.name}${status}`);
    }
    lines.push('');
  }

  lines.push(`\n**Total:** ${ontology.objects.length} objects, ${ontology.links.length} links`);
  return lines.join('\n');
}
