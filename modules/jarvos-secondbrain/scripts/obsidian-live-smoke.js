#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hashUtf8, validateVaultRelativeMarkdownPath } = require('../adapters/obsidian/src/vault-mutation-contract');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

const LIVE_GATE = 'JARVOS_LIVE_OBSIDIAN_SMOKE';
const CANDIDATE_MANIFEST_ENV = 'JARVOS_LIVE_CANDIDATE_MANIFEST';
const RUNTIME_MANIFEST_ENV = 'JARVOS_LIVE_RUNTIME_MANIFEST';
const ATTESTATION_PATH_ENV = 'JARVOS_LIVE_ATTESTATION_PATH';
const SMOKE_DIRECTORY_ENV = 'JARVOS_LIVE_OBSIDIAN_SMOKE_DIR';
const MINIMUM_OBSIDIAN_VERSION = [1, 12, 7];
const HEALTH_FIELDS = Object.freeze(['pending', 'ambiguous', 'conflict', 'quarantined', 'malformed', 'retainedTerminal']);
const ACTIVE_HEALTH_FIELDS = Object.freeze(['pending', 'ambiguous', 'conflict', 'quarantined', 'malformed']);

function readJsonFile(filePath, label) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) { throw new Error(`${label} is unreadable or invalid JSON: ${error.message}`); }
}

function isDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }

function assertMatchingManifests({ candidatePath, runtimePath } = {}) {
  const candidate = readJsonFile(candidatePath, CANDIDATE_MANIFEST_ENV);
  const runtime = readJsonFile(runtimePath, RUNTIME_MANIFEST_ENV);
  if (candidate.clean !== true) throw new Error('Candidate manifest must attest a clean source revision');
  if (typeof candidate.revision !== 'string' || !candidate.revision || candidate.revision !== runtime.revision) throw new Error('Candidate and runtime revisions do not match');
  if (!isDigest(candidate.artifactManifestHash) || candidate.artifactManifestHash !== runtime.artifactManifestHash) throw new Error('Candidate and runtime artifact manifests do not match');
  const gates = candidate.gateOutputDigests;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates) || Object.keys(gates).length === 0 || !Object.values(gates).every(isDigest)) throw new Error('Candidate manifest must include gate output digests');
  return Object.freeze({
    revision: candidate.revision,
    artifactManifestHash: candidate.artifactManifestHash.toLowerCase(),
    gateOutputDigests: Object.freeze({ ...gates }),
    equality: true,
  });
}

function writePrivateAttestation(filePath, value, { vaultRoot } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error(`${ATTESTATION_PATH_ENV} must be an absolute path`);
  const resolved = path.resolve(filePath);
  const root = path.resolve(vaultRoot);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) throw new Error('Live attestation must remain outside the Obsidian vault');
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, resolved);
  fs.chmodSync(resolved, 0o600);
}

function normalizeHealth(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} mutation health is unavailable`);
  const normalized = {};
  for (const field of HEALTH_FIELDS) {
    const count = value[field] ?? (field === 'malformed' ? 0 : undefined);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label} mutation health has an invalid ${field} count`);
    normalized[field] = count;
  }
  return Object.freeze(normalized);
}

function assertSafeHealthDelta(before, after, expectedTerminalDelta) {
  for (const field of ACTIVE_HEALTH_FIELDS) {
    if (after[field] !== before[field]) throw new Error(`Live smoke changed active mutation health: ${field} ${before[field]} -> ${after[field]}`);
  }
  if (after.retainedTerminal !== before.retainedTerminal + expectedTerminalDelta) {
    throw new Error(`Live smoke retained-terminal delta was ${after.retainedTerminal - before.retainedTerminal}; expected ${expectedTerminalDelta}`);
  }
}

function parseObsidianVersion(output) {
  const match = String(output || '').match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}

function isSupportedObsidianVersion(version) {
  if (!Array.isArray(version) || version.length !== 3 || version.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < MINIMUM_OBSIDIAN_VERSION.length; index += 1) {
    if (version[index] !== MINIMUM_OBSIDIAN_VERSION[index]) return version[index] > MINIMUM_OBSIDIAN_VERSION[index];
  }
  return true;
}

