#!/usr/bin/env node
/**
 * Paperclip HTTP client for jarvos-secondbrain bridge code.
 *
 * This module owns Paperclip auth resolution, request retries, and the small
 * issue/comment API surface used by bridge callers. Root clawd scripts should
 * import their compatibility shim from scripts/lib/paperclip-http.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');
const { resolvePaperclipConfig } = require('../config');

const DEFAULT_API_URL = 'http://127.0.0.1:3100';
const DEFAULT_PROJECT_ID = '3ba24079-15f4-48a5-aef3-24aa742d1177';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const HOME_DIR = process.env.HOME || os.homedir();
const CLAIMED_KEY_FILE = path.join(HOME_DIR, '.openclaw', 'workspace', 'paperclip-claimed-api-key.json');
const FALLBACK_KEY_FILE = path.join(HOME_DIR, '.openclaw', 'workspace', 'paperclip-api-key.json');
const RETRY_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function trimString(value) {
  return String(value || '').trim();
}

function trimTrailingSlash(value) {
  return trimString(value).replace(/\/$/, '');
}

function normalizeApiPath(apiPath) {
  const raw = String(apiPath || '').trim();
  if (!raw) throw new Error('Paperclip API path is required');
  const prefixed = raw.startsWith('/api') ? raw : `/api${raw.startsWith('/') ? raw : `/${raw}`}`;
  return prefixed;
}

function normalizeListPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.issues)) return payload.issues;
  if (Array.isArray(payload?.comments)) return payload.comments;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function readWorkspaceToken(files = [CLAIMED_KEY_FILE, FALLBACK_KEY_FILE]) {
  for (const filePath of files) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const token = trimString(parsed?.token);
      if (token) return token;
    } catch {
      // Ignore malformed optional token files.
    }
  }
  return '';
}

function resolvePaperclipAuth(overrides = {}) {
  const env = overrides.env || process.env;
  const resolved = resolvePaperclipConfig({
    configPath: overrides.configPath,
    env,
    envFile: overrides.envFile,
    homeDir: overrides.homeDir,
    workspaceRoot: overrides.workspaceRoot,
  });

  const workspaceToken = Object.prototype.hasOwnProperty.call(overrides, 'workspaceToken')
    ? trimString(overrides.workspaceToken)
    : readWorkspaceToken(overrides.workspaceTokenFiles);

  return {
    apiUrl: trimTrailingSlash(overrides.apiUrl || resolved.apiUrl || DEFAULT_API_URL),
    apiKey: trimString(
      overrides.apiKey ||
      resolved.apiKey ||
      env.PAPERCLIP_MICHAEL_API_KEY ||
      workspaceToken
    ),
    companyId: trimString(overrides.companyId || resolved.companyId || env.PAPERCLIP_COMPANY_ID),
    agentId: trimString(
      overrides.agentId ||
      resolved.agentId ||
      env.PAPERCLIP_AGENT_ID ||
      env.PAPERCLIP_MICHAEL_AGENT_ID
    ),
    runId: trimString(overrides.runId || resolved.runId || env.PAPERCLIP_RUN_ID),
    defaultProjectId: trimString(overrides.defaultProjectId || env.PAPERCLIP_DEFAULT_PROJECT_ID || DEFAULT_PROJECT_ID),
    envFile: overrides.envFile || resolved.envFile,
    hasApiUrl: Boolean(overrides.apiUrl || resolved.hasApiUrl || resolved.apiUrl),
    hasApiKey: Boolean(overrides.apiKey || resolved.hasApiKey || resolved.apiKey || env.PAPERCLIP_MICHAEL_API_KEY || workspaceToken),
  };
}

const loadPaperclipAuth = resolvePaperclipAuth;

function redactErrorText(text) {
  return String(text || '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/("(?:apiKey|token|accessToken|secret)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/((?:apiKey|token|accessToken|secret)\s*[:=]\s*)[^\s"']+/gi, '$1[REDACTED]');
}

class PaperclipHttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PaperclipHttpError';
    this.method = details.method;
    this.apiPath = details.apiPath;
    this.status = details.status || null;
    this.retryable = Boolean(details.retryable);
    this.bodySnippet = details.bodySnippet || '';
    this.cause = details.cause;
  }
}

function isMutation(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

function shouldRetry({ method, status, error, attempt, options }) {
  const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
  if (attempt >= maxRetries) return false;
  if (isMutation(method) && !options.retryMutations) return false;
  if (status) return RETRY_STATUS_CODES.has(Number(status));
  if (error) return true;
  return false;
}

async function requestWithTimeout(fetchImpl, url, requestOptions, timeoutMs) {
  if (!timeoutMs || typeof AbortController !== 'function') {
    return fetchImpl(url, requestOptions);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...requestOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function paperclipRequest(method, apiPath, body, auth, options = {}) {
  const resolvedAuth = auth || resolvePaperclipAuth(options.auth || {});
  if (!resolvedAuth?.apiUrl || !resolvedAuth?.apiKey) {
    throw new Error('Missing Paperclip API auth');
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch() is not available in this runtime.');
  }

  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedPath = normalizeApiPath(apiPath);
  const url = `${trimTrailingSlash(resolvedAuth.apiUrl)}${normalizedPath}`;
  const headers = {
    Authorization: `Bearer ${resolvedAuth.apiKey}`,
  };

  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (isMutation(normalizedMethod) && resolvedAuth.runId && options.mutate !== false) {
    headers['X-Paperclip-Run-Id'] = resolvedAuth.runId;
  }

  const requestOptions = {
    method: normalizedMethod,
    headers,
  };
  if (body !== undefined) requestOptions.body = JSON.stringify(body);

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const baseDelayMs = options.retryDelayMs || DEFAULT_RETRY_DELAY_MS;
  let lastError = null;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await requestWithTimeout(fetchImpl, url, requestOptions, timeoutMs);
      const parsed = await parseResponseBody(response);
      if (response.ok) return parsed;

      const bodySnippet = redactErrorText(typeof parsed === 'string' ? parsed : JSON.stringify(parsed)).slice(0, 500);
      const retryable = shouldRetry({
        method: normalizedMethod,
        status: response.status,
        attempt,
        options,
      });
      lastError = new PaperclipHttpError(
        `Paperclip API ${normalizedMethod} ${normalizedPath} failed with ${response.status}`,
        {
          method: normalizedMethod,
          apiPath: normalizedPath,
          status: response.status,
          retryable,
          bodySnippet,
        }
      );
      if (!retryable) throw lastError;
    } catch (error) {
      if (error instanceof PaperclipHttpError) {
        lastError = error;
        if (!error.retryable) throw error;
      } else {
        const retryable = shouldRetry({
          method: normalizedMethod,
          error,
          attempt,
          options,
        });
        lastError = new PaperclipHttpError(
          `Paperclip API ${normalizedMethod} ${normalizedPath} request failed`,
          {
            method: normalizedMethod,
            apiPath: normalizedPath,
            retryable,
            cause: error,
          }
        );
        if (!retryable) throw lastError;
      }
    }

    const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
    if (attempt >= maxRetries) throw lastError;
    await delay(baseDelayMs * (2 ** attempt));
  }
}

function paperclipGet(apiPath, auth, options = {}) {
  return paperclipRequest('GET', apiPath, undefined, auth, options);
}

function paperclipPost(apiPath, body, auth, options = {}) {
  return paperclipRequest('POST', apiPath, body, auth, { ...options, mutate: true });
}

function paperclipPatch(apiPath, body, auth, options = {}) {
  return paperclipRequest('PATCH', apiPath, body, auth, { ...options, mutate: true });
}

function paperclipPut(apiPath, body, auth, options = {}) {
  return paperclipRequest('PUT', apiPath, body, auth, { ...options, mutate: true });
}

function buildCreateIssuePayload(issueDraft, auth = {}) {
  const status = issueDraft.status || 'todo';
  if (status === 'in_progress') {
    throw new Error(
      'Refusing to create a Paperclip issue directly as in_progress. Create it as todo, attach the plan, then use the checkout endpoint with a real run id before moving execution forward.'
    );
  }

  return {
    title: trimString(issueDraft.title),
    description: trimString(issueDraft.description),
    projectId: issueDraft.projectId || auth.defaultProjectId || undefined,
    goalId: issueDraft.goalId || undefined,
    parentId: issueDraft.parentId || undefined,
    blockedByIssueIds: Array.isArray(issueDraft.blockedByIssueIds) ? issueDraft.blockedByIssueIds : undefined,
    labels: Array.isArray(issueDraft.labels) ? issueDraft.labels : undefined,
    status,
    priority: issueDraft.priority || 'medium',
    assigneeAgentId: Object.prototype.hasOwnProperty.call(issueDraft, 'assigneeAgentId')
      ? issueDraft.assigneeAgentId || undefined
      : auth.agentId || undefined,
  };
}

function encodeRef(value) {
  return encodeURIComponent(String(value || '').trim());
}

async function listCompanyIssues(auth, options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.status) params.set('status', String(options.status));
  if (options.assigneeAgentId) params.set('assigneeAgentId', String(options.assigneeAgentId));
  if (options.sort) params.set('sort', String(options.sort));
  if (options.q) params.set('q', String(options.q));
  const query = params.toString();
  const payload = await paperclipGet(`/companies/${encodeRef(auth.companyId)}/issues${query ? `?${query}` : ''}`, auth, options);
  return normalizeListPayload(payload);
}

function getIssue(issueRef, auth, options = {}) {
  return paperclipGet(`/issues/${encodeRef(issueRef)}`, auth, options);
}

async function getIssueComments(issueRef, auth, options = {}) {
  const payload = await paperclipGet(`/issues/${encodeRef(issueRef)}/comments`, auth, options);
  return normalizeListPayload(payload);
}

function createIssue(issueDraft, auth, options = {}) {
  const payload = buildCreateIssuePayload(issueDraft, auth);
  return paperclipPost(`/companies/${encodeRef(auth.companyId)}/issues`, payload, auth, options);
}

function updateIssue(issueRef, updates, auth, options = {}) {
  return paperclipPatch(`/issues/${encodeRef(issueRef)}`, updates, auth, options);
}

function addComment(issueRef, comment, auth, options = {}) {
  const payload = typeof comment === 'object' && comment !== null
    ? comment
    : { body: String(comment || '') };
  return paperclipPost(`/issues/${encodeRef(issueRef)}/comments`, payload, auth, options);
}

function searchIssues(query, auth, options = {}) {
  return listCompanyIssues(auth, { ...options, q: query });
}

function createPaperclipClient(options = {}) {
  const auth = options.auth || resolvePaperclipAuth(options);
  return {
    auth,
    request: (method, apiPath, body, requestOptions = {}) => paperclipRequest(method, apiPath, body, auth, { ...options, ...requestOptions }),
    getIssue: (issueRef, requestOptions = {}) => getIssue(issueRef, auth, { ...options, ...requestOptions }),
    getIssueComments: (issueRef, requestOptions = {}) => getIssueComments(issueRef, auth, { ...options, ...requestOptions }),
    createIssue: (issueDraft, requestOptions = {}) => createIssue(issueDraft, auth, { ...options, ...requestOptions }),
    updateIssue: (issueRef, updates, requestOptions = {}) => updateIssue(issueRef, updates, auth, { ...options, ...requestOptions }),
    addComment: (issueRef, comment, requestOptions = {}) => addComment(issueRef, comment, auth, { ...options, ...requestOptions }),
    searchIssues: (query, requestOptions = {}) => searchIssues(query, auth, { ...options, ...requestOptions }),
    listCompanyIssues: (requestOptions = {}) => listCompanyIssues(auth, { ...options, ...requestOptions }),
  };
}

module.exports = {
  DEFAULT_API_URL,
  DEFAULT_PROJECT_ID,
  PaperclipHttpError,
  addComment,
  buildCreateIssuePayload,
  createIssue,
  createPaperclipClient,
  getIssue,
  getIssueComments,
  listCompanyIssues,
  loadPaperclipAuth,
  normalizeListPayload,
  paperclipGet,
  paperclipPatch,
  paperclipPost,
  paperclipPut,
  paperclipRequest,
  readWorkspaceToken,
  resolvePaperclipAuth,
  searchIssues,
  updateIssue,
};
