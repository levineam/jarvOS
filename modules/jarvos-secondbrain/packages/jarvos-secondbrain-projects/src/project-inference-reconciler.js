'use strict';

/**
 * The public, deterministic Project Inference policy boundary.
 *
 * Source adapters and semantic engines stop at Project Candidate.  This
 * module owns the policy decision and is the only public inference component
 * allowed to call ProjectRegistry.  It deliberately accepts metadata-only
 * contracts: no source text, paths, prompts, or model calls cross this seam.
 */

const contracts = require('./project-inference-contracts');

const RECONCILER_CONTRACT = 'jarvos.project-inference-reconciler/v1';
// Candidate/decision contracts intentionally restrict revisions to opaque
// identifiers (no slash-bearing contract URI).  Keep the contract URI in the
// module name and use this normalized revision at the data boundary.
const POLICY_REVISION = 'jarvos.project-inference-policy-v1';
// The U3 bakeoff selected the deterministic arm.  This is intentionally an
// opaque revision, not a provider or model selector.
const ENGINE_REVISION = 'deterministic-baseline-v1';
const MIN_SPAN_MS = 24 * 60 * 60 * 1000;
const MUTATING_DISPOSITIONS = Object.freeze(new Set(['established', 'associated', 'corrected']));
const NON_MUTATING_DISPOSITIONS = Object.freeze(new Set([
  'provisional', 'quarantined', 'rejected', 'superseded', 'not-evaluable', 'unchanged',
]));

function clone(value) { return contracts.clone(value); }
function stableStringify(value) { return contracts.stableStringify(value); }
function stableDigest(value) { return contracts.stableDigest(value); }

function isPlainObject(value) { return contracts.isPlainObject(value); }

