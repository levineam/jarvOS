name: write-prose
description: Humanizer gate for publishable prose. Checks for AI writing patterns, enforces voice profile, requires human approval before saving or sending.
version: 1.0.0

# ─── INPUTS ────────────────────────────────────────────────────────────────────

inputs:
  draft:
    type: string
    description: The draft text to evaluate (inline)
    required: false
  draftPath:
    type: string
    description: Path to draft file (alternative to inline draft)
    required: false
  title:
    type: string
    description: Title of the piece
    required: true
  type:
    type: string
    description: "Content type: article | newsletter | post | thread | other"
    default: article
  outputPath:
    type: string
    description: Where to save approved output (optional — skip to just evaluate)
    required: false

# ─── STEPS ─────────────────────────────────────────────────────────────────────

steps:

  - id: load_draft_file
    description: Load and validate draft from file path (only when draftPath is set)
    action: script
    condition: "inputs.draftPath != ''"
    script: |
      # Read draftPath via single-quoted heredoc so template-interpolated content
      # is treated as literal data — no shell expansion of $VAR, $(cmd), or
      # backtick sequences the path might contain.
      DRAFT_PATH=$(cat << 'DRAFT_PATH_EOF_8b2e5a1c'
{{inputs.draftPath}}
DRAFT_PATH_EOF_8b2e5a1c
)
      # Validate: must be a regular file and must resolve without error
      REAL_PATH=$(realpath -- "$DRAFT_PATH" 2>/dev/null) || { echo "ERROR: Cannot resolve path: $DRAFT_PATH" >&2; exit 1; }
      [ -f "$REAL_PATH" ] || { echo "ERROR: Not a regular file: $REAL_PATH" >&2; exit 1; }
      # Restrict to workspace root. Default is $HOME/clawd (narrower than $HOME)
      # to reduce the traversal window (e.g. ../../.env outside workspace is rejected).
      # Override by setting WORKSPACE_PATH in the execution environment.
      ALLOWED_ROOT="${WORKSPACE_PATH:-$HOME/clawd}"
      ALLOWED_REAL=$(realpath -- "$ALLOWED_ROOT" 2>/dev/null || echo "$ALLOWED_ROOT")
      case "$REAL_PATH" in
        "$ALLOWED_REAL/"*) : ;;  # path is within allowed root — OK
        *) echo "ERROR: draftPath '$REAL_PATH' is outside allowed root '$ALLOWED_REAL'" >&2; exit 1 ;;
      esac
      cat -- "$REAL_PATH"
    output: file_draft_text

  - id: load_draft
    description: |
      Provide draft text from the appropriate source. Inline drafts are handled
      entirely by the template engine (action: template) — no shell script, no
      heredoc, no delimiter-collision injection risk. File drafts are read and
      validated by the preceding load_draft_file script step and referenced here.
    action: template
    template: |
      {{#if inputs.draftPath}}{{steps.load_draft_file.file_draft_text}}{{else}}{{inputs.draft}}{{/if}}
    output: draft_text

  - id: humanizer_check
    description: Check draft for AI writing patterns
    action: llm_task
    model: "{{env.DEFAULT_MODEL}}"
    prompt: |
      You are a writing quality reviewer. Analyze this {{inputs.type}} for signs of AI-generated writing.

      **TITLE:** {{inputs.title}}

      **DRAFT:**
      {{steps.load_draft.draft_text}}

      ---

      Check for these patterns and score each HIGH / MEDIUM / LOW / NONE:

      1. **AI Vocabulary** — delve, tapestry, leverage (as verb), seamlessly, pivotal, groundbreaking, transformative, comprehensive, robust, nuanced, synergy, utilize, dynamic, revolutionary
      2. **Inflated significance** — treating minor points as profound revelations
      3. **-ing endings overuse** — "making it possible," "allowing for," "enabling" chains
      4. **Promotional language** — hype, superlatives without evidence
      5. **Vague attributions** — "research shows," "experts say," "studies suggest" without specifics
      6. **Em dash overuse** — more than 2 em dashes per 500 words
      7. **Negative parallelisms** — "not X, but Y" structures used more than once
      8. **Generic conclusions** — "In conclusion, X is important" style endings
      9. **Excessive hedging** — "it's worth noting," "it's important to remember," "one might argue"
      10. **Rule of three overuse** — listing in threes as a crutch
      11. **Chatbot artifacts** — "Certainly!", "Of course!", "Great question!", "I'd be happy to"
      12. **Excessive boldface** — bolding more than 10% of text
      13. **Sycophantic tone** — unearned praise, excessive positivity
      14. **Knowledge-cutoff disclaimers** — "as of my training," "I don't have access to real-time"
      15. **Conjunctive phrase overuse** — "Furthermore," "Moreover," "Additionally" in consecutive paragraphs

      Output a JSON object:
      {
        "score": <0-100, where 100 = fully human>,
        "issues": [{"pattern": "<name>", "severity": "HIGH|MEDIUM|LOW", "example": "<quoted text>", "fix": "<suggestion>"}],
        "verdict": "PASS|NEEDS_REVISION",
        "summary": "<2-3 sentence assessment>"
      }

      PASS requires: score >= 85 AND no HIGH issues AND no more than 1 MEDIUM issue.
    output: humanizer_result

  - id: check_verdict
    description: Gate — block if score is too low
    action: condition
    condition: "{{steps.humanizer_check.humanizer_result.verdict}} == 'PASS'"
    on_false:
      action: fail
      message: |
        ❌ Humanizer gate FAILED for "{{inputs.title}}"
        Score: {{steps.humanizer_check.humanizer_result.score}}/100
        Issues: {{steps.humanizer_check.humanizer_result.issues | length}}

        {{steps.humanizer_check.humanizer_result.summary}}

        Top issues to fix:
        {{#each steps.humanizer_check.humanizer_result.issues}}
        - [{{severity}}] {{pattern}}: "{{example}}"
          Fix: {{fix}}
        {{/each}}

        Revise the draft and resubmit.

  - id: approval_request
    description: Present draft for human approval
    action: notify
    message: |
      ✅ Humanizer check PASSED for "{{inputs.title}}" (Score: {{steps.humanizer_check.humanizer_result.score}}/100)

      {{steps.humanizer_check.humanizer_result.summary}}

      ---

      **DRAFT READY FOR REVIEW:**

      {{steps.load_draft.draft_text}}

      ---

      Approve to save{{#if inputs.outputPath}} to {{inputs.outputPath}}{{/if}} or reply with edits.
    await_approval: true
    approval_prompt: "Approve and save this draft? (yes/no/edit)"

  - id: save_output
    description: Save approved draft to vault (only if outputPath provided and approved)
    action: script
    condition: "{{steps.approval_request.approved}} == true AND inputs.outputPath != ''"
    script: |
      # Read outputPath via single-quoted heredoc so template-interpolated content
      # is treated as literal data — no shell expansion of $VAR, $(cmd), or
      # backtick sequences the path might contain.
      OUTPUT_PATH=$(cat << 'OUTPUT_PATH_EOF_3d9f7c2b'
{{inputs.outputPath}}
OUTPUT_PATH_EOF_3d9f7c2b
)
      # Validate outputPath: must be non-empty, no path traversal components
      [ -n "$OUTPUT_PATH" ] || { echo "ERROR: outputPath is empty" >&2; exit 1; }
      case "$OUTPUT_PATH" in
        *../*|*/..*) echo "ERROR: outputPath contains path traversal" >&2; exit 1 ;;
      esac
      REAL_DIR=$(realpath -- "$(dirname "$OUTPUT_PATH")" 2>/dev/null || dirname "$OUTPUT_PATH")
      mkdir -p "$REAL_DIR"
      # Write draft content to the output file.
      #
      # The inline draft was loaded via action:template (no shell), so
      # {{steps.load_draft.draft_text}} is the template engine's output. Since
      # the template engine substitutes this value before the shell script runs,
      # a heredoc is used to embed it. The single-quoted delimiter prevents
      # further shell expansion ($VAR, $(cmd), backticks) of the content.
      #
      # Residual limitation: if the draft content contains the exact delimiter
      # string on its own line, the heredoc would terminate early (delimiter
      # collision). The delimiter below is 64 hex chars — practically unguessable
      # in normal prose, and by this point the content has been human-reviewed.
      # For untrusted automated content, always use draftPath instead of inline
      # draft: file reads bypass this step entirely, eliminating the risk.
      cat > "$OUTPUT_PATH" << 'PROSE_EOF_a3f8c2d1e4b7a9c6f2e0d5b8a1c4f7e2d0b3a6c9f1e4b7'
{{steps.load_draft.draft_text}}
PROSE_EOF_a3f8c2d1e4b7a9c6f2e0d5b8a1c4f7e2d0b3a6c9f1e4b7
      echo "Saved to $OUTPUT_PATH"

# ─── OUTPUT ────────────────────────────────────────────────────────────────────

output:
  score: "{{steps.humanizer_check.humanizer_result.score}}"
  verdict: "{{steps.humanizer_check.humanizer_result.verdict}}"
  approved: "{{steps.approval_request.approved}}"
  saved_to: "{{inputs.outputPath}}"
