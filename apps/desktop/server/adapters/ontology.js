'use strict';

const fs = require('fs');
const path = require('path');

const SPINE_ORDER = [
  '1-higher-order.md',
  '2-beliefs.md',
  '3-predictions.md',
  '4-core-self.md',
  '5-goals.md',
  '6-projects.md',
];

function spine(ontologyDir) {
  if (!fs.existsSync(ontologyDir)) return [];
  const present = new Set(fs.readdirSync(ontologyDir));
  return SPINE_ORDER.filter((f) => present.has(f)).map((f) => {
    const full = path.join(ontologyDir, f);
    const content = fs.readFileSync(full, 'utf8');
    const stat = fs.statSync(full);
    return {
      file: f,
      slug: f.replace(/^\d+-/, '').replace(/\.md$/, ''),
      title: titleOf(content) || f,
      content,
      modified: stat.mtime.toISOString(),
    };
  });
}

function titleOf(content) {
  const m = content.match(/^#{1,2}\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

module.exports = { spine };
