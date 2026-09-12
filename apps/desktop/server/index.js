'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { json, httpError, httpThrow, readJson, requireLoopbackRequest } = require('./http-utils');
const journal = require('./adapters/journal');
const notes = require('./adapters/notes');
const paperclip = require('./adapters/paperclip');
const ontology = require('./adapters/ontology');
const memory = require('./adapters/memory');
const health = require('./adapters/health');
const systemDoctor = require('./adapters/system-doctor');
const today = require('./today');
const agent = require('./agent');
const credentials = require('./agent/credentials');
const transcribe = require('./agent/transcribe');
const projectsContext = require('./adapters/projects-context');

const cfg = loadConfig();
const STATIC_DIR = path.join(__dirname, '..', 'static');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function configured(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function unavailable(name) {
  throw httpError(503, `${name} is not configured`);
}

const routes = {
  '/api/today': async () => today.brief(cfg),

  '/api/journal': async (q) => !configured(cfg.vault.journalDir) ? unavailable('Journal') :
    journal.stream(cfg.vault.journalDir, {
      limit: Math.min(parseInt(q.get('limit') || '10', 10), 60),
      before: q.get('before'),
    }),

  '/api/journal/day': async (q) => {
    if (!configured(cfg.vault.journalDir)) return unavailable('Journal');
    const date = q.get('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw httpError(400, 'date=YYYY-MM-DD required');
    return journal.readDay(cfg.vault.journalDir, date) || httpThrow(404, 'no journal for that day');
  },

  '/api/notes': async (q) => !configured(cfg.vault.notesDir) ? unavailable('Notes vault') :
    notes.list(cfg.vault.notesDir, {
      limit: Math.min(parseInt(q.get('limit') || '60', 10), 200),
      q: q.get('q') || '',
    }),

  '/api/note': async (q) => {
    if (!configured(cfg.vault.notesDir)) return unavailable('Notes vault');
    const title = (q.get('title') || '').replace(/[/\\]/g, ''); // vault notes are flat; block traversal
    if (!title) throw httpError(400, 'title required');
    return notes.read(cfg.vault.notesDir, title) || httpThrow(404, `note "${title}" not found`);
  },

  '/api/work': async () => {
    if (!paperclip.configured(cfg.paperclip)) return unavailable('Paperclip');
    const [allIssues, agents, activity, projects] = await Promise.all([
      paperclip.issues(cfg.paperclip),
      paperclip.agents(cfg.paperclip),
      paperclip.activity(cfg.paperclip, 40),
      paperclip.projects(cfg.paperclip),
    ]);
    return { issues: allIssues, agents, activity, projects };
  },

  '/api/projects': async () => projectsContext.read(cfg),

  '/api/ontology': async () => configured(cfg.ontologyDir) ? ontology.spine(cfg.ontologyDir) : unavailable('Ontology'),

  '/api/memory': async () => configured(cfg.memory.indexFile) && configured(cfg.memory.dailyDir) ? memory.index(cfg.memory) : unavailable('Memory'),

  '/api/memory/day': async (q) => !configured(cfg.memory.dailyDir) ? unavailable('Memory') :
    memory.readDaily(cfg.memory, q.get('file') || '') || httpThrow(404, 'memory file not found'),

  '/api/health': async () => health.services(cfg, today.localDate()),

  '/api/system-doctor': async () => {
    const loaded = systemDoctor.loadReceipt(cfg);
    if (!loaded.ok && !loaded.receipt) {
      const unavailable = systemDoctor.emptyUnavailable(loaded.error || 'system doctor unavailable');
      return unavailable;
    }
    return loaded;
  },

  '/api/chat/models': async () => agent.listModels(),
};

async function settingsRoute(req) {
  if (req.method === 'GET') {
    return { ...credentials.status(), subscription: await agent.subscriptionStatus(), voice: transcribe.voiceStatus(cfg) };
  }
  if (req.method === 'POST') {
    const body = await readJson(req, { limit: 20_000 });
    return { ...credentials.saveOpenAIKey(body.openaiKey), ...credentials.status() };
  }
  if (req.method === 'DELETE') {
    return { ...credentials.deleteOpenAIKey(), ...credentials.status() };
  }
  throw httpError(405, 'method not allowed');
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(STATIC_DIR)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback
    const index = path.join(STATIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return res.end(fs.readFileSync(index));
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      requireLoopbackRequest(req);
      return await agent.handleChat(req, res, cfg);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }
  if (url.pathname === '/api/settings') {
    try {
      if (req.method !== 'GET') requireLoopbackRequest(req);
      return json(res, 200, await settingsRoute(req));
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }
  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    try {
      requireLoopbackRequest(req);
      return json(res, 200, await transcribe.transcribe(req, cfg));
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }
  if (url.pathname === '/api/chat/models' && req.method === 'GET' && url.searchParams.get('connection') !== 'api-key') {
    try {
      return json(res, 200, await agent.subscriptionModels());
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }
  const handler = routes[url.pathname];
  if (!handler) return serveStatic(req, res, url.pathname);
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  try {
    json(res, 200, await handler(url.searchParams));
  } catch (err) {
    json(res, err.status || 500, { error: err.message });
  }
});

const port = cfg.port;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another listener may belong to a different workspace or application.
    console.error(`jarvOS Desktop cannot start: port ${port} is already in use. Choose another PORT.`);
    process.exitCode = 1;
  } else {
    throw err;
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`jarvOS Desktop serving on http://127.0.0.1:${port}`);
});

module.exports = { server, routes };
