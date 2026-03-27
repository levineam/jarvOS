/**
 * validator.js — Ontology integrity checks.
 *
 * Validates the ontology graph: orphan detection, staleness,
 * required links, and structural consistency.
 */

import { loadOntology, findOrphans, getByType } from './reader.js';

// ─── Validation checks ────────────────────────────────────────────────────

/**
 * Check that every project serves at least one goal.
 */
function checkProjectGoalLinks(ontology) {
  const issues = [];
  const projects = getByType(ontology, 'project');

  for (const proj of projects) {
    const servesGoal = proj.links?.some(
      l => l.type === 'serves' && (l.targetId?.startsWith('G') || l.target?.includes('Core Self'))
    );
    if (!servesGoal) {
      issues.push({
        level: 'warning',
        check: 'project-goal-link',
        objectId: proj.id,
        message: `Project ${proj.id} (${proj.name}) does not serve any Goal`,
      });
    }
  }

  return issues;
}

/**
 * Check that every goal serves Core Self.
 */
function checkGoalCoreSelfLinks(ontology) {
  const issues = [];
  const goals = getByType(ontology, 'goal');

  for (const goal of goals) {
    const servesCore = goal.links?.some(
      l => l.type === 'serves' && (
        l.target?.includes('Core Self') ||
        l.target?.includes('Mission') ||
        l.targetId === 'CORE'
      )
    );
    if (!servesCore) {
      issues.push({
        level: 'warning',
        check: 'goal-core-link',
        objectId: goal.id,
        message: `Goal ${goal.id} (${goal.name}) does not serve Core Self`,
      });
    }
  }

  return issues;
}

/**
 * Check for stopped/cancelled projects that are still listed as active.
 */
function checkStaleProjects(ontology) {
  const issues = [];
  const projects = getByType(ontology, 'project');

  for (const proj of projects) {
    const status = proj.metadata?.status?.toLowerCase();
    if (status === 'stopped' || status === 'cancelled' || status === 'abandoned') {
      // Not an issue per se, but flag it
      issues.push({
        level: 'info',
        check: 'project-status',
        objectId: proj.id,
        message: `Project ${proj.id} (${proj.name}) has status: ${status}`,
      });
    }
  }

  return issues;
}

/**
 * Check for orphan objects.
 */
function checkOrphans(ontology) {
  const orphans = findOrphans(ontology);
  return orphans.map(o => ({
    level: 'warning',
    check: 'orphan',
    objectId: o.id,
    message: `${o.type} ${o.id} (${o.name}) has no links`,
  }));
}

/**
 * Check ontology file completeness.
 */
function checkCompleteness(ontology) {
  return ontology.missingFiles.map(f => ({
    level: 'error',
    check: 'missing-file',
    objectId: null,
    message: `Ontology file missing: ${f}`,
  }));
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Run all validation checks on an ontology.
 *
 * @param {Ontology|string} ontologyOrDir - Loaded ontology or path to ontology/ dir
 * @returns {ValidationResult}
 */
export function validate(ontologyOrDir) {
  const ontology = typeof ontologyOrDir === 'string'
    ? loadOntology(ontologyOrDir)
    : ontologyOrDir;

  const issues = [
    ...checkCompleteness(ontology),
    ...checkOrphans(ontology),
    ...checkProjectGoalLinks(ontology),
    ...checkGoalCoreSelfLinks(ontology),
    ...checkStaleProjects(ontology),
  ];

  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');
  const infos = issues.filter(i => i.level === 'info');

  return {
    valid: errors.length === 0,
    issues,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      infos: infos.length,
      total: issues.length,
    },
    objectCount: ontology.objects.length,
    linkCount: ontology.links.length,
  };
}

/**
 * Format validation result as human-readable string.
 */
export function formatValidation(result) {
  const lines = [];
  lines.push(`📊 Ontology Validation — ${result.objectCount} objects, ${result.linkCount} links`);
  lines.push('─'.repeat(50));

  if (result.valid && result.summary.warnings === 0) {
    lines.push('✅ All checks passed');
  } else {
    if (result.summary.errors > 0) {
      lines.push(`\n❌ Errors (${result.summary.errors}):`);
      for (const i of result.issues.filter(x => x.level === 'error')) {
        lines.push(`  ${i.message}`);
      }
    }
    if (result.summary.warnings > 0) {
      lines.push(`\n⚠️  Warnings (${result.summary.warnings}):`);
      for (const i of result.issues.filter(x => x.level === 'warning')) {
        lines.push(`  ${i.message}`);
      }
    }
    if (result.summary.infos > 0) {
      lines.push(`\nℹ️  Info (${result.summary.infos}):`);
      for (const i of result.issues.filter(x => x.level === 'info')) {
        lines.push(`  ${i.message}`);
      }
    }
  }

  return lines.join('\n');
}
