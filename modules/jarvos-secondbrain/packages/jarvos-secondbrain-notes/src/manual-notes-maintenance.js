#!/usr/bin/env node
/**
 * Backfill/watch bridge for markdown notes created outside the canonical writer.
 *
 * Dry-run mode audits what would change. Apply mode can normalize fixable
 * frontmatter and writes lossless knowledge sidecars/queues through the shared
 * optimizer.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getVaultNotesDir } = require('./lib/notes-config');
const {
  buildArtifact,
  defaultKnowledgeDir,
  optimizeNoteKnowledge,
  sourcePathFor,
} = require('./knowledge-optimizer');
const {
  defaultFields,
  findProjectNames,
  frontmatterToObject,
  parseFrontmatter,
  validateOneFile,
  walkMarkdownFiles,
} = require('./lint-frontmatter');

const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_LIMIT = 0;
const DEFAULT_MAX_RUNS = 0;

function usage() {
  return `manual-notes-maintenance

Usage:
  node scripts/manual-notes-maintenance.js [options]

Options:
  --apply                       Write fixable frontmatter changes and optimizer artifacts.
  --dry-run                     Audit only. This is the default unless --apply is set.
  --notes-dir <path>            Notes directory. Default: configured vault Notes path.
  --knowledge-dir <path>        .jarvos knowledge artifact directory.
  --state <path>                Watch/backfill state path.
  --since-state                 Process files missing audit coverage or changed since prior state.
  --update-state                Update state even in dry-run mode.
  --limit <count>               Limit candidate files processed. Default: unlimited.
  --path <relative-or-absolute> Process one note path.
  --json                        Emit JSON only.
  --watch                       Poll repeatedly. Use with --since-state for maintenance.
  --interval-sec <seconds>      Watch polling interval. Default: ${DEFAULT_INTERVAL_SECONDS}.
  --max-runs <count>            Stop watch after N runs. Default: unlimited.
  --help                        Show this help.

Safe defaults:
  - Does not write anything unless --apply is present.
  - Sensitive/private notes still get local artifacts but are removed from
    automatic GBrain and memory-wiki queues by the shared optimizer.
  - QMD freshness is tracked by qmd-refresh-pending.json; run qmd update/embed
    after apply mode before treating search as fresh.
`;
}

function requiredValue(args, index, flag) {
  if (!args[index] || args[index].startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return args[index];
}

function positiveInteger(value, flag, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} requires ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return number;
}

function parseArgs(argv) {
  const flags = {
    apply: false,
    dryRun: null,
    notesDir: getVaultNotesDir(),
    knowledgeDir: null,
    statePath: null,
    sinceState: false,
    updateState: false,
    limit: DEFAULT_LIMIT,
    onlyPath: null,
    json: false,
    watch: false,
    intervalSec: DEFAULT_INTERVAL_SECONDS,
    maxRuns: DEFAULT_MAX_RUNS,
    help: false,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--apply') flags.apply = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--notes-dir') flags.notesDir = requiredValue(args, ++i, arg);
    else if (arg === '--knowledge-dir') flags.knowledgeDir = requiredValue(args, ++i, arg);
    else if (arg === '--state') flags.statePath = requiredValue(args, ++i, arg);
    else if (arg === '--since-state') flags.sinceState = true;
    else if (arg === '--update-state') flags.updateState = true;
    else if (arg === '--limit') flags.limit = positiveInteger(requiredValue(args, ++i, arg), arg, { allowZero: true });
    else if (arg === '--path') flags.onlyPath = requiredValue(args, ++i, arg);
    else if (arg === '--json') flags.json = true;
    else if (arg === '--watch') flags.watch = true;
    else if (arg === '--interval-sec') flags.intervalSec = positiveInteger(requiredValue(args, ++i, arg), arg);
    else if (arg === '--max-runs') flags.maxRuns = positiveInteger(requiredValue(args, ++i, arg), arg, { allowZero: true });
    else throw new Error(`Unknown argument: ${arg}`);
  }

  flags.notesDir = path.resolve(flags.notesDir);
  flags.knowledgeDir = path.resolve(flags.knowledgeDir || defaultKnowledgeDir(flags.notesDir));
  flags.statePath = path.resolve(flags.statePath || path.join(flags.knowledgeDir, 'manual-notes-maintenance-state.json'));
  flags.dryRun = flags.dryRun === null ? !flags.apply : flags.dryRun;
  if (flags.apply && flags.dryRun) throw new Error('--apply and --dry-run cannot be used together');
  return flags;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function titleFor(filePath, body) {
  const h1 = String(body || '').match(/^#\s+(.+)$/m);
  return (h1?.[1] || path.basename(filePath, '.md')).trim();
}

function readNote(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(content);
  const frontmatter = frontmatterToObject(parsed);
  const body = parsed ? parsed.remainder : content;
  return {
    content,
    parsed,
    frontmatter,
    body,
    title: titleFor(filePath, body),
    contentSha256: sha256(content),
    bodySha256: sha256(body),
  };
}

function loadAudit(knowledgeDir) {
  return readJson(path.join(knowledgeDir, 'optimization-audit.json'), { entries: {} });
}

function loadState(statePath) {
  const state = readJson(statePath, { version: 1, files: {} });
  state.version = state.version || 1;
  state.files = state.files && typeof state.files === 'object' ? state.files : {};
  return state;
}

function auditCoversNote(auditEntry, note) {
  return Boolean(auditEntry && auditEntry.bodyHash === note.bodySha256);
}

function stateCoversNote(previous, note) {
  if (!previous) return false;
  if (previous.contentSha256) return previous.contentSha256 === note.contentSha256;
  return previous.bodySha256 === note.bodySha256;
}

function shouldProcessFile({ flags, note, sourcePath, state, auditEntry, frontmatterViolations }) {
  if (!flags.sinceState) return true;
  const previous = state.files[sourcePath];
  if (!auditCoversNote(auditEntry, note)) return true;
  if (frontmatterViolations.length > 0) return true;
  return !stateCoversNote(previous, note);
}

function fileList(flags) {
  if (flags.onlyPath) {
    const candidate = path.isAbsolute(flags.onlyPath)
      ? flags.onlyPath
      : path.join(flags.notesDir, flags.onlyPath);
    return [path.resolve(candidate)];
  }
  return walkMarkdownFiles(flags.notesDir);
}

function makeRunReport(flags) {
  return {
    ok: true,
    dryRun: flags.dryRun,
    applied: flags.apply,
    notesDir: flags.notesDir,
    knowledgeDir: flags.knowledgeDir,
    statePath: flags.statePath,
    sinceState: flags.sinceState,
    scanned: 0,
    candidates: 0,
    skippedUnchanged: 0,
    frontmatter: {
      filesWithViolations: 0,
      violations: 0,
      filesChanged: 0,
      fieldUpdates: 0,
      filesSkippedUnfixable: 0,
    },
    optimization: {
      artifactsWritten: 0,
      gbrainQueued: 0,
      memoryWikiQueued: 0,
      qmdPending: 0,
      sensitiveSkipped: 0,
      auditOnly: 0,
    },
    errors: [],
    files: [],
    next: flags.apply
      ? [
        'Run qmd update and qmd embed before treating QMD search as fresh.',
        'Review .jarvos/knowledge queues before importing into GBrain or memory-wiki.',
        'Use --dry-run for audits and --apply only for intentional backfill/maintenance writes.',
      ]
      : [
        'Run with --apply to write audited changes.',
        'Use --watch --since-state for ongoing manual-note maintenance.',
        'Use --dry-run for audits and --apply only for intentional backfill/maintenance writes.',
      ],
  };
}

function processOnce(flags) {
  if (!fs.existsSync(flags.notesDir) || !fs.statSync(flags.notesDir).isDirectory()) {
    throw new Error(`Notes directory does not exist or is not a directory: ${flags.notesDir}`);
  }

  const files = fileList(flags);
  const projectNames = findProjectNames(files);
  const audit = loadAudit(flags.knowledgeDir);
  const state = loadState(flags.statePath);
  const nextState = {
    ...state,
    version: 1,
    updatedAt: new Date().toISOString(),
    files: { ...state.files },
  };
  const report = makeRunReport(flags);

  for (const filePath of files) {
    if (flags.limit > 0 && report.candidates >= flags.limit) break;
    report.scanned += 1;

    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`note path does not exist or is not a file: ${filePath}`);
      }

      const stat = fs.statSync(filePath);
      const note = readNote(filePath);
      const sourcePath = sourcePathFor(filePath, flags.notesDir);
      const defaults = defaultFields(filePath, note.content, projectNames, stat);
      const frontmatterDryRun = validateOneFile(filePath, note.content, defaults, { fix: false });
      const frontmatterFix = validateOneFile(filePath, note.content, defaults, { fix: true });
      const auditEntry = audit.entries?.[sourcePath] || null;
      const processFile = shouldProcessFile({
        flags,
        note,
        sourcePath,
        state,
        auditEntry,
        frontmatterViolations: frontmatterDryRun.violations,
      });

      if (!processFile) {
        report.skippedUnchanged += 1;
        continue;
      }

      report.candidates += 1;
      const fileResult = {
        sourcePath,
        title: note.title,
        contentSha256: note.contentSha256,
        bodySha256: note.bodySha256,
        auditCovered: auditCoversNote(auditEntry, note),
        frontmatterViolations: frontmatterDryRun.violations.map((violation) => ({
          field: violation.field,
          current: violation.current,
          expected: violation.expected,
          fixable: violation.fixable,
        })),
        frontmatterChanged: false,
        frontmatterEligible: false,
        frontmatterSkippedReason: null,
        optimized: false,
        sensitivity: null,
        stack: null,
      };

      if (frontmatterDryRun.violations.length > 0) {
        report.frontmatter.filesWithViolations += 1;
        report.frontmatter.violations += frontmatterDryRun.violations.length;
      }

      let frontmatterForOptimization = note.frontmatter;
      let bodyForOptimization = note.body;
      let contentShaForState = note.contentSha256;
      let bodyShaForState = note.bodySha256;
      let stateStat = stat;
      let currentFrontmatterViolationCount = frontmatterDryRun.violations.length;
      const unfixableFrontmatter = frontmatterDryRun.violations.some((violation) => !violation.fixable);
      fileResult.frontmatterEligible = frontmatterFix.changed && !unfixableFrontmatter;

      if (flags.apply && frontmatterFix.changed && !unfixableFrontmatter) {
        fs.writeFileSync(filePath, frontmatterFix.updatedText, 'utf8');
        const updatedNote = readNote(filePath);
        frontmatterForOptimization = updatedNote.frontmatter;
        bodyForOptimization = updatedNote.body;
        contentShaForState = updatedNote.contentSha256;
        bodyShaForState = updatedNote.bodySha256;
        stateStat = fs.statSync(filePath);
        fileResult.frontmatterChanged = true;
        currentFrontmatterViolationCount = 0;
        report.frontmatter.filesChanged += 1;
        report.frontmatter.fieldUpdates += frontmatterFix.fixedCount;
      } else if (flags.apply && frontmatterFix.changed && unfixableFrontmatter) {
        fileResult.frontmatterSkippedReason = 'unfixable frontmatter violation present; apply mode avoids partial normalization';
        report.frontmatter.filesSkippedUnfixable += 1;
      }

      if (flags.apply) {
        const optimized = optimizeNoteKnowledge({
          filePath,
          notesDir: flags.notesDir,
          knowledgeDir: flags.knowledgeDir,
          title: note.title,
          body: bodyForOptimization,
          frontmatter: frontmatterForOptimization,
          created: !auditEntry,
          journal: null,
        });
        fileResult.optimized = optimized.optimized;
        fileResult.artifactPath = optimized.artifactPath;
        fileResult.stack = optimized.stack;
        fileResult.sensitivity = {
          excluded: optimized.excluded,
          reasons: optimized.skippedReasons || [],
        };
        report.optimization.artifactsWritten += optimized.optimized ? 1 : 0;
        report.optimization.gbrainQueued += optimized.gbrainQueued ? 1 : 0;
        report.optimization.memoryWikiQueued += optimized.memoryWikiQueued ? 1 : 0;
        report.optimization.qmdPending += optimized.qmdStatus === 'pending-refresh' ? 1 : 0;
        report.optimization.sensitiveSkipped += optimized.excluded ? 1 : 0;
      } else {
        const artifact = buildArtifact({
          filePath,
          notesDir: flags.notesDir,
          title: note.title,
          body: bodyForOptimization,
          frontmatter: frontmatterForOptimization,
          created: !auditEntry,
          journal: null,
        });
        fileResult.stack = artifact.stack;
        fileResult.sensitivity = artifact.sensitivity;
        if (!auditCoversNote(auditEntry, note)) report.optimization.auditOnly += 1;
        report.optimization.gbrainQueued += artifact.gbrain.status === 'queued' ? 1 : 0;
        report.optimization.memoryWikiQueued += artifact.memoryWiki.status === 'queued' ? 1 : 0;
        report.optimization.qmdPending += artifact.qmd.status === 'pending-refresh' ? 1 : 0;
        report.optimization.sensitiveSkipped += artifact.sensitivity.excluded ? 1 : 0;
      }

      if (flags.apply || flags.updateState) {
        nextState.files[sourcePath] = {
          sourcePath,
          contentSha256: contentShaForState,
          bodySha256: bodyShaForState,
          mtimeMs: stateStat.mtimeMs,
          checkedAt: nextState.updatedAt,
          auditCovered: flags.apply ? true : auditCoversNote(auditEntry, note),
          frontmatterViolations: currentFrontmatterViolationCount,
        };
      }

      report.files.push(fileResult);
    } catch (error) {
      report.ok = false;
      report.errors.push({ file: filePath, error: error.message || String(error) });
    }
  }

  if (flags.apply || flags.updateState) {
    writeJson(flags.statePath, nextState);
  }

  return report;
}

function summarizeHuman(report) {
  const action = report.dryRun ? 'DRY RUN' : 'APPLY';
  const status = report.ok ? 'OK' : 'FAIL';
  const lines = [
    `manual-notes-maintenance ${status} (${action})`,
    `Scanned ${report.scanned} note(s); candidates ${report.candidates}; unchanged skipped ${report.skippedUnchanged}.`,
    `Frontmatter: ${report.frontmatter.filesWithViolations} file(s), ${report.frontmatter.violations} violation(s), ${report.frontmatter.filesChanged} file(s) changed, ${report.frontmatter.filesSkippedUnfixable} skipped as unfixable.`,
    `Optimization: artifacts=${report.optimization.artifactsWritten}, auditOnly=${report.optimization.auditOnly}, gbrainQueued=${report.optimization.gbrainQueued}, memoryWikiQueued=${report.optimization.memoryWikiQueued}, qmdPending=${report.optimization.qmdPending}, sensitiveSkipped=${report.optimization.sensitiveSkipped}.`,
  ];
  if (report.errors.length) {
    lines.push('Errors:');
    for (const error of report.errors.slice(0, 10)) lines.push(`- ${error.file}: ${error.error}`);
  }
  if (report.candidates > 0) {
    lines.push('Sample:');
    for (const item of report.files.slice(0, 8)) {
      const parts = [];
      if (!item.auditCovered) parts.push('audit-missing');
      if (item.frontmatterViolations.length) parts.push(`${item.frontmatterViolations.length} frontmatter`);
      if (item.sensitivity?.excluded) parts.push('sensitive-skip');
      lines.push(`- ${item.sourcePath}: ${parts.join(', ') || 'optimized'}`);
    }
  }
  lines.push(...report.next.map((item) => `Next: ${item}`));
  return `${lines.join('\n')}\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWatch(flags) {
  const reports = [];
  let run = 0;
  while (true) {
    run += 1;
    const report = processOnce(flags);
    report.watchRun = run;
    reports.push(report);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(summarizeHuman(report));
    }
    if (flags.maxRuns > 0 && run >= flags.maxRuns) break;
    await sleep(flags.intervalSec * 1000);
  }
  return reports;
}

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv);
    if (flags.help) {
      process.stdout.write(usage());
      return;
    }
    if (flags.watch) {
      const reports = await runWatch(flags);
      process.exitCode = reports.every((report) => report.ok) ? 0 : 1;
      return;
    }
    const report = processOnce(flags);
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else process.stdout.write(summarizeHuman(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message = error.message || String(error);
    if (flags?.json) console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(`manual-notes-maintenance error: ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseArgs,
  processOnce,
  readNote,
  auditCoversNote,
  stateCoversNote,
  shouldProcessFile,
  summarizeHuman,
};
