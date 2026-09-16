#!/usr/bin/env node
// Read-only content-origin audit plus an explicitly apply-gated backfill.
//
// Two hard rules shape this module:
//
//   1. `auditContentOrigin` never writes. It opens files for reading and
//      returns counts only. It does not invoke a model, a network call, or
//      Active Assistant, and it does not emit note bodies, journal bullets, or
//      source receipts — only vocabulary terms and integers. Paths are omitted
//      unless the operator explicitly asks for them.
//   2. Backfill is a two-step boundary. `planContentOriginBackfill` produces
//      proposals; `applyContentOriginBackfill` refuses to touch anything unless
//      `apply === true` and a supported note writer is supplied. Every proposal
//      is `unknown`/`unknown`/ineligible: a stored `author`, personality, model,
//      or harness is not evidence of intellectual origin, so ambiguity is
//      recorded as ambiguity rather than guessed.
//
// Apply additionally runs a fail-closed preflight before any mutation. A plan is
// caller-supplied data, so the path it names is treated as untrusted input, and
// the exact post-write bytes are computed from the supported writer's own pure
// operation factory and compared to the stored body BEFORE anything is
// committed. Nothing is mutated on the hope that the body survives.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONTENT_ORIGIN_SCHEMA_VERSION,
  CONTENT_ORIGIN_BASES,
  emptyOriginCounts,
  normalizeContentOriginForRead,
  resolveLegacyOrigin,
} = require('./content-origin-contract');
const { projectJournalEntriesFromMarkdown } = require('./content-origin-evidence');
const { CANONICAL_WRITERS } = require('./content-origin-writers');
const { frontmatterToObject, parseFrontmatter } = require('../../../packages/jarvos-secondbrain-notes/src/lib/note-schema');
// The supported writer's own pure operation factory and path resolver. Using
// them — rather than re-deriving what a write would produce — is what makes the
// preflight below a prediction of the real mutation instead of a second
// implementation of it.
const {
  NOTE_BODY_PRESERVATION_REFUSED,
  createNoteMutationOperation,
  noteFilePath,
} = require('../../../packages/jarvos-secondbrain-notes/src/write-to-vault');
const { getVaultNotesDir, getVaultJournalDir } = require('./lib/provenance-config');

const CONTENT_ORIGIN_AUDIT_VERSION = 'jarvos-content-origin-audit/v1';
const JOURNAL_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
// Vaults nest, but not infinitely. A bound keeps a pathological tree from
// turning a read-only audit into an unbounded walk.
const MAX_SCAN_DEPTH = 16;

// How a stored record declares itself, before any origin is resolved.
const CONTRACT_STATES = Object.freeze(['declared_v1', 'declared_other_version', 'legacy_author_only', 'undeclared']);

function emptyBasisCounts() {
  return Object.fromEntries(CONTENT_ORIGIN_BASES.map((basis) => [basis, 0]));
}

function emptyContractCounts() {
  return Object.fromEntries(CONTRACT_STATES.map((state) => [state, 0]));
}

/**
 * Walk `dir` for Markdown notes and return normalized POSIX-relative paths.
 *
 * Notes nest — `Notes/Projects/Something.md` is an ordinary vault shape — so a
 * flat `readdirSync` silently under-reports coverage, and an under-report on a
 * provenance audit reads as "everything is declared" when it is not.
 *
 * Symlinks are never followed, for directories or files. A symlinked directory
 * can point anywhere on disk, including outside the vault, and a symlinked note
 * is not a file this audit can honestly claim to have read in place. Dotted
 * entries (`.obsidian`, `.trash`) are skipped: they are tool state, not notes.
 */
function listMarkdownRelative(dir, { filter = () => true, maxDepth = MAX_SCAN_DEPTH } = {}) {
  const found = [];
  const walk = (absoluteDir, relativeDir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      // readdirSync(withFileTypes) reports link status without resolving it, so
      // this check happens before any decision to descend or read.
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(absoluteDir, entry.name), relative, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (!filter(entry.name, relative)) continue;
      found.push(relative);
    }
  };
  walk(dir, '', 0);
  return found.sort();
}

