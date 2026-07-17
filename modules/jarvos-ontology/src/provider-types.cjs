'use strict';

const ONTOLOGY_PACKET_VERSION = 'jarvos-ontology-context-v1';

const DEFAULT_PACKET_MAX_CHARS = 2200;

const DEFAULT_ONTOLOGY_WARNING = [
  'Ontology context is the user hierarchy-of-meaning layer.',
  'It can inform judgment, prioritization, and interpretation.',
  'It is not task state, raw memory, or an execution tracker.',
].join(' ');

const DEFAULT_LAYER_FILES = [
  { id: 'higher-order', type: 'higher-order', title: 'Higher-Order Principles', file: '1-higher-order.md' },
  { id: 'beliefs', type: 'belief', title: 'Beliefs', file: '2-beliefs.md' },
  { id: 'predictions', type: 'prediction', title: 'Predictions', file: '3-predictions.md' },
  { id: 'core-self', type: 'core-self', title: 'Core Self', file: '4-core-self.md' },
  { id: 'goals', type: 'goal', title: 'Goals', file: '5-goals.md' },
  { id: 'projects', type: 'project', title: 'Projects', file: '6-projects.md' },
];

module.exports = {
  DEFAULT_LAYER_FILES,
  DEFAULT_ONTOLOGY_WARNING,
  DEFAULT_PACKET_MAX_CHARS,
  ONTOLOGY_PACKET_VERSION,
};