function verifyObsidianCli({ command = 'obsidian', execute = execFileSync } = {}) {
  let output;
  try {
    output = execute(command, ['version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    throw new Error(`Registered Obsidian CLI could not run \`${command} version\`${detail ? `: ${detail}` : ''}`);
  }
  const version = parseObsidianVersion(output);
  if (!isSupportedObsidianVersion(version)) throw new Error(`Obsidian CLI must report version ${MINIMUM_OBSIDIAN_VERSION.join('.')} or newer; got ${String(output).trim() || '(no version)'}`);
  return Object.freeze({ command, version: version.join('.') });
}

function fixturePathFor({ smokeDirectory, nonce }) {
  if (typeof smokeDirectory !== 'string' || !smokeDirectory || path.posix.normalize(smokeDirectory) !== smokeDirectory || smokeDirectory === '.' || smokeDirectory.startsWith('../') || smokeDirectory.includes('\\')) throw new Error(`${SMOKE_DIRECTORY_ENV} must be a normalized vault-relative directory`);
  if (!/^[a-f0-9-]{16,64}$/i.test(nonce)) throw new Error('Smoke nonce is invalid');
  return validateVaultRelativeMarkdownPath(`${smokeDirectory}/jarvos-live-smoke-${nonce}.md`);
}

function committed(result, phase) {
  if (!result || !['committed', 'already_satisfied'].includes(result.status) || result.obsidian !== 'acknowledged') throw new Error(`${phase} was not acknowledged by Obsidian`);
}

function runLiveSmoke({
  env = process.env,
  execute = execFileSync,
  serviceFactory = createConfiguredVaultMutationService,
  nonce = crypto.randomUUID(),
  inspectSync,
  now = () => new Date().toISOString(),
} = {}) {
  if (env[LIVE_GATE] !== '1') return { skipped: true, reason: `${LIVE_GATE} is not 1` };

  const vaultRoot = path.resolve(env.JARVOS_VAULT_ROOT || '');
  if (!env.JARVOS_VAULT_ROOT || !path.isAbsolute(env.JARVOS_VAULT_ROOT)) throw new Error('JARVOS_VAULT_ROOT must be an absolute path');
  const manifest = assertMatchingManifests({ candidatePath: env[CANDIDATE_MANIFEST_ENV], runtimePath: env[RUNTIME_MANIFEST_ENV] });
  const attestationPath = env[ATTESTATION_PATH_ENV];
  const cli = verifyObsidianCli({ command: env.OBSIDIAN_CLI || 'obsidian', execute });
  const smokeDirectory = env[SMOKE_DIRECTORY_ENV] || 'JarVOS Smoke';
  if (!fs.statSync(path.join(vaultRoot, smokeDirectory), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Dedicated smoke directory does not exist: ${smokeDirectory}`);

  const vaultRelativePath = fixturePathFor({ smokeDirectory, nonce });
  const deleteAuthority = (operation) => operation.source === 'operator.obsidian-live-smoke' && operation.vaultRelativePath === vaultRelativePath;
  const service = serviceFactory({ vaultRoot, source: 'operator.obsidian-live-smoke', allowDeleteOperation: deleteAuthority });
  const baseline = normalizeHealth(service.reconciler.health(), 'Baseline');
  const initialContent = `---\njarvos_smoke_fixture: true\nnonce: ${nonce}\n---\n\n# jarvOS Obsidian Live Smoke\n`;
  const appendedLine = `- acknowledged transform: ${nonce}`;
  const finalContent = `${initialContent}${appendedLine}\n`;
  const createContext = service.createWriteContext({ vaultRelativePath, operationId: `smoke-create-${nonce}` });
  const createOperation = {
    schemaVersion: 1,
    operationId: createContext.operationId,
    vaultId: createContext.vaultId,
    vaultRelativePath,
    sequence: createContext.sequence,
    operationKind: 'create',
    content: initialContent,
    source: createContext.source,
  };
  const absence = service.adapter.inspectInvariant(createOperation);
  if (absence.status !== 'missing') throw new Error('Disposable smoke fixture was not proven absent through Obsidian');

  const attestation = {
    schemaVersion: 1,
    startedAt: now(),
    manifest,
    fixture: { vaultRelativePath, expectedTerminalDelta: 3 },
    baseline,
    status: 'preflight_verified',
  };
  writePrivateAttestation(attestationPath, attestation, { vaultRoot });

  let created = false;
  let transformed = false;
  try {
    const createResult = createContext.mutationExecutor(createOperation);
    committed(createResult, 'Fixture create');
    created = true;

    const transformContext = service.createWriteContext({ vaultRelativePath, operationId: `smoke-transform-${nonce}` });
    const transformResult = transformContext.mutationExecutor({
      schemaVersion: 1,
      operationId: transformContext.operationId,
      vaultId: transformContext.vaultId,
      vaultRelativePath,
      sequence: transformContext.sequence,
      operationKind: 'transform',
      transformName: 'append-line',
      transformVersion: 1,
      replayPayload: { line: appendedLine },
      source: transformContext.source,
    });
    committed(transformResult, 'Fixture transform');
    transformed = true;

    if (typeof inspectSync !== 'function') throw new Error('Live rollout requires the configured per-file Sync inspector');
    const sync = inspectSync({ vaultId: service.vaultId, vaultRelativePath, expectedHash: hashUtf8(finalContent) });
    if (!sync || sync.status !== 'converged') throw new Error(`Live rollout Sync did not converge: ${sync?.status || 'invalid'}`);

    const deleteResult = service.deleteMarkdownFile({
      vaultRelativePath,
      expectedContent: finalContent,
      operationId: `smoke-delete-${nonce}`,
    });
    committed(deleteResult, 'Fixture deletion');
    created = false;
    const deletion = service.adapter.inspectInvariant({
      schemaVersion: 1,
      operationId: `smoke-delete-check-${nonce}`,
      vaultId: service.vaultId,
      vaultRelativePath,
      sequence: 1,
      operationKind: 'delete',
      expectedContent: finalContent,
      expectedHash: hashUtf8(finalContent),
      source: 'operator.obsidian-live-smoke',
    });
    if (deletion.status !== 'satisfied' || deletion.invariant !== true) throw new Error('Obsidian did not confirm fixture deletion');

    const after = normalizeHealth(service.reconciler.health(), 'Post-smoke');
    assertSafeHealthDelta(baseline, after, 3);
    const result = { skipped: false, obsidianVersion: cli.version, fixture: vaultRelativePath, create: 'acknowledged', transform: 'acknowledged', deletion: 'acknowledged', sync, baseline, after };
    writePrivateAttestation(attestationPath, { ...attestation, completedAt: now(), status: 'passed', result }, { vaultRoot });
    return result;
  } catch (error) {
    const expectedContent = transformed ? finalContent : initialContent;
    if (created) {
      try { service.deleteMarkdownFile({ vaultRelativePath, expectedContent, operationId: `smoke-cleanup-${nonce}` }); } catch { /* guarded cleanup failure leaves the fixture for operator inspection */ }
    }
    writePrivateAttestation(attestationPath, { ...attestation, failedAt: now(), status: 'failed', failure: error.message }, { vaultRoot });
    throw error;
  }
}

function main() {
  try { process.stdout.write(`${JSON.stringify(runLiveSmoke())}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
}

module.exports = {
  ACTIVE_HEALTH_FIELDS,
  ATTESTATION_PATH_ENV,
  CANDIDATE_MANIFEST_ENV,
  HEALTH_FIELDS,
  LIVE_GATE,
  MINIMUM_OBSIDIAN_VERSION,
  RUNTIME_MANIFEST_ENV,
  SMOKE_DIRECTORY_ENV,
  assertMatchingManifests,
  assertSafeHealthDelta,
  fixturePathFor,
  normalizeHealth,
  parseObsidianVersion,
  runLiveSmoke,
  verifyObsidianCli,
  writePrivateAttestation,
};

if (require.main === module) main();