function noteTitleFromRelativePath(relativePath) {
  return path.posix.basename(relativePath).replace(/\.md$/, '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function contractStateFor(frontmatter = {}) {
  const schema = String(frontmatter.content_origin_schema || '').trim();
  const declared = frontmatter.content_origin !== undefined || frontmatter.content_origin_basis !== undefined;
  if (schema === CONTENT_ORIGIN_SCHEMA_VERSION) return 'declared_v1';
  if (schema || declared) return 'declared_other_version';
  if (frontmatter.author !== undefined) return 'legacy_author_only';
  return 'undeclared';
}

function writerBucket(frontmatter = {}) {
  const personality = String(frontmatter.source_personality || '').trim();
  if (personality) return `personality:${personality}`;
  const source = String(frontmatter.source || '').trim();
  if (source) return `source:${source}`;
  return 'unattributed';
}

/**
 * Classify one stored note without mutating it. The resolved origin uses the
 * read-time projection, so a declaration whose receipt no longer binds the
 * stored body resolves to unknown instead of staying human.
 */
function classifyNoteRecord({ markdown, title }) {
  const parsed = parseFrontmatter(String(markdown || ''));
  const frontmatter = parsed ? frontmatterToObject(parsed) : {};
  const contract = contractStateFor(frontmatter);
  const body = String(parsed?.remainder ?? markdown ?? '');

  if (contract === 'declared_v1' || contract === 'declared_other_version') {
    const normalized = normalizeContentOriginForRead({
      content_origin: frontmatter.content_origin,
      content_origin_basis: frontmatter.content_origin_basis,
      content_origin_source: frontmatter.content_origin_source,
      human_evidence_eligible: frontmatter.human_evidence_eligible,
    }, { content: stripHeading(body, title) });
    return {
      contract,
      content_origin: normalized.content_origin,
      content_origin_basis: normalized.content_origin_basis,
      human_evidence_eligible: normalized.human_evidence_eligible === true,
      writer: writerBucket(frontmatter),
      // A v1 declaration that fails read-time validation is a real finding:
      // the note claims something the stored bytes no longer support.
      degraded: normalized.content_origin !== String(frontmatter.content_origin || '').trim().toLowerCase(),
    };
  }

  const legacy = contract === 'legacy_author_only'
    ? resolveLegacyOrigin(frontmatter)
    : { content_origin: 'unknown', content_origin_basis: 'unknown' };
  return {
    contract,
    content_origin: legacy.content_origin,
    content_origin_basis: legacy.content_origin_basis,
    // legacy_author is read-time-only and never establishes human evidence.
    human_evidence_eligible: false,
    writer: writerBucket(frontmatter),
    degraded: false,
  };
}

function stripHeading(body, title) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  const heading = String(title || '').trim();
  if (!heading || !text.startsWith(`# ${heading}\n`)) return text;
  return text.slice(heading.length + 3).trim();
}

function countInto(bucket, key) {
  if (!Object.prototype.hasOwnProperty.call(bucket, key)) bucket[key] = 0;
  bucket[key] += 1;
}

/**
 * Read-only audit. Returns counts by contract state, origin, basis,
 * eligibility, and writer bucket. `includePaths` is opt-in because a vault
 * filename is itself private content.
 */
