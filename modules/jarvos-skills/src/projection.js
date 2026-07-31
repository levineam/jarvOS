'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECTION_STATE_DIR = '.jarvos-projections';

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
    return root;
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
      if (current !== root && stat.uid !== process.getuid?.()) throw new Error(`unsafe ownership in projection target: ${relative}`);
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

  function projectionStatus({ sourceDigest, targetDigest, state, compatibility }) {
    if (compatibility === 'unsupported') return 'unsupported';
    if (compatibility !== 'compatible') return 'incompatible';
    if (!targetDigest) return state ? 'conflict' : 'missing';
    if (!state) return 'unknown';
    if (state.targetDigest !== state.sourceDigest) return 'conflict';
    if (targetDigest === sourceDigest && state.sourceDigest === sourceDigest) return 'clean';
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
      observedDigest: record.observedDigest,
      stateDigest: record.state?.sourceDigest || null,
      stateTargetDigest: record.state?.targetDigest || null,
      stateRevision: record.state?.sourceRevision || null,
      renderer: record.renderer,
    }));
  }

  function planSkillProjection(options = {}) {
    const manifest = options.manifest || getManifest();
    assertProjectionManifest(manifest);
    const harness = String(options.harness || '').trim();
    if (!harness) throw new Error('harness is required');
    const root = assertSafeProjectionRoot(options.skillsRoot || options.destinationDir);
    const requested = options.skills === undefined ? manifest.defaultSkills : (Array.isArray(options.skills) ? options.skills : [options.skills]);
    const entries = requested.map((name) => {
      const skill = manifest.skills.find((item) => item.name === name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      const targetMeta = projectionMetadata(skill, harness);
      const compatibility = resolveProjectionCompatibility(skill, harness, options.incompatibleSkills);
      const compatible = compatibility === 'compatible';
      const target = compatible ? projectionTargetPath(root, skill, harness) : null;
      const statePath = projectionStatePath(root, skill.name);
      const state = readProjectionState(statePath);
      const sourceDigest = skill.source.digest;
      const targetDigest = target ? observedDigest(target) : null;
      const status = projectionStatus({ sourceDigest, targetDigest, state, compatibility });
      const entry = {
        name: skill.name,
        harness,
        compatible,
        compatibility,
        status,
        sourcePath: skill.path,
        sourceDigest,
        sourceRevision: skill.source.revision,
        renderer: targetMeta?.renderer || null,
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
      const current = {
        ...entry,
        observedDigest: observedDigest(target),
        state: readProjectionState(statePath),
        sourceDigest: skill.source.digest,
        renderer: projectionMetadata(skill, plan.harness).renderer,
      };
      current.generation = projectionGeneration(current);
      if (current.generation !== entry.generation) throw new Error(`Projection changed since planning: ${entry.name}`);
      const content = validatedSources.get(skill.name);
      if (!content) throw new Error(`Skill ${skill.name} source was not validated for projection`);
      atomicWriteNoFollow(target, content);
      const state = {
        version: 1,
        harness: plan.harness,
        name: skill.name,
        sourceRevision: skill.source.revision,
        sourceDigest: skill.source.digest,
        targetDigest: skill.source.digest,
        renderer: projectionMetadata(skill, plan.harness).renderer,
      };
      atomicWriteNoFollow(statePath, `${JSON.stringify(state, null, 2)}\n`);
      applied.push({ name: entry.name, status: entry.status, applied: true, targetPath: target, statePath });
    }
    return { ok: true, harness: plan.harness, applied };
  }

  return { applySkillProjection, planSkillProjection };
}

module.exports = { createProjectionApi };
