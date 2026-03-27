#!/usr/bin/env node
/**
 * extract.js — CLI for scanning memory files and routing signals to ontology.
 *
 * Usage:
 *   node scripts/extract.js [options]
 *
 * Options:
 *   --date YYYY-MM-DD   Scan a specific date (default: today)
 *   --days N            Scan last N days (default: 1)
 *   --memory-dir DIR    Path to memory directory (default: ~/clawd/memory)
 *   --ontology-dir DIR  Path to ontology/ directory (default: ./ontology)
 *   --dry-run           Show what would change without writing
 *   --json              Output structured JSON
 *   -h, --help          Show help
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { extractSignals, routeSignals } from '../src/extractor.js';

const HOME = process.env.HOME || homedir();

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    date: null,
    days: 1,
    dryRun: false,
    json: false,
    help: false,
    memoryDir: join(HOME, 'clawd', 'memory'),
    ontologyDir: join(new URL('.', import.meta.url).pathname, '..', 'ontology'),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--date': opts.date = args[++i]; break;
      case '--days': opts.days = parseInt(args[++i], 10); break;
      case '--memory-dir': opts.memoryDir = args[++i]; break;
      case '--ontology-dir': opts.ontologyDir = args[++i]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
    }
  }
  return opts;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function getTargetDates(opts) {
  if (opts.date) return [opts.date];
  const dates = [];
  const now = new Date();
  for (let i = 0; i < opts.days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(toDateStr(d));
  }
  return dates;
}

function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`jarvos-ontology extract — Scan memory files for ontology signals

Usage: node scripts/extract.js [options]

Options:
  --date YYYY-MM-DD   Scan a specific date (default: today)
  --days N            Scan last N days (default: 1)
  --memory-dir DIR    Path to memory directory
  --ontology-dir DIR  Path to ontology/ directory
  --dry-run           Show changes without writing
  --json              Output JSON
  -h, --help          Show help
`);
    process.exit(0);
  }

  const dates = getTargetDates(opts);
  const allSignals = [];
  const fileResults = [];

  for (const date of dates) {
    const filePath = join(opts.memoryDir, `${date}.md`);
    if (!existsSync(filePath)) {
      fileResults.push({ date, found: false, signals: [] });
      continue;
    }

    const content = readFileSync(filePath, 'utf8');
    const isSessionLog = /\d{4}-\d{2}-\d{2}-\d{4}/.test(basename(filePath));
    const signals = extractSignals(content, { isSessionLog, date });

    fileResults.push({ date, found: true, signals });
    allSignals.push(...signals);
  }

  // Route signals to ontology
  const result = routeSignals(allSignals, opts.ontologyDir, {
    dryRun: opts.dryRun,
  });

  if (opts.json) {
    console.log(JSON.stringify({
      scanned: fileResults.map(f => ({ date: f.date, found: f.found, signalCount: f.signals.length })),
      ...result,
    }, null, 2));
    process.exit(0);
  }

  // Human-readable output
  console.log('\n📊 Ontology Extraction Report');
  console.log('─'.repeat(50));

  for (const fr of fileResults) {
    if (!fr.found) {
      console.log(`\n📁 ${fr.date}: ⚠️  no memory file found`);
    } else {
      console.log(`\n📁 ${fr.date}: ${fr.signals.length} signal(s) detected`);
    }
  }

  if (result.addedCount > 0) {
    const verb = opts.dryRun ? 'Would add' : 'Added';
    console.log(`\n✅ ${verb} ${result.addedCount} entry/entries:\n`);
    for (const sig of result.added) {
      console.log(`   [${sig.type.toUpperCase()}] → ${sig.section}`);
      const preview = sig.text.length > 120 ? sig.text.slice(0, 117) + '...' : sig.text;
      console.log(`   "${preview}"\n`);
    }
  }

  if (result.skippedCount > 0) {
    console.log(`⏭️  Skipped ${result.skippedCount} (already in ontology):\n`);
    for (const sig of result.skipped) {
      const preview = sig.text.length > 100 ? sig.text.slice(0, 97) + '...' : sig.text;
      console.log(`   [${sig.type}] "${preview}"`);
    }
  }

  if (result.addedCount === 0 && result.skippedCount === 0) {
    console.log('\n✅ No new signals to add.');
  }

  if (!opts.dryRun && result.addedCount > 0) {
    console.log(`\n💾 Ontology updated with ${result.addedCount} new entry/entries.`);
  }
}

main();
