#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashUtf8, validateVaultRelativeMarkdownPath } = require('../adapters/obsidian/src/vault-mutation-contract');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

function removeIdeasOriginMarkers(content) {
  const lines = content.match(/[^\n]*(?:\n|$)/g).filter(Boolean);
  let inIdeas = false;
  const removed = new Set();
  const kept = lines.filter((line, index) => {
    if (/^##\s/.test(line)) inIdeas = line.trim() === '## 💡 Ideas';
    if (!inIdeas || !/^[ \t]*<!--\s*jarvos-content-origin\/v1\s+(?:(?!-->)[^\r\n])*-->[ \t]*(?:\r?\n)?$/.test(line)) return true;
    removed.add(index);
    return false;
  });
  return { nextContent: kept.join(''), count: removed.size, lines, removed };
}

function plannedDiff(journalPath, plan) {
  if (!plan.count) return '';
  const render = (line, prefix) => prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
  return `--- a/${journalPath}\n+++ b/${journalPath}\n@@ -1,${plan.lines.length} +1,${plan.lines.length - plan.count} @@\n`
    + plan.lines.map((line, index) => render(line, plan.removed.has(index) ? '-' : ' ')).join('');
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

function run({ vaultRoot, journalPath, mode = '--dry-run', preimagePath, restorePath } = {}, { createService = createConfiguredVaultMutationService } = {}) {
  if (!vaultRoot || !journalPath) throw new Error('--vault and --journal are required');
  if (!['--dry-run', '--apply', '--restore'].includes(mode)) throw new Error('Invalid mode');
  validateVaultRelativeMarkdownPath(journalPath);
  const root = fs.realpathSync(vaultRoot);
  const filePath = path.join(root, journalPath);
  if (!inside(root, fs.realpathSync(filePath))) throw new Error('Journal must be inside the vault');
  const expectedContent = readText(filePath);
  const plan = removeIdeasOriginMarkers(expectedContent);
  if (mode === '--dry-run') return { count: plan.count, output: plannedDiff(journalPath, plan) + `Markers to remove: ${plan.count}\n` };

  let nextContent = plan.nextContent;
  if (mode === '--restore') {
    if (!restorePath) throw new Error('--restore requires a preimage file');
    nextContent = readText(externalPreimage(root, restorePath));
    if (expectedContent !== removeIdeasOriginMarkers(nextContent).nextContent) throw new Error('Journal changed since cleanup; restore refused');
  } else {
    if (!preimagePath) throw new Error('--apply requires --preimage');
    const backup = externalPreimage(root, preimagePath);
    const fd = fs.openSync(backup, 'wx', 0o600);
    try { fs.writeFileSync(fd, expectedContent, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }

  const service = createService({ vaultRoot: root, source: 'journal.remove-ideas-origin-markers' });
  if (readText(filePath) !== expectedContent) throw new Error('Journal changed since read; mutation refused');
  const intentId = `ideas-markers-${hashUtf8(JSON.stringify([journalPath, mode, hashUtf8(expectedContent), hashUtf8(nextContent)]))}`;
  const receipt = service.applyMarkdownMutation({ vaultRelativePath: journalPath, expectedContent, nextContent, intentId });
  if (!['committed', 'already_satisfied'].includes(receipt.status) || receipt.obsidian !== 'acknowledged') throw new Error('Mutation was not acknowledged');
  if (readText(filePath) !== nextContent) throw new Error('Journal readback does not match');
  return { count: plan.count, receipt, output: `Acknowledged readback: ${journalPath}\nSHA256: ${hashUtf8(nextContent)}\n${mode === '--restore' ? 'Preimage restored' : `Markers removed: ${plan.count}`}\n` };
}

function parseArgs(argv) {
  const options = {};
  let selected = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (['--dry-run', '--apply', '--restore'].includes(flag)) {
      if (selected) throw new Error('Choose one mode');
      selected = true;
      options.mode = flag;
      if (flag !== '--restore') continue;
    }
    const key = { '--vault': 'vaultRoot', '--journal': 'journalPath', '--preimage': 'preimagePath', '--restore': 'restorePath' }[flag];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Invalid arguments');
    if (options[key]) throw new Error('Duplicate argument');
    options[key] = argv[++index];
  }
  if (options.restorePath && options.preimagePath) throw new Error('Restore does not take --preimage');
  return options;
}

module.exports = { parseArgs, plannedDiff, removeIdeasOriginMarkers, run };
if (require.main === module) {
  try { process.stdout.write(run(parseArgs(process.argv.slice(2))).output); }
  catch (error) { process.stderr.write(`${error.code ? 'File access failed' : error.message}\n`); process.exitCode = 1; }
}
