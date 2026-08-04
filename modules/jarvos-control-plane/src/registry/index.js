'use strict';

const {
  CONTRACT_VERSION,
  assertCompatibleVersion,
  canonicalMutationKey,
  clone,
  createManagerManifest,
  validateManagedSoftwareEntry,
} = require('../contracts');

function createManagedSoftwareCatalog(input = {}) {
  const revision = input.revision;
  if (typeof revision !== 'string' || !/^managed-software\.v\d+$/.test(revision)) {
    throw new Error('catalog revision must use the managed-software.vN format');
  }
  if (!Array.isArray(input.entries) || !input.entries.length) throw new Error('catalog entries are required');
  const entries = input.entries.map((entry) => validateManagedSoftwareEntry(entry));
  const byId = new Map();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`duplicate managed-software entry: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  const publicEntries = entries.map((entry) => {
    const publicEntry = clone(entry);
    delete publicEntry.checkoutSelectors;
    delete publicEntry.credentialRef;
    delete publicEntry.notificationPreferenceRef;
    delete publicEntry.approvalPrincipalRefs;
    if (publicEntry.runtime) {
      delete publicEntry.runtime.stagingRootSelector;
      delete publicEntry.runtime.recoveryAuthorityRef;
      delete publicEntry.runtime.activationPointerSelector;
    }
    return publicEntry;
  });

  function revise({ entryId, patch, actor, pendingApprovals = [] } = {}) {
    if (typeof entryId !== 'string' || !byId.has(entryId)) throw new Error('known entryId is required');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('revision patch is required');
    const sensitiveFields = new Set(['credentialRef', 'notificationPreferenceRef', 'approvalPrincipalRefs', 'publicationAdapter', 'runtime']);
    const sensitive = Object.keys(patch).some((field) => sensitiveFields.has(field));
    if (sensitive && (!actor || actor.authenticated !== true || !['andrew', 'delegate'].includes(actor.role))) {
      throw new Error('sensitive catalog revisions require an authenticated Andrew or delegate');
    }
    if (!actor || typeof actor.id !== 'string' || !actor.id) throw new Error('revision actor id is required');
    const nextEntries = entries.map((entry) => entry.id === entryId ? validateManagedSoftwareEntry({ ...entry, ...clone(patch) }) : entry);
    const currentVersion = Number(revision.slice('managed-software.v'.length));
    const nextRevision = `managed-software.v${currentVersion + 1}`;
    const invalidatedApprovalIds = sensitive ? pendingApprovals.map((approval) => approval && approval.id).filter(Boolean) : [];
    return {
      revision: nextRevision,
      entries: nextEntries.map(clone),
      provenance: { actor: clone(actor), previousRevision: revision, revision: nextRevision },
      invalidatedApprovalIds,
    };
  }
  return {
    revision,
    entries: entries.map(clone),
    find: (id) => byId.has(id) ? clone(byId.get(id)) : null,
    publicReport: { revision, entries: publicEntries },
    revise,
  };
}

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
  createManagedSoftwareCatalog,
  createRegistry,
  mutationOwnershipKey,
  versionCompatible,
};
