'use strict';

const { WORKSPACE_CONTRACT_VERSION } = require('./contracts');
const { projectOperatorSurface } = require('./projections');

function createWorkspaceControlPlanePort(options = {}) {
  const capabilityState = options.capabilityState || 'observe-only';
  const manifest = () => ({
    schemaVersion: 'jarvos-control-plane.manager.v1', contractVersion: '1.0.0',
    managerId: 'jarvos-workspace-manager', displayName: 'Workspace Manager',
    artifact: { version: WORKSPACE_CONTRACT_VERSION }, supportedCoreVersions: ['1.0.0'],
    capabilities: ['workspace.observe', 'workspace.inventory', 'workspace.disposition', 'workspace.release-clearance'],
    resourceSelectors: [], mutationClasses: [], requiredAuthorities: [], health: { capabilityState },
    trust: { level: 'data-only', observationOnly: true },
  });
  return {
    manifest,
    register(input = {}) {
      const registry = input.registry || options.registry;
      if (registry && typeof registry.registerManager === 'function') return { ...registry.registerManager(manifest()), observationOnly: true, executable: false };
      return { managerId: 'jarvos-workspace-manager', status: 'observation_only', observationOnly: true, executable: false };
    },
    observe(input = {}) {
      try {
        const projected = projectOperatorSurface({ inventory: Array.isArray(input.inventory) ? input.inventory : [] });
        return { kind: 'workspace-observation', observationOnly: true, status: 'ok', inventory: projected.agent.inventory };
      } catch (_) {
        // Never hand an unvalidated host record to a public Control Plane
        // caller. A malformed observation is visible as deferred health, not
        // as a raw private payload or an exception that can bypass the port.
        return { kind: 'workspace-observation', observationOnly: true, status: 'deferred', inventory: [], reason: 'workspace observation is not public-safe' };
      }
    },
  };
}

module.exports = { createWorkspaceControlPlanePort };
