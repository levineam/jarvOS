'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(read) {
  const app = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  const source = app.slice(app.indexOf('let stopVisibleRefresh'), app.indexOf('/* ── System Doctor receipt'));
  const timers = new Map();
  const listeners = new Map();
  const target = { innerHTML: '', textContent: '' };
  let next = 0;
  const context = vm.createContext({
    renderGeneration: 1, route: 'system', read,
    currentPage: () => context.route,
    document: { hidden: false, getElementById: () => target,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } },
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source + "\nstartVisibleRefresh('system', read);", context);
  async function tick() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    await timer.fn();
  }
  return { context, timers, listeners, target, tick };
}

test('visible refresh is single-flight and discards a response after navigation', async () => {
  let calls = 0;
  let commitCount = 0;
  let resolve;
  const h = harness(() => { calls++; return new Promise((done) => { resolve = done; }); });
  const pending = h.tick();
  h.listeners.get('visibilitychange')();
  assert.equal(calls, 1);
  h.context.route = 'projects';
  h.context.renderGeneration++;
  resolve(() => commitCount++);
  await pending;
  assert.equal(commitCount, 0);
  assert.equal(h.timers.size, 0);
  vm.runInContext('stopVisibleRefresh()', h.context);
  assert.equal(h.listeners.size, 0);
});

test('hidden pages pause reads; failures replace stale claims and back off; success recovers', async () => {
  let calls = 0;
  let fail = true;
  const h = harness(async () => { calls++; if (fail) throw new Error('offline'); return () => { h.target.innerHTML = 'fresh result'; }; });
  h.context.document.hidden = true;
  await h.tick();
  assert.equal(calls, 0);
  h.context.document.hidden = false;
  await h.tick();
  assert.match(h.target.innerHTML, /unavailable/);
  assert.equal([...h.timers.values()][0].delay, 60_000);
  fail = false;
  await h.tick();
  assert.equal(h.target.innerHTML, 'fresh result');
  assert.equal([...h.timers.values()][0].delay, 30_000);
});
