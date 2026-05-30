'use strict';

function releaseFitFromPaperclipReleaseIntake(classification = {}) {
  if (!classification || typeof classification !== 'object') {
    return {
      classification: 'unknown',
      matched: false,
      labels: [],
      reasons: ['no release-intake classification supplied'],
      publicNotesImpact: 'unknown',
    };
  }

  const releaseClassification = classification.classification || 'unknown';
  const mapped = releaseClassification === 'unrelated' ? 'not-release' : releaseClassification;

  return {
    classification: mapped,
    matched: Boolean(classification.matched),
    labels: Array.isArray(classification.labels) ? classification.labels : [],
    reasons: Array.isArray(classification.reasons) ? classification.reasons : [],
    publicNotesImpact: classification.publicNotesImpact || 'unknown',
    releasePlacement: classification.releasePlacement || null,
    targetVersion: classification.targetVersion || null,
    targetVersionReason: classification.targetVersionReason || null,
    releaseParentIssue: classification.releaseParentIssue || null,
    releaseRationale: classification.releaseRationale || '',
    verificationGate: classification.verificationGate || '',
    localDogfoodPolicy: classification.localDogfoodPolicy || '',
    localDogfoodPath: classification.localDogfoodPath || '',
    rollbackPath: classification.rollbackPath || '',
    graduationGate: classification.graduationGate || '',
  };
}

module.exports = {
  releaseFitFromPaperclipReleaseIntake,
};
