#!/usr/bin/env node
'use strict';

// Public, JSON-lines MCP boundary for managed coding. Host configuration is
// intentionally limited to a private registry binding; no filesystem roots,
// provider selection, executables, or credentials cross this protocol.
const readline = require('node:readline');
// Import only the public runtime boundary, rather than the package barrel:
// MCP initialization must work from an unpacked tarball before any repository
// registry is configured.
const { createCodexRuntime } = require('../src/runtime/codex');
const { resolveOwnerPlanAcceptance } = require('../src/runtime/repository-registry');

const REGISTRY_ENV = 'JARVOS_CODING_REPOSITORY_REGISTRY';
const SHA256 = /^[a-f0-9]{64}$/i;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SAFE_TEXT = /^[^\0\r\n]{1,500}$/;
const PATHISH = /(?:^|[\s"'])\/(?:[^\s"']*)/;
const SECRET = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;

const TOOLS = [
  ['jarvos_coding_plan', 'Create or route a managed plan for an owner-provisioned repository subject.'],
  ['jarvos_coding_accept_plan', 'Accept a plan only when matching durable owner acceptance already exists.'],
  ['jarvos_coding_work', 'Run accepted managed work for an owner-provisioned repository subject.'],
  ['jarvos_coding_finish', 'Run the managed completion gate for an accepted plan.'],
  ['jarvos_coding_status', 'Return public managed-work status.'],
  ['jarvos_coding_resume', 'Resume safe managed-work reconciliation.'],
  ['jarvos_coding_repositories', 'List agent-selectable owner-provisioned repositories.'],
  ['jarvos_coding_health', 'Return public coding runtime health.'],
].map(([name, description]) => ({ name, description, inputSchema: schemaFor(name) }));

function schemaFor(name) {
  const base = {
    type: 'object', additionalProperties: false,
    required: ['repositoryId', 'subjectKey'],
    properties: { repositoryId: { type: 'string', pattern: OPAQUE.source }, subjectKey: { type: 'string', pattern: SUBJECT.source }, workRunId: { type: 'string', pattern: OPAQUE.source } },
  };
  if (name === 'jarvos_coding_repositories' || name === 'jarvos_coding_health') return { type: 'object', additionalProperties: false, properties: {} };
  if (name === 'jarvos_coding_plan') return { ...base, properties: { ...base.properties, input: boundedInputSchema(), operationNonce: { type: 'string', maxLength: 128 } } };
  if (name === 'jarvos_coding_accept_plan' || name === 'jarvos_coding_work') return { ...base, required: [...base.required, 'planDigest', 'packet'], properties: { ...base.properties, planDigest: digestSchema(), expectedPlanDigest: { anyOf: [digestSchema(), { type: 'null' }] }, packet: packetSchema(), artifact: artifactSchema(), operationNonce: { type: 'string', maxLength: 128 } } };
  if (name === 'jarvos_coding_finish') return { ...base, required: [...base.required, 'planDigest'], properties: { ...base.properties, planDigest: digestSchema() } };
  return base;
}
function digestSchema() { return { type: 'string', pattern: SHA256.source }; }
function boundedInputSchema() { return { type: 'object', additionalProperties: false, required: ['kind', 'digest'], properties: { kind: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,80}$' }, digest: digestSchema() } }; }
function artifactSchema() { return { type: 'object', additionalProperties: false, required: ['reference'], properties: { reference: { type: 'string', pattern: '^artifact:[A-Za-z0-9._-]{6,160}$' } } }; }
function packetSchema() { return { type: 'object', additionalProperties: false, required: ['version', 'planDigest', 'steps'], properties: { version: { const: 'jarvos-implementation-packet/v1' }, planDigest: digestSchema(), summary: { type: 'string', maxLength: 500 }, steps: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['id', 'description'], properties: { id: { type: 'string', pattern: OPAQUE.source }, description: { type: 'string', maxLength: 500 }, files: { type: 'array', maxItems: 64, items: { type: 'string' } }, mutation: { type: 'string', maxLength: 500 } } } } } }; }

function fail(message, code = -32602) { const error = new Error(message); error.code = code; throw error; }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function known(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key} is not allowed`); }
function safeString(value, label, max = 500) { if (typeof value !== 'string' || !SAFE_TEXT.test(value) || value.length > max || PATHISH.test(value) || SECRET.test(value)) fail(`${label} is unsafe`); return value; }
function digest(value, label) { if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a SHA-256 digest`); return value; }
function identity(args) { object(args, 'arguments'); known(args, new Set(['repositoryId', 'subjectKey', 'workRunId', 'input', 'operationNonce', 'planDigest', 'expectedPlanDigest', 'packet', 'artifact']), 'arguments'); if (!OPAQUE.test(args.repositoryId || '')) fail('repositoryId is required'); if (typeof args.subjectKey !== 'string' || !SUBJECT.test(args.subjectKey)) fail('subjectKey must be a safe stable identifier'); if (args.workRunId !== undefined && !OPAQUE.test(args.workRunId)) fail('workRunId must be opaque'); return { repositoryId: args.repositoryId, subjectKey: args.subjectKey, ...(args.workRunId ? { workRunId: args.workRunId } : {}) }; }
function packet(value, planDigest) { object(value, 'packet'); known(value, new Set(['version', 'planDigest', 'steps', 'summary']), 'packet'); if (value.version !== 'jarvos-implementation-packet/v1') fail('packet.version is invalid'); digest(value.planDigest, 'packet.planDigest'); if (value.planDigest !== planDigest) fail('packet.planDigest must match planDigest'); if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 128) fail('packet.steps must contain 1 to 128 steps'); for (const [i, step] of value.steps.entries()) { object(step, `packet.steps[${i}]`); known(step, new Set(['id', 'description', 'files', 'mutation']), `packet.steps[${i}]`); if (!OPAQUE.test(step.id || '')) fail(`packet.steps[${i}].id is invalid`); safeString(step.description, `packet.steps[${i}].description`); if (step.mutation !== undefined) safeString(step.mutation, `packet.steps[${i}].mutation`); if (step.files !== undefined && (!Array.isArray(step.files) || step.files.some((file) => typeof file !== 'string' || file.startsWith('/') || file.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(file)))) fail(`packet.steps[${i}].files is invalid`); } if (value.summary !== undefined) safeString(value.summary, 'packet.summary'); return value; }
function publicValue(value) { if (value == null || typeof value === 'boolean' || typeof value === 'number') return value; if (typeof value === 'string') return (value.length <= 1000 && !PATHISH.test(value) && !SECRET.test(value)) ? value : '[redacted]'; if (Array.isArray(value)) return value.map(publicValue); if (typeof value === 'object') { const output = {}; for (const [key, entry] of Object.entries(value)) if (!/^(?:root|path|worktree|credential|provider|command|executable|detail)$/i.test(key)) output[key] = publicValue(entry); return output; } return null; }
function textResult(result, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(publicValue(result)) }], isError }; }
function hostRuntime(options = {}) { const registryPath = options.registryPath || process.env[REGISTRY_ENV]; if (typeof registryPath !== 'string' || !registryPath) fail('coding MCP host registry binding is not configured', -32000); return (options.createRuntime || createCodexRuntime)({ registryPath, ...(options.runtimeOptions || {}) }); }

