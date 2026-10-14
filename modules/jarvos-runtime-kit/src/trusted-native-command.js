'use strict';
const fs = require('node:fs');
const path = require('node:path');

function trustedExecutable(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
    || typeof process.getuid !== 'function') return null;
  let current = value;
  while (true) {
    let stat;
    try { stat = fs.lstatSync(current); } catch { return null; }
    if (stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid())) return null;
    if (current === value) {
      if (!stat.isFile() || !(stat.mode & 0o111) || (stat.mode & 0o022)) return null;
    } else if (!stat.isDirectory() || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) return null;
    const parent = path.dirname(current);
    if (parent === current) return value;
    current = parent;
  }
}

module.exports = { trustedExecutable };
