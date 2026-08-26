#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('readline');
const {
  createNote,
  controlPlane,
  currentWork,
  renderCurrentWorkUnavailable,
  ensureTodayJournal,
  healthTodayJournal,
  hydrate,
  HYDRATION_PROJECTS_PROVIDER,
  loadControlPlaneManager,
  loadSharedSkills,
  recall,
  proposeProjectsContext,
  readProjectsContext,
  readSessionThread,
  runtimeActivationStatus,
  setProjectsContextProvider,
  startupBrief,
  synthesizeRecall,
  writeSessionThread,
} = require('../src/index.js');

const CREDENTIAL_ENV = 'JARVOS_CONTROL_PLANE_CREDENTIAL';
const CREDENTIAL_FILE_ENV = 'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE';
const SHARED_SKILLS_CONFIG_ENV = 'JARVOS_SHARED_SKILLS_CONFIG_PATH';
const STRICT_EMPTY_ARGUMENT_TOOLS = new Set([
  'jarvos_journal_health',
  'jarvos_ensure_today_journal',
]);

let mcpProjectsContextProvider = null;

function normalizeToolArguments(name, args) {
  return STRICT_EMPTY_ARGUMENT_TOOLS.has(name)
    ? (args === undefined ? {} : args)
    : (args || {});
}

// Strict host-credential file binding for persisted MCP sessions. Shared with
// the human CLI and runtime setup: absolute path, owner-only leaf, trusted
// ownership, and trusted non-writable ancestry. Never accept model-visible
// credentials or put path/secret into errors.
function readCredentialFile(filePath) {
  return loadControlPlaneManager().readTrustedCredentialFile(filePath);
}

// Resolve the host-bound control-plane credential for this MCP session.
// Precedence: credential file (persisted host binding) then ambient env
// (non-persisted host sessions / tests). File binding fails closed and never
// falls through to ambient when the file path is configured but unusable.
function resolveHostCredential(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, CREDENTIAL_FILE_ENV)
    && env[CREDENTIAL_FILE_ENV] !== undefined
    && env[CREDENTIAL_FILE_ENV] !== null
    && String(env[CREDENTIAL_FILE_ENV]).length > 0) {
    return readCredentialFile(String(env[CREDENTIAL_FILE_ENV]));
  }
  const ambient = env[CREDENTIAL_ENV];
  if (typeof ambient === 'string' && ambient.length > 0) return ambient;
  return null;
}

// ownerOnly distinguishes two trust policies sharing one ancestry check:
// service/executable modules must be owner-only (no group/world bits at
// all), while a config file may be owner-controlled and merely
// non-group/world-writable, matching projects-context-bootstrap.js's split.
// Never loosen the default -- callers that load and execute code must pass
// ownerOnly: true explicitly or accept it as the default.
function trustedFile(filePath, { root = null, ownerOnly = true } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return null;
    const real = fs.realpathSync(filePath);
    const stat = fs.statSync(real);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || (uid !== null && stat.uid !== uid)) return null;
    if (ownerOnly ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o022) !== 0) return null;
    if (root) {
      const relative = path.relative(root, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    }
    let cursor = path.dirname(real);
    for (;;) {
      const ancestor = fs.statSync(cursor);
      if ((ancestor.mode & 0o022) !== 0 && !(ancestor.isDirectory() && (ancestor.mode & 0o1000) !== 0)) return null;
      if (uid !== null && ancestor.uid !== uid && ancestor.uid !== 0) return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return real;
  } catch {
    return null;
  }
}

function selectedWorkspaceRoot(env = process.env) {
  const configPath = trustedFile(env.JARVOS_PROJECTS_CONTEXT_CONFIG, { ownerOnly: false });
  if (!configPath) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof config.workspaceRoot !== 'string' || !path.isAbsolute(config.workspaceRoot)) return null;
    return fs.realpathSync(config.workspaceRoot);
  } catch {
    return null;
  }
}

