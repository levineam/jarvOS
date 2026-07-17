'use strict';

const { runTakeIssueToDone } = require('../features/orchestrator');
let CONTRACT_VERSION;
try {
  ({ CONTRACT_VERSION } = require('@jarvos/control-plane'));
} catch (_) {
  // The bootstrap repository ships public modules side-by-side before package
  // installation; published consumers resolve the declared package dependency.
  ({ CONTRACT_VERSION } = require('../../../jarvos-control-plane/src/contracts'));
}

const HOST_ADAPTER_SCHEMA_VERSION = 'jarvos-coding-host-adapter/v1';
const CODING_CONTROL_PLANE_PORT_SCHEMA_VERSION = 'jarvos-coding-control-plane-port/v1';
const CODING_MANAGER_ID = 'jarvos-coding';
const CODING_MUTATION_CLASS = 'coding.take-issue-to-done';
const SUPPORTED_HOSTS = Object.freeze(['claude-code', 'openclaw', 'codex', 'hermes', 'personality']);
const DEFAULT_MCP_TOOL_NAME = 'jarvos_coding_take_issue_to_done';
const DEFAULT_SKILL_NAME = 'jarvos-coding';

function normalizeHost(host = '') {
  const value = String(host || '').trim().toLowerCase();
  if (value === 'claude' || value === 'claude_code') return 'claude-code';
  if (value === 'open-claw' || value === 'open_claw') return 'openclaw';
  if (value === 'codex-cli') return 'codex';
  if (value === 'hermes-cli' || value === 'hermes-sidecar') return 'hermes';
  if (value === 'future-personality' || value === 'custom-personality') return 'personality';
  return value;
}

function codingHostAdapterContract(host) {
  const normalizedHost = normalizeHost(host);
  if (!SUPPORTED_HOSTS.includes(normalizedHost)) {
    throw new Error(`unsupported jarvos-coding host adapter: ${host}`);
  }

  return {
    schemaVersion: HOST_ADAPTER_SCHEMA_VERSION,
    host: normalizedHost,
    role: 'thin-host-adapter',
    drives: ['runTakeIssueToDone'],
    requiredTools: ['jarvos_session_state.read', 'jarvos_session_state.write'],
    entryBehavior: {
      readSessionState: true,
      readLiveArtifactFromPointer: true,
    },
    continuity: {
      sharedBrain: 'jarvos_session_state',
      surfaces: ['@jarvos/agent-context', 'scripts/jarvos-session-state.js'],
      readOnEntry: ['jarvos_session_state.read', 'hydrate_live_artifact_pointer'],
      writeCheckpoint: ['jarvos_session_state.write'],
      freshSessionSurvival: 'file-backed session state keyed by session id',
    },
    checkpointPolicy: {
      docsAndIssues: 'pointer-only',
      code: 'checkpoint-thin-thread-at-gates',
    },
  };
}

function articleFor(value) {
  return /^[aeiou]/i.test(String(value || '')) ? 'an' : 'a';
}