function exactObject(value, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be a plain object`);
  return value;
}

function requiredArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function reason(value) {
  const normalized = String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (!normalized || !/^[a-z0-9][a-z0-9_.:-]*$/.test(normalized)) throw new TypeError('reason code must be an opaque identifier');
  return normalized;
}

function reasons(values = []) {
  return [...new Set(values.map(reason))].sort();
}

function candidateSuppressionKey(candidate) {
  // Evidence identity, rather than the engine's origin field, is the stable
  // fence against a rejected/superseded structure reappearing after replay or
  // an adapter restart.
  return `evidence-${stableDigest([...candidate.evidenceIds].sort()).slice(0, 32)}`;
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function sourceEvidence(candidate, evidence) {
  const byId = new Map(evidence.map((item) => [item.evidenceId, item]));
  const selected = candidate.evidenceIds.map((id) => byId.get(id));
  if (selected.some((item) => !item)) throw new TypeError('candidate references evidence that was not supplied');
  return selected;
}

function normalizeEvidence(value, index) {
  try { return contracts.createEvidenceUnit(value); } catch (error) {
    throw new TypeError(`evidence[${index}] is invalid: ${error.message}`);
  }
}

function normalizeCoverage(value, evidence) {
  const source = value === undefined || value === null ? [] : requiredArray(value, 'coverage');
  const normalized = source.map((item, index) => {
    try { return contracts.createCoverageStatus(item); } catch (error) {
      throw new TypeError(`coverage[${index}] is invalid: ${error.message}`);
    }
  });
  // Policy-omitted coverage is intentionally not inferred from the evidence
  // rows.  Evidence freshness and source coverage are separate facts; a
  // missing coverage receipt must not silently become establishment authority.
  return normalized;
}

function normalizeInput(input) {
  exactObject(input, 'reconciliation input');
  const allowed = new Set([
    'candidate', 'evidence', 'coverage', 'correction', 'correctionAttestor', 'attestor',
    'canonicalId', 'expectedRegistryGeneration', 'expectedRegistryRevision',
  ]);
  const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new TypeError(`reconciliation input contains unsupported fields: ${unsupported.join(', ')}`);
  let candidate;
  try { candidate = contracts.createProjectCandidate(input.candidate); } catch (error) {
    throw new TypeError(`candidate is invalid: ${error.message}`);
  }
  const evidence = requiredArray(input.evidence, 'evidence').map(normalizeEvidence);
  if (!evidence.length) throw new TypeError('evidence must not be empty');
  const selected = sourceEvidence(candidate, evidence);
  const coverage = normalizeCoverage(input.coverage, selected);
  let correction = null;
  if (input.correction !== undefined && input.correction !== null) {
    const attestor = input.correctionAttestor || input.attestor || null;
    try {
      correction = contracts.createCorrectionEvidence(input.correction, attestor ? { attestor } : {});
    } catch (error) {
      throw new TypeError(`correction is invalid: ${error.message}`);
    }
  }
  return {
    candidate,
    evidence,
    selectedEvidence: selected,
    coverage,
    correction,
    correctionAttestor: input.correctionAttestor || input.attestor || null,
    canonicalId: input.canonicalId === undefined ? null : input.canonicalId,
    expectedRegistryGeneration: input.expectedRegistryGeneration,
    expectedRegistryRevision: input.expectedRegistryRevision,
  };
}

function coverageAssessment(selectedEvidence, coverage) {
  const relevantSources = new Set(selectedEvidence.map((item) => item.sourceClass));
  const coverageBySource = new Map(coverage.map((item) => [item.sourceClass, item]));
  const states = selectedEvidence.map((item) => item.coverageState);
  const coverageStates = [...relevantSources].map((sourceClass) => coverageBySource.get(sourceClass)?.state || null);
  const incomplete = states.some((state) => state !== 'fresh')
    || coverageStates.some((state) => state !== 'fresh');
  return {
    sufficient: !incomplete,
    incomplete,
    relevantSources: [...relevantSources].sort(),
    states: [...new Set([...states, ...coverageStates.filter(Boolean)])].sort(),
  };
}

function corroborationAssessment(selectedEvidence, coverageInfo) {
  const sourceClasses = new Set(selectedEvidence.map((item) => item.sourceClass));
  const dates = new Set(selectedEvidence.map((item) => isoDate(item.occurredAt)));
  const times = selectedEvidence.map((item) => Date.parse(item.occurredAt));
  const span = Math.max(...times) - Math.min(...times);
  return {
    sourceDiverse: sourceClasses.size >= 2,
    distinctDates: dates.size >= 2,
    spanAtLeast24Hours: span >= MIN_SPAN_MS,
    spanMs: span,
    sourceClassCount: sourceClasses.size,
    dateCount: dates.size,
    coverageSufficient: coverageInfo.sufficient,
  };
}

function decisionIdFor({ candidateId, policyRevision, disposition, reasonCodes, suppressionKey, supersededBy, lineage }) {
  return `dec_${stableDigest({
    candidateId, policyRevision, disposition, reasonCodes, suppressionKey, supersededBy, lineage,
  }).slice(0, 32)}`;
}

function decisionFor({ candidate, disposition, canonical = null, reasonCodes = [], suppressionKey = null, supersededBy = null, lineage = [] }, policyRevision) {
  const normalizedReasons = reasons(reasonCodes);
  const normalizedLineage = [...new Set(lineage)].sort();
  return contracts.createInferenceDecision({
    decisionId: decisionIdFor({
      candidateId: candidate.candidateId,
      policyRevision,
      disposition,
      reasonCodes: normalizedReasons,
      suppressionKey,
      supersededBy,
      lineage: normalizedLineage,
    }),
    candidateId: candidate.candidateId,
    policyRevision,
    disposition,
    canonical,
    reasonCodes: normalizedReasons,
    suppressionKey,
    supersededBy,
    lineage: normalizedLineage,
  });
}

function canonicalRef(record) {
  return {
    recordId: record.id,
    kind: record.kind,
    revision: record.revision,
    parentId: record.parentId,
    refDigest: stableDigest(record),
  };
}

function metadataFor(candidate, decision, suppressionKey = null) {
  return {
    candidateId: candidate.candidateId,
    decisionId: decision.decisionId,
    disposition: decision.disposition,
    suppressionKeys: suppressionKey ? [suppressionKey] : [],
    supersededBy: decision.supersededBy,
    reasonCodes: decision.reasonCodes,
  };
}

function mergeAliases(record, candidateAliases, oldTitle = null, assertedAliases = []) {
  const aliases = [...(record?.aliases || []), ...(candidateAliases || []), ...(assertedAliases || [])];
  if (oldTitle) aliases.push(oldTitle);
  const title = record?.title || null;
  const seen = new Set();
  const preserveCurrentTitle = oldTitle
    && String(oldTitle).normalize('NFKC').trim().toLocaleLowerCase('en-US') === String(title || '').toLocaleLowerCase('en-US');
  return aliases.filter((alias) => {
    const key = String(alias).normalize('NFKC').trim().toLocaleLowerCase('en-US');
    if (!key || (key === String(title || '').toLocaleLowerCase('en-US') && !preserveCurrentTitle) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.localeCompare(right, 'en-US'));
}

function findByInference(registry, candidateId) {
  return registry.list().find((record) => record.inference && record.inference.candidateId === candidateId) || null;
}

function normalizeCanonicalId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^(?:prj|out)_[0-9]{6,}$/.test(value)) throw new TypeError('canonicalId must reference a canonical record');
  return value;
}

class ProjectInferenceReconciler {
  constructor({
    registry,
    ledger,
    now = () => new Date().toISOString(),
    engineRevision = ENGINE_REVISION,
    policyRevision = POLICY_REVISION,
    correctionAttestor = null,
    attestor = null,
  } = {}) {
    if (!registry || typeof registry.list !== 'function' || typeof registry.create !== 'function' || typeof registry.update !== 'function') {
      throw new TypeError('ProjectRegistry-compatible registry is required');
    }
    if (!ledger || typeof ledger.appendCandidate !== 'function' || typeof ledger.appendDecision !== 'function' || typeof ledger.listEvents !== 'function') {
      throw new TypeError('ProjectInferenceLedger-compatible ledger is required');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.registry = registry;
    this.ledger = ledger;
    this.now = now;
    this.engineRevision = engineRevision;
    this.policyRevision = policyRevision;
    this.correctionAttestor = correctionAttestor || attestor || null;
  }

  _events() { return this.ledger.listEvents(); }

  _priorDecision(decisionId) {
    return this._events().find((event) => event.eventType === 'decision' && event.entityId === decisionId)?.payload || null;
  }

  _priorDecisionForCandidate(candidateId, correctionId = null) {
    const decisions = this._events()
      .filter((event) => event.eventType === 'decision' && event.payload.candidateId === candidateId)
      .map((event) => event.payload)
      .filter((decision) => correctionId === null || decision.lineage.includes(correctionId));
    return decisions.sort((left, right) => left.decisionId.localeCompare(right.decisionId))[0] || null;
  }

  _canonicalFor(input) {
    const { candidate, correction } = input;
    const explicit = normalizeCanonicalId(input.canonicalId);
    if (explicit) {
      const record = this.registry.get(explicit);
      return record ? { record } : { missing: true };
    }
    const inferred = findByInference(this.registry, candidate.candidateId);
    if (inferred) return { record: inferred };
    if (correction) {
      const targetId = correction.target.canonicalId;
      if (targetId) {
        const record = this.registry.get(targetId);
        return record ? { record } : { missing: true };
      }
      if (correction.target.alias) {
        const resolved = this.registry.resolve(correction.target.alias);
        if (resolved.status === 'ambiguous') return { ambiguous: true };
        if (resolved.status === 'resolved') return { record: resolved.record };
      }
      if (correction.target.candidateId) {
        const record = findByInference(this.registry, correction.target.candidateId);
        if (record) return { record };
      }
    }
    const names = [candidate.title, ...(candidate.aliases || [])];
    let found = null;
    for (const name of names) {
      const resolved = this.registry.resolve(name);
      if (resolved.status === 'ambiguous') return { ambiguous: true };
      if (resolved.status === 'resolved') {
        if (found && found.id !== resolved.record.id) return { ambiguous: true };
        found = resolved.record;
      }
    }
    return found ? { record: found } : {};
  }

  _parentFor(candidate, correction, existing, correctionVerified = false) {
    if (candidate.parentAlternatives.length > 0
      && !(correction && correctionVerified)) {
      return { ambiguous: true };
    }
    const assertedParent = correction && ['reparent', 'establish'].includes(correction.operation)
      ? correction.assertedChange.parentId
      : (correction && correction.assertedChange.parentId !== null ? correction.assertedChange.parentId : undefined);
    const parentId = assertedParent !== undefined ? assertedParent : candidate.parentId;
    if (parentId === null || parentId === undefined) return { parentId: null };
    const parent = this.registry.get(parentId);
    if (!parent || parent.kind !== 'project') return { missing: true };
    if (existing && parent.id === existing.id) return { invalid: true };
    return { parentId: parent.id };
  }

  _verifiedCorrection(correction, attestor) {
    if (!correction || correction.trustTier !== 'verified' || correction.attestation.status !== 'verified') return false;
    return contracts.isVerifiedCorrection(correction, attestor || this.correctionAttestor);
  }

  _policy(input) {
    const { candidate, selectedEvidence, coverage, correction } = input;
    const attestor = input.correctionAttestor || this.correctionAttestor;
    const verifiedCorrection = this._verifiedCorrection(correction, attestor);
    const lineage = [...candidate.lineage, ...(correction ? [correction.correctionId] : [])];
    const suppressionKey = candidateSuppressionKey(candidate);

    // Engine quarantine is an authority boundary, not a confidence hint. A
    // verified owner correction may resolve it; corroboration alone may not.
    if (candidate.disposition === 'quarantined' && !verifiedCorrection) return {
      disposition: 'quarantined',
      reasonCodes: [...candidate.reasonCodes, 'candidate-quarantined'],
      canonical: null,
      suppressionKey,
      lineage,
    };

    const canonical = this._canonicalFor(input);
    const existing = canonical.record || null;
    const parent = this._parentFor(candidate, verifiedCorrection ? correction : null, existing, verifiedCorrection);
    const coverageInfo = coverageAssessment(selectedEvidence, coverage);
    const corroboration = corroborationAssessment(selectedEvidence, coverageInfo);

    if (correction && correction.target.candidateId && correction.target.candidateId !== candidate.candidateId) return {
      disposition: 'quarantined', reasonCodes: ['correction-target-mismatch'], canonical: existing,
      suppressionKey, lineage,
    };

    if (!verifiedCorrection) {
      const suppressed = this._events()
        .filter((event) => event.eventType === 'decision')
        .map((event) => event.payload)
        .find((decision) => decision.suppressionKey === suppressionKey && ['rejected', 'superseded'].includes(decision.disposition));
      if (suppressed) return {
        disposition: suppressed.disposition,
        reasonCodes: ['suppressed-evidence'],
        canonical: existing ? canonicalRef(existing) : null,
        suppressionKey,
        lineage,
      };
    }

    if (canonical.ambiguous) return {
      disposition: 'quarantined', reasonCodes: ['ambiguous-identity'], canonical: existing,
      suppressionKey, lineage,
    };
    if (canonical.missing) return {
      disposition: 'quarantined', reasonCodes: ['canonical-not-found'], canonical: null,
      suppressionKey, lineage,
    };
    if (parent.ambiguous) return {
      disposition: 'quarantined', reasonCodes: ['ambiguous-parent'], canonical: existing,
      suppressionKey, lineage,
    };
    if (parent.missing) return {
      disposition: 'quarantined', reasonCodes: ['parent-not-found'], canonical: existing,
      suppressionKey, lineage,
    };
    if (parent.invalid) return {
      disposition: 'quarantined', reasonCodes: ['parent-cycle'], canonical: existing,
      suppressionKey, lineage,
    };

    if (correction && !verifiedCorrection) {
      if (existing) return {
        disposition: 'unchanged', reasonCodes: ['correction-unverified'], canonical: canonicalRef(existing),
        suppressionKey: null, lineage,
      };
      return {
        disposition: 'provisional', reasonCodes: ['correction-unverified'], canonical: null,
        suppressionKey: null, lineage,
      };
    }
    if (correction && verifiedCorrection) {
      if (correction.operation === 'reject') return {
        disposition: 'rejected', reasonCodes: ['correction-rejected'], canonical: existing ? canonicalRef(existing) : null,
        suppressionKey, lineage,
      };
      return {
        disposition: 'corrected', reasonCodes: ['correction-verified'], canonical: existing ? canonicalRef(existing) : null,
        suppressionKey: null, lineage,
      };
    }
    if (candidate.disposition === 'rejected') return { disposition: 'rejected', reasonCodes: ['candidate-rejected'], canonical: existing ? canonicalRef(existing) : null, suppressionKey, lineage };
    if (candidate.disposition === 'superseded') return { disposition: 'superseded', reasonCodes: ['candidate-superseded'], canonical: existing ? canonicalRef(existing) : null, suppressionKey, lineage };
    if (existing && !coverageInfo.sufficient) return {
      disposition: 'unchanged', reasonCodes: ['coverage-incomplete'], canonical: canonicalRef(existing),
      suppressionKey: null, lineage,
    };
    if (!coverageInfo.sufficient) return {
      disposition: 'provisional', reasonCodes: ['coverage-incomplete'], canonical: null,
      suppressionKey: null, lineage,
    };
    if (!corroboration.sourceDiverse) return { disposition: 'provisional', reasonCodes: ['source-diversity-insufficient'], canonical: existing ? canonicalRef(existing) : null, suppressionKey: null, lineage };
    if (!corroboration.distinctDates || !corroboration.spanAtLeast24Hours) return { disposition: 'provisional', reasonCodes: ['temporal-span-insufficient'], canonical: existing ? canonicalRef(existing) : null, suppressionKey: null, lineage };
    if (existing) return { disposition: 'associated', reasonCodes: ['policy-qualified'], canonical: canonicalRef(existing), suppressionKey: null, lineage };
    return { disposition: 'established', reasonCodes: ['policy-qualified'], canonical: null, suppressionKey: null, lineage };
  }

  _registryInput(input, policy, decision) {
    const { candidate, correction } = input;
    const verifiedCorrection = correction && this._verifiedCorrection(correction, input.correctionAttestor || this.correctionAttestor);
    const asserted = verifiedCorrection ? correction.assertedChange : {};
    const kind = asserted.kind || candidate.kind;
    const title = asserted.title || candidate.title;
    const parentId = verifiedCorrection && ['reparent', 'establish'].includes(correction.operation)
      ? asserted.parentId
      : (asserted.parentId !== null && asserted.parentId !== undefined ? asserted.parentId : candidate.parentId);
    return {
      kind,
      title,
      parentId: parentId === undefined ? null : parentId,
      aliases: candidate.aliases,
      assertedAliases: asserted.aliases || [],
      legacyTitle: candidate.title !== title ? candidate.title : null,
    };
  }

  _mutateRegistry(input, policy, decision, expectedGeneration, expectedRevision) {
    const canonical = this._canonicalFor(input);
    const existing = canonical.record || null;
    const values = this._registryInput(input, policy, decision);
    const metadata = metadataFor(input.candidate, decision, policy.suppressionKey);
    if (input.expectedRegistryGeneration !== undefined && input.expectedRegistryGeneration !== this.registry.generation) {
      const error = new Error('stale registry generation: expected caller generation does not match current generation');
      error.code = 'STALE_REGISTRY';
      throw error;
    }
    const generation = expectedGeneration === undefined ? this.registry.generation : expectedGeneration;
    if (existing) {
      if (values.kind !== existing.kind) {
        const error = new Error('inference cannot change canonical record kind');
        error.code = 'INVALID_INFERENCE';
        throw error;
      }
      const patch = {
        aliases: mergeAliases(existing, values.aliases, values.title !== existing.title ? existing.title : null, values.assertedAliases),
        inference: metadata,
      };
      if (input.correction && this._verifiedCorrection(input.correction, input.correctionAttestor || this.correctionAttestor)) {
        if (input.correction.operation === 'rename' || values.title !== existing.title) patch.title = values.title;
        if (input.correction.operation === 'reparent'
          || (input.correction.assertedChange.parentId !== null && values.parentId !== existing.parentId)) {
          patch.parentId = values.parentId;
        }
        if (input.correction.operation === 'restore') patch.lifecycle = existing.kind === 'outcome' ? 'planned' : 'active';
      }
      const result = this.registry.update(existing.id, patch, {
        expectedGeneration: generation,
        expectedRevision: expectedRevision === undefined ? existing.revision : expectedRevision,
        actor: 'project-inference',
        session: 'project-inference',
        decisionId: decision.decisionId,
        reasonCodes: decision.reasonCodes,
      });
      return result;
    }
    if (values.kind === 'outcome' && !values.parentId) {
      const error = new Error('outcome inference requires a canonical project parent');
      error.code = 'INVALID_INFERENCE';
      throw error;
    }
    return this.registry.create({
      kind: values.kind,
      title: values.title,
      aliases: mergeAliases(null, values.aliases, values.legacyTitle, values.assertedAliases),
      parentId: values.parentId,
      inference: metadata,
    }, {
      expectedGeneration: generation,
      actor: 'project-inference',
      session: 'project-inference',
      decisionId: decision.decisionId,
      reasonCodes: decision.reasonCodes,
    });
  }

  _result({ status, decision, registryResult = null, replayed = false, reasonCodes = decision.reasonCodes, error = null }) {
    const record = registryResult?.record || null;
    return {
      contract: RECONCILER_CONTRACT,
      status,
      replayed,
      decision: clone(decision),
      record: record ? clone(record) : null,
      registryGeneration: this.registry.generation,
      reasonCodes: reasons(reasonCodes),
      error: error ? String(error.message || error) : null,
    };
  }

  _recoverCommittedMutation(input) {
    const record = findByInference(this.registry, input.candidate.candidateId);
    const metadata = record?.inference;
    if (!record || !metadata || !MUTATING_DISPOSITIONS.has(metadata.disposition)) return null;
    if (this._priorDecision(metadata.decisionId)) return null;
    if (metadata.suppressionKeys.length > 1) throw new Error('committed inference metadata has unsupported suppression cardinality');
    const lineage = [...input.candidate.lineage, ...(input.correction ? [input.correction.correctionId] : [])];
    const recovered = contracts.createInferenceDecision({
      decisionId: metadata.decisionId,
      candidateId: input.candidate.candidateId,
      policyRevision: this.policyRevision,
      disposition: metadata.disposition,
      canonical: canonicalRef(record),
      reasonCodes: metadata.reasonCodes,
      suppressionKey: metadata.suppressionKeys[0] || null,
      supersededBy: metadata.supersededBy,
      lineage,
    });
    this.ledger.appendDecision(recovered);
    return this._result({
      status: recovered.disposition,
      decision: recovered,
      registryResult: { record },
      replayed: true,
    });
  }

  reconcile(rawInput, options = {}) {
    const input = normalizeInput(rawInput);
    if (input.candidate.engineRevision !== this.engineRevision) {
      throw new Error(`candidate engine revision mismatch: expected ${this.engineRevision}`);
    }
    if (input.candidate.policyRevision !== this.policyRevision) {
      throw new Error(`candidate policy revision mismatch: expected ${this.policyRevision}`);
    }
    const attestor = input.correctionAttestor || this.correctionAttestor;
    // A normalized correction that carries an admission is never silently
    // trusted.  The host attestor has to verify it at this boundary.
    if (input.correction && input.correction.trustTier === 'verified' && !this._verifiedCorrection(input.correction, attestor)) {
      throw new Error('verified correction requires a trusted host attestor');
    }
    for (const item of input.evidence) this.ledger.appendEvidence(item);
    if (input.correction) this.ledger.appendCorrection(input.correction);
    this.ledger.appendCandidate(input.candidate);

    // Resolve exact replay before looking at the current registry.  An
    // established candidate naturally resolves as an existing record on a
    // later run; re-evaluating it would otherwise change its disposition to
    // associated and create a second decision.
    const priorCandidateDecision = this._priorDecisionForCandidate(
      input.candidate.candidateId,
      input.correction ? input.correction.correctionId : null,
    );
    if (priorCandidateDecision) {
      const record = priorCandidateDecision.canonical ? this.registry.get(priorCandidateDecision.canonical.recordId) : null;
      return this._result({
        status: priorCandidateDecision.disposition,
        decision: priorCandidateDecision,
        registryResult: record ? { record } : null,
        replayed: true,
      });
    }


    // ProjectRegistry commits atomically, but it cannot share a transaction
    // with the append-only inference ledger. If a process died after the
    // registry commit, its inference metadata is a durable recovery marker.
    const recovered = this._recoverCommittedMutation(input);
    if (recovered) return recovered;

    const policy = this._policy(input);
    const lineage = policy.lineage;
    const decision = decisionFor({
      candidate: input.candidate,
      disposition: policy.disposition,
      canonical: null,
      reasonCodes: policy.reasonCodes,
      suppressionKey: policy.suppressionKey,
      supersededBy: policy.supersededBy || null,
      lineage,
    }, this.policyRevision);
    const prior = this._priorDecision(decision.decisionId);
    if (prior) {
      const record = prior.canonical ? this.registry.get(prior.canonical.recordId) : null;
      return this._result({ status: prior.disposition, decision: prior, registryResult: record ? { record } : null, replayed: true });
    }

    if (!MUTATING_DISPOSITIONS.has(policy.disposition)) {
      const nonMutating = contracts.createInferenceDecision({ ...decision, canonical: policy.canonical });
      this.ledger.appendDecision(nonMutating);
      const record = policy.canonical ? this.registry.get(policy.canonical.recordId) : null;
      return this._result({ status: policy.disposition, decision: nonMutating, registryResult: record ? { record } : null });
    }

    const expectedGeneration = options.expectedRegistryGeneration === undefined
      ? input.expectedRegistryGeneration
      : options.expectedRegistryGeneration;
    const expectedRevision = options.expectedRegistryRevision === undefined
      ? input.expectedRegistryRevision
      : options.expectedRegistryRevision;
    let registryResult;
    try {
      registryResult = this._mutateRegistry(input, policy, decision, expectedGeneration, expectedRevision);
    } catch (error) {
      if (/stale registry generation|stale project revision/i.test(error.message) || error.code === 'STALE_REGISTRY') {
        const blocked = contracts.createInferenceDecision({ ...decision, disposition: 'not-evaluable', canonical: null, reasonCodes: reasons([...decision.reasonCodes, 'stale-registry']) });
        this.ledger.appendDecision(blocked);
        return this._result({ status: 'blocked', decision: blocked, reasonCodes: blocked.reasonCodes, error });
      }
      throw error;
    }
    const finalDecision = contracts.createInferenceDecision({ ...decision, canonical: canonicalRef(registryResult.record) });
    this.ledger.appendDecision(finalDecision);
    return this._result({ status: finalDecision.disposition, decision: finalDecision, registryResult });
  }
}

function createProjectInferenceReconciler(options) { return new ProjectInferenceReconciler(options); }

module.exports = {
  ENGINE_REVISION,
  MIN_SPAN_MS,
  MUTATING_DISPOSITIONS: [...MUTATING_DISPOSITIONS],
  NON_MUTATING_DISPOSITIONS: [...NON_MUTATING_DISPOSITIONS],
  POLICY_REVISION,
  ProjectInferenceReconciler,
  RECONCILER_CONTRACT,
  createProjectInferenceReconciler,
  coverageAssessment,
  corroborationAssessment,
  normalizeInput,
};
