'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECTION_STATE_DIR = '.jarvos-projections';
const SHA256_RE = /^[a-f0-9]{64}$/i;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function createProjectionApi({ assertProjectionManifest, getManifest, projectionMetadata, sha256 } = {}) {
  if (typeof assertProjectionManifest !== 'function' || typeof getManifest !== 'function'
    || typeof projectionMetadata !== 'function' || typeof sha256 !== 'function') {
    throw new Error('projection helpers are required');
  }

  function assertSafeProjectionRoot(skillsRoot) {
    if (!skillsRoot) throw new Error('skillsRoot is required');
    const root = path.resolve(skillsRoot);
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('skillsRoot must be a real directory');
    assertSafeOwnedDirectory(stat, 'skillsRoot');
    return fs.realpathSync(root);
  }

  function assertSafeOwnedDirectory(stat, label) {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
  }

  function assertSafePathBelow(root, target) {
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('projection target escapes skillsRoot');
    }
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) continue;
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`unsafe symbolic link in projection target: ${relative}`);
      if (stat.isDirectory()) assertSafeOwnedDirectory(stat, `projection path ${relative}`);
      if (current !== root && typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`unsafe ownership in projection target: ${relative}`);
      if (current !== root && (stat.mode & 0o022) !== 0) throw new Error(`unsafe permissions in projection target: ${relative}`);
    }
    return target;
  }

  function projectionTargetPath(root, skill, harness) {
    const metadata = projectionMetadata(skill, harness);
    if (!metadata) return null;
    const relative = metadata.path.replace('{skillsRoot}/', '');
    return assertSafePathBelow(root, path.resolve(root, relative));
  }

  function projectionStatePath(root, name) {
    return assertSafePathBelow(root, path.join(root, PROJECTION_STATE_DIR, `${name}.json`));
  }

  function normalizePackagePath(value) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('package entry path is required');
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('package entry path must be relative');
    if (value.includes('\\')) throw new Error('package entry path must use forward slashes');
    const normalized = path.posix.normalize(value);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error('package entry path contains traversal');
    return normalized;
  }

  function validateProjectionAdapter(adapter, harnessVersion) {
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) throw new Error('projection adapter is required');
    for (const key of ['id', 'version', 'harness', 'supportedVersions']) {
      if (typeof adapter[key] !== 'string' || adapter[key].trim() === '') throw new Error(`projection adapter missing ${key}`);
    }
    if (!SEMVER_RE.test(adapter.version)) throw new Error('projection adapter version must be semver');
    if (!adapter.rootDetection || typeof adapter.rootDetection !== 'object' || Array.isArray(adapter.rootDetection)) throw new Error('projection adapter rootDetection is required');
    if (!adapter.discovery || typeof adapter.discovery !== 'object' || Array.isArray(adapter.discovery)
      || !Array.isArray(adapter.discovery.command) || adapter.discovery.command.length === 0
      || !adapter.discovery.command.every((part) => typeof part === 'string' && part.length > 0)) {
      throw new Error('projection adapter discovery command is required');
    }
    const version = parseSemver(harnessVersion);
    const compatible = version && satisfiesRange(version, adapter.supportedVersions);
    return {
      status: compatible ? 'compatible' : 'unsupported',
      adapter: { id: adapter.id, version: adapter.version, harness: adapter.harness },
      ...(compatible ? {} : { reason: version ? 'harness version is outside supported range' : 'harness version is missing or unparseable' }),
    };
  }

  function parseSemver(value) {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(SEMVER_RE);
    return match ? match.slice(1, 4).map(Number) : null;
  }

  function satisfiesRange(version, range) {
    const clauses = String(range).trim().split(/\s+/).filter(Boolean);
    if (clauses.length === 0) throw new Error('projection adapter supportedVersions is invalid');
    return clauses.every((clause) => {
      const match = clause.match(/^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/);
      if (!match) throw new Error('projection adapter supportedVersions is invalid');
      const comparison = compareSemver(version, match[2].split('.').map(Number));
      return ({ '>': comparison > 0, '>=': comparison >= 0, '<': comparison < 0, '<=': comparison <= 0, '=': comparison === 0, undefined: comparison === 0 })[match[1]];
    });
  }

  function compareSemver(left, right) {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
  }

  function stageProjectionPackage({ packageRoot, stagingRoot, entries, packageDigest } = {}) {
    if (!packageRoot || !stagingRoot) throw new Error('packageRoot and stagingRoot are required');
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('package entries are required');
    const sourceRootCandidate = path.resolve(packageRoot);
    const sourceStat = fs.lstatSync(sourceRootCandidate);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('packageRoot must be a real directory');
    const sourceRoot = fs.realpathSync(sourceRootCandidate);
    const normalizedEntries = entries.map((entry) => {
      const entryPath = normalizePackagePath(entry?.path);
      if (!SHA256_RE.test(entry?.digest || '')) throw new Error(`package entry ${entryPath} must declare a SHA-256 digest`);
      return { path: entryPath, digest: entry.digest.toLowerCase() };
    });
    const seen = new Set();
    for (const entry of normalizedEntries) {
      if (seen.has(entry.path)) throw new Error(`duplicate normalized package path: ${entry.path}`);
      seen.add(entry.path);
    }
    const computedPackageDigest = sha256(JSON.stringify([...normalizedEntries].sort((a, b) => a.path.localeCompare(b.path))));
    if (packageDigest !== undefined && packageDigest !== computedPackageDigest) throw new Error('package digest does not match entries');
    const stageParent = path.resolve(stagingRoot);
    fs.mkdirSync(stageParent, { recursive: true, mode: 0o700 });
    const stageParentStat = fs.lstatSync(stageParent);
    if (!stageParentStat.isDirectory() || stageParentStat.isSymbolicLink()) throw new Error('stagingRoot must be a real directory');
    assertSafeOwnedDirectory(stageParentStat, 'stagingRoot');
    const stagePath = fs.mkdtempSync(path.join(fs.realpathSync(stageParent), 'jarvos-projection-'));
    fs.chmodSync(stagePath, 0o700);
    try {
      for (const entry of normalizedEntries) {
        const source = assertSafePathBelow(sourceRoot, path.resolve(sourceRoot, entry.path));
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) throw new Error(`package entry is a symbolic link: ${entry.path}`);
        if (!stat.isFile()) throw new Error(`package entry must be a regular file: ${entry.path}`);
        const content = fs.readFileSync(source);
        if (sha256(content) !== entry.digest) throw new Error(`package entry digest mismatch: ${entry.path}`);
        const target = path.resolve(stagePath, entry.path);
        const targetRelative = path.relative(stagePath, target);
        if (targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) throw new Error(`package entry escapes staging: ${entry.path}`);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
      }
      return { path: stagePath, packageDigest: computedPackageDigest, entries: normalizedEntries };
    } catch (error) {
      fs.rmSync(stagePath, { recursive: true, force: true });
      throw error;
    }
  }

  function readProjectionState(statePath) {
    if (!fs.existsSync(statePath)) return null;
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('projection state must be a regular file');
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return state && typeof state === 'object' ? state : null;
    } catch {
      throw new Error('projection state is invalid JSON');
    }
  }

  function observedDigest(target) {
    if (!fs.existsSync(target)) return null;
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('projection target must be a regular file');
    return sha256(fs.readFileSync(target));
  }

  function projectionStatus({ sourceDigest, outputDigest, targetDigest, state, compatibility }) {
    if (compatibility === 'unsupported') return 'unsupported';
    if (compatibility !== 'compatible') return 'incompatible';
    if (!targetDigest) return state ? 'conflict' : 'missing';
    if (!state) return 'unknown';
    if (!SHA256_RE.test(state.targetDigest || '')) return 'conflict';
    if (targetDigest === outputDigest && state.sourceDigest === sourceDigest && state.targetDigest === outputDigest) return 'clean';
    if (targetDigest === state.targetDigest) return 'outdated';
    return 'local_modified';
  }

  function resolveProjectionCompatibility(skill, harness, incompatibleSkills) {
    if (!skill.supportedHarnesses.includes(harness)) return 'unsupported';
    if (incompatibleSkills?.includes(skill.name)) return 'incompatible';
    return projectionMetadata(skill, harness) ? 'compatible' : 'incompatible';
  }

  function projectionAction(status) {
    return { missing: 'create', outdated: 'update' }[status] || 'preserve';
  }

  function projectionGeneration(record) {
    return sha256(JSON.stringify({
      harness: record.harness,
      name: record.name,
      sourceDigest: record.sourceDigest,
      outputDigest: record.outputDigest,
      observedDigest: record.observedDigest,
      stateDigest: record.state?.sourceDigest || null,
      stateTargetDigest: record.state?.targetDigest || null,
      stateRevision: record.state?.sourceRevision || null,
      renderer: record.renderer,
      adapter: record.adapter || null,
    }));
  }

  function planSkillProjection(options = {}) {
    const manifest = options.manifest || getManifest();
    const harness = String(options.harness || '').trim();
    if (!harness) throw new Error('harness is required');
    const requested = options.skills === undefined ? manifest.defaultSkills : (Array.isArray(options.skills) ? options.skills : [options.skills]);
    const validatedSources = assertProjectionManifest(manifest, { captureSourceNames: requested });
    const adapterResult = options.adapter ? validateProjectionAdapter(options.adapter, options.harnessVersion) : null;
    if (adapterResult && options.adapter.harness !== harness) throw new Error(`projection adapter harness does not match ${harness}`);
    if (typeof options.transform === 'function' && !adapterResult) throw new Error('a transformed projection requires an adapter');
    const root = assertSafeProjectionRoot(options.skillsRoot || options.destinationDir);
    const entries = requested.map((name) => {
      const skill = manifest.skills.find((item) => item.name === name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      const targetMeta = projectionMetadata(skill, harness);
      const compatibility = adapterResult?.status === 'unsupported'
        ? 'unsupported'
        : resolveProjectionCompatibility(skill, harness, options.incompatibleSkills);
      const compatible = compatibility === 'compatible';
      const target = compatible ? projectionTargetPath(root, skill, harness) : null;
      const statePath = projectionStatePath(root, skill.name);
      const state = readProjectionState(statePath);
      const sourceDigest = skill.source.digest;
      const sourceContent = validatedSources.get(skill.name);
      const output = compatible ? renderProjectionOutput(sourceContent, { skill, harness, adapter: adapterResult?.adapter || null }, options.transform) : null;
      const outputDigest = output ? sha256(output) : null;
      const targetDigest = target ? observedDigest(target) : null;
      const status = projectionStatus({ sourceDigest, outputDigest, targetDigest, state, compatibility });
      const entry = {
        name: skill.name,
        harness,
        compatible,
        compatibility,
        status,
        sourcePath: skill.path,
        sourceDigest,
        sourceRevision: skill.source.revision,
        outputDigest,
        renderer: targetMeta?.renderer || null,
        adapter: adapterResult?.adapter || { id: targetMeta?.renderer || 'raw-skill-md', version: '1.0.0', harness },
        targetPath: target,
        statePath,
        observedDigest: targetDigest,
        state,
        action: projectionAction(status),
      };
      entry.generation = projectionGeneration(entry);
      return entry;
    });
    return { version: 1, harness, skillsRoot: root, entries, ok: entries.every((entry) => ['clean', 'missing', 'outdated'].includes(entry.status)) };
  }

  function renderProjectionOutput(content, context, transform) {
    const output = transform ? transform(Buffer.from(content), context) : content;
    if (!Buffer.isBuffer(output) && typeof output !== 'string') throw new Error('projection transform must return a string or Buffer');
    return Buffer.isBuffer(output) ? output : Buffer.from(output);
  }

  function atomicWriteNoFollow(filePath, content) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    const dirStat = fs.lstatSync(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o022) !== 0) throw new Error('unsafe projection directory');
    const tempPath = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    try {
      fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
      fs.renameSync(tempPath, filePath);
    } finally {
      try { fs.unlinkSync(tempPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  function applySkillProjection(plan, options = {}) {
    if (!plan || !Array.isArray(plan.entries)) throw new Error('projection plan is required');
    const manifest = options.manifest || getManifest();
    const entriesToApply = plan.entries.filter((entry) => ['missing', 'outdated'].includes(entry.status));
    const validatedSources = assertProjectionManifest(manifest, { captureSourceNames: entriesToApply.map((entry) => entry.name) });
    const root = assertSafeProjectionRoot(plan.skillsRoot);
    const applied = [];
    for (const entry of plan.entries) {
      if (!['missing', 'outdated'].includes(entry.status)) {
        applied.push({ name: entry.name, status: entry.status, applied: false });
        continue;
      }
      const skill = manifest.skills.find((item) => item.name === entry.name);
      if (!skill || !skill.supportedHarnesses.includes(plan.harness)) throw new Error(`Skill ${entry.name} is no longer compatible with ${plan.harness}`);
      const target = projectionTargetPath(root, skill, plan.harness);
      const statePath = projectionStatePath(root, skill.name);
      const adapterResult = options.adapter ? validateProjectionAdapter(options.adapter, options.harnessVersion) : null;
      if (adapterResult && options.adapter.harness !== plan.harness) throw new Error(`projection adapter harness does not match ${plan.harness}`);
      if (typeof options.transform === 'function' && !adapterResult) throw new Error('a transformed projection requires an adapter');
      const sourceContent = validatedSources.get(skill.name);
      const output = renderProjectionOutput(sourceContent, { skill, harness: plan.harness, adapter: adapterResult?.adapter || null }, options.transform);
      const outputDigest = sha256(output);
      const current = {
        ...entry,
        observedDigest: observedDigest(target),
        state: readProjectionState(statePath),
        sourceDigest: skill.source.digest,
        outputDigest,
        renderer: projectionMetadata(skill, plan.harness).renderer,
        adapter: adapterResult?.adapter || { id: projectionMetadata(skill, plan.harness).renderer, version: '1.0.0', harness: plan.harness },
      };
      current.generation = projectionGeneration(current);
      if (current.generation !== entry.generation) throw new Error(`Projection changed since planning: ${entry.name}`);
      if (!sourceContent) throw new Error(`Skill ${skill.name} source was not validated for projection`);
      atomicWriteNoFollow(target, output);
      const state = {
        version: 1,
        harness: plan.harness,
        name: skill.name,
        sourceRevision: skill.source.revision,
        sourceDigest: skill.source.digest,
        targetDigest: outputDigest,
        renderer: projectionMetadata(skill, plan.harness).renderer,
        adapter: current.adapter,
      };
      atomicWriteNoFollow(statePath, `${JSON.stringify(state, null, 2)}\n`);
      applied.push({ name: entry.name, status: entry.status, applied: true, targetPath: target, statePath });
    }
    return { ok: true, harness: plan.harness, applied };
  }

  return { applySkillProjection, planSkillProjection, stageProjectionPackage, validateProjectionAdapter };
}

module.exports = { createProjectionApi };
