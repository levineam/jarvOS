'use strict';

const fs = require('fs');
const path = require('path');

const MODULE_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(MODULE_ROOT, 'manifest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getManifest() {
  return readJson(MANIFEST_PATH);
}

function listSkills() {
  return getManifest().skills.map((skill) => ({ ...skill }));
}

function getSkill(name) {
  const skill = listSkills().find((item) => item.name === name);
  if (!skill) return null;
  return {
    ...skill,
    absolutePath: path.join(MODULE_ROOT, skill.path),
    content: fs.readFileSync(path.join(MODULE_ROOT, skill.path), 'utf8'),
  };
}

function validateBundle() {
  const manifest = getManifest();
  const errors = [];
  const defaultSet = new Set(manifest.defaultSkills || []);
  const declaredSkillNames = new Set((manifest.skills || []).map((skill) => skill.name));

  for (const expected of ['workflow-execution', 'rule-creation', 'context-management', 'cron-hygiene']) {
    if (!defaultSet.has(expected)) errors.push(`Missing default skill: ${expected}`);
  }

  if (defaultSet.has('qmd')) {
    errors.push('QMD must not be bundled as a default skill.');
  }

  for (const name of defaultSet) {
    if (!declaredSkillNames.has(name)) {
      errors.push(`Default skill not declared: ${name}`);
    }
  }

  for (const skill of manifest.skills || []) {
    const skillPath = path.join(MODULE_ROOT, skill.path || '');
    if (!fs.existsSync(skillPath)) {
      errors.push(`Missing skill file: ${skill.path}`);
      continue;
    }

    const content = fs.readFileSync(skillPath, 'utf8');
    if (!content.includes(`name: ${skill.name}`)) {
      errors.push(`Skill ${skill.name} frontmatter does not declare its manifest name.`);
    }
  }

  const qmdAdapter = (manifest.optionalAdapters || []).find((adapter) => adapter.name === 'qmd');
  if (!qmdAdapter || qmdAdapter.default !== false) {
    errors.push('QMD must be documented as an optional adapter with default=false.');
  }

  return {
    ok: errors.length === 0,
    errors,
    skillCount: (manifest.skills || []).length,
    defaultSkills: [...defaultSet],
  };
}

function copyFileSync(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function installSkills(destinationDir, options = {}) {
  if (!destinationDir) {
    throw new Error('destinationDir is required');
  }

  const manifest = getManifest();
  const names = options.skills === undefined
    ? manifest.defaultSkills
    : Array.isArray(options.skills)
      ? options.skills
      : [options.skills];
  const installed = [];

  for (const name of names) {
    const skill = getSkill(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);

    const target = path.join(destinationDir, name, 'SKILL.md');
    if (fs.existsSync(target) && !options.force) {
      throw new Error(`Refusing to overwrite existing skill without force: ${target}`);
    }

    copyFileSync(skill.absolutePath, target);
    installed.push({ name, path: target });
  }

  return installed;
}

module.exports = {
  MODULE_ROOT,
  MANIFEST_PATH,
  getManifest,
  listSkills,
  getSkill,
  validateBundle,
  installSkills,
};