const TOOLS = [
  {
    name: 'jarvos_todo_create',
    description: 'Create one canonically linked Beads-backed Todo through the host-authorized work-action service. Agent-discovered work must be submitted as a proposal by the host.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['title', 'operationId', 'canonical'], properties: { title: { type: 'string' }, description: { type: 'string' }, operationId: { type: 'string' }, canonical: { type: 'object' } } },
  },
  {
    name: 'jarvos_todo_list',
    description: 'List bounded, canonically linked Beads-backed Todo work through the host-authorized work-action service.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'jarvos_todo_show',
    description: 'Show one canonically linked Beads-backed Todo work item through the host-authorized work-action service.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['itemId'], properties: { itemId: { type: 'string' } } },
  },
  {
    name: 'jarvos_todo_transition',
    description: 'Request a claim, transition, completion, or reopen through the host-authorized work-action service. The MCP caller cannot supply authorization or verification evidence.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['itemId', 'operationId', 'action'], properties: { itemId: { type: 'string' }, operationId: { type: 'string' }, action: { type: 'string', enum: ['claim', 'transition', 'complete', 'reopen'] }, status: { type: 'string' }, expectedRevision: { type: 'string' } } },
  },
  {
    name: 'jarvos_control_plane',
    description: 'Use the installed host\'s authenticated jarvOS control-plane application service. It has the same request and approval semantics as the human CLI. The host binds the credential to this MCP session server-side; never pass a credential as a tool argument.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['list', 'inspect', 'evidence', 'approval-state', 'activation-status', 'request', 'approve'] },
        runtime: { type: 'string', enum: ['all', 'claude', 'codex', 'hermes', 'openclaw'] },
        requestId: { type: 'string' },
        actor: { type: 'object' }, resource: { type: 'object' }, mutationClass: { type: 'string' },
        desiredGeneration: { type: 'string' }, commandSpec: { type: 'object' }, idempotencyKey: { type: 'string' }, fence: { type: 'number' },
      },
    },
  },
  {
    name: 'jarvos_shared_skills',
    description: 'Inspect and manage cross-harness shared-skill parity. Status and explain are redacted reads; all other operations require the host-bound owner session and never reveal private names, paths, or bodies.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      additionalProperties: false,
      properties: {
        operation: { type: 'string', enum: ['status', 'explain', 'inventory', 'plan', 'repair', 'exclude', 'include'] },
        id: { type: 'string', description: 'Owner-known canonical skill id for explain, exclude, or include.' },
        reasonCode: { type: 'string', description: 'Optional exclusion reason code.' },
      },
    },
  },
  {
    name: 'jarvos_current_work',
    description: 'Diagnostic compatibility only: return a compact Paperclip current-work summary. This is not Projects orientation context.',
    inputSchema: {
      type: 'object',
      properties: {
        maxItems: { type: 'number', description: 'Maximum issue count to include.' },
        includeAllAgents: { type: 'boolean', description: 'Include issues assigned to any agent.' },
      },
    },
  },
  {
    name: 'jarvos_projects_context',
    description: 'Return the canonical bounded Projects packet through the host-bound provider. This is the sole project-orientation read model; unavailable or partial provider state is returned without raw-ledger fallback.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile: { type: 'string', enum: ['orientation', 'recent-activity'], description: 'Named bounded Projects read profile.' },
        date: { type: 'string', description: 'Local calendar date for recent-activity (YYYY-MM-DD).' },
        timeZone: { type: 'string', description: 'IANA timezone for recent-activity.' },
        from: { type: 'string', description: 'Optional bounded UTC activity-window start.' },
        to: { type: 'string', description: 'Optional bounded UTC activity-window end.' },
      },
    },
  },
  {
    name: 'jarvos_projects_propose',
    description: 'Submit a reviewable Projects proposal through the injected provider. This never creates a project, task, release, or external handoff directly.',
    inputSchema: {
      type: 'object',
      required: ['proposal'],
      additionalProperties: false,
      properties: {
        proposal: { type: 'object', description: 'Provider-neutral proposal payload.' },
      },
    },
  },
  {
    name: 'jarvos_recall',
    description: 'Recall relevant jarvOS memory context through GBrain, optional QMD, and graph sidecar retrieval.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language recall query.' },
        includeQmd: { type: 'boolean', description: 'Include QMD broad vault lookup when available.' },
        autoGraph: { type: 'boolean', description: 'Expand graph context from discovered GBrain seeds.' },
        seeds: { type: 'array', items: { type: 'string' }, description: 'Optional explicit GBrain graph seed pages.' },
        synthesize: { type: 'boolean', description: 'Return a concise retrieval synthesis with the source bundle.' },
        mode: { type: 'string', enum: ['recall', 'synthesis'], description: 'Use synthesis for a WS5 answer over WS4 retrieval evidence.' },
      },
    },
  },
  {
    name: 'jarvos_synthesize',
    description: 'Synthesize a concise answer from jarvOS WS4 retrieval evidence, preserving the source bundle for audit.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language synthesis question.' },
        includeQmd: { type: 'boolean', description: 'Include QMD broad vault lookup when available.' },
        autoGraph: { type: 'boolean', description: 'Expand graph context from discovered GBrain seeds.' },
        seeds: { type: 'array', items: { type: 'string' }, description: 'Optional explicit GBrain graph seed pages.' },
        evidenceLimit: { type: 'number', description: 'Maximum evidence lines to include before the source bundle.' },
      },
    },
  },
  {
    name: 'jarvos_create_note',
    description: "Create an Obsidian note, link it from today's journal, and verify the jarvOS note-capture contract.",
    inputSchema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string', description: 'Note title and filename stem.' },
        content: { type: 'string', description: 'Markdown note body.' },
        frontmatter: { type: 'object', description: 'Additional YAML frontmatter fields.' },
        section: { type: 'string', description: 'Journal section for the wikilink.' },
      },
    },
  },
  {
    name: 'jarvos_session_thread_read',
    description: 'Read the rolling journal-backed live session thread for an artifact, issue, project, or host session. Use on entry before continuing work across AIs.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Stable thread key. Defaults to PAPERCLIP_TASK_ID/JARVOS_SESSION_THREAD_ID/default.' },
        issueIdentifier: { type: 'string', description: 'Issue identifier such as SUP-2219.' },
        artifact: { type: 'string', description: 'Artifact pointer such as an issue, branch, note, URL, or file path.' },
        project: { type: 'string', description: 'Project tag used when no explicit thread id is provided.' },
        title: { type: 'string', description: 'Explicit note title to read.' },
        routeCapability: { type: 'string', description: 'Opaque short-lived route binding issued by the trusted native adapter.' },
        maxChars: { type: 'number', description: 'Maximum characters of thread content to return.' },
      },
    },
  },
  {
    name: 'jarvos_session_thread_write',
    description: "Append a checkpoint to the rolling journal-backed live session thread and link the thread note from today's journal.",
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'Stable thread key. Defaults to PAPERCLIP_TASK_ID/JARVOS_SESSION_THREAD_ID/default.' },
        issueIdentifier: { type: 'string', description: 'Issue identifier such as SUP-2219.' },
        artifact: { type: 'string', description: 'Artifact pointer such as an issue, branch, note, URL, or file path.' },
        project: { type: 'string', description: 'Project tag for frontmatter.' },
        host: { type: 'string', description: 'Host writing the checkpoint, such as claude-code, openclaw, codex, or hermes.' },
        actor: { type: 'string', description: 'AI/persona writing the checkpoint.' },
        event: { type: 'string', description: 'Checkpoint event such as entry, decision, artifact-change, task-switch, or pre-compaction.' },
        summary: { type: 'string', description: 'What changed or what the next AI needs to know.' },
        decision: { type: 'string', description: 'Latest decision to preserve.' },
        nextStep: { type: 'string', description: 'Concrete next action for the next host.' },
        title: { type: 'string', description: 'Explicit note title to write.' },
        routeCapability: { type: 'string', description: 'Opaque short-lived route binding issued by the trusted native adapter.' },
      },
    },
  },
  {
    name: 'jarvos_startup_brief',
    description: 'Return a bounded startup brief with current work and optional targeted recall.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional targeted recall query to include.' },
        maxItems: { type: 'number', description: 'Maximum issue count to include.' },
        maxChars: { type: 'number', description: 'Maximum output characters.' },
      },
    },
  },
  {
    name: 'jarvos_hydrate',
    description: 'Return a bounded jarvOS Working Context Packet. Use this when the user says "boot jarvOS", asks to hydrate jarvOS, or wants current jarvOS working context for a chat or session.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Maximum output characters. Defaults to about 12000.' },
        maxItems: { type: 'number', description: 'Maximum Paperclip issue count to include.' },
        includeAllAgents: { type: 'boolean', description: 'Include issues assigned to any agent.' },
        statuses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paperclip statuses to include. Defaults to in_progress and in_review.',
        },
      },
    },
  },
  {
    name: 'jarvos_journal_health',
    description: 'Return a bounded, read-only health projection for today\'s configured journal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'jarvos_ensure_today_journal',
    description: 'Mutating action: ensure today\'s configured journal only after an explicit user request to create/ensure it or a trusted host-declared maintenance trigger. Health is the default read-only status action; do not run this during startup housekeeping.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
];

