# Context Pruning Spec (D5)

**Defect:** `D5` — Context pruning rules need to be documented as a first-class jarvos-memory concern.

**Status:** Spec complete. Current config is `cache-ttl` mode (active since SUP-324).

---

## Purpose

Context pruning reduces context window bloat by removing stale, large tool outputs before
they accelerate compaction. It is distinct from memory flush — pruning *discards* context;
flush *promotes* durable context into memory.

---

## Current implementation

Config (`agents.defaults.contextPruning`):
```yaml
contextPruning:
  mode: cache-ttl
  ttl: 2h
  keepLastAssistants: 10
  minPrunableToolChars: 2000
```

This is the baseline. The spec below documents the rules these values encode.

---

## Pruning rules

### What gets pruned

**Stale tool outputs** — tool call results that are:
1. Older than the TTL (`2h` currently)
2. Larger than `minPrunableToolChars` (`2000` chars / ~2KB currently)

These are the dominant source of context bloat. Large file reads, search results, and
audit outputs are valuable when first retrieved but become dead weight after the relevant
conversation has moved on.

### When pruning fires

Pruning runs on a **TTL-based pass** before each context evaluation. Any tool output
matching both conditions (age ≥ TTL AND size ≥ minPrunableToolChars) is eligible for
pruning.

Pruning is **not** triggered by a specific event — it is a continuous background cleanup
applied to the rolling context window.

### What is protected (never pruned)

| Protected item | Reason |
|---|---|
| Recent assistant messages (last `keepLastAssistants: 10`) | Active reasoning chain; pruning breaks coherence |
| Tool outputs younger than TTL | Still potentially relevant |
| Tool outputs smaller than `minPrunableToolChars` | Low-cost; not worth the risk of pruning needed context |
| Active conversation turns | Current exchange must never be pruned mid-session |
| Memory surfaces (`MEMORY.md`, `memory/decisions/`, etc.) | These are injected as workspace context, not tool outputs |

---

## Tuning guidance

| Parameter | Default | Lower → | Higher → |
|---|---|---|---|
| `ttl` | `2h` | Prunes more aggressively (less context bloat, more re-fetch risk) | Retains longer (more bloat, fewer re-fetches) |
| `minPrunableToolChars` | `2000` | Prunes smaller outputs too (more aggressive) | Only prunes very large outputs (conservative) |
| `keepLastAssistants` | `10` | Tighter protection window | Wider protection window |

**Recommended baseline:** keep these defaults unless context pressure is observed. The
current values were tuned after observing premature compaction caused by large file reads.

---

## Relationship to compaction

Pruning is the first line of defense. Compaction fires when pruning alone is not enough to
keep the context window below the threshold.

Expected flow:
```
Active conversation
  → context grows with tool outputs
  → pruning removes stale large outputs (continuous)
  → context stabilizes
  → if context still grows past threshold: compaction fires
  → compaction: memoryFlush runs first, then context is summarized
```

---

## References

- `memory/decisions/2026-03-25-compaction-tuning.md` — original pruning config decision (SUP-324)
- `FLUSH_TIMING.md` — flush trigger spec (D3)
- `COMPACTION_SURVIVAL.md` — what survives compaction (D6)
- SUP-359, SUP-360
