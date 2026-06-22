# Source Material Provenance Contract

Source Material markdown represents external material that may enter QMD, GBrain, or another knowledge base. It must preserve source provenance separately from the canonical Notes `author` field.

## Required Frontmatter

```yaml
---
authorship: external
source_type: paper
authors:
  - "Original Author"
original_file: "paper.pdf"
original_url: "https://example.com/paper"
importer: jarvis
---
```

Required fields:

- `authorship`: who owns the original source material. Use `external`, `mixed`, `andrew`, or `jarvis`.
- `source_type`: the source class, such as `paper`, `article`, `book`, `web`, `x-post`, `video`, `transcript`, `dataset`, or `other`.
- `authors`: the original source author(s). For `external` or `mixed`, this must not be only Andrew/Jarvis.
- `original_file` or `original_url`: at least one stable pointer to the original material.
- `importer`: who or what imported the material into the vault.

## Principle

Use `author` for authored durable Notes. Use `authors` plus `authorship` for external Source Material. This keeps retrieval and audits from confusing "who wrote this note file" with "who created the source being indexed."

## Audit

Run:

```bash
node scripts/lint-source-material.js --json
```

The daily jarvOS memory audit surfaces Source Material provenance drift as its own check, separate from memory-wiki and Notes frontmatter health.
