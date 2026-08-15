'use strict';

/**
 * U3 rule-proven assessment.  It consumes U2 observations; it never scans an
 * ambient root, runs bundle code, loads a plugin, or makes a network request.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_ALLOWED_BUNDLE_GLOBS, OVERLAY_SCHEMA_VERSION, SUPPORTED_HARNESSES, computeBundleTree, validateLocalOverlay, validatePublicCatalog, composeEffectiveCatalog, CATALOG_SCHEMA_VERSION } = require('./catalog');
const { validateInventoryDocument, serializeOutwardStatus } = require('./inventory-contract');
const { captureAcceptedGeneration, readAcceptedGeneration } = require('./source-store');
const { readReceipt, validateReceipt } = require('./receipts');
const { loadConfig, resolveConfigPaths, atomicWriteJson, saveConfig } = require('./config');

const SECRET_RE = /(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const INJECTION_RE = /(?:ignore\s+(?:all\s+)?previous\s+instructions|system\s+message|exfiltrat(?:e|ion)|reveal\s+(?:your\s+)?(?:prompt|instructions))/i;
const NETWORK_RE = /(?:https?:\/\/|\b(?:curl|wget|fetch|axios|requests?)\b)/i;
const PLUGIN_RE = /\b(?:plugin|mcp|credential|interactive|hook)\b/i;
const NATIVE_RE = /\b(?:codex|claude|openclaw|hermes)[-_ ]?(?:only|native|specific)\b/i;

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function safeReadSkillMd(bundlePath) {
  const file = path.join(bundlePath, 'SKILL.md');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('unsafe_skill_metadata');
  return fs.readFileSync(file, 'utf8');
}

function featuresFor(bundlePath, expectedDigest) {
  const tree = computeBundleTree(bundlePath, { allowlist: DEFAULT_ALLOWED_BUNDLE_GLOBS, expectedDigest });
  const body = safeReadSkillMd(tree.root);
  const scripts = tree.entries.some((entry) => entry.path.startsWith('scripts/'));
  const capabilities = [
    ...(scripts ? ['scripts'] : []),
    ...(NETWORK_RE.test(body) ? ['network'] : []),
    ...(PLUGIN_RE.test(body) ? ['plugin_or_interactive'] : []),
    ...(NATIVE_RE.test(body) ? ['native_syntax'] : []),
  ].sort();
  return {
    tree,
    hasSecret: SECRET_RE.test(body),
    hasInjection: INJECTION_RE.test(body),
    hasNetwork: NETWORK_RE.test(body),
    hasPluginOrInteractive: PLUGIN_RE.test(body),
    hasNativeSyntax: NATIVE_RE.test(body),
    capabilities,
    profileDigest: digest(JSON.stringify({ capabilities, scripts, native: NATIVE_RE.test(body) })),
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

function compatibleTargets(skill, harnessRoots) {
  const sourcePresent = new Set(skill.matrix.filter((row) => row.projection === 'source_present').map((row) => row.harness));
  return SUPPORTED_HARNESSES.filter((harness) => !sourcePresent.has(harness)
    && !receiptOwns((harnessRoots || []).filter((root) => root.harness === harness), skill.logicalId));
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
} = {}) {
  let resolved = null;
  let config = null;
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
  const candidates = [];
  const assessed = [];

  for (const skill of validated.document.skills) {
    const sources = sourceRootsFor(skill, validated.document.roots);
    let result = { ...skill, ...stableDisposition('needs_input', 'incomplete_observation') };
    // Preserve owner exclusions applied by inventory observation.
    if (skill.disposition?.kind === 'blocked' && skill.disposition?.reasonCode === 'owner_excluded') {
      assessed.push({ ...result, ...stableDisposition('blocked', 'owner_excluded', 'quiet') });
      continue;
    }
    if (manual.error) {
      assessed.push({ ...result, ...stableDisposition('needs_input', 'needs_owner_input', 'actionable') });
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
    if (!feature || !source || selectedDigest !== skill.treeDigest) {
      assessed.push({ ...result, ...stableDisposition('needs_input', 'ambiguous_identity', 'actionable') });
      continue;
    }
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
    const targets = compatibleTargets(skill, harnessRoots);
    if (feature.hasNativeSyntax || targets.length === 0) {
      assessed.push({ ...result, ...stableDisposition(feature.hasNativeSyntax ? 'harness_local' : 'already_managed', feature.hasNativeSyntax ? 'harness_native' : 'already_managed_receipt') });
      continue;
    }
    if (receiptOwns(sources.map((item) => ({ root: item.root.root })), skill.logicalId)) {
      assessed.push({ ...result, ...stableDisposition('already_managed', 'already_managed_receipt') });
      continue;
    }
    const priorIdentity = priorIdentities.get(skill.logicalId);
    if (priorIdentity && priorIdentity.profileDigest !== feature.profileDigest) {
      assessed.push({ ...result, ...stableDisposition('needs_input', 'capability_unsupported', 'actionable') });
      continue;
    }
    const effectiveName = priorIdentity?.effectiveName || skill.logicalId;
    if (publicIds.has(effectiveName) || manualIds.has(effectiveName)) {
      assessed.push({ ...result, ...stableDisposition('blocked', 'ambiguous_identity', 'actionable') });
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
    candidates.push({ id: effectiveName, logicalId: skill.logicalId, sourcePath: source.observation.absolutePath, treeDigest: feature.tree.treeDigest, allowlist: feature.tree.allowlist, allowedHarnesses: targets, profileDigest: feature.profileDigest });
    assessed.push({ ...result, ...stableDisposition('shared', 'rule_proven_portable') });
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
  if (candidates.length === 0 || !complete || autoAdmit === false || persist === false) {
    const status = serializeOutwardStatus(nextDocument);
    return {
      ok: true,
      mutate: false,
      document: nextDocument,
      generatedOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
      acceptedGeneration: prior,
      sourceRoot: prior?.sourceRoot || null,
      localSourceRoot: sourceStorePath,
      admissions: [],
      skippedAdmissions,
      classifications,
      status,
    };
  }
  const captured = captureAcceptedGeneration({
    sourceStorePath,
    acceptedGenerationPath,
    generationId: validated.document.generationId,
    acceptedAt: acceptedAt || validated.document.observedAt,
    candidates,
  });
  const generatedOverlay = {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    entries: candidates.map((candidate) => ({
      id: candidate.id,
      allowedHarnesses: candidate.allowedHarnesses,
      verification: Object.fromEntries(candidate.allowedHarnesses.map((harness) => [harness, { tier: 'adapter-declared', remoteModelProbe: false }])),
      bundle: { root: path.posix.join(validated.document.generationId, candidate.id), allowlist: candidate.allowlist, treeDigest: candidate.treeDigest },
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
  const compositeOverlay = { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [...manualEntries, ...generatedOverlay.entries] };
  const effective = composeEffectiveCatalog({ publicCatalog: manual.publicCatalog, localOverlay: compositeOverlay });
  if (effective.status !== 'valid') throw new Error(effective.reason || 'generated catalog is invalid');
  const acceptedGeneration = {
    schemaVersion: 'jarvos.skill-source-generation/v1',
    generationId: validated.document.generationId,
    acceptedAt: acceptedAt || validated.document.observedAt,
    sourceRoot: captured.sourceRoot,
    localSourceRoot: sourceStorePath,
    entries: generatedOverlay.entries.map((entry) => ({ id: entry.id, treeDigest: entry.bundle.treeDigest, allowlist: entry.bundle.allowlist })),
    identities: candidates.map((candidate) => ({ logicalId: candidate.logicalId, effectiveName: candidate.id, profileDigest: candidate.profileDigest })),
    generatedOverlay,
  };
  // source-store has committed the immutable bytes; updating its pointer is
  // intentionally the final mutation and contains no body content.
  const changed = captured.changed;
  if (changed) {
    atomicWriteJson(acceptedGenerationPath, acceptedGeneration);
  }
  if (persist !== false && resolved?.localOverlayPath && (changed || !fs.existsSync(resolved.localOverlayPath))) {
    atomicWriteJson(resolved.localOverlayPath, compositeOverlay);
  }
  if (persist !== false && config && resolved && config.localSourceRoot !== sourceStorePath) {
    saveConfig({ ...config, localSourceRoot: sourceStorePath }, configPath);
  }
  const admittedDocument = { ...nextDocument, acceptedGenerationId: acceptedGeneration.generationId, acceptedAt: acceptedGeneration.acceptedAt };
  return {
    ok: true,
    mutate: changed,
    document: admittedDocument,
    generatedOverlay,
    effectiveCatalog: effective,
    acceptedGeneration,
    sourceRoot: captured.sourceRoot,
    admissions: candidates.map((candidate) => ({
      logicalId: candidate.logicalId,
      treeDigest: candidate.treeDigest,
      created: captured.changed,
    })),
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
