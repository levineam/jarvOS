#!/usr/bin/env bash
# smoke-test.sh — jarvOS repo structure validation
#
# Run from the repo root:
#   bash scripts/smoke-test.sh
#
# Checks that the expected directories and files exist.
# Exit code: 0 = all pass, 1 = one or more failures.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
FAILURES=()

check() {
  local label="$1"
  local path="$REPO_ROOT/$2"
  if [ -e "$path" ]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label  (missing: $2)"
    FAIL=$((FAIL + 1))
    FAILURES+=("$label")
  fi
}

echo ""
echo "jarvOS smoke test — $(date)"
echo "Repo: $REPO_ROOT"
echo ""

echo "── Core behavioral layer ─────────────────────────────────"
check "core/AGENTS.md"        "core/AGENTS.md"
check "core/SOUL.md"          "core/SOUL.md"
check "core/IDENTITY.md"      "core/IDENTITY.md"

echo ""
echo "── Templates ────────────────────────────────────────────"
check "templates/AGENTS-template.md"          "templates/AGENTS-template.md"
check "templates/BOOTSTRAP-template.md"       "templates/BOOTSTRAP-template.md"
check "templates/HEARTBEAT-template.md"       "templates/HEARTBEAT-template.md"

echo ""
echo "── Runtimes ────────────────────────────────────────────"
check "runtimes/openclaw/"    "runtimes/openclaw"
check "runtimes/hermes/"      "runtimes/hermes"

echo ""
echo "── Module: jarvos-memory ────────────────────────────────"
check "modules/jarvos-memory/README.md"              "modules/jarvos-memory/README.md"
check "modules/jarvos-memory/package.json"           "modules/jarvos-memory/package.json"
check "modules/jarvos-memory/index.js"               "modules/jarvos-memory/index.js"
check "modules/jarvos-memory/lib/memory-schema.js"   "modules/jarvos-memory/lib/memory-schema.js"
check "modules/jarvos-memory/lib/audit-memory.js"    "modules/jarvos-memory/lib/audit-memory.js"
check "modules/jarvos-memory/scripts/audit-memory.js" "modules/jarvos-memory/scripts/audit-memory.js"

echo ""
echo "── Module: jarvos-ontology ──────────────────────────────"
check "modules/jarvos-ontology/README.md"              "modules/jarvos-ontology/README.md"
check "modules/jarvos-ontology/package.json"           "modules/jarvos-ontology/package.json"
check "modules/jarvos-ontology/src/index.js"           "modules/jarvos-ontology/src/index.js"
check "modules/jarvos-ontology/src/validator.js"       "modules/jarvos-ontology/src/validator.js"
check "modules/jarvos-ontology/src/reader.js"          "modules/jarvos-ontology/src/reader.js"
check "modules/jarvos-ontology/schema/templates/"      "modules/jarvos-ontology/schema/templates"
check "modules/jarvos-ontology/scripts/validate.js"    "modules/jarvos-ontology/scripts/validate.js"

echo ""
echo "── Module: jarvos-secondbrain ───────────────────────────"
check "modules/jarvos-secondbrain/README.md"                          "modules/jarvos-secondbrain/README.md"
check "modules/jarvos-secondbrain/package.json"                       "modules/jarvos-secondbrain/package.json"
check "modules/jarvos-secondbrain/jarvos.config.example.json"         "modules/jarvos-secondbrain/jarvos.config.example.json"
check "modules/jarvos-secondbrain/bridge/config/jarvos-paths.js"      "modules/jarvos-secondbrain/bridge/config/jarvos-paths.js"
check "modules/jarvos-secondbrain/bridge/routing/src/keyword-capture-router.js" \
      "modules/jarvos-secondbrain/bridge/routing/src/keyword-capture-router.js"
check "modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/package.json" \
      "modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/package.json"
check "modules/jarvos-secondbrain/packages/jarvos-secondbrain-notes/package.json" \
      "modules/jarvos-secondbrain/packages/jarvos-secondbrain-notes/package.json"

echo ""
echo "── Docs and governance ──────────────────────────────────"
check "modules/README.md"     "modules/README.md"
check "PUBLIC_BASELINE.md"    "PUBLIC_BASELINE.md"
check "README.md"             "README.md"

echo ""
echo "── Privacy scan (no hardcoded user paths) ───────────────"
PRIVATE_HITS=$(grep -r "/Users/andrew/" "$REPO_ROOT/modules/" 2>/dev/null | grep -v "Binary file" || true)
if [ -z "$PRIVATE_HITS" ]; then
  echo "  ✓ No /Users/andrew/ paths found in modules/"
  PASS=$((PASS + 1))
else
  echo "  ✗ Private paths found in modules/:"
  echo "$PRIVATE_HITS" | head -10
  FAIL=$((FAIL + 1))
  FAILURES+=("Privacy: /Users/andrew/ found in modules/")
fi

echo ""
echo "─────────────────────────────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "Failures:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo ""
echo "All checks passed. ✓"
exit 0
