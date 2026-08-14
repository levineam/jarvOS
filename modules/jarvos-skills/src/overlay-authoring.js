'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { OVERLAY_SCHEMA_VERSION, computeBundleTree } = require('./catalog');
function write(file, value) { const tmp = `${file}.${process.pid}.tmp`; fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }
function admitOverlaySkill({ overlayPath, id, skillPath, allowedHarnesses, refresh = false } = {}) {
  if (!overlayPath || !id || !skillPath || !Array.isArray(allowedHarnesses)) throw new Error('overlayPath, id, skillPath, and allowedHarnesses are required');
  const tree = computeBundleTree(skillPath); const overlay = fs.existsSync(overlayPath) ? JSON.parse(fs.readFileSync(overlayPath, 'utf8')) : { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] };
  if (overlay.schemaVersion !== OVERLAY_SCHEMA_VERSION) throw new Error('local overlay schema is unsupported'); const index = overlay.entries.findIndex((e) => e.id === id);
  if (index >= 0 && !refresh) throw new Error('local overlay entry already exists; use refresh'); if (index < 0 && refresh) throw new Error('local overlay entry does not exist');
  if (allowedHarnesses.length === 0) throw new Error('allowedHarnesses must name at least one harness');
  const absoluteSkill = path.resolve(skillPath);
  const entry = {
    id,
    allowedHarnesses: [...allowedHarnesses].sort(),
    bundle: {
      // Catalog contracts require a contained relative root; the operator
      // supplies localSourceRoot separately and never publishes this body.
      root: path.basename(absoluteSkill),
      allowlist: tree.allowlist,
      treeDigest: tree.treeDigest,
    },
    verification: Object.fromEntries(allowedHarnesses.map((h) => [h, { tier: 'adapter-declared', remoteModelProbe: false }])),
  };
  if (index < 0) overlay.entries.push(entry); else overlay.entries[index] = entry; write(overlayPath, overlay); return { status: 'preview_required', id, treeDigest: tree.treeDigest, entry: { id, allowedHarnesses: entry.allowedHarnesses, treeDigest: tree.treeDigest } };
}
module.exports = { admitOverlaySkill };
