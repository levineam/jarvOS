#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveConfig, resolveJournalConfig } = require('../bridge/config');
const { headingsForSection } = require('../packages/jarvos-secondbrain-journal/src/section-config');
const { hashUtf8, validateVaultRelativeMarkdownPath } = require('../adapters/obsidian/src/vault-mutation-contract');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

const BUNDLE_SCHEMA = 'jarvos-journal-heading-preimage/v1';
const DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;

function renameJournalHeading(content) {
  const headings = headingsForSection('journal-entry');
  const lines = content.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
  let canonical = false;
  let fence = null;
  let frontmatter = lines[0]?.trimEnd() === '---';
  const changes = [];
  lines.forEach((line, index) => {
    if (frontmatter) {
      if (index > 0 && line.trimEnd() === '---') frontmatter = false;
      return;
    }
    const delimiter = line.trimEnd().match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      return;
    }
    if (delimiter) { fence = delimiter[1]; return; }
    if (line.trimEnd() === headings[0]) canonical = true;
    if (headings.slice(1).includes(line.trimEnd())) changes.push({ line: index + 1, before: line, after: line.replace(line.trimEnd(), headings[0]) });
  });
  if (canonical && changes.length) return { status: 'skipped', reason: 'canonical and legacy headings coexist', changes: [], nextContent: content };
  // Multiple legacy sections need a separate content decision, never an implicit merge.
  if (changes.length > 1) return { status: 'skipped', reason: 'multiple legacy headings', changes: [], nextContent: content };
  const next = [...lines];
  for (const change of changes) next[change.line - 1] = change.after;
  return { status: changes.length ? 'change' : canonical ? 'canonical' : 'skipped', reason: 'no Journal heading', changes, nextContent: next.join('') };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function externalPreimage(vaultRoot, filename) {
  const resolved = path.resolve(filename);
  const physical = fs.existsSync(resolved) ? fs.realpathSync(resolved) : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  if (inside(vaultRoot, resolved) || inside(vaultRoot, physical)) throw new Error('Preimage must be outside the vault');
  return physical;
}

function readText(filename) {
  const bytes = fs.readFileSync(filename);
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text, 'utf8'))) throw new Error('Invalid UTF-8 content');
  return text;
}

