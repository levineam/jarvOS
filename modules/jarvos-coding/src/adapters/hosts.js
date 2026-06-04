'use strict';

const { runTakeIssueToDone } = require('../features/orchestrator');

const HOST_ADAPTER_SCHEMA_VERSION = 'jarvos-coding-host-adapter/v1';
const SUPPORTED_HOSTS = Object.freeze(['claude-code', 'codex', 'hermes', 'personality']);
const DEFAULT_MCP_TOOL_NAME = 'jarvos_coding_take_issue_to_done';
const DEFAULT_SKILL_NAME = 'jarvos-coding';

function normalizeHost(host = '') {
  const value = String(host || '').trim().toLowerCase();
  if (value === 'claude' || value === 'claude_code') return 'claude-code';
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

module.exports = {
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
  normalizeHost,
};
