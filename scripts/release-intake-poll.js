#!/usr/bin/env node
'use strict';

/**
 * release-intake-poll.js — "Paperclip routine polling merged PRs" (SUP-3499).
 *
 * The other half of scripts/release-intake-gate.js's design-doc comment:
 * option B from the SUP-3499 scope ("a Paperclip routine polling merged
 * PRs") rather than option A (a public GitHub Action). This is the piece
 * that actually needs live Paperclip API credentials, which a jarvOS/
 * Paperclip agent runtime already has via the same PAPERCLIP_API_URL /
 * PAPERCLIP_API_KEY convention used by modules/jarvos-secondbrain/bridge/
 * paperclip — it is NOT wired into public GitHub Actions (see
 * release-intake-gate.js's file comment for why).
 *
 * Lists recently-merged levineam/jarvOS PRs via the `gh` CLI (covers both
 * direct PRs and clawd-mirror-promoted PRs uniformly — gh does not
 * distinguish the two, so neither path is special-cased), extracts any
 * SUP-#### reference from each PR's title/body, and evaluates the same
 * release-intake gate used pre-merge. Read-only by default: it reports gaps
 * to stdout/stderr and exits non-zero if any are found. Pass --comment to
 * additionally post a Paperclip comment on each gapped issue (opt-in, since
 * posting is a mutating, visible action).
 *
 * Usage:
 *   node scripts/release-intake-poll.js [--limit N] [--comment]
 *
 * Exit codes: 0 = no gaps found; 1 = gap(s) found; 2 = usage/IO error.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'levineam/jarvOS';

const {
  extractTicketIds,
  resolveReleaseFit,
  evaluateReleaseIntakeGate,
} = require('./release-intake-gate');
const { resolvePaperclipAuth, getIssue, paperclipGet, addComment } = require(
  path.join(ROOT, 'modules/jarvos-secondbrain/bridge/paperclip/client.js')
);
const { releaseFitFromPaperclipReleaseIntake } = require(
  path.join(ROOT, 'modules/jarvos-coding/src/adapters/paperclip.js')
);

function parseArgs(argv) {
  const args = { limit: 30, comment: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]) || args.limit;
    if (argv[i] === '--comment') args.comment = true;
  }
  return args;
}

function listMergedPRs(limit) {
  const r = spawnSync(
    'gh',
    ['pr', 'list', '--repo', REPO, '--state', 'merged', '--limit', String(limit), '--json', 'number,title,body,mergedAt'],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  if (r.error) throw new Error(`gh pr list failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh pr list exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout || '[]');
}

async function evaluatePR(pr, auth) {
  const ticketIds = extractTicketIds(pr.title, pr.body);
  const releaseFitByTicket = {};
  for (const ticketId of ticketIds) {
    try {
      const fit = await resolveReleaseFit(ticketId, auth, { getIssue, paperclipGet });
      releaseFitByTicket[ticketId] = releaseFitFromPaperclipReleaseIntake(fit);
    } catch (error) {
      releaseFitByTicket[ticketId] = releaseFitFromPaperclipReleaseIntake({ classification: 'unknown' });
      releaseFitByTicket[ticketId].fetchError = error.message;
    }
  }
  const result = evaluateReleaseIntakeGate({ ticketIds, releaseFitByTicket, checkDisposition: true });
  return { pr, ticketIds, result };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const auth = resolvePaperclipAuth();
  if (!auth.hasApiUrl || !auth.hasApiKey) {
    console.error(
      '[release-intake-poll] Paperclip credentials not configured (PAPERCLIP_API_URL/PAPERCLIP_API_KEY) — ' +
        'this routine requires live Paperclip access and cannot run structural-only.'
    );
    process.exit(2);
  }

  const prs = listMergedPRs(args.limit);
  console.log(`[release-intake-poll] checked ${prs.length} merged PR(s) against ${REPO}`);

  const gaps = [];
  for (const pr of prs) {
    const evaluated = await evaluatePR(pr, auth);
    if (!evaluated.result.ok) gaps.push(evaluated);
  }

  if (gaps.length === 0) {
    console.log('[release-intake-poll] OK — no undisposed merged PRs found');
    return;
  }

  console.error(`[release-intake-poll] FAIL — ${gaps.length} merged PR(s) lack a full release-intake disposition:`);
  for (const gap of gaps) {
    console.error(`  #${gap.pr.number} "${gap.pr.title}" (merged ${gap.pr.mergedAt})`);
    for (const reason of gap.result.reasons) console.error(`    - ${reason}`);

    if (args.comment) {
      for (const ticketId of gap.ticketIds) {
        try {
          await addComment(
            ticketId,
            `release-intake-poll: merged PR #${gap.pr.number} ("${gap.pr.title}") references this issue but it has no ` +
              'explicit release/future/internal-only disposition recorded. Per docs/release-process.md ' +
              '"Paperclip Intake", record a release-intake document with an explicit Classification.',
            auth
          );
        } catch (error) {
          console.error(`    (failed to post follow-up comment on ${ticketId}: ${error.message})`);
        }
      }
    }
  }
  process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[release-intake-poll] ${error.message}`);
    process.exit(2);
  });
}

module.exports = { listMergedPRs, evaluatePR, parseArgs };
