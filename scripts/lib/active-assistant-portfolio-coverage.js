'use strict';

const crypto = require('node:crypto');

const ACTIVE_ASSISTANT_PORTFOLIO_COVERAGE_VERSION = 'active-assistant-portfolio-coverage/v1';
const PROJECT_ID = /^prj_[0-9]{6,}$/;
const OUTCOME_ID = /^out_[0-9]{6,}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function uniqueSorted(values) { return [...new Set(values)].sort(); }

function publicResult({ registryGeneration = null, ready, reasonCodes, missingProjectIds, considered }) {
  const result = {
    contractVersion: ACTIVE_ASSISTANT_PORTFOLIO_COVERAGE_VERSION,
    registryGeneration: Number.isInteger(registryGeneration) ? registryGeneration : null,
    ready,
    reasonCodes: uniqueSorted(reasonCodes),
    missingProjectIds: uniqueSorted(missingProjectIds),
    considered: [...considered].sort((left, right) => left.projectId.localeCompare(right.projectId)),
  };
  return { ...result, digest: digest(result) };
}

function verifyPortfolioCoverageReceipt(receipt) {
  const keys = ['considered', 'contractVersion', 'digest', 'missingProjectIds', 'ready', 'reasonCodes', 'registryGeneration'];
  if (!isObject(receipt) || Object.keys(receipt).sort().join('\u0000') !== keys.sort().join('\u0000')) {
    return { ok: false, reasonCode: 'portfolio_coverage_receipt_malformed' };
  }
  const { digest: suppliedDigest, ...unsigned } = receipt;
  if (receipt.contractVersion !== ACTIVE_ASSISTANT_PORTFOLIO_COVERAGE_VERSION
    || !Number.isInteger(receipt.registryGeneration) || receipt.registryGeneration < 0
    || typeof receipt.ready !== 'boolean'
    || !Array.isArray(receipt.reasonCodes) || receipt.reasonCodes.some((code) => typeof code !== 'string')
    || !Array.isArray(receipt.missingProjectIds) || receipt.missingProjectIds.some((id) => !PROJECT_ID.test(id))
    || !Array.isArray(receipt.considered)
    || receipt.considered.some((row) => !isObject(row) || !PROJECT_ID.test(row.projectId || '')
      || !['enumerated', 'missing', 'unverified'].includes(row.state) || !Array.isArray(row.reasonCodes))
    || !DIGEST.test(suppliedDigest || '')
    || digest(unsigned) !== suppliedDigest) {
    return { ok: false, reasonCode: 'portfolio_coverage_receipt_invalid' };
  }
  return { ok: true, receipt: stable(receipt) };
}

function validProvenance(packet) {
  return packet.contract === 'jarvos.projects-context/v1'
    && ['public', 'private', 'restricted'].includes(packet.redactionClass)
    && isObject(packet.capability)
    && typeof packet.capability.receiptId === 'string'
    && /^cap_[a-f0-9]{32}$/.test(packet.capability.receiptId)
    && typeof packet.capability.digest === 'string'
    && DIGEST.test(packet.capability.digest);
}

function inspectPacket(packet) {
  if (!isObject(packet) || !isObject(packet.canonical) || !isObject(packet.truncation)) return { reasonCode: 'malformed_context_packet' };
  if (!Object.hasOwn(packet, 'contract') || !Object.hasOwn(packet, 'redactionClass') || !Object.hasOwn(packet, 'capability')) return { reasonCode: 'missing_context_provenance' };
  if (!validProvenance(packet)) return { reasonCode: 'malformed_context_provenance' };
  if (!Number.isInteger(packet.canonical.generation) || packet.canonical.generation < 0 || !Array.isArray(packet.canonical.records)
    || typeof packet.truncation.truncated !== 'boolean' || !Array.isArray(packet.truncation.sections) || packet.truncation.sections.some((section) => typeof section !== 'string')) return { reasonCode: 'malformed_context_packet' };
  if (packet.truncation.truncated && packet.truncation.sections.some((section) => section === 'canonical.records' || section === 'canonical')) return { reasonCode: 'canonical_records_truncated' };
  const seen = new Set();
  const projects = new Set();
  for (const record of packet.canonical.records) {
    if (!isObject(record) || typeof record.id !== 'string' || typeof record.kind !== 'string') return { reasonCode: 'malformed_context_packet' };
    if (!PROJECT_ID.test(record.id) && !OUTCOME_ID.test(record.id)) return { reasonCode: 'invalid_canonical_record_ids' };
    if (seen.has(record.id)) return { reasonCode: 'duplicate_canonical_record_ids' };
    seen.add(record.id);
    if (record.kind === 'project') {
      if (!PROJECT_ID.test(record.id)) return { reasonCode: 'invalid_canonical_record_ids' };
      projects.add(record.id);
    } else if (record.kind === 'outcome' && !OUTCOME_ID.test(record.id)) return { reasonCode: 'invalid_canonical_record_ids' };
  }
  return { generation: packet.canonical.generation, projects };
}

function evaluatePortfolioCoverage({ registryGeneration, activeProjectIds, packet } = {}) {
  const active = Array.isArray(activeProjectIds) ? activeProjectIds : null;
  const validActive = active && active.every((id) => typeof id === 'string' && PROJECT_ID.test(id));
  const duplicateActive = validActive && new Set(active).size !== active.length;
  const normalizedActive = validActive ? uniqueSorted(active) : [];
  const considered = normalizedActive.map((projectId) => ({ projectId, state: 'unverified', reasonCodes: [] }));
  if (!Number.isInteger(registryGeneration) || registryGeneration < 0) return publicResult({ registryGeneration, ready: false, reasonCodes: ['invalid_registry_generation'], missingProjectIds: [], considered });
  if (!active || !validActive) return publicResult({ registryGeneration, ready: false, reasonCodes: ['invalid_active_project_ids'], missingProjectIds: [], considered });
  if (duplicateActive) return publicResult({ registryGeneration, ready: false, reasonCodes: ['duplicate_active_project_ids'], missingProjectIds: [], considered });

  const inspected = inspectPacket(packet);
  if (inspected.reasonCode) return publicResult({ registryGeneration, ready: false, reasonCodes: [inspected.reasonCode], missingProjectIds: [], considered });
  if (inspected.generation !== registryGeneration) return publicResult({ registryGeneration, ready: false, reasonCodes: ['registry_generation_mismatch'], missingProjectIds: [], considered });

  const missingProjectIds = normalizedActive.filter((id) => !inspected.projects.has(id));
  const missing = new Set(missingProjectIds);
  const finalConsidered = normalizedActive.map((projectId) => missing.has(projectId)
    ? { projectId, state: 'missing', reasonCodes: ['portfolio_enumeration_incomplete'] }
    : { projectId, state: 'enumerated', reasonCodes: [] });
  return publicResult({
    registryGeneration,
    ready: missingProjectIds.length === 0,
    reasonCodes: missingProjectIds.length ? ['portfolio_enumeration_incomplete'] : [],
    missingProjectIds,
    considered: finalConsidered,
  });
}

module.exports = {
  ACTIVE_ASSISTANT_PORTFOLIO_COVERAGE_VERSION,
  evaluatePortfolioCoverage,
  verifyPortfolioCoverageReceipt,
};
