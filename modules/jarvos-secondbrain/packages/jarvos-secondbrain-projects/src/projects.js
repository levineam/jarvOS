#!/usr/bin/env node
/**
 * projects.js — the Projects record.
 *
 * A project is one markdown file in the vault holding three things: what the
 * project is for (Goal), roughly how it gets done (High-level plan), and how
 * you know it is finished (Definition of Done).
 *
 * They are plain files on purpose. They stay readable with no tooling in the
 * loop, they diff, and an assistant can be handed the whole directory as
 * context. Nothing here owns state that is not visible in the file itself.
 *
 * This module reads and writes those files. It does not talk to any issue
 * tracker; comparing projects against tracker state is a separate concern.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'projects-module.json');

/**
 * Resolve the shared vault config if the bridge is present.
 *
 * Only the bridge being ABSENT is tolerable -- this package has to work
 * standalone. A rejection from `resolveConfig()` is not: it throws
 * deliberately, as a fail-closed guard, when the resolved vault is the stale
 * `~/Documents/Vault v3` or falls outside `JARVOS_REQUIRE_CANONICAL_VAULT`
 * (a sandboxed runtime with an unexpected `$HOME`).
 *
 * Swallowing that turned the guard into a silent fallback: `resolveProjectsDir`
 * dropped through to `$HOME/Vaults/Vault v3/Projects`, `mkdirSync` conjured
 * that path into existence, and the Projects record was written into a dead
 * vault -- while the journal rendered `- (projects unavailable)` over the real
 * list. `journal-maintenance.js` calls the same `resolveConfig()` unguarded and
 * fails closed, so the two halves of this feature disagreed about one guard.
 *
 * Resolving the module and calling it are therefore separate steps: only the
 * `require` is caught.
 */
function tryResolveSharedConfig() {
  // Resolve the SPECIFIER first, and tolerate only its absence. `bridge/config`
  // is a directory whose index requires several further modules, so a broken or
  // partial install raises MODULE_NOT_FOUND for a NESTED module with the same
  // `err.code` -- indistinguishable from "no bridge here" if the whole
  // `require` is wrapped. That reinstated the silent `$HOME` fallback this
  // function exists to close: verified by deleting one nested bridge file, after
  // which resolveProjectsDir() returned a $HOME path instead of throwing.
  // "Absent" means the bridge DIRECTORY is not there. If it is there but its
  // entry point will not resolve -- index.js missing from a partial checkout, a
  // future package.json `main` pointing at a missing file, an unreadable
  // directory -- that is a broken install, and `require.resolve` reports it with
  // the same MODULE_NOT_FOUND as a genuinely absent bridge. Tolerating that put
  // the silent $HOME fallback straight back (verified: it returned
  // `/Users/andrew/Vaults/Vault v3/Projects` with resolution forced to fail).
  // The two states ARE distinguishable, so distinguish them.
  const bridgeDir = path.join(__dirname, '..', '..', '..', 'bridge', 'config');
  let modulePath;
  try {
    modulePath = require.resolve('../../../bridge/config');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && !fs.existsSync(bridgeDir)) return null;
    throw err;
  }
  // Past this point the bridge exists, so every failure is real and propagates:
  // a nested require failure, and the deliberate fail-closed vault guards.
  // eslint-disable-next-line global-require
  const { resolveConfig } = require(modulePath);
  return resolveConfig();
}

function loadConfig({ configFile } = {}) {
  try {
    return JSON.parse(fs.readFileSync(configFile || CONFIG_PATH, 'utf8'));
  } catch {
    // A missing or malformed contract must not take the journal down with it;
    // the defaults below are the same values the shipped config declares.
    return {};
  }
}

function resolveTilde(p) {
  if (p && p.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), p.slice(2));
  return p;
}

/**
 * Directory resolution, highest priority first:
 *   1. JARVOS_PROJECTS_DIR
 *   2. <vault>/Projects, where <vault> comes from the shared config bridge
 *      (JARVOS_VAULT_DIR or jarvos.config.json paths.vault)
 *   3. config.vault.projectsDir from projects-module.json
 *   4. ~/Vaults/Vault v3/Projects
 */
function resolveProjectsDir(config = loadConfig(), { env = process.env } = {}) {
  const explicit = String(env.JARVOS_PROJECTS_DIR || '').trim();
  if (explicit) return resolveTilde(explicit);

  const shared = tryResolveSharedConfig();
  const vault = shared && shared.paths && shared.paths.vault;
  if (vault) return path.join(vault, 'Projects');

  if (config.vault && config.vault.projectsDir) return resolveTilde(config.vault.projectsDir);
  return path.join(env.HOME || os.homedir(), 'Vaults', 'Vault v3', 'Projects');
}