async function callTool(name, args = {}, options = {}) {
  if (name === 'jarvos_coding_repositories') { object(args, 'arguments'); known(args, new Set(), 'arguments'); return textResult({ ok: true, repositories: hostRuntime(options).listRepositories() }); }
  if (name === 'jarvos_coding_health') { object(args, 'arguments'); known(args, new Set(), 'arguments'); return textResult({ ok: true, health: hostRuntime(options).health() }); }
  const names = new Set(TOOLS.map((tool) => tool.name)); if (!names.has(name)) fail(`Unknown tool: ${name}`, -32601);
  const allowedByTool = {
    jarvos_coding_plan: new Set(['repositoryId', 'subjectKey', 'workRunId', 'input', 'operationNonce']),
    jarvos_coding_accept_plan: new Set(['repositoryId', 'subjectKey', 'workRunId', 'planDigest', 'packet', 'expectedPlanDigest', 'artifact', 'operationNonce']),
    jarvos_coding_work: new Set(['repositoryId', 'subjectKey', 'workRunId', 'planDigest', 'packet', 'operationNonce']),
    jarvos_coding_finish: new Set(['repositoryId', 'subjectKey', 'workRunId', 'planDigest']),
    jarvos_coding_status: new Set(['repositoryId', 'subjectKey', 'workRunId']),
    jarvos_coding_resume: new Set(['repositoryId', 'subjectKey', 'workRunId']),
  };
  known(object(args, 'arguments'), allowedByTool[name], 'arguments');
  const input = identity(args); const runtime = hostRuntime(options); const context = runtime.resolveRequest(input); const workflow = context.managedWorkflow;
  // The runtime owns the qualified persistence subject. Native execution gets
  // the original opaque tracker identifier as its bounded work reference.
  const workflowInput = { ...input, subjectKey: context.subjectKey || input.subjectKey, issueIdentifier: args.subjectKey };
  if (name === 'jarvos_coding_plan') { if (args.input !== undefined) { object(args.input, 'input'); known(args.input, new Set(['kind', 'digest']), 'input'); safeString(args.input.kind, 'input.kind', 80); digest(args.input.digest, 'input.digest'); } if (args.operationNonce !== undefined) safeString(args.operationNonce, 'operationNonce', 128); return textResult(await workflow.plan({ ...workflowInput, input: args.input, operationNonce: args.operationNonce })); }
  if (name === 'jarvos_coding_status' || name === 'jarvos_coding_resume') return textResult(await workflow[name === 'jarvos_coding_status' ? 'status' : 'resume'](workflowInput));
  const planDigest = digest(args.planDigest, 'planDigest');
  if (name === 'jarvos_coding_finish') return textResult(await workflow.finish({ ...workflowInput, planDigest }));
  const implementationPacket = packet(args.packet, planDigest); if (args.operationNonce !== undefined) safeString(args.operationNonce, 'operationNonce', 128);
  if (name === 'jarvos_coding_accept_plan') {
    if (args.expectedPlanDigest !== undefined && args.expectedPlanDigest !== null) digest(args.expectedPlanDigest, 'expectedPlanDigest');
    if (args.artifact !== undefined) { object(args.artifact, 'artifact'); known(args.artifact, new Set(['reference']), 'artifact'); if (typeof args.artifact.reference !== 'string' || !/^artifact:[A-Za-z0-9._-]{6,160}$/.test(args.artifact.reference)) fail('artifact.reference is invalid'); }
    let acceptanceEvidence = null;
    if (context.repository.acceptancePolicy.mode !== 'agent-mediated-allowed') acceptanceEvidence = (options.resolveOwnerAcceptance || resolveOwnerPlanAcceptance)({ registryPath: options.registryPath || process.env[REGISTRY_ENV], repositoryId: context.repositoryId, runId: context.workRunId, planDigest, ...(options.ownerUid === undefined ? {} : { ownerUid: options.ownerUid }) });
    if (context.repository.acceptancePolicy.mode !== 'agent-mediated-allowed' && !acceptanceEvidence) return textResult({ ok: false, status: 'awaiting-plan-acceptance', workRunId: context.workRunId, reasonCode: 'owner_acceptance_required' }, true);
    return textResult(await workflow.acceptPlan({ ...workflowInput, planDigest, packet: implementationPacket, expectedPlanDigest: args.expectedPlanDigest, artifact: args.artifact, operationNonce: args.operationNonce, acceptanceEvidence }));
  }
  return textResult(await workflow.work({ ...workflowInput, planDigest, packet: implementationPacket, operationNonce: args.operationNonce }));
}

function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
async function handle(message, options = {}) { if (!message || typeof message !== 'object') return; const { id, method, params } = message; if (!id && String(method || '').startsWith('notifications/')) return; try { if (method === 'initialize') return write({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'jarvos-coding', version: '0.1.0' } } }); if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); if (method === 'tools/call') return write({ jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments === undefined ? {} : params.arguments, options) }); write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }); } catch (error) { write({ jsonrpc: '2.0', id, error: { code: error.code || -32000, message: publicValue(error.message || String(error)) } }); } }
function main() { const rl = readline.createInterface({ input: process.stdin }); rl.on('line', (line) => { if (!line.trim()) return; try { handle(JSON.parse(line)); } catch (error) { write({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }); } }); }
if (require.main === module) main();
module.exports = { TOOLS, callTool, handle, schemaFor, REGISTRY_ENV };
