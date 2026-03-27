#!/usr/bin/env node

/**
 * sync-to-paperclip.js — Push ontology Goals/Projects → Paperclip.
 *
 * Usage:
 *   node scripts/sync-to-paperclip.js              # live sync
 *   node scripts/sync-to-paperclip.js --dry-run     # plan only, no writes
 *   node scripts/sync-to-paperclip.js --verbose      # detailed output
 *
 * Environment (or source paperclip-env.sh):
 *   PAPERCLIP_API_URL       — e.g. http://127.0.0.1:3100
 *   PAPERCLIP_API_KEY       — API key with goal/project write access
 *   PAPERCLIP_COMPANY_ID    — company UUID
 *
 * Bridge-state.json is stored in the jarvos-ontology root (gitignored).
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { syncOntologyToPaperclip, loadBridgeState } from '../src/bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

// ─── Config ────────────────────────────────────────────────────────────────

const paperclipUrl = process.env.PAPERCLIP_API_URL;
const paperclipApiKey = process.env.PAPERCLIP_API_KEY;
const companyId = process.env.PAPERCLIP_COMPANY_ID;

if (!paperclipUrl || !paperclipApiKey || !companyId) {
  console.error('Missing env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID');
  console.error('Hint: set these environment variables before running this script');
  process.exit(1);
}

// Auto-detect company goal (first company-level goal)
async function getCompanyGoalId() {
  const res = await fetch(`${paperclipUrl}/api/companies/${companyId}/goals`, {
    headers: { 'Authorization': `Bearer ${paperclipApiKey}` },
  });
  if (!res.ok) return null;
  const goals = await res.json();
  const companyGoal = goals.find(g => g.level === 'company' && g.status === 'active');
  return companyGoal?.id || null;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🔄 Ontology → Paperclip sync${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`   Ontology: ${resolve(ROOT, 'ontology')}`);
  console.log(`   Paperclip: ${paperclipUrl}`);
  console.log('');

  const companyGoalId = await getCompanyGoalId();
  if (verbose) {
    console.log(`   Company goal: ${companyGoalId || '(none detected)'}`);
  }

  const result = await syncOntologyToPaperclip({
    ontologyDir: resolve(ROOT, 'ontology'),
    stateDir: ROOT,
    paperclipUrl,
    paperclipApiKey,
    companyId,
    companyGoalId,
    dryRun,
  });

  // ── Report goals ──

  console.log('── Goals ──');
  for (const g of result.goals) {
    const icon =
      g.action === 'create' ? '➕' :
      g.action === 'update' ? '✏️' :
      g.action === 'adopt' ? '🔗' :
      g.action === 'error' ? '❌' : '⏭️';
    const executed = g.executed ? '' : ' (skipped)';
    console.log(`  ${icon} ${g.ontologyId}: ${g.reason}${executed}`);
    if (verbose && g.updates) {
      console.log(`     updates: ${JSON.stringify(g.updates)}`);
    }
    if (g.error) {
      console.log(`     error: ${g.error}`);
    }
  }

  // ── Report projects ──

  console.log('');
  console.log('── Projects ──');
  for (const p of result.projects) {
    const icon =
      p.action === 'update-goals' ? '🔗' :
      p.action === 'error' ? '❌' : '⏭️';
    const executed = p.executed ? '' : ' (not executed)';
    console.log(`  ${icon} ${p.ontologyId}: ${p.reason}${executed}`);
    if (verbose && p.goalIds) {
      console.log(`     goalIds: ${JSON.stringify(p.goalIds)}`);
    }
    if (p.error) {
      console.log(`     error: ${p.error}`);
    }
  }

  // ── Summary ──

  console.log('');
  const ev = result.syncEvent;
  console.log(`✅ Sync complete: ${ev.goalsExecuted}/${ev.goalsPlanned} goals, ${ev.projectsExecuted}/${ev.projectsPlanned} projects`);
  if (ev.errors.length > 0) {
    console.log(`⚠️  ${ev.errors.length} error(s) — see above`);
  }

  if (verbose) {
    console.log('');
    console.log('── Bridge state ──');
    console.log(`  Goal map: ${JSON.stringify(result.state.goalMap, null, 2)}`);
    console.log(`  Project map: ${JSON.stringify(result.state.projectMap, null, 2)}`);
    console.log(`  Last sync: ${result.state.lastSyncAt}`);
  }

  // Exit with error code if there were failures
  if (ev.errors.length > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(2);
});
