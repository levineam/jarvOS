'use strict';

function normalizeLabels(labels) {
  if (!labels) return [];
  const rows = Array.isArray(labels) ? labels : String(labels).split(',');
  return rows
    .map((label) => {
      if (typeof label === 'string') return label.trim();
      if (label && typeof label === 'object') return String(label.name || label.id || '').trim();
      return '';
    })
    .filter(Boolean);
}

function issueText(issue = {}) {
  return [
    issue.identifier,
    issue.title,
    issue.description,
    normalizeLabels(issue.labels).join(' '),
    issue.project?.name,
    issue.projectName,
  ].filter(Boolean).join('\n');
}

function findMarkers(text, markers = []) {
  const lower = String(text || '').toLowerCase();
  return markers.filter((marker) => lower.includes(String(marker).toLowerCase()));
}

function hasLabel(issue, label) {
  const target = String(label || '').toLowerCase();
  return Boolean(target && normalizeLabels(issue.labels).some((item) => item.toLowerCase() === target));
}

function collectEvidence(issue = {}, markerGroups = {}) {
  const fields = [
    ['identifier', issue.identifier],
    ['title', issue.title],
    ['description', issue.description],
    ['labels', normalizeLabels(issue.labels).join(' ')],
    ['project', issue.project?.name || issue.projectName],
  ];
  const evidence = [];

  for (const [group, markers] of Object.entries(markerGroups)) {
    for (const marker of markers || []) {
      const lowerMarker = String(marker).toLowerCase();
      const match = fields.find(([, value]) => String(value || '').toLowerCase().includes(lowerMarker));
      if (match) evidence.push({ group, field: match[0], marker });
    }
  }

  return evidence;
}

module.exports = {
  collectEvidence,
  findMarkers,
  hasLabel,
  issueText,
  normalizeLabels,
};
