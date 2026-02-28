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

  - id: load_draft
    description: Load draft from path or inline input
    action: script
    script: |
      if [ -n "{{inputs.draftPath}}" ]; then
        cat "{{inputs.draftPath}}"
      else
        echo "{{inputs.draft}}"
      fi
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
      mkdir -p "$(dirname '{{inputs.outputPath}}')"
      cat > "{{inputs.outputPath}}" << 'DRAFT_EOF'
      {{steps.load_draft.draft_text}}
      DRAFT_EOF
      echo "Saved to {{inputs.outputPath}}"

# ─── OUTPUT ────────────────────────────────────────────────────────────────────

output:
  score: "{{steps.humanizer_check.humanizer_result.score}}"
  verdict: "{{steps.humanizer_check.humanizer_result.verdict}}"
  approved: "{{steps.approval_request.approved}}"
  saved_to: "{{inputs.outputPath}}"
