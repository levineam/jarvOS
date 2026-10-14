'use strict';

const { PRIORITIES } = require('./records');

function resolvePriority(recordId, records) {
  const record = records[recordId];
  if (!record) throw new Error(`project record not found: ${recordId}`);
  const visited = new Set();
  let current = record;
  while (current) {
    if (visited.has(current.id)) throw new Error('project hierarchy contains a cycle');
    visited.add(current.id);
    const declared = current.declaredPriority || 'unset';
    if (!PRIORITIES.includes(declared)) throw new Error(`invalid declared priority: ${declared}`);
    if (declared !== 'unset') {
      return {
        declared: record.declaredPriority || 'unset',
        effective: declared,
        source: current.id === record.id ? 'explicit' : 'inherited',
        sourceRecordId: current.id,
        sourceKind: current.kind,
      };
    }
    current = current.parentId ? records[current.parentId] : null;
  }
  return {
    declared: record.declaredPriority || 'unset',
    effective: 'unset',
    source: 'unset',
    sourceRecordId: null,
    sourceKind: null,
  };
}

module.exports = { resolvePriority };
