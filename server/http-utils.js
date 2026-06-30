'use strict';

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function httpThrow(status, message) {
  throw httpError(status, message);
}

function readJson(req, { limit = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(httpError(413, 'request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(httpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function pipeWebResponse(webResponse, res) {
  res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
  if (!webResponse.body) return res.end();
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } finally {
    res.end();
    reader.releaseLock();
  }
}

module.exports = { json, httpError, httpThrow, readJson, pipeWebResponse };
