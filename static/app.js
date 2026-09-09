'use strict';

/* jarvOS Desktop — single-page client.
   Hash router -> page renderers; all data from the local server. */

const $main = document.getElementById('main');

const fmt = {
  esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },
  day(dateStr) {
    const d = new Date(`${dateStr}T12:00:00`);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  },
  weekday(dateStr) {
    return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  },
  ago(iso) {
    if (!iso) return '';
    const mins = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
    if (mins < 60) return `${Math.round(mins)}m`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / 1440)}d`;
  },
  status(s) {
    return String(s || '').replace(/_/g, ' ');
  },
};

async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${path} failed (${res.status})`);
  return data;
}

/* ── Markdown pipeline: frontmatter, CriticMarkup, wikilinks ── */

function renderMarkdown(src) {
  let text = String(src || '').replace(/^---\n[\s\S]*?\n---\n/, '');

  // CriticMarkup -> styled spans (before marked, emit inline HTML)
  const attrChip = (attrs) => {
    const by = (attrs || '').match(/by="([^"]*)"/);
    return by ? `<span class="cm-author">${fmt.esc(by[1])}</span>` : '';
  };
  text = text
    .replace(/\{==([\s\S]*?)==\}/g, '<span class="cm-hl">$1</span>')
    .replace(/\{>>([\s\S]*?)<<\}(\{[^}]*\})?/g, (_, c, attrs) =>
      `<span class="cm-comment">${c.trim()}${attrChip(attrs)}</span>`)
    .replace(/\{\+\+([\s\S]*?)\+\+\}(\{[^}]*\})?/g, (_, c, attrs) =>
      `<span class="cm-ins">${c}</span>${attrChip(attrs)}`)
    .replace(/\{--([\s\S]*?)--\}(\{[^}]*\})?/g, (_, c, attrs) =>
      `<span class="cm-del">${c}</span>${attrChip(attrs)}`)
    .replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}(\{[^}]*\})?/g, (_, a, b, attrs) =>
      `<span class="cm-del">${a}</span><span class="cm-ins">${b}</span>${attrChip(attrs)}`)
    .replace(/\{id="[^"]*"[^}]*\}/g, '');

  // wikilinks
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
    `<a class="wikilink" data-note="${fmt.esc(target.trim())}">${fmt.esc((alias || target).trim())}</a>`);

  const html = DOMPurify.sanitize(marked.parse(text, { mangle: false, headerIds: false }));
  return `<div class="md">${html}</div>`;
}

// Wikilink clicks anywhere -> open note in Notes page.
document.addEventListener('click', (e) => {
  const wl = e.target.closest('.wikilink');
  if (!wl) return;
  const target = wl.dataset.note;
  if (/^\d{4}-\d{2}-\d{2}$/.test(target)) {
    // date links belong to the journal, not the notes vault
    location.hash = '#/journal';
    return;
  }
  state.pendingNote = target;
  location.hash = '#/notes';
  if (currentPage() === 'notes') render();
});

/* ── Shared render helpers ──────────────────────────────── */

function head(kicker, title, sub = '') {
  return `<header class="page-head reveal">
    <div class="page-kicker">${kicker}</div>
    <h1 class="page-title">${title}</h1>
    ${sub ? `<p class="page-sub">${sub}</p>` : ''}
  </header>`;
}

function card(title, body, { count = null, delay = 0, spark = false } = {}) {
  return `<section class="card reveal" style="animation-delay:${delay}ms">
    <h2 class="card-title">${spark ? '<span class="spark">✦</span>' : ''}${title}
      ${count !== null ? `<span class="count">${count}</span>` : ''}</h2>
    ${body}
  </section>`;
}

function issueRow(i) {
  const prio = i.priority && i.priority !== 'medium' ? `<span class="who prio-${i.priority}">${i.priority}</span>` : '';
  return `<div class="issue-row">
    <span class="issue-id">${fmt.esc(i.identifier || '')}</span>
    <span class="issue-title" title="${fmt.esc(i.title)}">${fmt.esc(i.title)}</span>
    <span class="issue-meta">${prio}
      ${i.assignee ? `<span class="who">@${fmt.esc(i.assignee)}</span>` : ''}
      <span class="pill ${i.status}">${fmt.status(i.status)}</span>
    </span>
  </div>`;
}

function plainList(items) {
  if (!items?.length) return '<div class="empty">nothing here today</div>';
  return `<ul class="plain-list">${items.map((x) => `<li>${renderInline(x)}</li>`).join('')}</ul>`;
}

