const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  PaperclipHttpError,
  buildCreateIssuePayload,
  createPaperclipClient,
} = require('../bridge/paperclip/client');

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body ? JSON.parse(body) : null));
  });
}

function createServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    await handler(req, res, body, requests);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        requests,
        url: `http://${address.address}:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('bridge Paperclip client creates, comments, updates, searches, and fetches issues', async () => {
  const state = {
    issue: {
      id: 'issue-1',
      identifier: 'SUP-9999',
      title: 'Bridge smoke',
      status: 'todo',
    },
    comments: [],
  };

  const server = await createServer((req, res, body) => {
    if (req.method === 'POST' && req.url === '/api/companies/company-1/issues') {
      assert.equal(req.headers.authorization, 'Bearer test-token');
      state.issue = {
        ...state.issue,
        title: body.title,
        status: body.status,
        priority: body.priority,
      };
      return json(res, 200, state.issue);
    }

    if (req.method === 'POST' && req.url === '/api/issues/SUP-9999/comments') {
      state.comments.push({ id: `comment-${state.comments.length + 1}`, body: body.body });
      return json(res, 200, state.comments[state.comments.length - 1]);
    }

    if (req.method === 'PATCH' && req.url === '/api/issues/SUP-9999') {
      state.issue = { ...state.issue, ...body };
      return json(res, 200, state.issue);
    }

    if (req.method === 'GET' && req.url === '/api/issues/SUP-9999') {
      return json(res, 200, state.issue);
    }

    const url = new URL(req.url, 'http://paperclip.test');
    if (
      req.method === 'GET' &&
      url.pathname === '/api/companies/company-1/issues' &&
      url.searchParams.get('q') === 'Bridge' &&
      url.searchParams.get('limit') === '5'
    ) {
      return json(res, 200, { items: [state.issue] });
    }

    return json(res, 404, { error: 'not_found' });
  });

  try {
    const client = createPaperclipClient({
      auth: {
        apiUrl: server.url,
        apiKey: 'test-token',
        companyId: 'company-1',
        agentId: 'agent-1',
        defaultProjectId: 'project-1',
        runId: 'run-1',
      },
      retryDelayMs: 1,
    });

    const created = await client.createIssue({ title: 'Bridge smoke' });
    assert.equal(created.identifier, 'SUP-9999');
    assert.equal(created.status, 'todo');

    const comment = await client.addComment('SUP-9999', 'client smoke comment');
    assert.equal(comment.body, 'client smoke comment');

    const updated = await client.updateIssue('SUP-9999', { status: 'in_review' });
    assert.equal(updated.status, 'in_review');

    const fetched = await client.getIssue('SUP-9999');
    assert.equal(fetched.status, 'in_review');

    const found = await client.searchIssues('Bridge', { limit: 5 });
    assert.equal(found.length, 1);
    assert.equal(found[0].identifier, 'SUP-9999');

    assert.ok(server.requests.some((request) => request.headers['x-paperclip-run-id'] === 'run-1'));
  } finally {
    await server.close();
  }
});

test('Paperclip client retries transient GET failures', async () => {
  let attempts = 0;
  const server = await createServer((req, res) => {
    attempts += 1;
    if (attempts === 1) return json(res, 503, { error: 'temporarily unavailable' });
    return json(res, 200, { id: 'issue-1', identifier: 'SUP-1' });
  });

  try {
    const client = createPaperclipClient({
      auth: {
        apiUrl: server.url,
        apiKey: 'test-token',
        companyId: 'company-1',
      },
      retryDelayMs: 1,
    });

    const issue = await client.getIssue('SUP-1');
    assert.equal(issue.identifier, 'SUP-1');
    assert.equal(attempts, 2);
  } finally {
    await server.close();
  }
});

test('Paperclip client does not retry mutating requests unless explicitly enabled', async () => {
  let attempts = 0;
  const server = await createServer((req, res) => {
    attempts += 1;
    return json(res, 503, { error: 'temporarily unavailable' });
  });

  try {
    const client = createPaperclipClient({
      auth: {
        apiUrl: server.url,
        apiKey: 'test-token',
        companyId: 'company-1',
      },
      retryDelayMs: 1,
    });

    await assert.rejects(
      () => client.addComment('SUP-1', 'comment body'),
      (error) => error instanceof PaperclipHttpError && error.status === 503,
    );
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});
