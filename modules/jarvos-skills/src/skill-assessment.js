'use strict';

/**
 * U3 rule-proven assessment.  It consumes U2 observations; it never scans an
 * ambient root, runs bundle code, loads a plugin, or makes a network request.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_ALLOWED_BUNDLE_GLOBS, OVERLAY_SCHEMA_VERSION, SUPPORTED_HARNESSES, computeBundleTree, validateLocalOverlay, validatePublicCatalog, composeEffectiveCatalog, CATALOG_SCHEMA_VERSION } = require('./catalog');
const { validateInventoryDocument, serializeOutwardStatus, normalizeRetirementPolicy } = require('./inventory-contract');
const { captureAcceptedGeneration, readAcceptedGeneration } = require('./source-store');
const { readReceipt, validateReceipt } = require('./receipts');
const { loadConfig, resolveConfigPaths, atomicWriteJson, saveConfig } = require('./config');

const SECRET_RE = /(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const INJECTION_RE = /(?:ignore\s+(?:all\s+)?previous\s+instructions|system\s+message|exfiltrat(?:e|ion)|reveal\s+(?:your\s+)?(?:prompt|instructions))/i;
const NETWORK_RE = /(?:https?:\/\/|\b(?:curl|wget|fetch|axios|requests?)\b)/i;
const PLUGIN_RE = /\b(?:plugin|mcp|credential|interactive|hook)\b/i;
const NATIVE_RE = /\b(?:codex|claude|openclaw|hermes)[-_ ]?(?:only|native|specific)\b/i;
const MAX_ANALYSIS_BYTES = 4 * 1024 * 1024;

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function safeReadSkillMd(bundlePath) {
  const file = path.join(bundlePath, 'SKILL.md');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('unsafe_skill_metadata');
  return fs.readFileSync(file, 'utf8');
}

function featuresFor(bundlePath, expectedDigest) {
  const tree = computeBundleTree(bundlePath, { allowlist: DEFAULT_ALLOWED_BUNDLE_GLOBS, expectedDigest });
  safeReadSkillMd(tree.root);
  let analysisBytes = 0;
  const analysisText = tree.entries.map((entry) => {
    const file = path.join(tree.root, entry.path);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_bundle_analysis_file');
    analysisBytes += stat.size;
    if (analysisBytes > MAX_ANALYSIS_BYTES) throw new Error('bundle_analysis_too_large');
    return fs.readFileSync(file, 'utf8');
  }).join('\n');
  const scripts = tree.entries.some((entry) => entry.path.startsWith('scripts/'));
  const capabilities = [
    ...(scripts ? ['scripts'] : []),
    ...(NETWORK_RE.test(analysisText) ? ['network'] : []),
    ...(PLUGIN_RE.test(analysisText) ? ['plugin_or_interactive'] : []),
    ...(NATIVE_RE.test(analysisText) ? ['native_syntax'] : []),
  ].sort();
  return {
    tree,
    hasSecret: SECRET_RE.test(analysisText),
    hasInjection: INJECTION_RE.test(analysisText),
    hasNetwork: NETWORK_RE.test(analysisText),
    hasPluginOrInteractive: PLUGIN_RE.test(analysisText),
    hasNativeSyntax: NATIVE_RE.test(analysisText),
    capabilities,
    profileDigest: digest(JSON.stringify({ capabilities, scripts, native: NATIVE_RE.test(analysisText) })),
  };
}

function analyzeBundle(bundlePath, { expectedTreeDigest = null } = {}) {
  try {
    const feature = featuresFor(bundlePath, expectedTreeDigest);
    return {
      ok: true,
      treeDigest: feature.tree.treeDigest,
      allowlist: feature.tree.allowlist,
      hasScripts: feature.capabilities.includes('scripts'),
      secretHit: feature.hasSecret,
      injectionHit: feature.hasInjection,
      egressHit: feature.hasNetwork,
      nativeSyntax: feature.hasNativeSyntax,
      requiredTools: [],
      profileDigest: feature.profileDigest,
    };
  } catch (error) {
    return { ok: false, reason: error.message || 'unsafe_source' };
  }
}

function buildRedactedReviewFeatures(skill, feature) {
  return {
    version: 'jarvos-skill-semantic-review/v1',
    logicalId: skill.logicalId,
    treeDigest: skill.treeDigest,
    observationCount: Array.isArray(skill.observations) ? skill.observations.length : 0,
    hasScripts: feature.hasScripts === true,
    requiredTools: Array.isArray(feature.requiredTools) ? feature.requiredTools.slice().sort() : [],
  };
}

function principalMayAutoAdmit(principal) {
  const capabilities = new Set(principal?.capabilities || []);
  return capabilities.has('inventory.observe') && capabilities.has('inventory.auto_admit_rule_proven');
}

function stableDisposition(kind, reasonCode, attention = 'quiet') {
  return { disposition: { kind, reasonCode }, attention };
}

function sourceRootsFor(skill, roots) {
  const byId = new Map(roots.map((root) => [root.rootId, root]));
  return skill.observations
    .map((observation) => ({ observation, root: byId.get(observation.rootId) }))
    .filter((item) => item.root && item.observation.state !== 'missing')
    .sort((left, right) => left.observation.rootId.localeCompare(right.observation.rootId)
      || left.observation.relativePath.localeCompare(right.observation.relativePath));
}

function receiptOwns(harnessRoots, id) {
  for (const root of harnessRoots || []) {
    try {
      const receipt = validateReceipt(readReceipt(root.root, id));
      if (receipt && receipt.id === id) return true;
    } catch {
      return true; // unsafe receipt state is never an admission opportunity
    }
  }
  return false;
}

function compatibleTargets(skill, harnessRoots, { forUpdate = false } = {}) {
  const sourcePresent = new Set(skill.matrix.filter((row) => row.projection === 'source_present').map((row) => row.harness));
  return SUPPORTED_HARNESSES.filter((harness) => {
    if (sourcePresent.has(harness)) return false;
    // Updates must keep receipt-owned destinations eligible so reconcile can
    // refresh outdated projections from a new accepted generation.
    if (forUpdate) return true;
    return !receiptOwns((harnessRoots || []).filter((root) => root.harness === harness), skill.logicalId);
  });
}

function priorEntryFor(prior, logicalId) {
  if (!prior) return null;
  const identity = (prior.identities || []).find((item) => item.logicalId === logicalId);
  const effectiveName = identity?.effectiveName || logicalId;
  const entry = (prior.generatedOverlay?.entries || prior.entries || [])
    .find((item) => item.id === effectiveName);
  if (!entry) return null;
  return { identity, effectiveName, entry, treeDigest: entry.treeDigest || entry.bundle?.treeDigest || null };
}

function recordAbsence(priorAbsences, logicalId, observedAt, policy) {
  const prev = (priorAbsences && priorAbsences[logicalId]) || null;
  const count = (prev?.count || 0) + 1;
  const firstMissingAt = prev?.firstMissingAt || observedAt;
  const lastMissingAt = observedAt;
  const minCount = policy?.minAbsenceObservations || 2;
  const firstAtMs = Date.parse(firstMissingAt);
  const lastAtMs = Date.parse(lastMissingAt);
  const requiredMs = (policy?.effectiveAbsenceIntervalHours || policy?.minAbsenceIntervalHours || 24) * 60 * 60 * 1000;
  // An invalid timestamp is unsafe evidence: retain rather than retire.
  const graceElapsed = Number.isFinite(firstAtMs)
    && Number.isFinite(lastAtMs)
    && lastAtMs >= firstAtMs
    && (lastAtMs - firstAtMs) >= requiredMs;
  return {
    logicalId,
    count,
    firstMissingAt,
    lastMissingAt,
    retireReady: count >= minCount && graceElapsed,
  };
}

function loadManualInputs({ publicCatalog, localOverlay }) {
  const publicResult = publicCatalog === undefined || publicCatalog === null
    ? { status: 'valid', catalog: { schemaVersion: CATALOG_SCHEMA_VERSION, entries: [] } }
    : validatePublicCatalog(publicCatalog);
  if (publicResult.status !== 'valid') return { error: publicResult.reason || 'public_catalog_unsupported' };
  const localResult = validateLocalOverlay(localOverlay);
  if (localResult.status === 'unsupported') return { error: localResult.reason || 'local_overlay_unsupported' };
  return { publicCatalog: publicResult.catalog, localOverlay: localResult.overlay };
}

function legacyManualMigration({ manualEntries, oldLocalSourceRoot, sourceStorePath }) {
  if (!oldLocalSourceRoot
    || path.resolve(oldLocalSourceRoot) === path.resolve(sourceStorePath)
    || manualEntries.length === 0) {
    return { required: false, candidates: [] };
  }
  const root = path.resolve(oldLocalSourceRoot);
  if (!fs.existsSync(root)) throw new Error('legacy manual localSourceRoot does not exist');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('legacy manual localSourceRoot must be a real directory');
  }
  if (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) {
    throw new Error('legacy manual localSourceRoot must be owned by the current user');
  }
  if ((rootStat.mode & 0o022) !== 0) {
    throw new Error('legacy manual localSourceRoot has unsafe permissions');
  }
  const realRoot = fs.realpathSync(root);
  const candidates = manualEntries.map((entry) => {
    const candidate = path.resolve(realRoot, ...entry.bundle.root.split('/'));
    const relative = path.relative(realRoot, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`legacy manual bundle escapes localSourceRoot: ${entry.id}`);
    }
    let current = realRoot;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) throw new Error(`legacy manual bundle is missing: ${entry.id}`);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`legacy manual bundle contains a symbolic link: ${entry.id}`);
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`legacy manual bundle has unsafe ownership: ${entry.id}`);
      }
      if ((stat.mode & 0o022) !== 0) throw new Error(`legacy manual bundle has unsafe permissions: ${entry.id}`);
    }
    const tree = computeBundleTree(candidate, {
      allowlist: entry.bundle.allowlist,
      expectedDigest: entry.bundle.treeDigest,
    });
    return {
      id: entry.id,
      sourcePath: tree.root,
      treeDigest: tree.treeDigest,
      allowlist: tree.allowlist,
      manualEntry: entry,
    };
  });
  return { required: true, candidates };
}

function reviewDivergence({ skill, variants, reviewer }) {
  if (variants.size <= 1) return { status: 'single' };
  if (typeof reviewer !== 'function') return { status: 'needs_input', reasonCode: 'semantic_collision' };
  const payload = {
    version: 'jarvos-skill-semantic-review/v1',
    logicalId: skill.logicalId,
    variants: [...variants.entries()].map(([treeDigest, feature]) => ({
      treeDigest,
      profileDigest: feature.profileDigest,
      capabilities: feature.capabilities,
    })).sort((a, b) => a.treeDigest.localeCompare(b.treeDigest)),
  };
  let response;
  try { response = reviewer(payload); } catch { return { status: 'needs_input', reasonCode: 'semantic_collision' }; }
  if (!response || response.kind !== 'same_purpose' || typeof response.selectedDigest !== 'string' || !variants.has(response.selectedDigest)) {
    return { status: 'needs_input', reasonCode: 'semantic_collision' };
  }
  return { status: 'selected', selectedDigest: response.selectedDigest };
}

function assessInventory({
  configPath,
  controlRoot,
  document,
  sourceStorePath,
  acceptedGenerationPath,
  acceptedAt,
  harnessRoots = [],
  publicCatalog,
  localOverlay,
  reviewer,
  complete = true,
  autoAdmit = true,
  persist = true,
  config: suppliedConfig = null,
  resolved: suppliedResolved = null,
} = {}) {
  let resolved = suppliedResolved;
  let config = suppliedConfig;
  if (configPath || controlRoot) {
    const loaded = loadConfig(configPath);
    config = controlRoot ? { ...loaded.config, controlRoot } : loaded.config;
    resolved = resolveConfigPaths(config);
    sourceStorePath = sourceStorePath || resolved.inventory.sourceStorePath;
    acceptedGenerationPath = acceptedGenerationPath || resolved.inventory.acceptedGenerationPath;
    harnessRoots = harnessRoots.length > 0 ? harnessRoots : resolved.allHarnesses;
    if (publicCatalog === undefined && fs.existsSync(resolved.publicCatalogPath)) publicCatalog = JSON.parse(fs.readFileSync(resolved.publicCatalogPath, 'utf8'));
    if (localOverlay === undefined && resolved.localOverlayPath && fs.existsSync(resolved.localOverlayPath)) localOverlay = JSON.parse(fs.readFileSync(resolved.localOverlayPath, 'utf8'));
  }
  const validated = validateInventoryDocument(document);
  if (validated.status !== 'valid') return { ok: false, mutate: false, reason: validated.reason || 'inventory_unsupported' };
  if (!sourceStorePath || !acceptedGenerationPath) throw new Error('sourceStorePath and acceptedGenerationPath are required');
  const manual = loadManualInputs({ publicCatalog, localOverlay });
  const prior = readAcceptedGeneration(acceptedGenerationPath);
  const priorIdentities = new Map((prior?.identities || []).map((identity) => [identity.logicalId, identity]));
  const publicIds = new Set((manual.publicCatalog?.entries || []).map((entry) => entry.id));
  const generatedIds = new Set((prior?.generatedOverlay?.entries || []).map((entry) => entry.id));
  const manualEntries = (manual.localOverlay?.entries || []).filter((entry) => !generatedIds.has(entry.id));
  const manualIds = new Set(manualEntries.map((entry) => entry.id));
  const manualMigration = manual.error
    ? { required: false, candidates: [] }
    : legacyManualMigration({
      manualEntries,
      oldLocalSourceRoot: resolved?.localSourceRoot || null,
      sourceStorePath,
    });
  const retirementPolicy = normalizeRetirementPolicy(
    config?.inventory?.retirement || {},
    { intervalMinutes: config?.scheduler?.intervalMinutes || 60 },
  );
  const priorAbsences = (prior && typeof prior.absences === 'object' && prior.absences) || {};
  const nextAbsences = {};
  const retireIds = new Set();
  const candidates = [];
  const assessed = [];
  const observedLogicalIds = new Set();

  for (const skill of validated.document.skills) {
    observedLogicalIds.add(skill.logicalId);
    const sources = sourceRootsFor(skill, validated.document.roots);
    let result = { ...skill, ...stableDisposition('needs_input', 'incomplete_observation') };
    // Preserve owner exclusions applied by inventory observation.
    if (skill.disposition?.kind === 'blocked' && skill.disposition?.reasonCode === 'owner_excluded') {
      if (priorEntryFor(prior, skill.logicalId)) retireIds.add(skill.logicalId);
      assessed.push({ ...result, ...stableDisposition('blocked', 'owner_excluded', 'quiet') });
      continue;
    }
    if (manual.error) {
      assessed.push({ ...result, ...stableDisposition('needs_input', 'needs_owner_input', 'actionable') });
      continue;
    }
    const liveObservations = (skill.observations || []).filter((item) => item.state !== 'missing');
    const onlyMissing = liveObservations.length === 0
      && (skill.observations || []).length > 0
      && (skill.observations || []).every((item) => item.state === 'missing');
    if (onlyMissing) {
      // Track consecutive complete-generation absences for retirement.
      if (complete && priorEntryFor(prior, skill.logicalId)) {
        const absence = recordAbsence(priorAbsences, skill.logicalId, validated.document.observedAt, retirementPolicy);
        nextAbsences[skill.logicalId] = absence;
        if (absence.retireReady) {
          retireIds.add(skill.logicalId);
          assessed.push({ ...result, ...stableDisposition('already_managed', 'source_retired', 'quiet') });
        } else {
          assessed.push({ ...result, ...stableDisposition('needs_input', 'source_absent', 'actionable') });
        }
      } else if (skill.observations.some((item) => item.state === 'unsafe')) {
        assessed.push({ ...result, ...stableDisposition('blocked', 'unsafe_source', 'actionable') });
      } else {
        assessed.push({ ...result, ...stableDisposition('needs_input', 'source_absent', 'quiet') });
      }
      continue;
    }
    if (sources.length === 0 || skill.observations.some((item) => item.state === 'unsafe')) {
      assessed.push({ ...result, ...stableDisposition('blocked', 'unsafe_source', 'actionable') });
      continue;
    }
    const featureByDigest = new Map();
    const sourceByDigest = new Map();
    try {
      for (const source of sources) {
        const feature = featuresFor(source.observation.absolutePath, null);
        featureByDigest.set(feature.tree.treeDigest, feature);
        if (!sourceByDigest.has(feature.tree.treeDigest)) sourceByDigest.set(feature.tree.treeDigest, source);
      }
    } catch {
      assessed.push({ ...result, ...stableDisposition('blocked', 'unsafe_source', 'actionable') });
      continue;
    }
    const reviewed = reviewDivergence({ skill, variants: featureByDigest, reviewer });
    if (reviewed.status === 'needs_input') {
      assessed.push({ ...result, ...stableDisposition('needs_input', reviewed.reasonCode, 'actionable') });
      continue;
    }
    const selectedDigest = reviewed.selectedDigest || skill.treeDigest;
    const feature = featureByDigest.get(selectedDigest);
    const source = sourceByDigest.get(selectedDigest);
    // Reviewer may select any observed same-purpose variant; prefer that digest.
    if (!feature || !source || !featureByDigest.has(selectedDigest)) {
      assessed.push({ ...result, ...stableDisposition('needs_input', 'ambiguous_identity', 'actionable') });
      continue;
    }
    // Collapse the skill identity onto the selected digest for admission.
    result = { ...result, treeDigest: selectedDigest };
    if (feature.hasSecret) {
      assessed.push({ ...result, ...stableDisposition('blocked', 'privacy_restricted', 'actionable') });
      continue;
    }
    if (feature.hasInjection) {
      assessed.push({ ...result, ...stableDisposition('blocked', 'unsafe_source', 'actionable') });
      continue;
    }
    if (feature.hasNetwork || feature.hasPluginOrInteractive) {
      assessed.push({ ...result, ...stableDisposition('needs_input', 'needs_owner_input', 'actionable') });
      continue;
    }
    const trustClasses = new Set(sources.map((item) => item.root.trustClass));
    if (feature.capabilities.includes('scripts') && trustClasses.has('markdown-only')) {
      assessed.push({ ...result, ...stableDisposition('blocked', 'trust_class_insufficient', 'actionable') });
      continue;
    }
    if (feature.hasNativeSyntax) {
      assessed.push({ ...result, ...stableDisposition('harness_local', 'harness_native') });
      continue;
    }
    const priorMeta = priorEntryFor(prior, skill.logicalId);
    const priorIdentity = priorMeta?.identity || priorIdentities.get(skill.logicalId) || null;
    if (priorIdentity && priorIdentity.profileDigest && priorIdentity.profileDigest !== feature.profileDigest) {
      assessed.push({ ...result, ...stableDisposition('needs_input', 'capability_unsupported', 'actionable') });
      continue;
    }
    const effectiveName = priorIdentity?.effectiveName || skill.logicalId;
    if (publicIds.has(effectiveName) || manualIds.has(effectiveName)) {
      assessed.push({ ...result, ...stableDisposition('blocked', 'ambiguous_identity', 'actionable') });
      continue;
    }
    const isUpdate = Boolean(priorMeta?.treeDigest && priorMeta.treeDigest !== feature.tree.treeDigest);
    const isSameManaged = Boolean(priorMeta?.treeDigest && priorMeta.treeDigest === feature.tree.treeDigest);
    // A receipt at a source root means the unchanged source is already managed,
    // but it must never suppress a safe update from a newer source digest.
    if (!isUpdate && receiptOwns(sources.map((item) => ({ root: item.root.root })), skill.logicalId)) {
      assessed.push({ ...result, ...stableDisposition('already_managed', 'already_managed_receipt') });
      continue;
    }
    const targets = compatibleTargets(skill, harnessRoots, { forUpdate: isUpdate });
    // Prefer prior allowed harnesses on update so the matrix does not shrink.
    const priorAllowed = priorMeta?.entry?.allowedHarnesses || [];
    const allowedHarnesses = [...new Set([
      ...targets,
      ...(isUpdate || isSameManaged ? priorAllowed : []),
    ])].filter((harness) => !skill.matrix.some((row) => row.harness === harness && row.projection === 'source_present'));

    if (!isUpdate && targets.length === 0 && isSameManaged) {
      assessed.push({ ...result, ...stableDisposition('already_managed', 'already_managed_receipt') });
      continue;
    }
    if (!isUpdate && !isSameManaged && targets.length === 0) {
      assessed.push({ ...result, ...stableDisposition('already_managed', 'already_managed_receipt') });
      continue;
    }
    if (allowedHarnesses.length === 0) {
      assessed.push({ ...result, ...stableDisposition('already_managed', 'already_managed_receipt') });
      continue;
    }
    // Incomplete generations may classify but must not admit/capture.
    if (!complete || autoAdmit === false || persist === false) {
      assessed.push({
        ...result,
        ...stableDisposition(
          complete ? 'shared' : 'needs_input',
          complete ? 'rule_proven_portable' : 'incomplete_observation',
          complete ? 'quiet' : 'quiet',
        ),
      });
      continue;
    }
    // Same-digest managed skills with no missing destinations stay quiet and
    // are preserved via prior-overlay merge below (not re-captured).
    if (isSameManaged && targets.length === 0) {
      assessed.push({ ...result, ...stableDisposition('already_managed', 'already_managed_receipt') });
      continue;
    }
    candidates.push({
      id: effectiveName,
      logicalId: skill.logicalId,
      sourcePath: source.observation.absolutePath,
      treeDigest: feature.tree.treeDigest,
      allowlist: feature.tree.allowlist,
      allowedHarnesses: allowedHarnesses.length > 0 ? allowedHarnesses : targets,
      profileDigest: feature.profileDigest,
      mode: isUpdate ? 'update' : 'admit',
    });
    assessed.push({ ...result, ...stableDisposition('shared', isUpdate ? 'rule_proven_update' : 'rule_proven_portable') });
  }

  // Also retire prior-managed skills that vanished entirely from this complete generation.
  if (complete && prior) {
    for (const identity of prior.identities || []) {
      if (observedLogicalIds.has(identity.logicalId)) continue;
      if (retireIds.has(identity.logicalId)) continue;
      const absence = recordAbsence(priorAbsences, identity.logicalId, validated.document.observedAt, retirementPolicy);
      nextAbsences[identity.logicalId] = absence;
      if (absence.retireReady) {
        retireIds.add(identity.logicalId);
        assessed.push({
          logicalId: identity.logicalId,
          observedName: identity.effectiveName || identity.logicalId,
          treeDigest: priorEntryFor(prior, identity.logicalId)?.treeDigest || '0'.repeat(64),
          observations: [],
          matrix: SUPPORTED_HARNESSES.map((harness) => ({
            harness,
            projection: 'missing',
            verification: 'verification_pending',
          })),
          ...stableDisposition('already_managed', 'source_retired', 'quiet'),
        });
      }
    }
  }

  const nextDocument = { ...validated.document, skills: assessed };
  const classifications = nextDocument.skills.map((skill) => ({
    logicalId: skill.logicalId,
    disposition: skill.disposition,
    reasonCode: skill.disposition.reasonCode,
  }));
  const skippedAdmissions = !complete
    ? classifications.filter((item) => item.disposition.kind === 'needs_input').map((item) => ({ logicalId: item.logicalId, reason: 'incomplete_generation' }))
    : [];

  const shouldMutate = complete && autoAdmit !== false && persist !== false
    && (candidates.length > 0 || retireIds.size > 0 || manualMigration.required);

  if (!shouldMutate) {
    // Still persist absence counters on complete generations so retirement can advance.
    if (complete && persist !== false && Object.keys(nextAbsences).length > 0 && prior) {
      const absenceOnly = {
        ...prior,
        absences: { ...priorAbsences, ...nextAbsences },
      };
      // Drop cleared absences for skills that reappeared.
      for (const logicalId of observedLogicalIds) {
        if (!nextAbsences[logicalId] && absenceOnly.absences[logicalId]) {
          delete absenceOnly.absences[logicalId];
        }
      }
      atomicWriteJson(acceptedGenerationPath, absenceOnly);
    }
    const status = serializeOutwardStatus(nextDocument);
    return {
      ok: true,
      mutate: false,
      document: nextDocument,
      generatedOverlay: prior?.generatedOverlay || { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
      acceptedGeneration: prior,
      sourceRoot: prior?.sourceRoot || null,
      localSourceRoot: sourceStorePath,
      admissions: [],
      retirements: [...retireIds],
      skippedAdmissions,
      classifications,
      status,
    };
  }

  // Capture only skills that need a new immutable generation (new or updated digest).
  const generatedCaptureCandidates = candidates.filter((candidate) => {
    const priorMeta = priorEntryFor(prior, candidate.logicalId);
    return !priorMeta || priorMeta.treeDigest !== candidate.treeDigest;
  });
  const captureCandidates = [...generatedCaptureCandidates, ...manualMigration.candidates];
  const captured = captureCandidates.length > 0
    ? captureAcceptedGeneration({
      sourceStorePath,
      acceptedGenerationPath,
      generationId: validated.document.generationId,
      acceptedAt: acceptedAt || validated.document.observedAt,
      candidates: captureCandidates,
    })
    : { changed: false, generation: prior, sourceRoot: prior?.sourceRoot || null };

  const capturedById = new Map(
    generatedCaptureCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const retainedPriorEntries = (prior?.generatedOverlay?.entries || [])
    .filter((entry) => {
      const identity = (prior.identities || []).find((item) => item.effectiveName === entry.id || item.logicalId === entry.id);
      const logicalId = identity?.logicalId || entry.id;
      if (retireIds.has(logicalId)) return false;
      // Replaced by a fresh capture/candidate with same id.
      if (capturedById.has(entry.id)) return false;
      if (candidates.some((candidate) => candidate.id === entry.id)) return false;
      return true;
    });

  const newEntries = candidates.map((candidate) => ({
    id: candidate.id,
    allowedHarnesses: candidate.allowedHarnesses,
    verification: Object.fromEntries(candidate.allowedHarnesses.map((harness) => [harness, { tier: 'adapter-declared', remoteModelProbe: false }])),
    bundle: {
      root: path.posix.join(
        ((captured.changed || captured.recoveryNeeded) ? validated.document.generationId : (prior?.generationId || validated.document.generationId)),
        candidate.id,
      ),
      allowlist: candidate.allowlist,
      treeDigest: candidate.treeDigest,
    },
  }));

  const generatedOverlay = {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    entries: [...retainedPriorEntries, ...newEntries].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const capturedGenerationId = (captured.changed || captured.recoveryNeeded)
    ? validated.document.generationId
    : (prior?.generationId || validated.document.generationId);
  const migratedManualById = new Map(manualMigration.candidates.map((candidate) => [candidate.id, candidate]));
  const migratedManualEntries = manualEntries.map((entry) => (
    migratedManualById.has(entry.id)
      ? {
        ...entry,
        bundle: {
          ...entry.bundle,
          root: path.posix.join(capturedGenerationId, entry.id),
        },
      }
      : entry
  ));
  const compositeOverlay = {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    entries: [...migratedManualEntries, ...generatedOverlay.entries],
  };
  const effective = composeEffectiveCatalog({ publicCatalog: manual.publicCatalog, localOverlay: compositeOverlay });
  if (effective.status !== 'valid') throw new Error(effective.reason || 'generated catalog is invalid');

  const retainedIdentities = (prior?.identities || [])
    .filter((identity) => !retireIds.has(identity.logicalId)
      && !candidates.some((candidate) => candidate.logicalId === identity.logicalId));
  const nextIdentities = [
    ...retainedIdentities,
    ...candidates.map((candidate) => ({
      logicalId: candidate.logicalId,
      effectiveName: candidate.id,
      profileDigest: candidate.profileDigest,
    })),
  ];

  // Drop absence counters for skills that are live again; keep remaining counters.
  const mergedAbsences = { ...priorAbsences, ...nextAbsences };
  for (const logicalId of observedLogicalIds) {
    if (!nextAbsences[logicalId] && mergedAbsences[logicalId]) delete mergedAbsences[logicalId];
  }
  for (const logicalId of retireIds) delete mergedAbsences[logicalId];

  const acceptedGeneration = {
    schemaVersion: 'jarvos.skill-source-generation/v1',
    generationId: capturedGenerationId,
    acceptedAt: acceptedAt || validated.document.observedAt,
    sourceRoot: captured.sourceRoot || prior?.sourceRoot || null,
    localSourceRoot: sourceStorePath,
    entries: compositeOverlay.entries.map((entry) => ({
      id: entry.id,
      treeDigest: entry.bundle.treeDigest,
      allowlist: entry.bundle.allowlist,
    })),
    identities: nextIdentities,
    generatedOverlay,
    absences: mergedAbsences,
    tombstones: [
      ...((prior?.tombstones || []).filter((item) => !observedLogicalIds.has(item.logicalId))),
      ...[...retireIds].map((logicalId) => ({
        logicalId,
        retiredAt: acceptedAt || validated.document.observedAt,
        reasonCode: 'source_absent',
      })),
    ],
  };

  // Always rewrite the accepted pointer when we mutate overlay/absences/retirements,
  // even if capture was a no-op (pure retirement).
  if (persist !== false && resolved?.localOverlayPath) {
    atomicWriteJson(resolved.localOverlayPath, compositeOverlay);
  }
  atomicWriteJson(acceptedGenerationPath, acceptedGeneration);
  if (persist !== false && config && resolved && config.localSourceRoot !== sourceStorePath) {
    saveConfig({ ...config, localSourceRoot: sourceStorePath }, configPath);
  }
  const admittedDocument = {
    ...nextDocument,
    acceptedGenerationId: acceptedGeneration.generationId,
    acceptedAt: acceptedGeneration.acceptedAt,
  };
  return {
    ok: true,
    mutate: true,
    document: admittedDocument,
    generatedOverlay,
    localOverlay: compositeOverlay,
    effectiveCatalog: effective,
    acceptedGeneration,
    sourceRoot: acceptedGeneration.sourceRoot,
    // Bundle roots are generation/id relative to the immutable store, not to
    // one generation directory. Keep the configured root at the store level.
    localSourceRoot: sourceStorePath,
    admissions: candidates.map((candidate) => ({
      logicalId: candidate.logicalId,
      treeDigest: candidate.treeDigest,
      created: generatedCaptureCandidates.some((item) => item.logicalId === candidate.logicalId),
      mode: candidate.mode || 'admit',
    })),
    retirements: [...retireIds],
    skippedAdmissions,
    classifications,
    status: serializeOutwardStatus(admittedDocument),
  };
}

function assessAndAdmitFromObservation(options = {}) {
  const { observeInventory } = require('./inventory');
  const observation = observeInventory({
    configPath: options.configPath,
    controlRoot: options.controlRoot,
    persist: options.persist !== false,
    observedAt: options.observedAt,
  });
  const assessment = assessInventory({
    ...options,
    document: observation.document,
    complete: observation.complete,
  });
  return { ok: assessment.ok, observation, assessment, status: assessment.status };
}

module.exports = {
  analyzeBundle,
  assessInventory,
  assessAndAdmitFromObservation,
  buildRedactedReviewFeatures,
  principalMayAutoAdmit,
  featuresFor,
};
