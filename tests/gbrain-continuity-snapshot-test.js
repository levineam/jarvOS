'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CONTINUITY_MODULE_ID,
  HEALTH_MODULE_DIRECTORY,
  loadHealthModules,
  modulePath,
} = require('../lib/jarvos-doctor-modules');
const { writeContinuitySnapshot } = require('../scripts/jarvos-gbrain-continuity-snapshot');

const NOW = new Date('2026-08-27T12:00:00.000Z');

function digest(seed) {
  return `sha256:${seed.charCodeAt(0).toString(16).repeat(64).slice(0, 64)}`;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-gbrain-snapshot-'));
  fs.chmodSync(root, 0o755);
  const runtime = path.join(root, 'runtime');
  const skills = path.join(runtime, 'skills');
  const skillify = path.join(skills, 'skillify');
  fs.mkdirSync(skillify, { recursive: true, mode: 0o755 });
  const executable = path.join(runtime, 'gbrain.js');
  fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
  const manifest = path.join(skills, 'manifest.json');
  const skill = path.join(skillify, 'SKILL.md');
  fs.writeFileSync(manifest, JSON.stringify({ skills: [{ name: 'skillify', path: 'skillify/SKILL.md' }] }), { mode: 0o644 });
  fs.writeFileSync(skill, '# Skillify\n', { mode: 0o644 });
  const descriptor = path.join(root, 'runtime.json');
  const interpreter = path.join(runtime, 'node-interpreter');
  fs.writeFileSync(interpreter, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(descriptor, JSON.stringify({
    schemaVersion: 'jarvos-gbrain-runtime-descriptor/v1',
    executablePath: executable,
    sha256: sha256File(executable),
    expectedOwnerUid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    version: '0.46.32.0',
    commit: 'd11b7992d7085ada60505730f53bda7ab4df3313',
    engineKind: 'postgres',
    storeIdentity: { host: '127.0.0.1', port: 5432, database: 'gbrain' },
    gbrainHome: path.join(root, 'gbrain-home'),
    gbrainStore: path.join(root, 'gbrain-store'),
    providerEnv: { GBRAIN_BRAIN_ID: 'test' },
    interpreter: {
      executablePath: interpreter,
      sha256: sha256File(interpreter),
      expectedOwnerUid: fs.statSync(interpreter).uid,
    },
    skills: {
      directoryPath: skills,
      manifestSha256: sha256File(manifest),
      skillifySha256: sha256File(skill),
    },
  }), { mode: 0o600 });
  fs.chmodSync(descriptor, 0o600);

  const probe = path.join(runtime, 'probe.js');
  fs.writeFileSync(probe, `
const target = process.env.JARVOS_CONTINUITY_TARGET;
process.stdout.write(JSON.stringify({
  schema: 'jarvos-gbrain-native-probe/v1',
  target,
  challengeDigest: process.env.JARVOS_CONTINUITY_CHALLENGE_DIGEST,
  probeGeneration: Number(process.env.JARVOS_CONTINUITY_PROBE_GENERATION),
  nativeRegistered: true,
  serviceReachable: true,
  capabilityProven: true,
  skillifyProven: target === 'codex',
  machineProven: true,
  jarvosRuntimeDigest: process.env.JARVOS_CONTINUITY_JARVOS_RUNTIME_DIGEST,
  gbrainRuntimeDigest: process.env.JARVOS_CONTINUITY_GBRAIN_RUNTIME_DIGEST,
  logicalBrainDigest: ${JSON.stringify(digest('l'))},
  storeDigest: ${JSON.stringify(digest('s'))},
  fixtureDigest: ${JSON.stringify(digest('f'))},
  liveTurnObserved: true,
}));
`, { mode: 0o700 });
  const probeCommand = path.join(runtime, 'probe-command');
  fs.writeFileSync(probeCommand, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}\n`, { mode: 0o700 });
  return { root, descriptor, probe, probeCommand };
}

function producerInput(probeCommand, generation = 11) {
  return {
    schema: 'jarvos-gbrain-continuity-producer-input/v1',
    generation,
    validForSeconds: 1800,
    jarvosRuntimeDigest: digest('j'),
    targets: ['codex', 'hermes', 'openclaw'].map((target) => ({
      target,
      command: probeCommand,
      args: [],
      timeoutMs: 5000,
      maintenanceBlocked: false,
      backupFresh: true,
    })),
  };
}

function writeInput(root, value, mode = 0o600) {
  const input = path.join(root, `input-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(input, `${JSON.stringify(value)}\n`, { mode });
  fs.chmodSync(input, mode);
  return input;
}

test('the producer runs native probes and atomically writes trusted continuity', () => {
  const { root, descriptor, probeCommand } = fixture();
  const input = writeInput(root, producerInput(probeCommand));
  const result = writeContinuitySnapshot({ workspace: root, input, descriptor, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.moduleId, CONTINUITY_MODULE_ID);
  assert.equal(result.generation, 11);
  assert.match(result.provenance.gbrainRuntimeDigest, /^sha256:/);
  assert.equal(fs.statSync(root).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(root, '.jarvos')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(modulePath(root, CONTINUITY_MODULE_ID))).mode & 0o777, 0o700);
  assert.equal(fs.statSync(modulePath(root, CONTINUITY_MODULE_ID)).mode & 0o777, 0o600);
  const report = loadHealthModules({ workspace: root, now: NOW, expectedContinuity: true });
  assert.equal(report.modules[0].state, 'healthy');
  assert.ok(report.modules[0].targets.every((item) => item.evidenceState === 'live-turn-proven'));
});

test('arbitrary full-snapshot input cannot create trusted live health', () => {
  const { root, descriptor } = fixture();
  const input = writeInput(root, {
    schema: 'jarvos-health-module-snapshot/v1',
    moduleId: CONTINUITY_MODULE_ID,
    generation: 1,
    trust: 'trusted',
    facts: { producer: 'jarvos-gbrain', targets: [] },
  });
  assert.throws(
    () => writeContinuitySnapshot({ workspace: root, input, descriptor, now: NOW }),
    /continuity-producer-input-invalid/,
  );
});

test('a replayed probe output cannot satisfy the current challenge', () => {
  const { root, descriptor } = fixture();
  const replay = path.join(root, 'runtime', 'replay.js');
  fs.writeFileSync(replay, `process.stdout.write(JSON.stringify({
    schema: 'jarvos-gbrain-native-probe/v1', target: process.env.JARVOS_CONTINUITY_TARGET,
    challengeDigest: ${JSON.stringify(digest('x'))}, probeGeneration: Number(process.env.JARVOS_CONTINUITY_PROBE_GENERATION),
    nativeRegistered: true, serviceReachable: true, capabilityProven: true, skillifyProven: true,
    machineProven: true, jarvosRuntimeDigest: process.env.JARVOS_CONTINUITY_JARVOS_RUNTIME_DIGEST,
    gbrainRuntimeDigest: process.env.JARVOS_CONTINUITY_GBRAIN_RUNTIME_DIGEST,
    logicalBrainDigest: ${JSON.stringify(digest('l'))}, storeDigest: ${JSON.stringify(digest('s'))},
    fixtureDigest: ${JSON.stringify(digest('f'))}, liveTurnObserved: true
  }));`, { mode: 0o700 });
  const replayCommand = path.join(root, 'runtime', 'replay-command');
  fs.writeFileSync(replayCommand, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(replay)}\n`, { mode: 0o700 });
  const input = writeInput(root, producerInput(replayCommand));
  writeContinuitySnapshot({ workspace: root, input, descriptor, now: NOW });
  const report = loadHealthModules({ workspace: root, now: NOW, expectedContinuity: true });
  assert.equal(report.modules[0].state, 'needs your attention');
  assert.ok(report.modules[0].targets.every((item) => item.evidenceState !== 'live-turn-proven'));
});

test('the writer rejects unsafe input and non-monotonic generations', () => {
  const { root, descriptor, probeCommand } = fixture();
  const unsafe = writeInput(root, producerInput(probeCommand), 0o644);
  assert.throws(() => writeContinuitySnapshot({ workspace: root, input: unsafe, descriptor, now: NOW }), /file-unsafe/);

  const first = writeInput(root, producerInput(probeCommand, 11));
  writeContinuitySnapshot({ workspace: root, input: first, descriptor, now: NOW });
  const same = writeInput(root, producerInput(probeCommand, 11));
  assert.throws(() => writeContinuitySnapshot({ workspace: root, input: same, descriptor, now: NOW }), /generation-not-newer/);
});

test('the owner-only lock serializes generation commits', () => {
  const { root, descriptor, probeCommand } = fixture();
  writeContinuitySnapshot({ workspace: root, input: writeInput(root, producerInput(probeCommand, 11)), descriptor, now: NOW });
  const lock = path.join(root, HEALTH_MODULE_DIRECTORY, `.${CONTINUITY_MODULE_ID}.lock`);
  fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  assert.throws(
    () => writeContinuitySnapshot({ workspace: root, input: writeInput(root, producerInput(probeCommand, 12)), descriptor, now: NOW }),
    /writer-busy/,
  );
  fs.unlinkSync(lock);
  writeContinuitySnapshot({ workspace: root, input: writeInput(root, producerInput(probeCommand, 12)), descriptor, now: NOW });
  assert.throws(
    () => writeContinuitySnapshot({ workspace: root, input: writeInput(root, producerInput(probeCommand, 11)), descriptor, now: NOW }),
    /generation-not-newer/,
  );
});

test('the producer rejects symlinked input and unsafe state directories', () => {
  const { root, descriptor, probeCommand } = fixture();
  const source = writeInput(root, producerInput(probeCommand));
  const link = path.join(root, 'input-link.json');
  fs.symlinkSync(source, link);
  assert.throws(() => writeContinuitySnapshot({ workspace: root, input: link, descriptor, now: NOW }), /file-unsafe/);

  const unsafe = fixture();
  fs.mkdirSync(path.join(unsafe.root, '.jarvos'), { mode: 0o755 });
  fs.chmodSync(path.join(unsafe.root, '.jarvos'), 0o755);
  const input = writeInput(unsafe.root, producerInput(unsafe.probeCommand));
  assert.throws(() => writeContinuitySnapshot({ workspace: unsafe.root, input, descriptor: unsafe.descriptor, now: NOW }), /directory-unsafe/);
});
