name: spawn-code-subagent
description: Code quality gate for spawning code subagents. Enforces branch-first, PR-required, test-pass, and review-before-merge discipline.
version: 1.0.0

# ─── INPUTS ────────────────────────────────────────────────────────────────────

inputs:
  task:
    type: string
    description: Description of the coding task
    required: true
  repo:
    type: string
    description: Path to the repository
    required: true
  branch:
    type: string
    description: Feature branch name (auto-generated from task if not provided)
    required: false
  model:
    type: string
    description: Model to use for the subagent (required — no defaults)
    required: true
  scope_estimate:
    type: string
    description: "Rough scope: small (1-3 files) | medium (4-10 files) | large (10+ files)"
    default: small
  tests_required:
    type: boolean
    description: Whether tests must pass before PR creation
    default: true
  test_command:
    type: string
    description: "Command to run tests (default: npm test)"
    default: "npm test"

# ─── STEPS ─────────────────────────────────────────────────────────────────────

steps:

  - id: validate_inputs
    description: Check required fields are present
    action: script
    script: |
      # Read model via single-quoted heredoc so template-interpolated content is
      # treated as literal data — no shell expansion of $VAR, $(cmd), or backticks.
      MODEL_INPUT=$(cat << 'MODEL_INPUT_EOF_2a7d9c4b'
{{inputs.model}}
MODEL_INPUT_EOF_2a7d9c4b
)
      if [ -z "$MODEL_INPUT" ]; then
        echo "ERROR: model parameter is required. No defaults. Set explicitly."
        exit 1
      fi
      # Read task via single-quoted heredoc so template-interpolated content is
      # treated as literal data — no shell expansion of $VAR, $(cmd), or backticks.
      TASK_CHECK=$(cat << 'TASK_CHECK_EOF_9f2b4c7a'
{{inputs.task}}
TASK_CHECK_EOF_9f2b4c7a
)
      if [ -z "$TASK_CHECK" ]; then
        echo "ERROR: task description is required."
        exit 1
      fi
      echo "Validation passed"

  - id: generate_branch_name
    description: Generate branch name from task if not provided
    action: script
    script: |
      # Read custom branch via single-quoted heredoc so template-interpolated
      # content is treated as literal data — no shell expansion of $VAR, $(cmd),
      # or backtick sequences the branch input might contain.
      BRANCH_INPUT=$(cat << 'BRANCH_INPUT_EOF_6f3c1e8d'
{{inputs.branch}}
BRANCH_INPUT_EOF_6f3c1e8d
)
      if [ -n "$BRANCH_INPUT" ]; then
        echo "$BRANCH_INPUT"
      else
        # Read task into a variable via a single-quoted heredoc so the template-
        # interpolated value is treated as literal data (no shell expansion of
        # any $VAR, $(cmd), or backtick sequences the task text might contain).
        TASK_CONTENT=$(cat << 'TASK_CONTENT_EOF_3b8d2f1a'
{{inputs.task}}
TASK_CONTENT_EOF_3b8d2f1a
)
        # Slugify: lowercase, replace non-alphanumeric with hyphens, collapse
        # consecutive hyphens, strip leading/trailing hyphens, truncate to 50.
        SLUG=$(printf '%s' "$TASK_CONTENT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-*//' | cut -c1-50 | sed 's/-*$//')
        # If slug is empty after sanitization, use a safe default
        if [ -z "$SLUG" ]; then
          SLUG="untitled-task"
        fi
        echo "$SLUG"
      fi
    output: branch_name

  - id: build_spawn_task
    description: Build the full task description with all required quality gates injected
    action: template
    template: |
      ## Task
      {{inputs.task}}

      ## Repository
      {{inputs.repo}}

      ## Required Process (HARD — do not skip any step)

      1. **Create feature branch first:**
         ```bash
         cd {{inputs.repo}}
         git checkout main && git pull origin main
         git checkout -b {{steps.generate_branch_name.branch_name}}
         ```

      2. **Implement the changes** on the feature branch only. Never commit to main.

      3. **One feature per PR** — if you discover an unrelated issue, create a separate branch/PR.

      {{#if inputs.tests_required}}
      4. **Run tests before creating PR:**
         ```bash
         {{inputs.test_command}}
         ```
         If tests fail, fix them before proceeding. Do not create a PR with failing tests.
      {{/if}}

      5. **Create a PR:**
         ```bash
         gh pr create --title "[brief description]" --body "[what changed and why]"
         ```

      6. **Wait for review.** If Codex or CodeRabbit leave P1/P2 comments, fix them immediately.
         - P1/P2 = blocking issues that must be fixed before merge
         - P3 = suggestions (fix if easy, note if not)
         - Do NOT merge with open P1/P2 issues

      7. **Fix ALL P1/P2 comments**, push fixes, let reviews re-run.

      8. **Merge only when:** CI is green AND all P1/P2 issues are resolved.

      ## Blockers
      If you hit a decision that requires the owner's input, write it to `memory/briefing-queue.md` under `🧭 INPUT` using the escalation format:
      ```
      **Blocked:** [what's stuck]
      **Why now:** [why this matters]
      **Options:** A) ... B) ... C) ...
      **Recommended:** [which option and why]
      **Default if no response by [time]:** [what I'll do]
      ```

      ## Proof of Work
      When complete, report:
      - Branch name
      - PR URL
      - Summary of changes made
      - Test results
      - Any open questions for review
    output: full_task

  - id: log_spawn
    description: Log the spawn to today's memory
    action: script
    script: |
      DATE=$(date +%Y-%m-%d)
      TIME=$(date +%H:%M)
      # Resolve workspace path; create $HOME/clawd if neither is set nor exists
      WS_PATH="${WORKSPACE_PATH:-$HOME/clawd}"
      mkdir -p "$WS_PATH"
      MEMORY_DIR="$WS_PATH/memory"
      mkdir -p "$MEMORY_DIR"
      # Read task via single-quoted heredoc to prevent shell expansion, then
      # sanitize for markdown safety: collapse newlines, escape backticks.
      TASK_RAW=$(cat << 'TASK_RAW_EOF_5c9a1d3e'
{{inputs.task}}
TASK_RAW_EOF_5c9a1d3e
)
      TASK_SAFE=$(printf '%s' "$TASK_RAW" | tr '\n' ' ' | sed 's/`/\\`/g')
      printf '\n' >> "$MEMORY_DIR/$DATE.md"
      printf '## [%s] Code subagent spawned\n' "$TIME" >> "$MEMORY_DIR/$DATE.md"
      printf '- Task: %s\n' "$TASK_SAFE" >> "$MEMORY_DIR/$DATE.md"
      printf '- Branch: %s\n' "{{steps.generate_branch_name.branch_name}}" >> "$MEMORY_DIR/$DATE.md"
      printf '- Model: %s\n' "{{inputs.model}}" >> "$MEMORY_DIR/$DATE.md"
      echo "Logged spawn to memory"

  - id: spawn_agent
    description: Spawn the code subagent with quality gates injected
    action: spawn_subagent
    task: "{{steps.build_spawn_task.full_task}}"
    model: "{{inputs.model}}"

# ─── OUTPUT ────────────────────────────────────────────────────────────────────

output:
  branch: "{{steps.generate_branch_name.branch_name}}"
  task_injected: "{{steps.build_spawn_task.full_task}}"
  agent_session: "{{steps.spawn_agent.session_id}}"
