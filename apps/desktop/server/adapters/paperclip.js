'use strict';

const fs = require('fs');

const CACHE_TTL_MS = 20 * 1000;
const cache = new Map();

// Only these agent fields ever leave the server — adapterConfig holds gateway tokens.
const AGENT_SAFE_FIELDS = [
  'id', 'name', 'role', 'title', 'icon', 'status', 'reportsTo',
  'adapterType', 'lastHeartbeatAt', 'capabilities', 'createdAt',
];

function readToken(cfg) {
  if (process.env.PAPERCLIP_BOARD_TOKEN) return process.env.PAPERCLIP_BOARD_TOKEN;
  if (!cfg || !cfg.authFile || !cfg.url) return null;
  try {
    const auth = JSON.parse(fs.readFileSync(cfg.authFile, 'utf8'));
    return auth.credentials?.[cfg.url]?.token || null;
  } catch {
    return null;
  }
}

function configured(cfg) {
  return Boolean(cfg && cfg.url && cfg.companyId);
}

async function request(cfg, route, { method = 'GET', body, companyScoped = true, cacheable = method === 'GET' } = {}) {
  if (!configured(cfg)) throw new Error('Paperclip is not configured');
  const key = route;
  const hit = cacheable ? cache.get(key) : null;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const token = readToken(cfg);
  if (!token) throw new Error('No Paperclip credential (auth file or PAPERCLIP_BOARD_TOKEN)');
  const prefix = companyScoped ? `/api/companies/${cfg.companyId}` : '/api';
  const res = await fetch(`${cfg.url}${prefix}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Paperclip ${route} -> ${res.status}`);
  const value = await res.json();
  if (cacheable) cache.set(key, { at: Date.now(), value });
  return value;
}

async function api(cfg, route) {
  return request(cfg, route);
}

function unwrap(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) if (Array.isArray(payload?.[k])) return payload[k];
  return [];
}

function sanitizeAgent(agent) {
  const out = {};
  for (const f of AGENT_SAFE_FIELDS) if (agent[f] !== undefined) out[f] = agent[f];
  return out;
}

async function issues(cfg) {
  const raw = unwrap(await api(cfg, '/issues?limit=250'), 'issues', 'data', 'items');
  return raw.map((i) => ({
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    status: i.status,
    priority: i.priority,
    assigneeAgentId: i.assigneeAgentId ?? i.assignee_agent_id ?? null,
    projectId: i.projectId ?? null,
    parentId: i.parentId ?? null,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    blockedReason: i.blockedReason ?? i.blocked_reason ?? null,
  }));
}

async function issueDetail(cfg, id) {
  return api(cfg, `/issues/${id}`);
}

async function agents(cfg) {
  const raw = unwrap(await api(cfg, '/agents'), 'agents', 'data', 'items');
  return raw.map(sanitizeAgent);
}

async function activity(cfg, limit = 40) {
  const raw = unwrap(await api(cfg, `/activity?limit=${limit}`), 'activity', 'data', 'items');
  return raw.map((a) => ({
    id: a.id,
    action: a.action,
    actorType: a.actorType,
    actorId: a.actorId,
    agentId: a.agentId,
    entityType: a.entityType,
    entityId: a.entityId,
    createdAt: a.createdAt,
    summary: summarizeDetails(a),
  }));
}

function summarizeDetails(a) {
  const d = a.details || {};
  const bits = [];
  if (d.issueIdentifier) bits.push(d.issueIdentifier);
  if (d.title) bits.push(String(d.title).slice(0, 90));
  if (d.status) bits.push(`status: ${d.status}`);
  if (d.fromStatus && d.toStatus) bits.push(`${d.fromStatus} -> ${d.toStatus}`);
  if (d.failureReason) bits.push(String(d.failureReason).slice(0, 120));
  return bits.join(' · ');
}

async function projects(cfg) {
  const raw = unwrap(await api(cfg, '/projects'), 'projects', 'data', 'items');
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    targetDate: p.targetDate,
    color: p.color,
  }));
}

async function ping(cfg) {
  const started = Date.now();
  try {
    await api(cfg, '/agents');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function createIssue(cfg, payload) {
  const created = await request(cfg, '/issues', { method: 'POST', body: payload, cacheable: false });
  cache.clear();
  return created.issue || created.data || created;
}

async function updateIssue(cfg, id, payload) {
  const updated = await request(cfg, `/issues/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: payload,
    companyScoped: false,
    cacheable: false,
  });
  cache.clear();
  return updated.issue || updated.data || updated;
}

module.exports = { issues, issueDetail, agents, activity, projects, ping, createIssue, updateIssue, readToken, configured };
