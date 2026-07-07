# Maintenance Hygiene

Three patterns every OpenClaw deployment should have from day one. They keep the system cheap, responsive, and inspectable without turning local machine inventory into shared project data.

---

## Pattern 1: Session Pruning

### The problem

Every cron job run and every subagent spawn creates a session entry in `~/.openclaw/agents/main/sessions/sessions.json`. These entries are never automatically cleaned up. If you have 40 cron jobs running frequently, you'll accumulate hundreds of session entries per day. The file grows, gateway startup slows, and eventually you get warnings like:

> main sessions.json is 2.26 MB (threshold 2.00 MB)

At that point, things start getting flaky.

### The fix

Run `scripts/prune-cron-sessions.sh` on a schedule. It removes all completed cron sessions and subagent sessions older than 2 hours, keeping your main session and anything actively running.

**Setup:**
1. Copy `scripts/prune-cron-sessions.sh` into your workspace
2. Add the cron job from `templates/CRON-MAINTENANCE.template.md`
3. That's it — runs every 6 hours, uses a cheap model, stays quiet when there's nothing to prune

**What it keeps:**
- Your main session(s)
- Subagent sessions updated in the last 2 hours

**What it removes:**
- All cron session entries (they're ephemeral by nature)
- Stale subagent sessions

---

## Pattern 2: Cron Model Tiering

### The problem

When you create cron jobs, it's easy to default every one to your best model. After all, you want things to work well, right?

Here's what that actually looks like in practice:

- 40+ enabled cron jobs, all on `gpt-5.3-codex`
- Some jobs run every 5 minutes, others every 10-15 minutes
- By 8 AM: **200+ API calls** to an expensive model
- Result: rate limits, credit exhaustion, and jobs failing — before you've even opened your phone

The math is brutal. A monitoring job that runs every 5 minutes = 288 calls/day. If it's on a $0.01/call model instead of a $0.001/call model, you're burning 10x for no reason.

### The fix

**Tier your jobs by what they actually need:**

| What the job does | Model tier | Examples |
|---|---|---|
| Writes code, creates PRs, complex reasoning | Expensive (codex, opus) | `autonomous-work-loop`, `pr-autopilot` |
| Runs a script and reports output | Cheap (haiku, flash) | `calendar-reminders`, `session-prune`, `git-sync` |
| Checks a status and says "nothing to report" | Cheap or free | `rate-limit-watchdog`, `uncommitted-work-check` |

**Rule of thumb:** if the job's prompt is "run this script and tell me the output," it doesn't need a coding model. That's 90% of cron jobs.

### How to audit and fix

See `templates/CRON-MAINTENANCE.template.md` for:
- A one-liner to audit your current model distribution
- A bulk reassignment script

### Emergency: credits exhausted

If you've burned through credits on one provider, you can temporarily switch all cheap jobs to a free model:

```
openrouter/meta-llama/llama-3.3-70b-instruct:free
```

It's good enough for script-running jobs and costs nothing. Switch back to haiku/flash once credits are topped up.

---

## Pattern 3: On-Demand Exposure Scanning

### The problem

Local OpenClaw profiles accumulate real software exposure: package managers, browser extensions, editor extensions, MCP servers, CLIs, lockfiles, and developer tools. A scanner can help spot known-risk inventory, but raw scanner output can also reveal hostnames, usernames, project paths, and technology inventory.

That makes exposure scanning useful for manual maintenance and risky for unattended reporting.

### The fix

Use exposure scanning as an on-demand, findings-only check until you have a wrapper that verifies the scanner, runs selftests, and redacts machine-specific fields before anything is posted to a tracker or briefing channel.

The current v0.4 local-openclaw candidate is Bumblebee, pinned to the pilot-tested release:

| Field | Value |
|---|---|
| Tool | `https://github.com/perplexityai/bumblebee` |
| Version | `v0.1.1` |
| Tag commit | `c24089804ee66ece4bec6f14638cb98985389cdb` |
| Darwin amd64 checksum | `dd3b2573a974a2786f58215483420fa11cf62b39ff4032693f1440575940dc25` |

**Manual check:**

```bash
shasum -a 256 -c checksums.txt --ignore-missing
./bumblebee version
./bumblebee selftest
./bumblebee scan \
  --profile deep \
  --root /path/to/workspace \
  --exposure-catalog /path/to/bumblebee/threat_intel \
  --findings-only \
  --max-duration 2m \
  --output file \
  --output-file /tmp/jarvos-bumblebee-findings.ndjson
```

Keep the NDJSON under a local temp/private artifact path. Do not paste raw records into issues, chat, email, or recurring briefs.

**Safe summary fields:**

- scanner version and verified checksum
- scan profile
- redacted root labels, such as `workspace` or `local-openclaw-profile`
- finding count
- diagnostic count and diagnostic categories after path redaction
- the maintenance recommendation

**Fields to redact before sharing:**

- hostnames, usernames, user ids, and endpoint records
- full project paths, source files, and scan roots
- full package inventory

### Automation gate

Do not wire exposure scanning into cron, `openclaw-security-maintenance`, Paperclip comments, or briefing queues until a wrapper exists that:

1. Verifies the pinned release checksum.
2. Runs `bumblebee selftest` before the first scan after install or upgrade.
3. Uses explicit roots and `deep --findings-only`.
4. Writes raw output only to local/private storage.
5. Parses summary and finding records.
6. Redacts endpoint, source file, project path, and roots fields.
7. Fails closed on checksum mismatch, scan errors, missing summary records, or unexpected schema.

---

## Pattern 4: GBrain Provider Watch Surface

### The problem

When multiple AI tools share memory through GBrain, silent drift is easy:

- the source checkout and installed executable can be different versions;
- Codex may be connected while Claude Code is not;
- advisor/status can degrade without breaking ordinary chat;
- skillpack reference drift can tempt an agent to overwrite local skills without
  a review issue.

### The fix

Treat GBrain as a watched provider in jarvOS, not as a hidden dependency. During
rollout, run the checks noisily enough that stale or missing state is obvious:

```bash
gbrain --version
gbrain status --fast --json
gbrain advisor --json
jarvos doctor --profile local-openclaw --workspace /path/to/workspace --json
```

The watch report should name:

- installed GBrain version and minimum expected version;
- `status --fast` availability and high-level counts;
- advisor worst severity and whether user action is requested;
- runtime connection state for Codex, Claude Code, OpenClaw, and Hermes;
- skillpack reference drift as an action, not an overwrite;
- whether `jarvos-secondbrain` capture remains healthy.

### Rollout posture

Start noisy: record one plain-English Paperclip status per day while the rollout
is active. Quiet down only after three consecutive checks show:

- GBrain is at the expected version or newer;
- `status --fast` and advisor both return structured output;
- runtime connection states are known;
- `jarvos-secondbrain` status has no capture-contract failures;
- no SkillOpt run is pending without reviewed benchmarks and cost limits.

After that, switch to failure-only Paperclip updates plus release/check evidence.
If any check fails, the issue comment should include the smallest next action and
the owner lane. Do not post raw tokens, MCP bearer credentials, or full provider
config.

---

## Quick Health Check

Run these periodically (or add them to your morning routine):

```bash
# Session file size
du -h ~/.openclaw/agents/main/sessions/sessions.json

# Cron model distribution (are you overspending?)
node -e "const d=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.openclaw/cron/jobs.json','utf8'));const m={};for(const j of(d.jobs||d)){if(j.enabled===false)continue;const k=j.payload?.model||'DEFAULT';m[k]=(m[k]||0)+1}Object.entries(m).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(v+' jobs on '+k))"

# Recent cron errors
grep -r "error\|failed\|429\|rate.limit" ~/.openclaw/cron/runs/*.jsonl 2>/dev/null | tail -10
```

---

*These patterns saved us from burning $50+/day in API credits and eliminated recurring gateway slowdowns. Set them up once, forget about them.*
