#!/usr/bin/env node
'use strict';

/**
 * release-intake-gate.js — merge-time release-intake gate (SUP-3499).
 *
 * Follow-up to SUP-3496/SUP-3493: PR #107 and PR #108 were opened directly
 * against levineam/jarvOS, merged, and never auto-classified into a release
 * lane, requiring manual backfill (SUP-3496/SUP-3497). Both PRs *did* carry a
 * SUP-#### reference in their commit subjects — the gap was not "no linked
 * issue", it was "linked issue never got an explicit release/future/
 * internal-only disposition recorded before merge." This gate checks both
 * failure modes and treats neither as more trustworthy than the other:
 *
 *   1. STRUCTURAL — no SUP-#### reference anywhere in the PR title, body, or
 *      commit subjects. Pure, offline, always enforced. This alone would NOT
 *      have caught #107/#108 (see above) but closes the "zero linkage at all"
 *      gap and is cheap enough to run as a public, credential-free required
 *      GitHub Actions check (.github/workflows/release-intake-gate.yml).
 *
 *   2. DISPOSITION — a SUP-#### issue is referenced, but its release-intake
 *      classification (docs/release-process.md "Paperclip Intake") is still
 *      "unknown" — no release-candidate / future-release / release-ops /
 *      not-release decision has been recorded. This is what actually would
 *      have caught #107/#108. It requires a live Paperclip API read
 *      (PAPERCLIP_API_URL / PAPERCLIP_API_KEY, the same convention used by
 *      modules/jarvos-secondbrain/bridge/paperclip) and is intentionally NOT
 *      wired into public GitHub Actions by this change: handing a public
 *      repo's Actions runner read access to the Paperclip API is a
 *      credentials-provisioning decision for the repo owner, not something
 *      this change assumes. When credentials ARE present (for example, when
 *      this script runs from the local jarvOS/Paperclip agent runtime), this
 *      layer activates automatically — see resolveReleaseFit() below.
 *
 *      Verified against the live Paperclip instance while building this
 *      (2026-07-17): issue.labels comes back empty on every issue checked, so
 *      the label path documented in "Paperclip Intake" is currently a no-op
 *      here — the *actual* signal is the per-issue `release-intake` document
 *      at GET /api/issues/{id}/documents/release-intake (docs' own documented
 *      fallback for "Paperclip instances that don't expose labels on issue
 *      reads"). Its body is freeform markdown with a `Classification: <value>`
 *      line (sometimes bulleted, sometimes not — see parseReleaseIntakeDocument).
 *      resolveReleaseFit() tries labels first (future-proof if an instance
 *      ever populates them) and falls back to the document.
 *
 * Applies uniformly to direct levineam/jarvOS PRs and clawd-mirror-promoted
 * PRs alike; neither path is special-cased or treated as pre-trusted.
 *
 * Usage (CLI):
 *   PR_TITLE="..." PR_BODY="..." PR_BASE_SHA=<sha> PR_HEAD_SHA=<sha> \
 *     node scripts/release-intake-gate.js
 *
 * Exit codes: 0 = gate passes; 1 = gate fails (reasons printed); 2 = usage/IO error.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TICKET_PATTERN = /SUP-\d+/gi;

// Labels documented in docs/release-process.md's "Paperclip Intake" section,
// mapped to the classification vocabulary already used by
// modules/jarvos-coding/src/adapters/paperclip.js /
// modules/jarvos-coding/src/features/triage/index.js. Kept in one place so
// the gate and the coding-triage module never drift into two taxonomies.
const KNOWN_LABEL_DISPOSITIONS = {
  'jarvos-release-candidate': 'release-candidate',
  'jarvos-future-release': 'future-release',
  'jarvos-release-ops': 'release-ops',
};

function extractTicketIds(...sources) {
  const ids = new Set();
  for (const text of sources) {
    if (!text) continue;
    const matches = String(text).match(TICKET_PATTERN) || [];
    for (const match of matches) ids.add(match.toUpperCase());
  }
  return Array.from(ids).sort();
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args.join(' ')} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

// Commit subjects for commits reachable from headRef but not baseRef — the
// commits a PR actually introduces.
function commitSubjectsInRange(baseRef, headRef) {
  if (!baseRef || !headRef) return [];
  const out = git(['log', `${baseRef}..${headRef}`, '--format=%s']);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

// Maps an issue's labels to a release-intake-shaped classification object,
// consumable by modules/jarvos-coding's releaseFitFromPaperclipReleaseIntake.
// This is the label-based path from docs/release-process.md's "Paperclip
// Intake" section. The release-intake *document* fallback (for Paperclip
// instances that don't expose labels on reads, per that same doc section) is
// not implemented here yet — a named follow-up, not silently assumed
// equivalent to the label path.
function classificationFromLabels(labels = []) {
  const normalized = (labels || []).map((label) => String(label).toLowerCase());
  for (const [label, classification] of Object.entries(KNOWN_LABEL_DISPOSITIONS)) {
    if (normalized.includes(label)) {
      return { classification, matched: true, labels: normalized };
    }
  }
  return { classification: 'unknown', matched: false, labels: normalized };
}

// Field names as written by Jarvis into the `release-intake` document body
// (freeform markdown, one "Label: value" line per field). Observed in
// production to vary in small ways (leading "- " bullet, trailing period,
// "Release parent:" vs "Release parent issue:") — patterns are written
// leniently on purpose rather than assuming one canonical writer.
const DOCUMENT_FIELD_PATTERNS = {
  classification: /^Classification:\s*([^\n]+?)\.?\s*$/im,
  releasePlacement: /^Release placement:\s*([^\n]+?)\.?\s*$/im,
  targetVersion: /^Target version:\s*([^\n]+?)\.?\s*$/im,
  releaseParentIssue: /^Release parent(?: issue)?:\s*([^\n]+?)\.?\s*$/im,
  releaseRationale: /^Release rationale:\s*([^\n]+?)\.?\s*$/im,
  verificationGate: /^Verification gate:\s*([^\n]+?)\.?\s*$/im,
};

// Parses the `release-intake` document body into the shape
// releaseFitFromPaperclipReleaseIntake expects. Strips leading "-"/"*" bullet
// markers before matching so both observed real-world formats
// ("Classification: release-candidate" and "- Classification: release-candidate.")
// parse the same way.
function parseReleaseIntakeDocument(body = '') {
  const cleaned = String(body || '').replace(/^[ \t]*[-*]\s+/gm, '');
  const result = {};
  for (const [field, pattern] of Object.entries(DOCUMENT_FIELD_PATTERNS)) {
    const match = cleaned.match(pattern);
    if (match) result[field] = match[1].trim();
  }
  return result;
}

// Resolves an issue's release-intake classification, trying labels first
// (per docs/release-process.md "Paperclip Intake") and falling back to the
// release-intake document when labels are empty/unpopulated. `deps.getIssue`
// and `deps.paperclipGet` are injected so this stays testable without a live
// network call.
async function resolveReleaseFit(ticketId, auth, deps) {
  const { getIssue, paperclipGet } = deps;
  const issue = await getIssue(ticketId, auth);
  const fromLabels = classificationFromLabels(issue.labels);
  if (fromLabels.matched) return fromLabels;

  try {
    const doc = await paperclipGet(`/issues/${encodeURIComponent(ticketId)}/documents/release-intake`, auth);
    return parseReleaseIntakeDocument(doc.body);
  } catch (error) {
    if (error.status === 404) return { classification: 'unknown' };
    throw error;
  }
}

// releaseFitByTicket: Map<ticketId, { classification: string, ... }> as
// returned by releaseFitFromPaperclipReleaseIntake. checkDisposition: false
// means "structural-only mode" (no Paperclip credentials available) — the
// gate only enforces linkage, not disposition, and does not treat an absent
// entry as a failure.
function evaluateReleaseIntakeGate({ ticketIds, releaseFitByTicket = {}, checkDisposition = true }) {
  if (!ticketIds || ticketIds.length === 0) {
    return {
      ok: false,
      reasons: [
        'no linked Paperclip issue: no SUP-#### reference found in the PR title, body, or commit subjects',
      ],
    };
  }

  if (!checkDisposition) {
    return { ok: true, reasons: [] };
  }

  const reasons = [];
  for (const ticketId of ticketIds) {
    const releaseFit = releaseFitByTicket[ticketId];
    if (!releaseFit || releaseFit.classification === 'unknown') {
      reasons.push(
        `${ticketId}: linked Paperclip issue has no explicit release/future/internal-only disposition ` +
          '(release-intake classification is "unknown" — see docs/release-process.md "Paperclip Intake")'
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  TICKET_PATTERN,
  KNOWN_LABEL_DISPOSITIONS,
  DOCUMENT_FIELD_PATTERNS,
  extractTicketIds,
  commitSubjectsInRange,
  classificationFromLabels,
  parseReleaseIntakeDocument,
  resolveReleaseFit,
  evaluateReleaseIntakeGate,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[release-intake-gate] ${error.message}`);
    process.exit(2);
  });
}

async function main() {
  const prTitle = process.env.PR_TITLE || '';
  const prBody = process.env.PR_BODY || '';
  const baseRef = process.env.PR_BASE_SHA || '';
  const headRef = process.env.PR_HEAD_SHA || 'HEAD';

  const commitSubjects = commitSubjectsInRange(baseRef, headRef);
  const ticketIds = extractTicketIds(prTitle, prBody, ...commitSubjects);

  console.log(`[release-intake-gate] linked ticket(s): ${ticketIds.length ? ticketIds.join(', ') : '(none found)'}`);

  const { resolvePaperclipAuth, getIssue, paperclipGet } = require(
    path.join(ROOT, 'modules/jarvos-secondbrain/bridge/paperclip/client.js')
  );
  const { releaseFitFromPaperclipReleaseIntake } = require(
    path.join(ROOT, 'modules/jarvos-coding/src/adapters/paperclip.js')
  );

  const auth = resolvePaperclipAuth();
  const checkDisposition = Boolean(auth.hasApiUrl && auth.hasApiKey);
  const releaseFitByTicket = {};

  if (checkDisposition) {
    for (const ticketId of ticketIds) {
      try {
        const fit = await resolveReleaseFit(ticketId, auth, { getIssue, paperclipGet });
        releaseFitByTicket[ticketId] = releaseFitFromPaperclipReleaseIntake(fit);
      } catch (error) {
        console.error(`[release-intake-gate] failed to fetch ${ticketId} from Paperclip: ${error.message}`);
        releaseFitByTicket[ticketId] = releaseFitFromPaperclipReleaseIntake({ classification: 'unknown' });
      }
    }
  } else {
    console.log(
      '[release-intake-gate] Paperclip credentials not configured (PAPERCLIP_API_URL/PAPERCLIP_API_KEY) — ' +
        'running the structural (ticket-linkage) check only. The disposition check against the live ' +
        'Paperclip issue is inactive until these are configured; see docs/release-process.md.'
    );
  }

  const result = evaluateReleaseIntakeGate({ ticketIds, releaseFitByTicket, checkDisposition });
  if (!result.ok) {
    console.error('[release-intake-gate] FAIL');
    for (const reason of result.reasons) console.error(`  - ${reason}`);
    process.exit(1);
  }

  console.log('[release-intake-gate] OK');
}