function requiredSections(config = loadConfig()) {
  const declared = config.sections && Array.isArray(config.sections.required)
    ? config.sections.required
    : null;
  if (declared && declared.length) return declared;
  return [
    { id: 'goal', heading: '## Goal' },
    { id: 'plan', heading: '## High-level plan' },
    { id: 'definition-of-done', heading: '## Definition of Done' },
  ];
}

function ongoingStatuses(config = loadConfig()) {
  const declared = config.statuses && Array.isArray(config.statuses.ongoing)
    ? config.statuses.ongoing
    : null;
  return new Set(declared && declared.length ? declared : ['active', 'paused']);
}

function defaultStatus(config = loadConfig()) {
  return (config.frontmatter && config.frontmatter.defaultStatus) || 'active';
}

function indexFilename(config = loadConfig()) {
  return (config.index && config.index.filename) || 'index.md';
}

/** Filesystem-safe slug that still reads like the title. */
function slugify(title) {
  return String(title || '')
    .trim()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitFrontmatter(md) {
  // Normalise CRLF up front so every downstream line split and trim behaves
  // the same whether the file was written on macOS, Linux, or Windows.
  const text = String(md || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: text };
  const frontmatter = text.slice(4, end).replace(/^\n/, '');
  const body = text.slice(end + 4).replace(/^\n/, '');
  return { frontmatter, body };
}

function parseFrontmatter(frontmatter) {
  const out = {};
  for (const line of String(frontmatter || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Split a body into `## `-delimited sections, keyed by heading.
 * Content before the first heading is ignored — the template never puts
 * anything there, and treating it as a section would invent headings.
 */
function parseSections(body) {
  const sections = new Map();
  let heading = null;
  let buffer = [];
  const flush = () => {
    if (heading === null) return;
    // A duplicated heading appends rather than replaces, so content in the
    // first occurrence is never silently dropped from the completeness check.
    const prior = sections.get(heading);
    const next = buffer.join('\n').trim();
    sections.set(heading, prior ? `${prior}\n${next}`.trim() : next);
  };
  for (const line of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^##\s+/.test(line)) {
      flush();
      heading = line.trim();
      buffer = [];
    } else if (heading !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** A section counts as filled only if it has real text — not just the template's `-`. */
function isFilled(content) {
  const text = String(content || '').trim();
  if (!text) return false;
  const material = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== '-' && line !== '- ');
  return material.length > 0;
}

function titleFromBody(body, fallback) {
  const match = String(body || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function readProject(filePath, config = loadConfig()) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(frontmatter);
  const sections = parseSections(body);
  const basename = path.basename(filePath, '.md');

  const missing = [];
  const filled = {};
  for (const section of requiredSections(config)) {
    const content = sections.get(section.heading);
    filled[section.id] = content || '';
    if (!isFilled(content)) missing.push(section.id);
  }

  return {
    slug: basename,
    path: filePath,
    title: meta.title || titleFromBody(body, basename),
    status: (meta.status || defaultStatus(config)).toLowerCase(),
    created: meta.created || null,
    sections: filled,
    missingSections: missing,
    complete: missing.length === 0,
  };
}

/**
 * Read the projects directory.
 *
 * Returns null when the directory cannot be read at all, which must stay
 * distinguishable from an empty directory: an unmounted vault or a mistyped
 * JARVOS_PROJECTS_DIR would otherwise render as a confident "no ongoing
 * projects" and overwrite the Projects section of every journal entry it
 * touches. Callers that cannot express uncertainty use listProjects().
 */
function readProjectsDir({ dir, config = loadConfig() } = {}) {
  const projectsDir = dir || resolveProjectsDir(config);
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const skip = indexFilename(config).toLowerCase();
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .filter((entry) => entry.name.toLowerCase() !== skip)
    .map((entry) => {
      try {
        return readProject(path.join(projectsDir, entry.name), config);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title));
}

function listProjects(opts = {}) {
  return readProjectsDir(opts) || [];
}

function isOngoing(project, config = loadConfig()) {
  return ongoingStatuses(config).has(String(project.status || '').toLowerCase());
}

function renderProjectPage({
  title,
  status,
  created,
  goal = '',
  plan = '',
  definitionOfDone = '',
  config = loadConfig(),
} = {}) {
  const sectionBody = {
    goal,
    plan,
    'definition-of-done': definitionOfDone,
  };
  const lines = [
    '---',
    `type: ${(config.frontmatter && config.frontmatter.type) || 'project'}`,
    `title: ${title}`,
    `status: ${status || defaultStatus(config)}`,
    `created: ${created}`,
    '---',
    '',
    `# ${title}`,
    '',
  ];
  for (const section of requiredSections(config)) {
    lines.push(section.heading);
    const content = String(sectionBody[section.id] || '').trim();
    lines.push(content || '-');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function createProject({ title, dir, config = loadConfig(), now = new Date(), ...rest } = {}) {
  const clean = slugify(title);
  if (!clean) throw new Error('a project needs a title');

  const projectsDir = dir || resolveProjectsDir(config);
  fs.mkdirSync(projectsDir, { recursive: true });

  const filePath = path.join(projectsDir, `${clean}.md`);
  // The generated index is not a project. Without this, `new "Index"` writes
  // Index.md and the caller's follow-up writeIndex() overwrites it — the same
  // inode on a case-insensitive filesystem — silently replacing a page the CLI
  // just reported creating.
  if (path.basename(filePath).toLowerCase() === indexFilename(config).toLowerCase()) {
    throw new Error(`"${clean}" collides with the generated index (${indexFilename(config)}); pick another title`);
  }
  if (fs.existsSync(filePath)) throw new Error(`project already exists: ${filePath}`);

  const created = now.toISOString().slice(0, 10);
  const page = renderProjectPage({ title: clean, created, config, ...rest });
  fs.writeFileSync(filePath, page, 'utf8');
  return { path: filePath, slug: clean, title: clean, created };
}

/**
 * Wiki-links for the journal's Projects section.
 *
 * `projects` of null means the directory could not be read. That renders the
 * unavailable marker, which the journal treats as a degraded source and will
 * not write over existing content — unlike the empty-state line, which is a
 * positive claim that there are no projects.
 */
function journalProjectLines(projects, config = loadConfig()) {
  const journal = config.journal || {};
  if (projects === null) return journal.unavailableText || '- (projects unavailable)';
  const allowed = Array.isArray(journal.listStatuses) && journal.listStatuses.length
    ? new Set(journal.listStatuses)
    : ongoingStatuses(config);
  const max = Number.isFinite(journal.maxItems) ? journal.maxItems : 25;

  const listed = projects.filter((project) => allowed.has(String(project.status || '').toLowerCase()));
  if (!listed.length) return journal.emptyText || '- No ongoing projects';

  const lines = listed.slice(0, max).map((project) => `- [[${project.title}]]`);
  if (listed.length > max) lines.push(`- _...and ${listed.length - max} more_`);
  return lines.join('\n');
}

function renderIndex(projects, config = loadConfig()) {
  const title = (config.index && config.index.title) || 'Projects';
  const ongoing = projects.filter((project) => isOngoing(project, config));
  const closed = projects.filter((project) => !isOngoing(project, config));

  const lines = [
    '---',
    'type: project-index',
    '---',
    '',
    `# ${title}`,
    '',
    '_Generated from the project pages. Edits here are overwritten._',
    '',
    '## Ongoing',
    '',
  ];
  lines.push(ongoing.length
    ? ongoing.map((project) => {
      const flag = project.complete ? '' : ` — _missing: ${project.missingSections.join(', ')}_`;
      return `- [[${project.title}]] (${project.status})${flag}`;
    }).join('\n')
    : '- None');

  if (closed.length) {
    lines.push('', '## Closed', '');
    lines.push(closed.map((project) => `- [[${project.title}]] (${project.status})`).join('\n'));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function writeIndex({ dir, config = loadConfig(), projects } = {}) {
  const projectsDir = dir || resolveProjectsDir(config);
  const list = projects || listProjects({ dir: projectsDir, config });
  fs.mkdirSync(projectsDir, { recursive: true });
  const indexPath = path.join(projectsDir, indexFilename(config));
  fs.writeFileSync(indexPath, renderIndex(list, config), 'utf8');
  return { path: indexPath, count: list.length };
}

/**
 * Report project pages that cannot be judged on-track: missing Goal, plan, or
 * Definition of Done. Only ongoing projects are reported — a finished project
 * with a thin page is not worth nagging about.
 */
function checkProjects({ dir, config = loadConfig(), projects } = {}) {
  const list = projects || listProjects({ dir, config });
  const issues = list
    .filter((project) => isOngoing(project, config))
    .filter((project) => !project.complete)
    .map((project) => ({
      slug: project.slug,
      title: project.title,
      path: project.path,
      missing: project.missingSections,
    }));
  return { checked: list.length, issues, ok: issues.length === 0 };
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  resolveProjectsDir,
  readProjectsDir,
  requiredSections,
  ongoingStatuses,
  slugify,
  splitFrontmatter,
  parseFrontmatter,
  parseSections,
  isFilled,
  readProject,
  listProjects,
  isOngoing,
  renderProjectPage,
  createProject,
  journalProjectLines,
  renderIndex,
  writeIndex,
  checkProjects,
};
