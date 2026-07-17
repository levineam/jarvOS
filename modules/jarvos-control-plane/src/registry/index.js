'use strict';

const {
  CONTRACT_VERSION,
  assertCompatibleVersion,
  canonicalMutationKey,
  createManagerManifest,
} = require('../contracts');

function versionCompatible(manifest) {
  try {
    assertCompatibleVersion(manifest.contractVersion || CONTRACT_VERSION, 'manager contractVersion');
  } catch (_) {
    return false;
  }
  return (manifest.supportedCoreVersions || []).some((version) => {
    try {
      assertCompatibleVersion(version, 'supportedCoreVersions');
      return true;
    } catch (_) {
      return false;
    }
  });
}

function mutationOwnershipKey(machineId, mutation) {
  return canonicalMutationKey({
    machineId,
    resource: {
      machineId,
      type: mutation.resourceType,
      id: mutation.resourceId || '*',
    },
    mutationClass: mutation.class,
  });
}

function createRegistry(options = {}) {
  const machineId = options.machineId || 'machine:default';
  const managers = new Map();
  const ownership = new Map();
  const conflicts = [];

  function registerManager(input) {
    let manifest;
    try {
      manifest = createManagerManifest(input);
    } catch (error) {
      manifest = {
        schemaVersion: input.schemaVersion,
        contractVersion: input.contractVersion,
        managerId: input.managerId || input.id || 'unknown-manager',
        displayName: input.displayName || input.name || input.managerId || input.id || 'Unknown manager',
        capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
        resourceSelectors: Array.isArray(input.resourceSelectors) ? input.resourceSelectors : [],
        mutationClasses: Array.isArray(input.mutationClasses) ? input.mutationClasses : [],
        requiredAuthorities: Array.isArray(input.requiredAuthorities) ? input.requiredAuthorities : [],
        trust: input.trust || { level: 'data-only' },
      };
      const registration = {
        manifest,
        managerId: manifest.managerId,
        status: 'incompatible',
        compatible: false,
        executable: false,
        observationOnly: true,
        conflicts: [],
        diagnostics: [error.message],
      };
      managers.set(manifest.managerId, registration);
      return registration;
    }
    const trusted = manifest.trust && manifest.trust.level === 'trusted';
    const compatible = versionCompatible(manifest);
    const observationOnly = !trusted || !compatible || manifest.trust.observationOnly === true;
    const status = observationOnly ? 'observation_only' : 'active';
    const registration = {
      manifest,
      managerId: manifest.managerId,
      status,
      compatible,
      executable: trusted && compatible,
      observationOnly,
      conflicts: [],
    };

    for (const mutation of manifest.mutationClasses) {
      const key = mutationOwnershipKey(machineId, mutation);
      const existing = ownership.get(key);
      if (existing && existing.managerId !== manifest.managerId) {
        const conflict = {
          type: 'mutation_ownership_conflict',
          key,
          resourceType: mutation.resourceType,
          mutationClass: mutation.class,
          currentOwner: existing.managerId,
          candidateOwner: manifest.managerId,
        };
        registration.conflicts.push(conflict);
        conflicts.push(conflict);
      } else if (!observationOnly) {
        ownership.set(key, { managerId: manifest.managerId, mutation });
      }
    }

    if (registration.conflicts.length && !observationOnly) {
      registration.status = 'conflict';
      registration.executable = false;
    }
    managers.set(manifest.managerId, registration);
    return registration;
  }

  function selectManager(resource, mutationClass) {
    const exactKey = canonicalMutationKey({ resource, mutationClass });
    const wildcardKey = canonicalMutationKey({
      resource: { machineId: resource.machineId, type: resource.type, id: '*' },
      mutationClass,
    });
    const owner = ownership.get(exactKey) || ownership.get(wildcardKey);
    if (!owner) {
      return {
        ok: false,
        reason: 'no_mutation_owner',
        resource,
        mutationClass,
      };
    }
    const registration = managers.get(owner.managerId);
    if (!registration || !registration.executable) {
      return {
        ok: false,
        reason: 'owner_not_executable',
        managerId: owner.managerId,
      };
    }
    return { ok: true, managerId: owner.managerId, registration };
  }

  function getManager(managerId) {
    return managers.get(managerId) || null;
  }

  function listManagers() {
    return Array.from(managers.values());
  }

  return {
    machineId,
    registerManager,
    selectManager,
    getManager,
    listManagers,
    listConflicts: () => conflicts.slice(),
  };
}

module.exports = {
  createRegistry,
  mutationOwnershipKey,
  versionCompatible,
};