function auditContentOrigin({
  notesDir = getVaultNotesDir(),
  journalDir = getVaultJournalDir(),
  includePaths = false,
} = {}) {
  const notes = {
    scanned: 0,
    // How many of the scanned notes live below the notes root. This is a count,
    // not a path, and it matters: the supported flat writer cannot address them,
    // so they are reported but never backfilled in place.
    nested: 0,
    contract: emptyContractCounts(),
    origin: emptyOriginCounts(),
    basis: emptyBasisCounts(),
    human_evidence_eligible: 0,
    degraded_declarations: 0,
    byWriter: {},
    ...(includePaths ? { undeclaredPaths: [] } : {}),
  };

  for (const relativePath of listMarkdownRelative(notesDir)) {
    const absolute = path.join(notesDir, ...relativePath.split('/'));
    let markdown;
    try {
      markdown = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    // A nested note's heading matches its file name, not its folder path.
    const title = noteTitleFromRelativePath(relativePath);
    const record = classifyNoteRecord({ markdown, title });
    notes.scanned += 1;
    if (relativePath.includes('/')) notes.nested += 1;
    countInto(notes.contract, record.contract);
    countInto(notes.origin, record.content_origin);
    countInto(notes.basis, record.content_origin_basis);
    if (record.human_evidence_eligible) notes.human_evidence_eligible += 1;
    if (record.degraded) notes.degraded_declarations += 1;
    countInto(notes.byWriter, record.writer);
    if (includePaths && record.contract !== 'declared_v1') notes.undeclaredPaths.push(relativePath);
  }

  const journal = {
    scannedDays: 0,
    entries: 0,
    marked: 0,
    unmarked: 0,
    origin: emptyOriginCounts(),
    human_evidence_eligible: 0,
  };

  // Journal days are sometimes filed under year or month folders, so the date
  // comes from the file name and the folder is irrelevant to classification.
  for (const relativePath of listMarkdownRelative(journalDir, { filter: (name) => JOURNAL_FILE_RE.test(name) })) {
    const absolute = path.join(journalDir, ...relativePath.split('/'));
    let markdown;
    try {
      markdown = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const date = noteTitleFromRelativePath(relativePath);
    journal.scannedDays += 1;
    for (const section of ['ideas', 'notes']) {
      // No resolver is available in an audit, so a human claim can only be
      // reported as unverified; the projection already downgrades it.
      for (const entry of projectJournalEntriesFromMarkdown(markdown, { date, section })) {
        journal.entries += 1;
        countInto(journal.origin, entry.content_origin);
        if (entry.human_evidence_eligible) journal.human_evidence_eligible += 1;
        if (entry.marker_present) journal.marked += 1;
        else journal.unmarked += 1;
      }
    }
  }

  return {
    audit_version: CONTENT_ORIGIN_AUDIT_VERSION,
    content_origin_schema: CONTENT_ORIGIN_SCHEMA_VERSION,
    read_only: true,
    mutated: false,
    declaredWriters: CANONICAL_WRITERS.length,
    notes,
    journal,
  };
}

// The one supported-writer capability this module asks for: a metadata-only
// provenance rewrite that keeps the stored body remainder byte for byte. The
// same frozen object is handed to the preflight's operation factory and to the
// injected writer, so the bytes that were proven are the bytes requested.
const METADATA_ONLY_WRITE_OPTIONS = Object.freeze({ preserveExistingBodyBytes: true });

// The writer refuses this capability rather than rewriting prose behind the
// caller's back. A refusal is a preflight verdict, not a crash, so each reason
// maps onto the vocabulary an operator already reads in the results table.
const PRESERVE_BODY_REFUSALS = Object.freeze({
  body_would_change: 'body_bytes_would_change',
  body_bytes_not_reproducible: 'body_bytes_would_change',
  not_a_provenance_rewrite: 'not_a_metadata_only_replace',
  not_an_existing_note: 'not_a_metadata_only_replace',
  append_entry_unsupported: 'not_a_metadata_only_replace',
});

const PROPOSED_DECLARATION = Object.freeze({
  content_origin_schema: CONTENT_ORIGIN_SCHEMA_VERSION,
  content_origin: 'unknown',
  content_origin_basis: 'unknown',
  human_evidence_eligible: false,
});

/**
 * Propose a conservative frontmatter-only repair for every note without an
 * explicit v1 declaration. Nothing is inferred: every proposal is `unknown`.
 *
 * The walk is recursive, so nested notes are reported. Paths are withheld
 * unless `includePaths` is set, for the same reason the audit withholds them —
 * a vault filename is private content. Apply needs them, so an operator who
 * intends to apply plans with `includePaths: true` deliberately.
 *
 * Every proposal records `sourceDigest`, the SHA-256 of the exact bytes the
 * plan was computed from. That is what lets apply reject a stale or tampered
 * proposal instead of writing a declaration derived from a file that has since
 * changed.
 */
function planContentOriginBackfill({ notesDir = getVaultNotesDir(), includeDegraded = false, includePaths = false } = {}) {
  const proposals = [];
  let nested = 0;
  for (const relativePath of listMarkdownRelative(notesDir)) {
    const absolute = path.join(notesDir, ...relativePath.split('/'));
    let markdown;
    try {
      markdown = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const title = noteTitleFromRelativePath(relativePath);
    const record = classifyNoteRecord({ markdown, title });
    const needsDeclaration = record.contract !== 'declared_v1';
    if (!needsDeclaration && !(includeDegraded && record.degraded)) continue;
    if (relativePath.includes('/')) nested += 1;
    proposals.push({
      ...(includePaths ? { relativePath, title } : {}),
      sourceDigest: sha256(markdown),
      reason: needsDeclaration ? `contract:${record.contract}` : 'degraded_declaration',
      current: {
        contract: record.contract,
        content_origin: record.content_origin,
        content_origin_basis: record.content_origin_basis,
      },
      next: { ...PROPOSED_DECLARATION },
    });
  }
  return {
    audit_version: CONTENT_ORIGIN_AUDIT_VERSION,
    ...(includePaths ? { notesDir } : {}),
    pathsIncluded: includePaths === true,
    nestedProposals: nested,
    proposals,
    proposalCount: proposals.length,
  };
}

// Raw, untrimmed body remainder. Trimming here is exactly the bug this module
// had: two bodies that differ only in trailing bytes are NOT the same body, and
// calling that "preserved" turns a silent rewrite into a success report.
function bodyOf(markdown) {
  const parsed = parseFrontmatter(String(markdown || ''));
  return String(parsed?.remainder ?? markdown ?? '');
}

/**
 * Resolve a caller-supplied proposal path inside `notesDir`, or refuse it.
 *
 * A plan is data. It can come from another process, a file, or a hand-edit, so
 * its `relativePath` is untrusted: absolute paths, drive-qualified paths, `..`
 * segments, backslash segments, and anything that still escapes the notes root
 * after resolution are rejected before the filesystem is touched at all.
 */
function resolveProposalPath(notesDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return { ok: false, reason: 'path_missing' };
  if (relativePath !== relativePath.trim()) return { ok: false, reason: 'path_not_normalized' };
  if (path.isAbsolute(relativePath) || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    return { ok: false, reason: 'path_absolute' };
  }
  const segments = relativePath.split('/');
  const safeSegment = (segment) => segment.length > 0
    && segment !== '.' && segment !== '..'
    && !segment.includes('\\') && !segment.includes('\0');
  if (!segments.length || !segments.every(safeSegment)) return { ok: false, reason: 'path_escape' };
  if (!relativePath.endsWith('.md')) return { ok: false, reason: 'path_not_markdown' };

  const root = path.resolve(notesDir);
  const absolute = path.resolve(root, ...segments);
  if (absolute === root || !absolute.startsWith(root + path.sep)) return { ok: false, reason: 'path_escape' };

  // Walk every component with lstat. A symlink anywhere on the way down can
  // redirect the write outside the vault, and a symlinked note is not a note
  // this module is willing to rewrite in place.
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (stats.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  }
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!stats.isFile()) return { ok: false, reason: 'not_a_regular_file' };
  return { ok: true, absolute, relativePath: segments.join('/') };
}

/**
 * Decide, without mutating anything, whether one proposal can be applied with a
 * provably byte-identical body.
 *
 * The decisive step is building the operation the supported writer would build
 * and reading the bytes it would commit. `createNoteMutationOperation` is pure:
 * for a frontmatter-only provenance change on an existing note it returns a
 * `replace` carrying both the exact next content and the `expectedHash` of the
 * pre-state. So the body comparison happens BEFORE the commit, and the commit
 * itself is compare-and-swap against that hash — a concurrent edit between
 * preflight and write turns into a conflict receipt, not a lost body.
 *
 * The operation is built with the writer's `preserveExistingBodyBytes` option,
 * the supported metadata-only capability, and apply asks the injected writer for
 * the same one. Without it the writer re-renders the body around canonical
 * frontmatter, which is a legitimate write but not a byte-identical one; the
 * writer refuses the option for anything but a metadata-only repair, and a
 * refusal is recorded as a skip rather than swallowed.
 *
 * Anything that cannot be proven is skipped, not attempted.
 */
function preflightProposal({ notesDir, proposal }) {
  const relativePath = proposal?.relativePath;
  if (typeof relativePath !== 'string' || !relativePath) {
    return { ok: false, reason: 'plan_paths_withheld' };
  }
  const resolved = resolveProposalPath(notesDir, relativePath);
  if (!resolved.ok) return { ok: false, relativePath, reason: resolved.reason };

  let before;
  try {
    before = fs.readFileSync(resolved.absolute, 'utf8');
  } catch {
    return { ok: false, relativePath, reason: 'unreadable' };
  }

  // The plan describes bytes that existed when it was produced. If the note has
  // changed since, the classification behind the proposal is no longer known to
  // hold, so the proposal is stale and must be re-planned, not applied.
  if (typeof proposal.sourceDigest !== 'string' || !proposal.sourceDigest) {
    return { ok: false, relativePath, reason: 'proposal_unverifiable' };
  }
  if (proposal.sourceDigest !== sha256(before)) {
    return { ok: false, relativePath, reason: 'stale_proposal' };
  }
  // The declaration is this module's, not the plan's. A hand-edited plan cannot
  // smuggle `content_origin: human` through the backfill path.
  const next = { ...PROPOSED_DECLARATION };

  const title = noteTitleFromRelativePath(relativePath);
  const record = classifyNoteRecord({ markdown: before, title });
  if (record.contract === 'declared_v1' && !record.degraded) {
    return { ok: false, relativePath, reason: 'no_longer_applicable' };
  }

  // Where would the supported writer actually put this title? If that is not
  // this file, applying would create a second note somewhere else and leave the
  // original untouched. Nested notes land here, because the canonical writer is
  // flat by construction.
  let writerTarget;
  try {
    writerTarget = noteFilePath(title);
  } catch {
    return { ok: false, relativePath, reason: 'writer_path_unresolvable' };
  }
  if (path.resolve(writerTarget) !== resolved.absolute) {
    return { ok: false, relativePath, reason: 'writer_path_mismatch' };
  }

  const bodyBefore = bodyOf(before);
  const content = bodyBefore.trim();
  const parsedBefore = parseFrontmatter(before);
  const existingFrontmatter = parsedBefore ? frontmatterToObject(parsedBefore) : {};

  let operation;
  try {
    operation = createNoteMutationOperation({
      operationId: 'content-origin-backfill-preflight',
      vaultId: 'content-origin-backfill-preflight',
      vaultRelativePath: relativePath,
      title,
      content,
      frontmatter: next,
      existingContent: before,
      existingFrontmatter,
      ...METADATA_ONLY_WRITE_OPTIONS,
    });
  } catch (error) {
    if (error?.code === NOTE_BODY_PRESERVATION_REFUSED) {
      return { ok: false, relativePath, reason: PRESERVE_BODY_REFUSALS[error.reason] || 'preflight_failed' };
    }
    return { ok: false, relativePath, reason: 'preflight_failed' };
  }

  // Only a `replace` carries its full next content up front. A `create` or a
  // `transform` would have to be executed to find out what it did, which is
  // precisely the "mutate first, discover afterwards" shape this refuses.
  if (operation.operationKind !== 'replace' || typeof operation.content !== 'string') {
    return { ok: false, relativePath, reason: 'not_a_metadata_only_replace' };
  }
  if (operation.expectedHash !== sha256(before)) {
    return { ok: false, relativePath, reason: 'expected_state_mismatch' };
  }
  if (bodyOf(operation.content) !== bodyBefore) {
    return { ok: false, relativePath, reason: 'body_bytes_would_change' };
  }

  return {
    ok: true,
    relativePath,
    absolute: resolved.absolute,
    title,
    content,
    next,
    before,
    bodyBefore,
    predictedBody: bodyOf(operation.content),
  };
}

const COMMITTED_RECEIPT_STATUSES = Object.freeze(['committed', 'already_satisfied']);

/**
 * Apply a backfill plan through a supported note writer.
 *
 * `apply !== true` is a hard stop: nothing is written, and the returned
 * `results` are the read-only preflight verdicts — the safe dry run an operator
 * should read before deciding anything.
 *
 * With `apply === true` the caller must supply `writeNote`, the canonical note
 * mutation composition, so this module never opens a vault file for writing
 * itself. Each proposal is fully preflighted first; only a proposal whose
 * post-write body bytes are already known to be identical is written at all.
 *
 * The post-write re-read is defence in depth, not the guarantee. If it ever
 * disagrees with the preflight, the run stops immediately — every remaining
 * proposal is left untouched — and the pre-image is handed to the optional
 * `restoreNote` recovery seam. One anomalous write must not become a cascade.
 */
function applyContentOriginBackfill({
  plan,
  apply = false,
  writeNote,
  restoreNote,
  notesDir = plan?.notesDir || getVaultNotesDir(),
} = {}) {
  const proposals = Array.isArray(plan?.proposals) ? plan.proposals : [];
  if (apply !== true) {
    const results = proposals.map((proposal) => {
      const preflight = preflightProposal({ notesDir, proposal });
      return {
        ...(preflight.relativePath ? { relativePath: preflight.relativePath } : {}),
        status: preflight.ok ? 'eligible' : 'skipped',
        ...(preflight.ok ? {} : { reason: preflight.reason }),
      };
    });
    return {
      audit_version: CONTENT_ORIGIN_AUDIT_VERSION,
      mode: 'dry-run',
      applied: false,
      mutated: false,
      proposalCount: proposals.length,
      eligibleCount: results.filter((result) => result.status === 'eligible').length,
      results,
    };
  }
  if (typeof writeNote !== 'function') {
    throw new Error('applyContentOriginBackfill requires a supported note writer; this module never writes vault Markdown directly');
  }

  const results = [];
  let aborted = false;
  let writeAttempted = false;
  for (const proposal of proposals) {
    if (aborted) {
      results.push({
        ...(typeof proposal?.relativePath === 'string' ? { relativePath: proposal.relativePath } : {}),
        status: 'skipped',
        reason: 'aborted_after_integrity_violation',
      });
      continue;
    }

    const preflight = preflightProposal({ notesDir, proposal });
    if (!preflight.ok) {
      results.push({
        ...(preflight.relativePath ? { relativePath: preflight.relativePath } : {}),
        status: 'skipped',
        reason: preflight.reason,
      });
      continue;
    }

    let receipt;
    writeAttempted = true;
    try {
      receipt = writeNote({
        title: preflight.title,
        content: preflight.content,
        frontmatter: { ...preflight.next },
        // Same capability the preflight proved, asked of the writer explicitly.
        // A writer that ignores it does not get the benefit of the doubt: the
        // post-write body comparison below still has to hold.
        ...METADATA_ONLY_WRITE_OPTIONS,
      });
    } catch {
      results.push({ relativePath: preflight.relativePath, status: 'failed', reason: 'write_rejected' });
      continue;
    }

    const mutationStatus = receipt?.receipt?.status || receipt?.mutationStatus || 'unknown';
    let after;
    try {
      after = fs.readFileSync(preflight.absolute, 'utf8');
    } catch {
      results.push({
        relativePath: preflight.relativePath,
        status: 'failed',
        reason: 'unreadable_after_write',
        mutationStatus,
      });
      aborted = true;
      continue;
    }

    const bodyAfter = bodyOf(after);
    // Raw remainder equality, byte for byte. Not trimmed: a body that gained or
    // lost trailing bytes is a changed body.
    if (bodyAfter !== preflight.bodyBefore) {
      const recovery = attemptRestore({ restoreNote, preflight, after });
      results.push({
        relativePath: preflight.relativePath,
        status: 'failed',
        reason: 'body_changed_after_write',
        bodyPreserved: false,
        mutationStatus,
        ...recovery,
      });
      // Stop the run. The preflight said this was impossible, so the writer or
      // the vault is not behaving as modelled and no further note is safe.
      aborted = true;
      continue;
    }

    // A receipt that neither committed nor durably saved locally is not an
    // applied declaration, even though the body survived.
    const status = COMMITTED_RECEIPT_STATUSES.includes(mutationStatus)
      ? 'applied'
      : mutationStatus === 'saved_locally_sync_pending'
        ? 'applied_pending_sync'
        : 'failed';
    results.push({
      relativePath: preflight.relativePath,
      status,
      ...(status === 'failed' ? { reason: `mutation_not_committed:${mutationStatus}` } : {}),
      bodyPreserved: true,
      bodyBytesIdentical: true,
      mutationStatus,
    });
  }

  return {
    audit_version: CONTENT_ORIGIN_AUDIT_VERSION,
    mode: 'apply',
    applied: results.some((result) => result.status === 'applied'),
    // True as soon as the supported writer was invoked at all: an operator must
    // not read `mutated: false` off a run that reached the mutation boundary.
    mutated: writeAttempted,
    aborted,
    proposalCount: proposals.length,
    results,
  };
}

/**
 * Hand the pre-image back to a caller-supplied recovery seam.
 *
 * This module still refuses to write Markdown itself, so recovery goes through
 * the same supported mutation boundary as the write did, guarded by the hash of
 * the state the write actually produced. Without a seam there is nothing to do
 * but say so loudly.
 */
function attemptRestore({ restoreNote, preflight, after }) {
  if (typeof restoreNote !== 'function') return { rollbackAvailable: false, rolledBack: false };
  try {
    const outcome = restoreNote({
      relativePath: preflight.relativePath,
      absolutePath: preflight.absolute,
      content: preflight.before,
      expectedContent: after,
      expectedHash: sha256(after),
    });
    const restored = fs.readFileSync(preflight.absolute, 'utf8');
    return {
      rollbackAvailable: true,
      rolledBack: restored === preflight.before,
      restoreStatus: outcome?.receipt?.status || outcome?.status || 'unknown',
    };
  } catch {
    return { rollbackAvailable: true, rolledBack: false, restoreStatus: 'threw' };
  }
}

function parseArgs(argv) {
  const args = { json: false, backfill: false, apply: false, includePaths: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--backfill') args.backfill = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--include-paths') args.includePaths = true;
    else if (arg === '--notes-dir') args.notesDir = argv[++index];
    else if (arg === '--journal-dir') args.journalDir = argv[++index];
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.backfill) {
    const report = auditContentOrigin({
      ...(args.notesDir ? { notesDir: args.notesDir } : {}),
      ...(args.journalDir ? { journalDir: args.journalDir } : {}),
      includePaths: args.includePaths,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const plan = planContentOriginBackfill({
    ...(args.notesDir ? { notesDir: args.notesDir } : {}),
    includePaths: args.includePaths,
  });
  if (!args.apply) {
    // The dry run is read-only and reports, per proposal, whether apply could
    // prove byte preservation. Without `--include-paths` the plan withholds
    // paths, so the preflight can only report that.
    const dryRun = applyContentOriginBackfill({
      plan,
      ...(args.notesDir ? { notesDir: args.notesDir } : {}),
    });
    process.stdout.write(`${JSON.stringify({ ...plan, ...dryRun, mutated: false }, null, 2)}\n`);
    return plan;
  }
  // The apply path is deliberately not wired to a default vault writer from the
  // CLI. Applying a backfill is an operator decision that goes through the
  // supported note contract with an explicit composition.
  process.stderr.write(`${JSON.stringify({
    error: 'refusing to apply from the CLI',
    detail: 'compose applyContentOriginBackfill with the canonical note writer explicitly',
    proposalCount: plan.proposalCount,
  }, null, 2)}\n`);
  process.exitCode = 1;
  return plan;
}

module.exports = {
  CONTENT_ORIGIN_AUDIT_VERSION,
  CONTRACT_STATES,
  MAX_SCAN_DEPTH,
  classifyNoteRecord,
  auditContentOrigin,
  listMarkdownRelative,
  resolveProposalPath,
  preflightProposal,
  planContentOriginBackfill,
  applyContentOriginBackfill,
  main,
};

if (require.main === module) {
  main();
}