function run({ vaultRoot, journalDir, mode = '--dry-run', preimagePath } = {}, { createService = createConfiguredVaultMutationService } = {}) {
  if (!['--dry-run', '--apply', '--restore'].includes(mode)) throw new Error('Invalid mode');
  const configured = !vaultRoot || !journalDir ? resolveConfig().paths : {};
  if (!journalDir) {
    configured.journal = vaultRoot ? path.join(vaultRoot, 'Journal') : resolveJournalConfig().journalDir;
  }
  const root = fs.realpathSync(vaultRoot || configured.vault);
  const directory = fs.realpathSync(journalDir ? path.resolve(root, journalDir) : configured.journal);
  if (!inside(root, directory)) throw new Error('Journal directory must be inside the vault');
  const filePath = (journalPath) => {
    validateVaultRelativeMarkdownPath(journalPath);
    const target = path.resolve(root, journalPath);
    if (path.dirname(target) !== directory || !DAILY_FILE.test(path.basename(target))) throw new Error('Invalid daily journal path');
    if (fs.existsSync(target) && !inside(root, fs.realpathSync(target))) throw new Error('Invalid daily journal path');
    return target;
  };
  if (mode !== '--dry-run' && !preimagePath) throw new Error(`${mode} requires --preimage`);
  const backup = mode === '--dry-run' ? null : externalPreimage(root, preimagePath);
  const output = [];
  let files;
  // Each apply is its own run; its id lives in the backup so a restore (or a
  // retried restore) uses the same identity, while a later apply gets a new one.
  let runId = mode === '--apply' ? crypto.randomUUID() : null;
  let skipped = 0;
  let canonical = 0;
  if (mode === '--restore') {
    const bundle = JSON.parse(readText(backup));
    if (bundle.schema !== BUNDLE_SCHEMA || bundle.vaultRoot !== root || !Array.isArray(bundle.files)
      || typeof bundle.runId !== 'string' || !bundle.runId) throw new Error('Invalid preimage bundle');
    runId = bundle.runId;
    const seen = new Set();
    files = bundle.files.map((file) => {
      if (typeof file.content !== 'string' || file.hash !== hashUtf8(file.content) || seen.has(file.journalPath)) throw new Error('Invalid preimage content');
      seen.add(file.journalPath);
      const plan = renameJournalHeading(file.content);
      if (plan.status !== 'change' || file.writtenHash !== hashUtf8(plan.nextContent)) throw new Error('Invalid preimage written hash');
      return { ...file, target: filePath(file.journalPath), expectedContent: plan.nextContent, nextContent: file.content };
    });
  } else {
    files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !DAILY_FILE.test(entry.name)) continue;
      const journalPath = path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/');
      const target = filePath(journalPath);
      const content = readText(target);
      const plan = renameJournalHeading(content);
      if (plan.status === 'canonical') { canonical += 1; output.push(`${journalPath}: already canonical`); continue; }
      if (plan.status === 'skipped') { skipped += 1; output.push(`${journalPath}: skipped (${plan.reason})`); continue; }
      for (const change of plan.changes) output.push(`${journalPath}:${change.line}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
      files.push({ journalPath, target, content, hash: hashUtf8(content), writtenHash: hashUtf8(plan.nextContent), expectedContent: content, nextContent: plan.nextContent });
    }
    if (mode === '--apply' && files.length) {
      const bundle = { schema: BUNDLE_SCHEMA, vaultRoot: root, runId, files: files.map(({ journalPath, content, hash, writtenHash }) => ({ journalPath, content, hash, writtenHash })) };
      const fd = fs.openSync(backup, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(bundle, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
  }
  let changed = 0;
  if (mode !== '--dry-run' && files.length) {
    const service = createService({ vaultRoot: root, source: 'journal.rename-journal-heading' });
    for (const file of files) {
      if (!fs.existsSync(file.target) || !fs.readFileSync(file.target).equals(Buffer.from(file.expectedContent, 'utf8'))) {
        skipped += 1;
        output.push(`${file.journalPath}: skipped (changed since ${mode === '--restore' ? 'rename; restore refused' : 'read; mutation refused'})`);
        continue;
      }
      const intentId = `journal-heading-${hashUtf8(JSON.stringify([runId, file.journalPath, mode, hashUtf8(file.expectedContent), hashUtf8(file.nextContent)]))}`;
      const receipt = service.applyMarkdownMutation({ vaultRelativePath: file.journalPath, expectedContent: file.expectedContent, nextContent: file.nextContent, intentId });
      if (!['committed', 'already_satisfied'].includes(receipt.status) || receipt.obsidian !== 'acknowledged') throw new Error('Mutation was not acknowledged');
      if (readText(file.target) !== file.nextContent) throw new Error('Journal readback does not match');
      changed += 1;
      output.push(`Acknowledged ${mode === '--restore' ? 'restore' : 'rename'}: ${file.journalPath}`);
    }
  }
  output.push(`Files to change: ${files.length}; skipped: ${skipped}; already canonical: ${canonical}; ${mode === '--restore' ? 'restored' : 'changed'}: ${changed}`);
  return { count: files.length, changed, skipped, canonical, output: output.join('\n') + '\n' };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (['--dry-run', '--apply', '--restore'].includes(flag)) {
      if (options.mode) throw new Error('Choose one mode');
      options.mode = flag;
      continue;
    }
    const key = { '--vault': 'vaultRoot', '--journal': 'journalDir', '--preimage': 'preimagePath' }[flag];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Invalid arguments');
    if (options[key]) throw new Error('Duplicate argument');
    options[key] = argv[++index];
  }
  return options;
}

module.exports = { parseArgs, renameJournalHeading, run };
if (require.main === module) {
  try { process.stdout.write(run(parseArgs(process.argv.slice(2))).output); }
  catch (error) { process.stderr.write(`${error.code ? 'File access failed' : error.message}\n`); process.exitCode = 1; }
}
