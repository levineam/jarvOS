'use strict';

const { HARNESSES } = require('./contracts');
const { stableDigest } = require('./catalog');

const RENDER_VERSION = 'jarvos-instruction-projection-render/v1';
const LOGICAL_BUNDLE_SCHEMA_VERSION = 'jarvos.instruction-logical-bundle/v1';
const APPLICABLE_DISPOSITION_STATUSES = Object.freeze(['equivalent-native', 'harness-native-translation', 'private-only']);

function computeGenerationDigest(catalogGeneration, harness, rendererVersion = RENDER_VERSION) {
  return stableDigest({
    schemaVersion: LOGICAL_BUNDLE_SCHEMA_VERSION,
    rendererVersion,
    catalogGeneration,
    harness,
  });
}

function computeRenderedDigest(generationDigest, roles) {
  return stableDigest({
    schemaVersion: LOGICAL_BUNDLE_SCHEMA_VERSION,
    rendererVersion: RENDER_VERSION,
    generationDigest,
    roles,
  });
}

function renderDirective(role, directive, harness, content) {
  const disposition = directive.dispositions[harness];
  const applicable = role.sourceClass !== 'dynamic-service' && APPLICABLE_DISPOSITION_STATUSES.includes(disposition.status);
  return {
    id: directive.id,
    disposition,
    applicable,
    body: applicable ? content[role.role][directive.id] : null,
  };
}

function renderRole(role, harness, content) {
  return {
    role: role.role,
    sourceClass: role.sourceClass,
    scope: role.scope,
    visibility: role.visibility,
    directives: role.directives.map((directive) => renderDirective(role, directive, harness, content)),
  };
}

function renderHarnessBundle({ catalog, content, catalogGeneration }, harness) {
  if (!HARNESSES.includes(harness)) throw new Error('render harness is unknown');
  const roles = catalog.roles.map((role) => renderRole(role, harness, content));
  const generationDigest = computeGenerationDigest(catalogGeneration, harness);
  return {
    schemaVersion: LOGICAL_BUNDLE_SCHEMA_VERSION,
    rendererVersion: RENDER_VERSION,
    harness,
    catalogId: catalog.catalogId,
    catalogGeneration,
    generationDigest,
    renderedDigest: computeRenderedDigest(generationDigest, roles),
    roles,
  };
}

function renderAllHarnesses(normalized) {
  return Object.fromEntries(HARNESSES.map((harness) => [harness, renderHarnessBundle(normalized, harness)]));
}

module.exports = {
  RENDER_VERSION,
  LOGICAL_BUNDLE_SCHEMA_VERSION,
  APPLICABLE_DISPOSITION_STATUSES,
  computeGenerationDigest,
  renderHarnessBundle,
  renderAllHarnesses,
};