function renderInline(s) {
  // bullets from the journal can carry bold / wikilinks
  return renderMarkdown(s).replace(/^<div class="md"><p>|<\/p><\/div>$/g, '').replace(/^<div class="md">|<\/div>$/g, '');
}

function agentChip(a) {
  const initial = (a.name || '?')[0];
  const hue = { Jarvis: 'var(--amber)', Michael: 'var(--sky)', Charlie: 'var(--sage)', Steve: 'var(--violet)' }[a.name] || 'var(--ink-dim)';
  return `<div class="agent-chip" title="${fmt.esc(a.capabilities || '')}">
    <span class="agent-face" style="background:${hue}">${fmt.esc(initial)}</span>
    <span><span class="nm">${fmt.esc(a.name)}</span><br><span class="rl">${fmt.esc(a.title || a.role || '')}</span></span>
    <span class="agent-dot ${fmt.esc(a.status || 'idle')}" title="${fmt.esc(a.status || '')}"></span>
  </div>`;
}

/* ── Pages ──────────────────────────────────────────────── */

const state = { journalDays: [], notes: [], activeNote: null, activeProject: null, pendingNote: null, after: null };
let renderedPage = null;
let renderGeneration = 0;

const pages = {
  async chat() {
    state.after = () => mountChatIsland();
    return '<div id="chat-root" class="reveal"><div class="spin">opening chat…</div></div>';
  },

  async today() {
    const d = await api('/api/today');
    const hour = new Date().getHours();
    const greeting = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    const needsBody = d.needsYou.length
      ? d.needsYou.map(issueRow).join('')
      : '<div class="empty">nothing is waiting on you</div>';

    let html = head(
      `${fmt.weekday(d.date)} · ${d.date}`,
      `${greeting}, Andrew.`,
      `${d.moving.length} thread${d.moving.length === 1 ? '' : 's'} moving · ${d.needsYou.length} waiting on you · ${d.recentlyDone.length} shipped in the last two days`
    );

    if (d.paperclipError) html += `<div class="err-banner reveal">Paperclip unreachable: ${fmt.esc(d.paperclipError)}</div>`;

    html += `<div class="cols">
      <div class="stack">
        ${card('Needs you', needsBody, { count: d.needsYou.length, delay: 60, spark: true })}
        ${card('Moving now', d.moving.length ? d.moving.map(issueRow).join('') : '<div class="empty">no agent is mid-flight</div>', { count: d.moving.length, delay: 120 })}
        ${card('Recently shipped', d.recentlyDone.length ? d.recentlyDone.map(issueRow).join('') : '<div class="empty">nothing closed in the last 48h</div>', { count: d.recentlyDone.length, delay: 180 })}
        ${card('Agents', `<div class="agents-strip">${d.agents.map(agentChip).join('')}</div>`, { delay: 240 })}
      </div>
      <div class="stack">
        ${card('Calendar', plainList(d.calendar), { delay: 90 })}
        ${card('Reminders', plainList(d.reminders), { delay: 150 })}
        ${d.flagged.length ? card('Flagged', plainList(d.flagged), { delay: 180 }) : ''}
        ${d.ideas.length ? card('Ideas', plainList(d.ideas), { delay: 200 }) : ''}
        ${d.recentNotes.length ? card('Notes touched recently', `<ul class="plain-list">${d.recentNotes.map((n) =>
          `<li><a class="wikilink" data-note="${fmt.esc(n.title)}">${fmt.esc(n.title)}</a> <span class="who">${fmt.ago(n.modified)} ago</span></li>`).join('')}</ul>`, { delay: 220 }) : ''}
        ${card('Paperclip inbox', plainList(d.inbox.slice(0, 8)), { count: d.inbox.length, delay: 260 })}
      </div>
    </div>`;
    return html;
  },

  async journal() {
    state.journalDays = await api('/api/journal?limit=10');
    let html = head('the stream', 'Journal', 'Every day your agents and you leave a trail — calendar, captures, decisions, work. Newest first.');
    html += `<div class="stream reveal" style="animation-delay:80ms" id="stream">${state.journalDays.map(dayBlock).join('')}</div>
      <button class="load-more" id="load-more">earlier days…</button>`;
    state.after = () => {
      document.getElementById('load-more')?.addEventListener('click', async () => {
        const oldest = state.journalDays[state.journalDays.length - 1]?.date;
        const more = await api(`/api/journal?limit=10&before=${oldest}`);
        state.journalDays.push(...more);
        document.getElementById('stream').insertAdjacentHTML('beforeend', more.map(dayBlock).join(''));
        if (!more.length) document.getElementById('load-more').remove();
      });
    };
    return html;
  },

  async notes() {
    const q = state.notesQuery || '';
    const data = await api(`/api/notes?limit=80${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    state.notes = data.notes;
    if (state.pendingNote) {
      state.activeNote = state.pendingNote;
      state.pendingNote = null;
    }
    if (!state.activeNote && state.notes.length) state.activeNote = state.notes[0].title;

    let html = head('durable knowledge', 'Notes', `${data.total} Obsidian-compatible notes in the vault. Yours, in plain markdown, forever.`);
    html += `<div class="notes-shell reveal" style="animation-delay:60ms">
      <div class="notes-list">
        <input class="search" id="note-search" placeholder="Search ${data.total} notes…" value="${fmt.esc(q)}">
        <div id="note-items">${state.notes.map(noteItem).join('')}</div>
      </div>
      <div class="reader card" id="note-reader"><div class="spin">opening…</div></div>
    </div>`;
    state.after = () => {
      bindNotesEvents();
      if (state.activeNote) openNote(state.activeNote);
    };
    return html;
  },

  async projects() {
    const data = await api('/api/projects');
    let html = head('portfolio', 'Projects', 'Outcomes, definitions of done, verified completion evidence, and the next useful step.');
    html += `<div id="projects-view" class="reveal" style="animation-delay:60ms">${window.JarvosProjectsView.render(data, state.activeProject)}</div>`;
    state.after = () => {
      document.querySelectorAll('[data-project-id]').forEach((button) => button.addEventListener('click', () => {
        state.activeProject = button.dataset.projectId;
        document.getElementById('projects-view').innerHTML = window.JarvosProjectsView.render(data, state.activeProject);
        state.after();
      }));
    };
    return html;
  },

  async memory() {
    return head('deferred', 'Memory', 'Memory development is intentionally deferred from this Desktop slice.')
      + card('Not in this release', '<p>The underlying data remains untouched. Memory will return when its product contract is ready.</p>', { delay: 60 });
  },

  async ontology() {
    const spine = await api('/api/ontology');
    let html = head('the meaning spine', 'Ontology',
      'Why the work matters: higher order, beliefs, predictions, core self, goals, projects. Agents read this before they act.');
    html += `<div class="onto-shell reveal" style="animation-delay:60ms">
      <nav class="toc">${spine.map((s, i) => `<button data-target="onto-${i}" ${i === 0 ? 'class="active"' : ''}>${fmt.esc(s.title)}</button>`).join('')}</nav>
      <div>${spine.map((s, i) => `<section class="onto-section card" id="onto-${i}">${renderMarkdown(s.content)}</section>`).join('')}</div>
    </div>`;
    state.after = () => {
      document.querySelectorAll('.toc button').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('.toc button').forEach((x) => x.classList.toggle('active', x === b));
        document.getElementById(b.dataset.target)?.scrollIntoView({ behavior: 'smooth' });
      }));
    };
    return html;
  },

  async services() {
    const svcs = await api('/api/health');
    const okCount = svcs.filter((s) => s.ok).length;
    let html = head('the bundle', 'Services',
      `The systems jarvOS stitches into one operating layer. ${okCount}/${svcs.length} healthy.`);
    html += `<div class="svc-grid reveal" style="animation-delay:80ms">${svcs.map((s) => `
      <div class="svc">
        <span class="light ${s.ok ? 'ok' : 'bad'}"></span>
        <div>
          <div><span class="nm">${fmt.esc(s.name)}</span><span class="kind">${fmt.esc(s.kind)}</span></div>
          <div class="det">${fmt.esc(s.detail)}</div>
          <div class="ep">${fmt.esc(s.endpoint)}</div>
        </div>
      </div>`).join('')}</div>`;
    return html;
  },
};

/* ── Journal helpers ────────────────────────────────────── */

function dayBlock(day) {
  const sections = day.sections.filter((s) => !s.empty);
  return `<article class="day">
    <h2 class="day-date">${fmt.day(day.date)}<span class="wd">${fmt.weekday(day.date)}</span></h2>
    <div class="day-sections">${sections.length
      ? sections.map((s) => `<div class="sec"><h4><span class="emoji">${s.emoji}</span>${fmt.esc(s.title)}</h4>${renderMarkdown(s.content)}</div>`).join('')
      : '<div class="empty">a quiet day</div>'}</div>
  </article>`;
}

/* ── Notes helpers ──────────────────────────────────────── */

function noteItem(n) {
  return `<button class="note-item ${n.title === state.activeNote ? 'active' : ''}" data-note-open="${fmt.esc(n.title)}">
    <div class="t">${fmt.esc(n.title)}</div>
    ${n.excerpt ? `<div class="x">${fmt.esc(n.excerpt)}</div>` : ''}
    <div class="d">${fmt.ago(n.modified)} ago</div>
  </button>`;
}

let searchTimer = null;
function bindNotesEvents() {
  document.getElementById('note-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.notesQuery = e.target.value;
      const data = await api(`/api/notes?limit=80&q=${encodeURIComponent(state.notesQuery)}`);
      state.notes = data.notes;
      document.getElementById('note-items').innerHTML = state.notes.map(noteItem).join('');
    }, 220);
  });
  document.addEventListener('click', notesClickDelegate);
}

function notesClickDelegate(e) {
  const btn = e.target.closest('[data-note-open]');
  if (btn) openNote(btn.dataset.noteOpen);
}

async function openNote(title) {
  state.activeNote = title;
  document.querySelectorAll('.note-item').forEach((x) =>
    x.classList.toggle('active', x.dataset.noteOpen === title));
  const reader = document.getElementById('note-reader');
  if (!reader) return;
  reader.innerHTML = '<div class="spin">opening…</div>';
  try {
    const note = await api(`/api/note?title=${encodeURIComponent(title)}`);
    reader.innerHTML = `<div class="reader-head">
        <h2 class="reader-title">${fmt.esc(note.title)}</h2>
        <div class="reader-meta">edited ${fmt.ago(note.modified)} ago · ${fmt.esc(note.path)}</div>
      </div>${renderMarkdown(note.content)}`;
    reader.scrollIntoView({ block: 'nearest' });
  } catch (err) {
    reader.innerHTML = `<div class="err-banner">${fmt.esc(err.message)}</div>`;
  }
}

/* ── Router ─────────────────────────────────────────────── */

function currentPage() {
  const m = location.hash.match(/^#\/(\w+)/);
  if (m?.[1] === 'work') {
    history.replaceState(null, '', '#/projects');
    return 'projects';
  }
  return m && pages[m[1]] ? m[1] : 'chat';
}

function mountChatIsland() {
  const cssId = 'chat-css';
  if (!document.getElementById(cssId)) {
    const link = document.createElement('link');
    link.id = cssId;
    link.rel = 'stylesheet';
    link.href = '/chat/style.css';
    document.head.appendChild(link);
  }
  if (window.__jarvosChatLoaded) {
    window.mountJarvosChat?.();
    return;
  }
  const script = document.createElement('script');
  script.type = 'module';
  script.src = '/chat/chat.js';
  script.onload = () => {
    window.__jarvosChatLoaded = true;
    window.mountJarvosChat?.();
  };
  document.body.appendChild(script);
}

function unmountChatIsland() {
  if (window.unmountJarvosChat && typeof window.unmountJarvosChat === 'function') {
    window.unmountJarvosChat();
  }
}

async function render() {
  const generation = ++renderGeneration;
  const page = currentPage();
  if (renderedPage === 'chat' && page !== 'chat') {
    unmountChatIsland();
  }
  document.querySelectorAll('.nav a').forEach((a) =>
    a.classList.toggle('active', a.dataset.page === page));
  document.removeEventListener('click', notesClickDelegate);
  $main.innerHTML = '<div class="spin">gathering…</div>';
  state.after = null;
  try {
    const html = await pages[page]();
    if (generation !== renderGeneration) return;
    $main.innerHTML = html;
    renderedPage = page;
    state.after?.(); // post-render bindings, now that the HTML is in the DOM
  } catch (err) {
    if (generation !== renderGeneration) return;
    $main.innerHTML = head('hm', 'Something broke', '') +
      `<div class="err-banner">${fmt.esc(err.message)}</div>`;
    renderedPage = 'error';
  }
  $main.scrollTop = 0;
}

window.addEventListener('hashchange', render);

/* sidebar health pulse */
async function pulse() {
  try {
    const svcs = await api('/api/health');
    const bad = svcs.filter((s) => !s.ok);
    const dot = document.getElementById('pulse-dot');
    const label = document.getElementById('pulse-label');
    dot.className = `pulse-dot ${bad.length ? 'warn' : 'ok'}`;
    label.textContent = bad.length ? `${bad.length} service${bad.length > 1 ? 's' : ''} down` : 'all systems calm';
  } catch {
    document.getElementById('pulse-dot').className = 'pulse-dot warn';
    document.getElementById('pulse-label').textContent = 'server offline';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  render();
  pulse();
  setInterval(pulse, 60_000);
});
