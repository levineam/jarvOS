'use strict';

const { createReleaseClearanceBinding } = require('../contracts');

function createWorkspaceRecoveryPort({ verifier, releaseClearancePort } = {}) {
  if (!verifier || typeof verifier.verify !== 'function') throw new Error('recovery verifier is required');
  return {
    async recover(command) {
      if (!command || command.status !== 'uncertain') return { ok: false, status: 'needs_judgment', reason: 'uncertain command is required', command };
      if (releaseClearancePort) {
        if (typeof releaseClearancePort.resolve !== 'function') return { ok: false, status: 'uncertain', reason: 'release clearance revalidation is unavailable', command };
        let releaseResult;
        try {
          releaseResult = await releaseClearancePort.resolve({
            subjectIdentity: command.subjectIdentity,
            digest: command.releaseClearanceDigest,
            generation: command.releaseClearanceGeneration,
            currentPointerId: command.releaseClearanceCurrentPointerId,
            fresh: true,
          });
          const binding = releaseResult?.status === 'admissible' && releaseResult.binding ? releaseResult.binding : releaseResult;
          const clearance = createReleaseClearanceBinding(binding);
          if (clearance.subjectIdentity !== command.subjectIdentity || clearance.digest !== command.releaseClearanceDigest || clearance.generation !== command.releaseClearanceGeneration || clearance.currentPointerId !== command.releaseClearanceCurrentPointerId || !['satisfied', 'not-required'].includes(clearance.outcome)) throw new Error('release clearance has changed');
        } catch (_) {
          return { ok: false, status: 'uncertain', reason: 'release clearance revalidation failed', command };
        }
      }
      let verification;
      try {
        verification = await verifier.verify({ command, fresh: true, recovery: true });
      } catch (error) {
        return { ok: false, status: 'uncertain', reason: 'recovery verification failed', error, command };
      }
      if (!verification || !['satisfied', 'needs_judgment'].includes(verification.outcome)) {
        return { ok: false, status: 'uncertain', reason: 'recovery verification was inconclusive', command };
      }
      return {
        ok: verification.outcome === 'satisfied',
        status: verification.outcome,
        command: { ...command, status: verification.outcome },
        evidence: verification,
      };
    },
  };
}

module.exports = { createWorkspaceRecoveryPort };
