'use strict';

const fs = require('fs');
const path = require('path');

const DAILY_RE = /^(\d{4}-\d{2}-\d{2})(-[\w-]+)?\.md$/;

function index(memoryCfg) {
  let indexContent = null;
  try {
    indexContent = fs.readFileSync(memoryCfg.indexFile, 'utf8');
  } catch {
    /* no MEMORY.md */
  }

  let dailies = [];
  try {
    dailies = fs
      .readdirSync(memoryCfg.dailyDir)
      .filter((f) => DAILY_RE.test(f))
      .sort()
      .reverse()
      .slice(0, 30)
      .map((f) => {
        const full = path.join(memoryCfg.dailyDir, f);
        return {
          file: f,
          date: f.match(DAILY_RE)[1],
          modified: fs.statSync(full).mtime.toISOString(),
        };
      });
  } catch {
    /* no daily dir */
  }

  return { index: indexContent, dailies };
}

function readDaily(memoryCfg, file) {
  if (!DAILY_RE.test(file)) return null; // path traversal guard: only daily-shaped names
  const full = path.join(memoryCfg.dailyDir, file);
  if (!fs.existsSync(full)) return null;
  return { file, content: fs.readFileSync(full, 'utf8') };
}

module.exports = { index, readDaily };