const WORK_ACTION_HOST_UNAVAILABLE = 'Todo work-action host binding is unavailable. Set JARVOS_WORK_ACTION_SERVICE_MODULE to an absolute owner-only host service module and JARVOS_PROJECTS_CONTEXT_CONFIG to an absolute trusted Projects context config whose workspaceRoot contains that module.';
const WORK_ACTION_HOST_REFUSED = 'Todo work-action host binding was refused. JARVOS_WORK_ACTION_SERVICE_MODULE must be an owner-only regular file contained under the workspaceRoot selected by JARVOS_PROJECTS_CONTEXT_CONFIG.';

function envBinding(name, env = process.env) {
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function loadHostWorkActionService() {
  const modulePath = envBinding('JARVOS_WORK_ACTION_SERVICE_MODULE');
  const configPath = envBinding('JARVOS_PROJECTS_CONTEXT_CONFIG');
  if (!modulePath || !configPath) {
    return { service: null, error: WORK_ACTION_HOST_UNAVAILABLE };
  }
  const selectedRoot = selectedWorkspaceRoot();
  const trusted = selectedRoot ? trustedFile(modulePath, { root: selectedRoot, ownerOnly: true }) : null;
  if (!trusted) {
    return { service: null, error: WORK_ACTION_HOST_REFUSED };
  }
  // Past this point the module passed the containment check, so reporting the
  // containment message would name the wrong cause -- the failure is inside the
  // host module, and the operator needs to see which.
  try {
    const loaded = require(trusted);
    const service = typeof loaded === 'function' ? loaded() : (loaded?.service || loaded);
    if (!service || typeof service !== 'object') {
      return { service: null, error: 'Todo work-action host module loaded but exported no service object.' };
    }
    return { service, error: null };
  } catch (error) {
    const detail = error && error.message ? error.message : 'unknown error';
    return { service: null, error: `Todo work-action host module failed to load: ${detail}` };
  }
}

async function todoAction(name, args) {
  const { service, error } = loadHostWorkActionService();
  if (!service) return textResult(error, true);
  // Deliberately project only ordinary request fields. Authorization, human
  // identity, and verification receipts are host-bound service state, never
  // caller-controlled MCP arguments.
  const actor = { kind: 'agent', id: 'mcp' };
  if (name === 'jarvos_todo_create') return textResult(JSON.stringify(await service.create({ title: args.title, description: args.description, operationId: args.operationId, canonical: args.canonical, actor }), null, 2));
  if (name === 'jarvos_todo_list') return textResult(JSON.stringify(await service.list(), null, 2));
  if (name === 'jarvos_todo_show') return textResult(JSON.stringify(await service.show(args), null, 2));
  const request = { itemId: args.itemId, operationId: args.operationId, expectedRevision: args.expectedRevision, actor };
  if (args.action === 'claim') return textResult(JSON.stringify(await service.claim(request), null, 2));
  if (args.action === 'transition') return textResult(JSON.stringify(await service.transition({ ...request, status: args.status }), null, 2));
  if (args.action === 'complete') {
    if (typeof service.completeFromHost !== 'function') return textResult('Todo host completion binding is unavailable', true);
    return textResult(JSON.stringify(await service.completeFromHost(request), null, 2));
  }
  return textResult(JSON.stringify(await service.reopen(request), null, 2));
}

function setMcpProjectsContextProvider(provider) {
  mcpProjectsContextProvider = provider || null;
  setProjectsContextProvider(mcpProjectsContextProvider);
  return mcpProjectsContextProvider;
}
const BOOT_JARVOS_PROMPT_TEXT = [
  'Boot jarvOS for this chat.',
  '',
  'Call the jarvos_hydrate tool with maxChars: 9000, then use the returned jarvOS Working Context Packet as working context for the rest of this chat.',
  '',
  'After the tool call, reply with a concise confirmation that includes:',
  '- whether the jarvOS Working Context Packet was loaded',
  '- whether the Hydration Report was included',
  '- which source groups were included',
  '- any omissions, stale data, or missing sources reported',
  '',
  'Do not paste raw private notes, secrets, API tokens, or the full packet unless explicitly asked.',
].join('\n');

const PROMPTS = [
  {
    name: 'boot_jarvos',
    title: 'Boot jarvOS',
    description: 'Hydrate the current chat with the bounded jarvOS Working Context Packet.',
    arguments: [
      {
        name: 'maxChars',
        description: 'Optional maximum character budget for the hydration packet. Defaults to 9000 for Claude Desktop.',
        required: false,
      },
    ],
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text || '') }],
    isError,
  };
}

