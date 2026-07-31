'use strict';

function localChangeRoute(catalogEntry, privacy) {
  if (!catalogEntry) {
    return {
      kind: 'relationship-needed',
      publicRouting: { blocked: true, reason: 'relationship-needed' },
    };
  }
  if (privacy.blocked) {
    return {
      kind: 'privacy-review-needed',
      publicRouting: { blocked: true, reason: privacy.reason },
    };
  }
  if (catalogEntry.ownership === 'jarvos-owned') {
    return {
      kind: 'jarvos-release-proposal',
      publicRouting: { blocked: false, reason: null },
    };
  }
  if (catalogEntry.ownership === 'andrew-owned') {
    return {
      kind: 'independent-project',
      publicRouting: { blocked: catalogEntry.defaultVisibility !== 'public', reason: catalogEntry.defaultVisibility !== 'public' ? 'project-not-public' : null },
    };
  }
  return {
    kind: 'external-integration',
    publicRouting: { blocked: false, reason: null },
  };
}

module.exports = { localChangeRoute };
