'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

const fs = require('node:fs');

// Where the jarvos CLI lives: an explicit jarvosRepo, else the location the
// installer recorded in this copy, else (running from the repo) the repo itself.
function resolveJarvosRoot(cfg, appDir = path.join(__dirname, '..', '..')) {
  if (typeof cfg.jarvosRepo === 'string' && cfg.jarvosRepo.trim()) return cfg.jarvosRepo;
  try {
    const recorded = JSON.parse(fs.readFileSync(path.join(appDir, 'install-source.json'), 'utf8')).jarvosRoot;
    if (typeof recorded === 'string' && path.isAbsolute(recorded)) return recorded;
  } catch { /* not an installed copy */ }
  const repo = path.resolve(appDir, '..', '..');
  return fs.existsSync(path.join(repo, 'scripts', 'jarvos.js')) && fs.existsSync(path.join(repo, 'apps', 'desktop')) ? repo : null;
}

function appendJournal(cfg, { date, section, bullet, words, asked }, { appDir } = {}) {
  if (!['Ideas', 'Journal'].includes(section)) throw new Error('Capture supports only Ideas or Journal sections');
  if (!['user', 'assistant', 'mixed'].includes(words)) throw new Error('words must be user, assistant, or mixed');
  if (!['explicit', 'accepted_offer'].includes(asked)) throw new Error('asked must be explicit or accepted_offer');
  if (typeof bullet !== 'string' || !bullet.trim()) throw new Error('bullet is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date=YYYY-MM-DD required');
  const jarvosRoot = resolveJarvosRoot(cfg, appDir);
  if (!jarvosRoot) {
    return Promise.resolve({ available: false, reason: 'jarvOS capture is unavailable: jarvosRepo is not configured' });
  }
  // Save only where Desktop itself reads the journal; never let capture fall
  // back to an ambient or home-default journal Desktop cannot show.
  if (typeof cfg.vault?.journalDir !== 'string' || !cfg.vault.journalDir.trim()) {
    return Promise.resolve({ available: false, reason: 'jarvOS capture is unavailable: the journal folder is not configured' });
  }
  if (!path.isAbsolute(jarvosRoot)) throw new Error('jarvosRepo must be an absolute path for capture');
  const args = [path.join(jarvosRoot, 'scripts', 'jarvos.js'), 'capture',
    '--kind', section === 'Ideas' ? 'idea' : 'journal', '--date', date,
    '--words', words, '--asked', asked, '--source', 'jarvos-desktop', '--json'];
  // Desktop also runs in Electron; its executable must run the CLI as Node.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const [key, value] of Object.entries({
    JARVOS_VAULT_DIR: cfg.vault?.root,
    JARVOS_JOURNAL_DIR: cfg.vault?.journalDir,
    JARVOS_NOTES_DIR: cfg.vault?.notesDir,
  })) {
    if (typeof value === 'string' && value.trim()) env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, args, { env, timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      try {
        const receipt = JSON.parse(stdout);
        if (typeof receipt.ok !== 'boolean' || typeof receipt.message !== 'string' || !receipt.message.trim() || /[\r\n]/.test(receipt.message)) throw new Error('Invalid capture receipt');
        resolve({ ok: !error && receipt.ok, message: receipt.message });
      } catch {
        reject(new Error('Capture failed or outcome uncertain; check the journal before retrying.'));
      }
    });
    child.stdin.on('error', () => {}); // An early child exit is reported by execFile.
    child.stdin.end(bullet);
  });
}

module.exports = { appendJournal, resolveJarvosRoot };
