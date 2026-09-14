'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const DEFAULT_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DEFAULT_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 180_000;
const FORBIDDEN_ITEM_TYPES = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'imageGeneration', 'webSearch', 'collabAgentToolCall', 'imageView', 'sleep',
]);

function fixedArgs() {
  return [
    'app-server', '--stdio',
    '--disable', 'shell_tool', '--disable', 'unified_exec',
    '--disable', 'image_generation', '--disable', 'view_image',
    '--disable', 'computer_use', '--disable', 'browser_use',
    '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'skill_search', '--disable', 'sleep_tool',
    '-c', 'mcp_servers={}', '-c', 'tools.web_search=false',
  ];
}

class CodexAppServerClient {
  constructor({ binary = DEFAULT_BINARY, spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, interruptTimeoutMs = 5_000 } = {}) {
    this.binary = binary;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.earlyTurnEvents = new Map();
    this.conversations = new Map();
    this.runtimeDir = null;
    this.stderr = '';
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start().catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }

  async _start() {
    if (!fs.existsSync(this.binary)) throw new Error('ChatGPT subscription connection is unavailable on this Mac');
    this.runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-desktop-chat-'));
    const child = this.spawnImpl(this.binary, fixedArgs(), {
      cwd: this.runtimeDir,
      env: { ...process.env, PWD: this.runtimeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.once('error', (error) => this._shutdownChild(child, new Error(`Subscription connection failed: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      const detail = this.stderr.trim().split('\n').slice(-1)[0];
      this._failAll(new Error(`Subscription connection exited${code === null ? ` (${signal})` : ` (${code})`}${detail ? `: ${detail}` : ''}`));
      this.child = null;
      this.ready = null;
      this._removeRuntimeDir();
    });
    child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_000); });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this._receive(line));
    lines.on('error', (error) => this._failAll(error));

    try {
      await this.request('initialize', {
        clientInfo: { name: 'jarvos-desktop', title: 'jarvOS Desktop', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
    } catch (error) {
      this._shutdownChild(child, error);
      throw error;
    }
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Subscription connection is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) { this._write({ method, params }); }

  _write(message) {
    if (!this.child?.stdin?.writable) throw new Error('Subscription connection is not running');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `${pending.method} failed`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this._write({ id: message.id, error: { code: -32601, message: 'Desktop chat does not permit server-initiated tools or approvals' } });
      this._rejectTurnFromParams(message.params, `Blocked unexpected ${message.method} request`);
      return;
    }
    if (message.method) this._notification(message.method, message.params || {});
  }

  _notification(method, params) {
    const turnId = params.turnId || params.turn?.id;
    const turnScoped = method === 'item/agentMessage/delta'
      || method === 'turn/completed'
      || (method === 'item/started' && FORBIDDEN_ITEM_TYPES.has(params.item?.type))
      || /^item\/(?:commandExecution|fileChange|mcpToolCall|dynamicToolCall|imageGeneration|webSearch)/.test(method);
    if (turnScoped && turnId && !this.turns.has(turnId)) {
      this._queueTurnEvent(turnId, { kind: 'notification', method, params });
      return;
    }
    if (method === 'item/agentMessage/delta') {
      this.turns.get(turnId)?.onDelta?.(params.delta || '');
      return;
    }
    if (method === 'item/started' && FORBIDDEN_ITEM_TYPES.has(params.item?.type)) {
      this._rejectTurnFromParams(params, `Blocked unexpected ${params.item.type} item`);
      return;
    }
    if (/^item\/(?:commandExecution|fileChange|mcpToolCall|dynamicToolCall|imageGeneration|webSearch)/.test(method)) {
      this._rejectTurnFromParams(params, `Blocked unexpected ${method} event`);
      return;
    }
    if (method === 'turn/completed') {
      const turn = this.turns.get(turnId);
      if (!turn) return;
      if (params.turn.status === 'completed') turn.resolve({ turn: params.turn, security: { forbiddenEvents: 0, serverRequests: 0 } });
      else turn.reject(new Error(params.turn.error?.message || `Subscription turn ${params.turn.status}`));
    }
  }

  _queueTurnEvent(turnId, event) {
    if (!this.earlyTurnEvents.has(turnId) && this.earlyTurnEvents.size >= 32) {
      this.earlyTurnEvents.delete(this.earlyTurnEvents.keys().next().value);
    }
    const events = this.earlyTurnEvents.get(turnId) || [];
    if (events.length < 256) events.push(event);
    this.earlyTurnEvents.set(turnId, events);
  }

  _drainTurnEvents(turnId) {
    const events = this.earlyTurnEvents.get(turnId) || [];
    this.earlyTurnEvents.delete(turnId);
    for (const event of events) {
      if (!this.turns.has(turnId)) break;
      if (event.kind === 'reject') this._rejectTurnFromParams({ turnId }, event.message);
      else this._notification(event.method, event.params);
    }
  }

  _rejectTurnFromParams(params, message) {
    const turnId = params?.turnId || params?.turn?.id;
    const turn = this.turns.get(turnId);
    if (!turn) {
      if (turnId) this._queueTurnEvent(turnId, { kind: 'reject', message });
      return;
    }
    const { threadId } = turn;
    turn.reject(new Error(message));
    this._interruptTurn(threadId, turnId);
  }

  _interruptTurn(threadId, turnId) {
    this.request('turn/interrupt', { threadId, turnId }, this.interruptTimeoutMs).catch((error) => {
      const child = this.child;
      if (child) this._shutdownChild(child, new Error(`Subscription interrupt failed: ${error.message}`));
    });
  }

  _failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const turn of [...this.turns.values()]) turn.reject(error);
    this.turns.clear();
    this.earlyTurnEvents.clear();
    this.conversations.clear();
  }

  _shutdownChild(child, error) {
    if (!child || this.child !== child) return;
    this.child = null;
    this.ready = null;
    this._failAll(error);
    try { child.kill(); } catch {}
    this._removeRuntimeDir();
  }

  async status() {
    await this.start();
    const account = await this.request('account/read', { refreshToken: false });
    const loggedIn = account?.account?.type === 'chatgpt';
    return {
      available: true,
      authenticated: loggedIn,
      connection: loggedIn ? 'chatgpt-subscription' : 'none',
      planType: loggedIn ? account.account.planType : null,
      requiresSignIn: account?.requiresOpenaiAuth === true && !loggedIn,
    };
  }

  async models() {
    await this.start();
    const response = await this.request('model/list', { includeHidden: false, limit: 100 });
    return (response?.data || []).filter((model) => !model.hidden).map((model) => ({
      id: model.id,
      label: model.displayName,
      description: model.description,
      isDefault: model.isDefault === true,
      defaultReasoningEffort: model.defaultReasoningEffort,
      reasoningEfforts: (model.supportedReasoningEfforts || []).map((option) => option.reasoningEffort || option.effort).filter(Boolean),
    }));
  }

  async _thread(conversationId, model) {
    const existing = this.conversations.get(conversationId);
    if (existing?.model === model) return existing.threadId;
    const result = await this.request('thread/start', {
      cwd: this.runtimeDir,
      model,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      environments: [], dynamicTools: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [],
      baseInstructions: 'You are the jarvOS Desktop conversational assistant. Answer directly from the text in this conversation. You have no tools, files, apps, connectors, or workspace access.',
      developerInstructions: 'Never claim to inspect or change local or remote state. If the user asks for an action or private workspace fact, explain that this subscription chat connection is text-only.',
      config: {
        mcp_servers: {}, tools: { web_search: false },
        features: { shell_tool: false, unified_exec: false, apps: false, plugins: false, image_generation: false, view_image: false, computer_use: false, browser_use: false, skill_search: false, sleep_tool: false },
      },
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new Error('Subscription connection did not create a conversation');
    this.conversations.set(conversationId, { threadId, model });
    while (this.conversations.size > 24) this.conversations.delete(this.conversations.keys().next().value);
    return threadId;
  }

  async turn({ conversationId, model, effort, text, onDelta, signal }) {
    await this.start();
    if (signal?.aborted) throw new Error('Subscription turn interrupted');
    const account = await this.request('account/read', { refreshToken: false });
    if (account?.account?.type !== 'chatgpt') throw new Error('Sign in with ChatGPT in Codex before using subscription chat');
    const threadId = await this._thread(conversationId, model);
    const started = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      model, effort, approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      environments: [], runtimeWorkspaceRoots: [],
    });
    const turnId = started?.turn?.id;
    if (!turnId) throw new Error('Subscription connection did not start the reply');
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (callback, value) => {
        if (this.turns.get(turnId) !== turn) return;
        clearTimeout(timer);
        this.turns.delete(turnId);
        signal?.removeEventListener('abort', abort);
        callback(value);
      };
      const abort = () => {
        if (this.turns.get(turnId) !== turn) return;
        turn.reject(new Error('Subscription turn interrupted'));
        this._interruptTurn(threadId, turnId);
      };
      const turn = {
        threadId,
        onDelta,
        get timer() { return timer; },
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      timer = setTimeout(() => {
        turn.reject(new Error('Subscription reply timed out'));
        this._interruptTurn(threadId, turnId);
      }, TURN_TIMEOUT_MS);
      this.turns.set(turnId, turn);
      signal?.addEventListener('abort', abort, { once: true });
      this._drainTurnEvents(turnId);
      if (signal?.aborted) abort();
    });
  }

  close() {
    const child = this.child;
    if (child) this._shutdownChild(child, new Error('Subscription connection closed'));
    else {
      this._failAll(new Error('Subscription connection closed'));
      this.ready = null;
      this._removeRuntimeDir();
    }
  }

  _removeRuntimeDir() {
    if (!this.runtimeDir) return;
    try { fs.rmSync(this.runtimeDir, { recursive: true, force: true }); } catch {}
    this.runtimeDir = null;
  }
}

let shared;
function getCodexAppServer() {
  if (!shared) {
    shared = new CodexAppServerClient();
    process.once('exit', () => shared?.close());
  }
  return shared;
}

module.exports = { CodexAppServerClient, FORBIDDEN_ITEM_TYPES, fixedArgs, getCodexAppServer };