function toolTimeoutMs() {
  const value = Number(process.env.JARVOS_MCP_TOOL_TIMEOUT_MS || 15000);
  return Number.isFinite(value) && value > 0 ? value : 15000;
}

function toolTimeoutError(name, timeoutMs) {
  const error = new Error(`${name || 'tool'} timed out after ${timeoutMs}ms`);
  error.code = -32000;
  return error;
}

function logLateToolSettlement(name, state, value) {
  const message = value && value.message ? value.message : undefined;
  process.stderr.write(`${JSON.stringify({
    level: 'warn',
    event: 'jarvos_mcp_tool_late_settlement',
    tool: name || 'tool',
    state,
    message,
  })}\n`);
}

function withToolTimeout(name, operation, timeoutMs = toolTimeoutMs()) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(toolTimeoutError(name, timeoutMs));
    }, timeoutMs);

    Promise.resolve()
      .then(operation)
      .then((result) => {
        if (settled) {
          logLateToolSettlement(name, 'resolved');
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }, (error) => {
        if (settled) {
          logLateToolSettlement(name, 'rejected', error);
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function noteCaptureArgs(args = {}) {
  return {
    ...args,
    trigger: 'note',
    frontmatter: {
      ...(args.frontmatter || {}),
      trigger: 'note',
    },
  };
}

function requireEmptyObjectArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
    const error = new Error('Journal action accepts only an empty object');
    error.code = -32602;
    throw error;
  }
}

function sharedSkillsConfigPath(env = process.env) {
  const value = env[SHARED_SKILLS_CONFIG_ENV];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireSharedSkillsOwnerSession() {
  const credential = resolveHostCredential();
  if (!credential) throw new Error('shared-skill owner session is not configured for this MCP session');
}

function redactSharedSkillPlan(result, opaqueSkillId) {
  return {
    ok: result?.ok !== false,
    mode: 'plan',
    catalogDigest: result?.catalogDigest || null,
    aliasRevision: result?.aliasRevision ?? null,
    pairs: (result?.pairs || []).map((pair) => ({
      id: opaqueSkillId(pair.id),
      harness: pair.harness,
      effectiveName: pair.effectiveName ? opaqueSkillId(pair.effectiveName) : null,
      status: pair.status,
      action: pair.action || null,
      reason: pair.reason || null,
    })),
  };
}

function redactSharedSkillMutation(result, opaqueSkillId) {
  const safe = {
    ok: result?.ok !== false,
    mode: result?.mode || null,
    repaired: result?.repaired,
    mutationDenied: result?.mutationDenied,
    reason: result?.reason || null,
  };
  if (result?.logicalId) safe.logicalId = opaqueSkillId(result.logicalId);
  if (Array.isArray(result?.applied)) {
    safe.applied = result.applied.map((item) => ({
      id: opaqueSkillId(item.id),
      harness: item.harness,
      effectiveName: item.effectiveName ? opaqueSkillId(item.effectiveName) : null,
      status: item.status,
      applied: item.applied === true,
    }));
  }
  return safe;
}

async function callTool(name, args = {}) {
  args = normalizeToolArguments(name, args);
  if (['jarvos_todo_create', 'jarvos_todo_list', 'jarvos_todo_show', 'jarvos_todo_transition'].includes(name)) return todoAction(name, args);
  if (name === 'jarvos_journal_health') {
    requireEmptyObjectArguments(args);
    const result = healthTodayJournal();
    return textResult(JSON.stringify(result), result.status !== 'ok');
  }
  if (name === 'jarvos_ensure_today_journal') {
    requireEmptyObjectArguments(args);
    const result = ensureTodayJournal();
    return textResult(JSON.stringify(result), result.status !== 'ok');
  }
  if (name === 'jarvos_control_plane') {
    // The credential is bound to this MCP session server-side by the installed
    // host, never taken as model-visible tool input (it would persist in
    // transcripts). Strip any credential the model supplies and inject the
    // host session credential instead.
    const { credential: _credential, service: _service, applicationService: _applicationService, serviceModule: _serviceModule, ...input } = args;
    let hostCredential;
    try {
      hostCredential = resolveHostCredential();
    } catch (error) {
      return textResult(error.message || 'control-plane host credential binding failed', true);
    }
    if (!hostCredential) {
      return textResult('control-plane host credential is not configured for this MCP session', true);
    }
    if (input.operation === 'activation-status') {
      // Reuse the authenticated control-plane read boundary, then project the
      // same closed runtime-kit result used by the CLI. The evidence path is a
      // host binding and is never model-visible.
      try {
        controlPlane('list', { credential: hostCredential });
        const result = runtimeActivationStatus({ runtime: input.runtime || 'all' });
        return textResult(JSON.stringify(result, null, 2), !result.ok);
      } catch (error) {
        return textResult(error.message || 'activation status is unavailable', true);
      }
    }
    // Match CLI numeric semantics for approve fence comparisons (strict ===).
    try {
      loadControlPlaneManager().coerceNumericFlags(input, { labelPrefix: '' });
    } catch (error) {
      return textResult(error.message || 'control-plane input validation failed', true);
    }
    const result = controlPlane(input.operation, { ...input, credential: hostCredential });
    return textResult(JSON.stringify(result, null, 2), !result.ok);
  }
  if (name === 'jarvos_shared_skills') {
    const skills = loadSharedSkills();
    const configPath = sharedSkillsConfigPath();
    const operation = args.operation;
    if (operation === 'status') {
      return textResult(JSON.stringify(skills.sharedStatusOperator({ configPath }), null, 2));
    }
    if (operation === 'explain') {
      return textResult(JSON.stringify(skills.explainOperator({ configPath, id: args.id }), null, 2));
    }
    try {
      requireSharedSkillsOwnerSession();
    } catch (error) {
      return textResult(error.message, true);
    }
    if (operation === 'inventory') {
      return textResult(JSON.stringify(skills.inventoryStatusOperator({ configPath, persist: false }), null, 2));
    }
    if (operation === 'plan') {
      return textResult(JSON.stringify(redactSharedSkillPlan(skills.planOperator({ configPath }), skills.opaqueSkillId), null, 2));
    }
    if (operation === 'repair') {
      return textResult(JSON.stringify(redactSharedSkillMutation(skills.repairOperator({ configPath }), skills.opaqueSkillId), null, 2));
    }
    if (operation === 'exclude') {
      return textResult(JSON.stringify(redactSharedSkillMutation(skills.excludeSkillOperator({ configPath, id: args.id, reasonCode: args.reasonCode }), skills.opaqueSkillId), null, 2));
    }
    if (operation === 'include') {
      return textResult(JSON.stringify(redactSharedSkillMutation(skills.includeSkillOperator({ configPath, id: args.id }), skills.opaqueSkillId), null, 2));
    }
    return textResult('unsupported shared-skill operation', true);
  }
  if (name === 'jarvos_current_work') {
    try {
      const result = await currentWork(args);
      if (!result || typeof result.markdown !== 'string' || !result.markdown.trim()) {
        return textResult(renderCurrentWorkUnavailable(), true);
      }
      return textResult(result.markdown, !result.ok);
    } catch {
      return textResult(renderCurrentWorkUnavailable(), true);
    }
  }
  if (name === 'jarvos_projects_context') {
    const request = {
      profile: args.profile || 'orientation',
      date: args.date,
      timeZone: args.timeZone,
      from: args.from,
      to: args.to,
    };
    if (mcpProjectsContextProvider) request.provider = mcpProjectsContextProvider;
    const result = await readProjectsContext(request, true);
    return textResult(JSON.stringify(result, null, 2), false);
  }
  if (name === 'jarvos_projects_propose') {
    const result = await proposeProjectsContext({ ...args, provider: mcpProjectsContextProvider });
    return textResult(JSON.stringify(result, null, 2), false);
  }
  if (name === 'jarvos_recall') {
    const result = recall(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_synthesize') {
    const result = synthesizeRecall(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_create_note') {
    const result = await createNote(noteCaptureArgs(args));
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_session_thread_read') {
    const result = readSessionThread(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_session_thread_write') {
    const result = writeSessionThread(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_startup_brief') {
    const result = await startupBrief(args);
    return textResult(result.markdown, !result.ok);
  }
  if (name === 'jarvos_hydrate') {
    const result = await hydrate({ ...args, [HYDRATION_PROJECTS_PROVIDER]: mcpProjectsContextProvider });
    return textResult(result.markdown, !result.ok);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function promptResult(name, args = {}) {
  if (name !== 'boot_jarvos') {
    const error = new Error(`Unknown prompt: ${name}`);
    error.code = -32602;
    throw error;
  }

  const maxChars = Number(args.maxChars || 9000);
  const text = Number.isFinite(maxChars) && maxChars > 0
    ? BOOT_JARVOS_PROMPT_TEXT.replace('maxChars: 9000', `maxChars: ${Math.floor(maxChars)}`)
    : BOOT_JARVOS_PROMPT_TEXT;

  return {
    description: 'Boot jarvOS manual hydration for this chat.',
    messages: [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ],
  };
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if (!id && String(method || '').startsWith('notifications/')) return;

  try {
    if (method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: 'jarvos', version: '0.1.0' },
        },
      });
      return;
    }

    if (method === 'tools/list') {
      write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'prompts/list') {
      write({ jsonrpc: '2.0', id, result: { prompts: PROMPTS } });
      return;
    }

    if (method === 'prompts/get') {
      const promptArguments = params?.arguments || {};
      const result = promptResult(params?.name, promptArguments);
      write({ jsonrpc: '2.0', id, result });
      return;
    }

    if (method === 'tools/call') {
      const toolArguments = normalizeToolArguments(params?.name, params?.arguments);
      const result = await withToolTimeout(
        params?.name,
        () => callTool(params?.name, toolArguments),
      );
      write({ jsonrpc: '2.0', id, result });
      return;
    }

    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (error) {
    write({
      jsonrpc: '2.0',
      id,
      error: { code: error.code || -32000, message: error.message || String(error) },
    });
  }
}

async function runCliCommand() {
  const command = process.argv[2];
  if (command === 'startup-brief') {
    const query = process.argv.slice(3).join(' ').trim();
    const result = await startupBrief({ query });
    process.stdout.write(`${result.markdown}\n`);
    return true;
  }
  if (command === 'hydrate') {
    const maxCharsIndex = process.argv.indexOf('--max-chars');
    const maxChars = maxCharsIndex >= 0 ? Number(process.argv[maxCharsIndex + 1]) : undefined;
    const result = await hydrate({ maxChars });
    process.stdout.write(`${result.markdown}\n`);
    return true;
  }
  return false;
}

async function main() {
  if (await runCliCommand()) return;

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      write({ jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${error.message}` } });
      return;
    }
    handle(message);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { TOOLS, callTool, handle, setMcpProjectsContextProvider, textResult, loadHostWorkActionService };
module.exports.WORK_ACTION_HOST_UNAVAILABLE = WORK_ACTION_HOST_UNAVAILABLE;
module.exports.WORK_ACTION_HOST_REFUSED = WORK_ACTION_HOST_REFUSED;
module.exports.BOOT_JARVOS_PROMPT_TEXT = BOOT_JARVOS_PROMPT_TEXT;
module.exports.PROMPTS = PROMPTS;
module.exports.promptResult = promptResult;
module.exports.noteCaptureArgs = noteCaptureArgs;
module.exports.withToolTimeout = withToolTimeout;
module.exports.resolveHostCredential = resolveHostCredential;
module.exports.readCredentialFile = readCredentialFile;
module.exports.requireEmptyObjectArguments = requireEmptyObjectArguments;
module.exports.CREDENTIAL_ENV = CREDENTIAL_ENV;
module.exports.CREDENTIAL_FILE_ENV = CREDENTIAL_FILE_ENV;
