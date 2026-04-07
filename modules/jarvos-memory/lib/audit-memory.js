'use strict';

const fs = require('fs');
const path = require('path');
const {
  SCHEMA_VERSION,
  ACCEPTED_PROVENANCE_FIELDS,
  CORE_MEMORY_CLASSES,
  INPUT_ONLY_SURFACES,
  EXTERNAL_ADAPTER_SURFACES,
  isAllowedRecordStatus,
  hasAcceptedProvenance,
  isAcceptedProjectEntry,
} = require('./memory-schema');
const { getMemoryPaths } = require('./memory-config');

const RECORD_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-.+\.md$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;

  const frontmatter = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    frontmatter[m[1]] = m[2];
  }
  return frontmatter;
}

function listMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
  return fs.readdirSync(dirPath)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .filter((name) => name !== 'README.md')
    .sort()
    .map((name) => path.join(dirPath, name));
}

function listProjectEntries(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
  return fs.readdirSync(dirPath)
    .sort()
    .map((name) => ({
      name,
      fullPath: path.join(dirPath, name),
      stat: fs.statSync(path.join(dirPath, name)),
    }));
}

function addViolation(violations, file, field, message, current) {
  violations.push({ file, field, message, current });
}

function auditRecordFile(filePath, expectedClass, violations) {
  const content = fs.readFileSync(filePath, 'utf8');
  const frontmatter = parseFrontmatter(content);
  const rel = path.relative(process.cwd(), filePath) || filePath;

  if (!RECORD_FILE_PATTERN.test(path.basename(filePath))) {
    addViolation(violations, rel, 'filename', 'expected YYYY-MM-DD-slug.md', path.basename(filePath));
  }

  if (!frontmatter) {
    addViolation(violations, rel, 'frontmatter', 'missing YAML frontmatter block', '(missing)');
    return;
  }

  for (const field of CORE_MEMORY_CLASSES[expectedClass].requiredFields) {
    const value = frontmatter[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      addViolation(violations, rel, field, 'required field missing or empty', value ?? '(missing)');
    }
  }

  if ((frontmatter.class || '').trim() !== expectedClass) {
    addViolation(violations, rel, 'class', `expected ${expectedClass}`, frontmatter.class ?? '(missing)');
  }

  if (frontmatter.created && !DATE_PATTERN.test(frontmatter.created.trim())) {
    addViolation(violations, rel, 'created', 'expected YYYY-MM-DD', frontmatter.created);
  }

  if (frontmatter.status && !isAllowedRecordStatus(frontmatter.status.trim())) {
    addViolation(
      violations,
      rel,
      'status',
      'expected active | superseded | corrected | archived | abandoned',
      frontmatter.status,
    );
  }

  if (!hasAcceptedProvenance(frontmatter)) {
    addViolation(
      violations,
      rel,
      'provenance',
      `expected at least one provenance field: ${ACCEPTED_PROVENANCE_FIELDS.join(', ')}`,
      '(missing)',
    );
  }
}

function auditProjectEntries(projectEntries, violations) {
  for (const entry of projectEntries) {
    const rel = path.relative(process.cwd(), entry.fullPath) || entry.fullPath;
    if (!isAcceptedProjectEntry(entry.name, entry.stat.isDirectory())) {
      addViolation(
        violations,
        rel,
        'project-state-shape',
        'expected markdown file or directory under memory/projects/',
        entry.name,
      );
    }
  }
}

function auditMemory(paths = getMemoryPaths()) {
  const violations = [];

  if (!fs.existsSync(paths.memoryRegistryFile)) {
    addViolation(violations, path.relative(process.cwd(), paths.memoryRegistryFile), 'MEMORY.md', 'canonical registry file is missing', '(missing)');
  }

  for (const [field, dirPath] of [
    ['decisionsDir', paths.decisionsDir],
    ['lessonsDir', paths.lessonsDir],
    ['projectsDir', paths.projectsDir],
  ]) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      addViolation(violations, path.relative(process.cwd(), dirPath), field, 'canonical memory directory is missing', '(missing)');
    }
  }

  const decisionFiles = listMarkdownFiles(paths.decisionsDir);
  const lessonFiles = listMarkdownFiles(paths.lessonsDir);
  const projectEntries = listProjectEntries(paths.projectsDir);

  for (const filePath of decisionFiles) {
    auditRecordFile(filePath, 'decision', violations);
  }

  for (const filePath of lessonFiles) {
    auditRecordFile(filePath, 'lesson', violations);
  }

  auditProjectEntries(projectEntries, violations);

  return {
    summary: {
      schemaVersion: SCHEMA_VERSION,
      memoryRegistryPresent: fs.existsSync(paths.memoryRegistryFile),
      decisionsChecked: decisionFiles.length,
      lessonsChecked: lessonFiles.length,
      projectEntriesChecked: projectEntries.filter((entry) => entry.name !== 'README.md').length,
      totalRecordFilesChecked: decisionFiles.length + lessonFiles.length,
      violations: violations.length,
      excludedInputSurfaces: INPUT_ONLY_SURFACES.map((item) => item.path),
      externalAdapterSurfaces: EXTERNAL_ADAPTER_SURFACES.map((item) => item.path),
    },
    violations,
    paths,
  };
}

function formatAudit(result) {
  const { summary, violations, paths } = result;
  const lines = [
    `Schema version: ${summary.schemaVersion}`,
    `Canonical registry file: ${summary.memoryRegistryPresent ? 'present' : 'missing'} (${paths.memoryRegistryFile})`,
    `Record audit: ${summary.decisionsChecked} decisions, ${summary.lessonsChecked} lessons, ${summary.projectEntriesChecked} project entries, ${summary.violations} violations`,
    `Excluded input surfaces: ${summary.excludedInputSurfaces.join(', ')}`,
    `External adapter surfaces: ${summary.externalAdapterSurfaces.join(', ')}`,
  ];

  if (violations.length > 0) {
    lines.push('Violations:');
    for (const v of violations) {
      lines.push(`- ${v.file} | ${v.field} | ${v.message} | current=${JSON.stringify(v.current)}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  parseFrontmatter,
  auditMemory,
  formatAudit,
};