function continuityAdapterMatrix(hosts = SUPPORTED_HOSTS) {
  return hosts.map((host) => {
    try {
      const contract = codingHostAdapterContract(host);
      return {
        host,
        normalizedHost: contract.host,
        status: 'supported',
        readOnEntry: contract.entryBehavior.readSessionState,
        hydrateLiveArtifact: contract.entryBehavior.readLiveArtifactFromPointer,
        writeCheckpoint: contract.requiredTools.includes('jarvos_session_state.write'),
        freshSessionSurvival: contract.continuity.freshSessionSurvival,
        ownerAction: null,
      };
    } catch (error) {
      const normalizedHost = normalizeHost(host);
      return {
        host,
        normalizedHost,
        status: 'unsupported',
        readOnEntry: false,
        hydrateLiveArtifact: false,
        writeCheckpoint: false,
        freshSessionSurvival: null,
        ownerAction: `Add ${articleFor(normalizedHost)} ${normalizedHost} host adapter or mark the lane out of scope before assigning shared-brain continuity work.`,
      };
    }
  });
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeRegistrationResult(host, result = {}) {
  return {
    schemaVersion: HOST_ADAPTER_SCHEMA_VERSION,
    host,
    status: result.status || 'registered',
    mcpTool: result.mcpTool || DEFAULT_MCP_TOOL_NAME,
    skill: result.skill || DEFAULT_SKILL_NAME,
    details: result.details || null,
  };
}

function buildMcpToolDescriptor(host, options = {}) {
  return {
    name: options.name || DEFAULT_MCP_TOOL_NAME,
    title: options.title || 'Take jarvOS Coding Issue To Done',
    description: options.description || `Run @jarvos/coding take-issue-to-done from ${host}.`,
    inputSchema: {
      type: 'object',
      required: ['issueIdentifier'],
      properties: {
        issueIdentifier: {
          type: 'string',
          description: 'Tracker issue identifier, for example SUP-2214.',
        },
        branch: {
          type: 'string',
          description: 'Optional issue-named branch to use for the run.',
        },
        baseRef: {
          type: 'string',
          description: 'Optional git base ref. Defaults to origin/main.',
        },
        issue: {
          type: 'object',
          description: 'Optional tracker issue payload. Must remain pointer-first.',
        },
      },
    },
  };
}

function buildSkillDescriptor(host, options = {}) {
  return {
    name: options.name || DEFAULT_SKILL_NAME,
    title: options.title || 'jarvOS Coding',
    description: options.description || 'Run the portable jarvOS coding orchestrator from this host.',
    host,
    invokes: DEFAULT_MCP_TOOL_NAME,
    contract: codingHostAdapterContract(host),
  };
}

async function maybeRegisterMcp(registry, host, toolDescriptor, invoke) {
  if (!registry || typeof registry.registerMcpTool !== 'function') return null;
  return registry.registerMcpTool({
    ...toolDescriptor,
    handler: invoke,
    host,
  });
}

async function maybeRegisterSkill(registry, host, skillDescriptor) {
  if (!registry || typeof registry.registerSkill !== 'function') return null;
  return registry.registerSkill({
    ...skillDescriptor,
    host,
  });
}

function createCodingHostAdapter(host, options = {}) {
  const normalizedHost = normalizeHost(host);
  const contract = codingHostAdapterContract(normalizedHost);
  const registry = options.registry || null;
  const adapterProvider = options.adapters || options.adapterProvider;
  const toolDescriptor = buildMcpToolDescriptor(normalizedHost, options.mcpTool);
  const skillDescriptor = buildSkillDescriptor(normalizedHost, options.skill);

  async function resolveAdapters(input = {}) {
    if (typeof adapterProvider === 'function') {
      return requireObject(await adapterProvider(input, { host: normalizedHost, contract }), 'host adapter provider result');
    }
    return requireObject(adapterProvider || {}, 'host adapters');
  }

  async function invoke(input = {}) {
    const adapters = await resolveAdapters(input);
    const result = await runTakeIssueToDone(input, adapters);
    return {
      schemaVersion: HOST_ADAPTER_SCHEMA_VERSION,
      host: normalizedHost,
      status: result.status || 'completed',
      result,
    };
  }

  async function register(registrationRegistry = registry) {
    const mcp = await maybeRegisterMcp(registrationRegistry, normalizedHost, toolDescriptor, invoke);
    const skill = await maybeRegisterSkill(registrationRegistry, normalizedHost, skillDescriptor);
    return normalizeRegistrationResult(normalizedHost, {
      details: { mcp, skill },
      mcpTool: toolDescriptor.name,
      skill: skillDescriptor.name,
    });
  }

  return {
    ...contract,
    mcpTool: toolDescriptor,
    skill: skillDescriptor,
    register,
    runTakeIssueToDone: invoke,
  };
}

function createClaudeCodeHostAdapter(options = {}) {
  return createCodingHostAdapter('claude-code', options);
}

function createCodexHostAdapter(options = {}) {
  return createCodingHostAdapter('codex', options);
}

function createOpenClawHostAdapter(options = {}) {
  return createCodingHostAdapter('openclaw', options);
}

function codingControlPlaneManifest(options = {}) {
  return {
    schemaVersion: 'jarvos-control-plane.manager.v1',
    contractVersion: CONTRACT_VERSION,
    managerId: options.managerId || CODING_MANAGER_ID,
    displayName: options.displayName || 'jarvOS Coding',
    capabilities: ['execute', 'verify'],
    mutationClasses: [{
      resourceType: 'paperclip-issue',
      class: CODING_MUTATION_CLASS,
    }],
    operationContract: {
      finalSideEffectFence: { required: true, mode: 'target-fenced' },
      verifier: { authoritativeReadPath: 'coding-submission-evidence' },
    },
    trust: { level: 'trusted' },
  };
}

function issueIdentifierFor(command = {}) {
  const identifier = command.commandSpec?.arguments?.issueIdentifier
    || command.commandSpec?.arguments?.issue?.identifier
    || command.resource?.id;
  if (!identifier) throw new Error('coding command requires an issueIdentifier-scoped resource');
  return String(identifier);
}

function submissionEvidenceFrom(result = {}) {
  const events = Array.isArray(result.events) ? result.events : [];
  const byStage = Object.fromEntries(events.map((event) => [event.stage, event.result || null]));
  const checkpoint = Array.isArray(result.checkpoints) && result.checkpoints.length
    ? result.checkpoints.at(-1)
    : null;
  return {
    issueIdentifier: result.issueIdentifier || null,
    branch: result.branch || null,
    checkpoint,
    pullRequest: byStage.pullRequest || null,
    postMergeSweep: byStage.postMergeSweep || null,
    verifyClose: byStage.verifyClose || null,
  };
}

function createCodingControlPlanePort(options = {}) {
  const host = normalizeHost(options.host || 'codex');
  const hostAdapter = options.hostAdapter || createCodingHostAdapter(host, { adapters: options.adapters });
  const completed = new Map();

  async function executeFenced(command = {}, context = {}) {
    if (command.mutationClass !== CODING_MUTATION_CLASS) {
      throw new Error(`unsupported coding mutation class: ${command.mutationClass}`);
    }
    if (command.commandSpec?.operation !== 'take-issue-to-done') {
      throw new Error(`unsupported coding operation: ${command.commandSpec?.operation}`);
    }
    if (!context || typeof context.assertCurrentFence !== 'function') {
      throw new Error('coding control-plane execution requires assertCurrentFence');
    }
    context.assertCurrentFence();
    const completedResult = completed.get(command.id);
    if (completedResult) return completedResult;

    const issueIdentifier = issueIdentifierFor(command);
    const args = command.commandSpec.arguments || {};
    const result = await hostAdapter.runTakeIssueToDone({
      issueIdentifier,
      issue: args.issue || { identifier: issueIdentifier },
      branch: args.branch,
      baseRef: args.baseRef,
      resumeFrom: command.checkpoint || null,
      controlPlane: {
        commandId: command.id,
        fence: context.fence,
        desiredGeneration: command.desiredGeneration,
      },
    });
    context.assertCurrentFence();
    const orchestrator = result.result || result;
    if (orchestrator.status !== 'completed') {
      throw new Error(`coding host did not complete command: ${orchestrator.status || 'unknown'}`);
    }
    const execution = {
      schemaVersion: CODING_CONTROL_PLANE_PORT_SCHEMA_VERSION,
      status: 'completed',
      host,
      commandId: command.id,
      fence: context.fence,
      checkpoint: submissionEvidenceFrom(orchestrator).checkpoint,
      submissionEvidence: submissionEvidenceFrom(orchestrator),
    };
    completed.set(command.id, execution);
    return execution;
  }

  async function verify(_command, context = {}) {
    const execution = context.execution;
    if (!execution || execution.status !== 'completed' || !execution.submissionEvidence?.verifyClose) {
      return { outcome: 'unverifiable', verifier: `${CODING_MANAGER_ID}.verify`, reason: 'submission evidence is incomplete' };
    }
    return {
      outcome: 'satisfied',
      verifier: `${CODING_MANAGER_ID}.verify`,
      postcondition: {
        issueIdentifier: execution.submissionEvidence.issueIdentifier,
        branch: execution.submissionEvidence.branch,
        checkpoint: execution.checkpoint,
      },
      submissionEvidence: execution.submissionEvidence,
    };
  }

  return {
    schemaVersion: CODING_CONTROL_PLANE_PORT_SCHEMA_VERSION,
    manifest: codingControlPlaneManifest(options),
    executeFenced,
    verify,
  };
}

module.exports = {
  CODING_CONTROL_PLANE_PORT_SCHEMA_VERSION,
  CODING_MANAGER_ID,
  CODING_MUTATION_CLASS,
  DEFAULT_MCP_TOOL_NAME,
  DEFAULT_SKILL_NAME,
  HOST_ADAPTER_SCHEMA_VERSION,
  SUPPORTED_HOSTS,
  buildMcpToolDescriptor,
  buildSkillDescriptor,
  codingHostAdapterContract,
  continuityAdapterMatrix,
  createClaudeCodeHostAdapter,
  createCodexHostAdapter,
  createCodingHostAdapter,
  createCodingControlPlanePort,
  createOpenClawHostAdapter,
  codingControlPlaneManifest,
  normalizeHost,
};
