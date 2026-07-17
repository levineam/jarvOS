#!/usr/bin/env node
'use strict';

/**
 * unreleased-drift-check.js — guard against "release confusion".
 *
 * Two failure modes this catches, both seen in practice ("I thought we were
 * already at v0.3?" — work merged to main, package.json/CHANGELOG moved, but no
 * tag/Release ever cut):
 *
 *   1. UNTAGGED RELEASE — package.json's version is ahead of the latest git
 *      tag, but there is no finalized `## v<version>` CHANGELOG section to back
 *      it (the version was bumped without a release entry).
 *   2. UNLOGGED WORK — package.json matches the latest tag (we just released),
 *      yet commits have landed since that tag with no `## [Unreleased]` section
 *      tracking them.
 *
 * The healthy "ready to tag" state — package.json ahead of the latest tag with
 * a dated `## v<version>` section present — is reported and exits 0.
 *
 * Usage:
 *   node scripts/unreleased-drift-check.js [--json]
 *
 * Exit codes: 0 = no drift (or ready to tag); 1 = drift; 2 = usage/IO error.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args.join(' ')} failed: ${r.error.message}`);
  return { status: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

function semverTags() {
  const { out } = git(['tag', '--list']);
  return out
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number);
      const pb = b.slice(1).split('.').map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
}

// Returns { present, dated } for the `## v<version>` heading in the changelog.
function changelogVersionSection(changelog, version) {
  const re = new RegExp(`^##\\s+v${version.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b([^\\n]*)`, 'm');
  const m = changelog.match(re);
  if (!m) return { present: false, dated: false };
  return { present: true, dated: !/unreleased/i.test(m[1] || '') };
}

// Placeholder bullets that mean "no entries recorded yet" rather than real,
// tracked work. Without this, a literal "- Nothing yet." placeholder counts
// as tracked content and the drift check reports a false OK (this is exactly
// how #107/#108 landed on main without ever showing up as [Unreleased] drift).
const PLACEHOLDER_UNRELEASED_ENTRY = /^(nothing yet|none|n\/a|tbd)\.?$/i;

// Returns { present, nonEmpty } for the `## [Unreleased]` section.
function unreleasedSection(changelog) {
  const lines = changelog.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+\[Unreleased\]/i.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return { present: false, nonEmpty: false };
  let nonEmpty = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    const bullet = lines[i].match(/^\s*[-*]\s+(\S.*)$/);
    if (bullet && !PLACEHOLDER_UNRELEASED_ENTRY.test(bullet[1].trim())) {
      nonEmpty = true;
      break;
    }
  }
  return { present: true, nonEmpty };
}

function main() {
  const json = process.argv.slice(2).includes('--json');
  let pkg;
  let changelog;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch (e) {
    console.error(`[unreleased-drift] Error: ${e.message}`);
    process.exit(2);
  }

  const version = String(pkg.version || '').trim();
  const tags = semverTags();
  const latestTag = tags.length ? tags[tags.length - 1] : null;
  const latestTagVersion = latestTag ? latestTag.slice(1) : null;

  let commitsSinceTag = null;
  try {
    if (latestTag) commitsSinceTag = parseInt(git(['rev-list', '--count', `${latestTag}..HEAD`]).out, 10);
  } catch (_) { commitsSinceTag = null; }

  const verSection = changelogVersionSection(changelog, version);
  const unreleased = unreleasedSection(changelog);

  const result = {
    packageVersion: version,
    latestTag,
    commitsSinceTag,
    changelogHasVersionSection: verSection.present,
    changelogVersionDated: verSection.dated,
    hasUnreleasedSection: unreleased.present,
    unreleasedNonEmpty: unreleased.nonEmpty,
    state: 'ok',
    drift: false,
    messages: [],
  };

  const aheadOfTag = version && version !== latestTagVersion;

  if (aheadOfTag) {
    // package.json moved past the latest tag — a release should be staged.
    if (!verSection.present) {
      result.drift = true;
      result.state = 'untagged-release';
      result.messages.push(`package.json is ${version} (ahead of latest tag ${latestTag || 'none'}) but CHANGELOG has no "## v${version}" section. Add the release section before tagging, or revert the version bump.`);
    } else if (!verSection.dated) {
      result.state = 'prep';
      result.messages.push(`v${version} section exists but is still marked Unreleased — finalize its date when ready to tag.`);
    } else {
      result.state = 'ready-to-tag';
      result.messages.push(`v${version} is finalized in CHANGELOG and ahead of latest tag ${latestTag || 'none'} — ready to "git tag v${version}".`);
    }
  } else {
    // package.json matches the latest tag — we are post-release; pending work
    // must be tracked under [Unreleased].
    if (commitsSinceTag && commitsSinceTag > 0 && !(unreleased.present && unreleased.nonEmpty)) {
      result.drift = true;
      result.state = 'unlogged-work';
      result.messages.push(`${commitsSinceTag} commit(s) since ${latestTag} but the CHANGELOG "## [Unreleased]" section is ${unreleased.present ? 'empty' : 'missing'}. Record pending user-facing work there.`);
    } else {
      result.state = 'ok';
      result.messages.push(commitsSinceTag ? `${commitsSinceTag} commit(s) since ${latestTag}; tracked under [Unreleased].` : `In sync with ${latestTag || 'no tag yet'}.`);
    }
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const m of result.messages) console.log(`[unreleased-drift] ${m}`);
    console.log(result.drift ? `[unreleased-drift] DRIFT (${result.state})` : `[unreleased-drift] OK (${result.state})`);
  }

  process.exit(result.drift ? 1 : 0);
}

if (require.main === module) main();

module.exports = { semverTags, changelogVersionSection, unreleasedSection };
