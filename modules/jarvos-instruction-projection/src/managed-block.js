'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function upsertManagedBlock(target, id, body) {
  let file = target;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid managed block id');
  if (typeof body !== 'string') throw new Error('Managed block body must be text');
  const start = `<!-- jarvos:managed ${id}:start -->`;
  const end = `<!-- jarvos:managed ${id}:end -->`;
  if (body.includes(start) || body.includes(end)) throw new Error('Managed block body contains markers');
  // A symlinked instruction file (for example one shared by two harnesses) is
  // updated at its target, so the link and every harness reading it stay
  // connected; replacing the link with a copy would orphan future updates.
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) file = fs.realpathSync(file);
  const exists = fs.existsSync(file);
  const prior = exists ? fs.readFileSync(file, 'utf8') : '';
  const starts = prior.split(start).length - 1;
  const ends = prior.split(end).length - 1;
  if (starts !== ends || starts > 1 || (starts && prior.indexOf(end) < prior.indexOf(start))) {
    throw new Error(`Unbalanced or duplicated managed block markers: ${id}`);
  }
  const inner = `\n${body.trim()}\n`;
  const next = starts
    ? prior.slice(0, prior.indexOf(start) + start.length) + inner + prior.slice(prior.indexOf(end))
    : prior + (prior ? (prior.endsWith('\n\n') ? '' : prior.endsWith('\n') ? '\n' : '\n\n') : '') + start + inner + end + '\n';
  if (next === prior) return { changed: false };
  const mode = exists ? fs.statSync(file).mode & 0o7777 : 0o644;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup;
  if (exists) {
    backup = `${file}.jarvos-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  const temp = `${file}.jarvos-tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, next, { encoding: 'utf8', flag: 'wx', mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { changed: true, backup };
}

module.exports = { upsertManagedBlock };
