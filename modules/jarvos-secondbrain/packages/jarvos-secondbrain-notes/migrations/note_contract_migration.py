#!/usr/bin/env python3
"""Safe migrator for the canonical jarvOS note contract.

Goals:
- Audit all Notes/*.md files against the canonical frontmatter schema.
- Classify notes into:
  - compliant: already valid
  - straightforward: safe to backfill automatically
  - review: needs manual categorization / ambiguous inference
- Apply only straightforward fixes.
- Keep a reversible trail with backups + unified diff + JSON/Markdown reports.

Canonical required fields:
  status, type, project, created, updated, author
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import difflib
import json
import os
import re
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REQ_KEYS = ["status", "type", "project", "created", "updated", "author"]
ALLOWED_STATUS = {"active", "draft", "archived", "abandoned"}
ALLOWED_TYPE = {"project-note", "draft", "research", "decision", "reference", "article", "chapter"}
ALLOWED_AUTHOR = {"jarvis", "andrew", "both"}
DATE_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")
KEY_RE = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")

STATUS_MAP = {
    "draft": "draft",
    "pending": "draft",
    "planning": "draft",
    "planned": "draft",
    "paused": "draft",
    "someday": "draft",
    "stub": "draft",
    "proposed": "draft",
    "testing": "draft",
    "raw": "draft",
    "rough": "draft",
    "rough-capture": "draft",
    "ready-for-review": "draft",
    "draft — awaiting andrew approval": "draft",
    "active": "active",
    "current": "active",
    "inprogress": "active",
    "in-progress": "active",
    "published": "active",
    "shipped": "active",
    "reference": "active",
    "research": "active",
    "archived": "archived",
    "archive": "archived",
    "superseded": "archived",
    "completed": "archived",
    "complete": "archived",
    "merged": "archived",
    "final": "archived",
    "shelved": "archived",
    "abandoned": "abandoned",
    "canceled": "abandoned",
    "cancelled": "abandoned",
}

TYPE_MAP = {
    "project note": "project-note",
    "projectnote": "project-note",
    "project management": "project-note",
    "execution plan": "project-note",
    "event planning": "project-note",
    "website strategy": "project-note",
    "live-plan": "project-note",
    "project-board": "project-note",
    "project-brief": "project-note",
    "project plan": "project-note",
    "plan": "project-note",
    "brief": "project-note",
    "spec": "project-note",
    "working-note": "project-note",
    "implementation-log": "project-note",
    "decision document": "decision",
    "postmortem": "decision",
    "research project": "research",
    "research-note": "research",
    "research analysis": "research",
    "investment research": "research",
    "analysis": "research",
    "audit-report": "research",
    "report": "research",
    "feasibility study": "research",
    "technical evaluation": "research",
    "strategy": "research",
    "persona": "research",
    "chad-output": "article",
    "newsletter": "article",
    "x post": "article",
    "x-post-draft": "article",
    "content-draft": "article",
    "content-plan": "article",
    "outreach-draft": "article",
    "article/thread": "article",
    "checklist": "reference",
    "template": "reference",
    "implementation": "reference",
    "technical setup": "reference",
    "security": "reference",
    "customer deployment": "reference",
    "strategy document": "reference",
    "note": "reference",
    "architecture": "reference",
    "operating-contract": "reference",
    "chapter": "chapter",
}

AUTHOR_MAP = {
    "jarvis": "jarvis",
    "andrew": "andrew",
    "both": "both",
    "assistant": "jarvis",
    "chatgpt": "jarvis",
    "codex": "jarvis",
    "ai": "jarvis",
    "michael": "jarvis",
    "chad": "jarvis",
    "amelia": "jarvis",
    "steve": "jarvis",
    "andrew levine": "andrew",
    "coauthored": "both",
    "co-authored": "both",
    "collaborative": "both",
}

CONFIDENCE_ORDER = {"low": 0, "medium": 1, "high": 2}


def utc_stamp() -> str:
    return dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")


def to_local_date(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def strip_quotes(value: str) -> str:
    value = str(value or "").strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1].strip()
    return value


def normalize_key(value: str) -> str:
    return (
        str(value or "")
        .strip()
        .lower()
        .replace("_", " ")
        .replace("/", " ")
        .replace("  ", " ")
    )


def is_valid_date(value: str) -> bool:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(value or ""))
    if not m:
        return False
    y, mo, d = map(int, m.groups())
    try:
        return dt.date(y, mo, d).isoformat() == value
    except ValueError:
        return False


def normalize_date(value: str) -> Optional[str]:
    raw = strip_quotes(value)
    if not raw:
        return None
    if is_valid_date(raw):
        return raw
    m = re.match(r"^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$", raw)
    if m:
        candidate = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        return candidate if is_valid_date(candidate) else None
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", raw)
    if m:
        candidate = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        return candidate if is_valid_date(candidate) else None
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed.date().isoformat()
    except ValueError:
        return None


def parse_frontmatter(text: str) -> Dict[str, object]:
    if not (text.startswith("---\n") or text.startswith("---\r\n")):
        return {"has_frontmatter": False, "malformed": False}
    m = re.match(r"^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)", text)
    if not m:
        return {"has_frontmatter": True, "malformed": True}
    raw = m.group(1)
    lines = raw.splitlines()
    fields: Dict[str, str] = {}
    line_index: Dict[str, int] = {}
    for idx, line in enumerate(lines):
        km = KEY_RE.match(line.strip())
        if km:
            key, value = km.group(1), km.group(2)
            if key not in line_index:
                line_index[key] = idx
            fields[key] = value
    return {
        "has_frontmatter": True,
        "malformed": False,
        "raw": raw,
        "lines": lines,
        "fields": fields,
        "line_index": line_index,
        "match_len": len(m.group(0)),
        "body": text[len(m.group(0)):],
        "eol": "\r\n" if "\r\n" in m.group(0) else "\n",
        "post_fence_newline": m.group(2) != "",
    }


def stringify_frontmatter(parsed: Dict[str, object], new_lines: List[str]) -> str:
    eol = parsed.get("eol", "\n")
    post = eol if parsed.get("post_fence_newline", True) else ""
    body = parsed.get("body", "")
    return f"---{eol}{eol.join(new_lines)}{eol}---{post}{body}"


def find_project_names(files: List[Path]) -> List[str]:
    names = set()
    pat = re.compile(r"^(.*?)(?:\s+[—-]\s+|\s+-\s+|\s+—\s+)?Project Board$", re.IGNORECASE)
    for f in files:
        m = pat.match(f.stem)
        if m and m.group(1).strip():
            names.add(m.group(1).strip())
    return sorted(names, key=lambda s: (-len(s), s.lower()))


def choose_confidence(*levels: str) -> str:
    return min(levels, key=lambda x: CONFIDENCE_ORDER[x])


def infer_author(content: str) -> Tuple[str, str, str]:
    lc = content.lower()
    if "edited by jarvis" in lc:
        return "both", "high", "explicit 'Edited by Jarvis' signature"
    if "written by jarvis" in lc or "drafted by jarvis" in lc:
        return "jarvis", "high", "explicit Jarvis signature"
    if re.search(r"\b(written|drafted|edited) by (chad|michael|steve|amelia)\b", lc):
        return "jarvis", "medium", "non-Andrew agent signature normalized to coarse author taxonomy"
    return "andrew", "medium", "default fallback when no agent signature is present"


def infer_status(stem: str, content: str) -> Tuple[str, str, str]:
    s = stem.lower()
    lc = content.lower()
    explicit = re.search(r"(?mi)^status\s*:\s*(active|draft|archived|abandoned)\b", content)
    if explicit:
        return explicit.group(1).lower(), "high", "explicit status marker found in note body"
    if re.search(r"\b(abandoned|cancelled|canceled)\b", s):
        return "abandoned", "high", "title indicates abandonment/cancellation"
    if re.search(r"\b(archived|archive|superseded)\b", s):
        return "archived", "high", "title indicates archive/superseded state"
    if re.search(r"\b(draft|wip|todo|in progress|planned|planning|pending)\b", s):
        return "draft", "high", "title indicates draft/in-progress state"
    if "- [ ]" in lc:
        return "draft", "medium", "unchecked task list suggests draft/working note"
    return "active", "low", "default fallback when no lifecycle signal is present"


def infer_type(stem: str, content: str, inferred_status: str, status_conf: str) -> Tuple[str, str, str]:
    s = stem.lower()
    lc = content.lower()
    title_plus_text = f"{s}\n{lc}"
    if any(token in s for token in ["project board", "project brief", "— plan", " - plan", " plan"]):
        return "project-note", "high", "title matches board/brief/plan project-note pattern"
    if "chapter" in s:
        return "chapter", "high", "title indicates chapter"
    if re.search(r"\b(research|analysis|market scan|literature review|lastxdays|audit)\b", title_plus_text):
        conf = "high" if re.search(r"\b(research|analysis|audit)\b", s) else "medium"
        return "research", conf, "research/analysis language detected"
    if "decision" in title_plus_text:
        conf = "high" if "decision" in s else "medium"
        return "decision", conf, "decision language detected"
    if re.search(r"\b(newsletter|blog|article|essay|x post|twitter thread|thread)\b", title_plus_text):
        conf = "high" if re.search(r"\b(newsletter|blog|article|essay)\b", s) else "medium"
        return "article", conf, "publishing/article language detected"
    if inferred_status == "draft" and status_conf in {"high", "medium"}:
        return "draft", "medium", "draft status safely maps to draft type"
    return "reference", "low", "default fallback when content category is ambiguous"


def infer_project(stem: str, project_names: List[str]) -> Tuple[str, str, str, List[str]]:
    board_match = re.match(r"^(.*?)(?:\s+[—-]\s+|\s+-\s+|\s+—\s+)?Project (?:Board|Brief)$", stem, re.IGNORECASE)
    if board_match and board_match.group(1).strip():
        value = board_match.group(1).strip()
        return value, "high", "project board/brief title yields exact project namespace", [value]

    prefix_matches = []
    for name in project_names:
        if stem == name or stem.startswith(name + " ") or stem.startswith(name + "-") or stem.startswith(name + "—"):
            prefix_matches.append(name)
    if len(prefix_matches) == 1:
        return prefix_matches[0], "high", "title prefix matches a single known project board namespace", prefix_matches
    if len(prefix_matches) > 1:
        return "", "low", "multiple project namespace matches; manual review required", prefix_matches
    return "", "medium", "explicit blank fallback when note does not match a project namespace", []


def infer_created(content: str, stat: os.stat_result) -> Tuple[str, str, str]:
    m = DATE_RE.search(content)
    if m:
        return m.group(1), "medium", "first YYYY-MM-DD found in note body"
    birth = getattr(stat, "st_birthtime", None)
    if birth:
        return to_local_date(birth), "medium", "filesystem birthtime fallback"
    return to_local_date(stat.st_ctime), "medium", "filesystem ctime fallback"


def infer_updated(stat: os.stat_result) -> Tuple[str, str, str]:
    return to_local_date(stat.st_mtime), "high", "filesystem mtime"


def normalize_existing(field: str, raw_value: str) -> Tuple[Optional[str], str]:
    current = strip_quotes(raw_value)
    lc = current.lower()
    nk = normalize_key(current)
    if field == "status":
        if lc in ALLOWED_STATUS:
            return lc, "high"
        if current in STATUS_MAP:
            return STATUS_MAP[current], "high"
        if lc in STATUS_MAP:
            return STATUS_MAP[lc], "high"
        if nk in STATUS_MAP:
            return STATUS_MAP[nk], "medium"
        return None, "low"
    if field == "type":
        if lc in ALLOWED_TYPE:
            return lc, "high"
        if current in TYPE_MAP:
            return TYPE_MAP[current], "high"
        if lc in TYPE_MAP:
            return TYPE_MAP[lc], "high"
        if nk in TYPE_MAP:
            return TYPE_MAP[nk], "medium"
        return None, "low"
    if field == "author":
        if lc in ALLOWED_AUTHOR:
            return lc, "high"
        if current in AUTHOR_MAP:
            return AUTHOR_MAP[current], "high"
        if lc in AUTHOR_MAP:
            return AUTHOR_MAP[lc], "high"
        if nk in AUTHOR_MAP:
            return AUTHOR_MAP[nk], "medium"
        return None, "low"
    if field in {"created", "updated"}:
        normalized = normalize_date(current)
        if normalized:
            conf = "high" if normalized == current else "medium"
            return normalized, conf
        return None, "low"
    if field == "project":
        return current, "high"
    return None, "low"


def format_line(key: str, value: str) -> str:
    if key == "project":
        return f'project: {json.dumps(str(value or ""))}'
    return f"{key}: {value}"


def assess_file(path: Path, root: Path, project_names: List[str]) -> Dict[str, object]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    parsed = parse_frontmatter(text)
    rel = str(path.relative_to(root))
    stat = path.stat()

    record: Dict[str, object] = {
        "path": rel,
        "classification": "compliant",
        "action": "none",
        "proposed": {},
        "reasons": [],
        "changes": [],
        "has_frontmatter": parsed.get("has_frontmatter", False),
        "malformed_frontmatter": parsed.get("malformed", False),
        "existing_fields": parsed.get("fields", {}),
    }

    if parsed.get("malformed"):
        record["classification"] = "review"
        record["action"] = "review"
        record["reasons"] = ["malformed frontmatter"]
        return record

    fields = parsed.get("fields", {}) if parsed.get("has_frontmatter") else {}
    proposed: Dict[str, Dict[str, str]] = {}
    reasons: List[str] = []
    changes: List[str] = []
    low_confidence = False

    project_value, project_conf, project_reason, project_matches = infer_project(path.stem, project_names)
    author_value, author_conf, author_reason = infer_author(text)
    status_value, status_conf, status_reason = infer_status(path.stem, text)
    type_value, type_conf, type_reason = infer_type(path.stem, text, status_value, status_conf)
    created_value, created_conf, created_reason = infer_created(text, stat)
    updated_value, updated_conf, updated_reason = infer_updated(stat)

    inferred = {
        "status": (status_value, status_conf, status_reason),
        "type": (type_value, type_conf, type_reason),
        "project": (project_value, project_conf, project_reason),
        "created": (created_value, created_conf, created_reason),
        "updated": (updated_value, updated_conf, updated_reason),
        "author": (author_value, author_conf, author_reason),
    }

    if len(project_matches) > 1:
        low_confidence = True
        reasons.append("multiple project namespace matches")

    for key in REQ_KEYS:
        existing = fields.get(key)
        if existing is None:
            value, conf, why = inferred[key]
            proposed[key] = {"value": value, "confidence": conf, "reason": why}
            changes.append(f"add {key}")
            if conf == "low":
                low_confidence = True
                reasons.append(f"low-confidence {key} inference")
            continue

        normalized, conf = normalize_existing(key, existing)
        if normalized is None:
            value, infer_conf, why = inferred[key]
            proposed[key] = {"value": value, "confidence": choose_confidence(conf, infer_conf), "reason": f"invalid existing value {strip_quotes(existing)!r}; {why}"}
            changes.append(f"normalize {key}")
            low_confidence = True
            reasons.append(f"unmappable existing {key} value")
            continue

        current = strip_quotes(existing)
        if normalized != current:
            proposed[key] = {"value": normalized, "confidence": conf, "reason": f"normalize existing {key} value"}
            changes.append(f"normalize {key}")
            if conf == "low":
                low_confidence = True
                reasons.append(f"low-confidence normalization for {key}")

    record["proposed"] = proposed
    record["changes"] = changes

    if not changes:
        record["classification"] = "compliant"
        record["action"] = "none"
        return record

    if not parsed.get("has_frontmatter"):
        reasons.append("missing frontmatter")

    if low_confidence:
        record["classification"] = "review"
        record["action"] = "review"
    else:
        record["classification"] = "straightforward"
        record["action"] = "apply"

    deduped = []
    seen = set()
    for reason in reasons:
        if reason not in seen:
            deduped.append(reason)
            seen.add(reason)
    record["reasons"] = deduped
    return record


def apply_record(path: Path, text: str, record: Dict[str, object]) -> str:
    parsed = parse_frontmatter(text)
    proposed = record.get("proposed", {})
    if not proposed:
        return text

    if not parsed.get("has_frontmatter"):
        frontmatter_lines = []
        for key in REQ_KEYS:
            value = proposed[key]["value"] if key in proposed else ""
            frontmatter_lines.append(format_line(key, value))
        eol = "\r\n" if "\r\n" in text else "\n"
        return f"---{eol}{eol.join(frontmatter_lines)}{eol}---{eol}{eol}{text}"

    lines = list(parsed.get("lines", []))
    line_index = dict(parsed.get("line_index", {}))
    for key in REQ_KEYS:
        if key not in proposed:
            continue
        new_line = format_line(key, proposed[key]["value"])
        if key in line_index:
            lines[line_index[key]] = new_line
        else:
            lines.append(new_line)
    return stringify_frontmatter(parsed, lines)


def ensure_report_dir(path_arg: Optional[str]) -> Path:
    if path_arg:
        report_dir = Path(path_arg).expanduser().resolve()
    else:
        clawd_dir = (os.environ.get("JARVOS_CLAWD_DIR") or
                     os.environ.get("CLAWD_DIR") or
                     os.path.join(os.path.expanduser("~"), "clawd"))
        report_dir = Path(clawd_dir) / "artifacts" / "note-contract-migration" / utc_stamp()
    report_dir.mkdir(parents=True, exist_ok=True)
    return report_dir


def write_audit_outputs(report_dir: Path, args: argparse.Namespace, records: List[Dict[str, object]], summary: Dict[str, object]) -> None:
    audit_json = report_dir / "audit.json"
    audit_md = report_dir / "audit.md"
    review_csv = report_dir / "review.csv"
    straightforward_txt = report_dir / "straightforward.txt"

    payload = {
        "generatedAt": dt.datetime.utcnow().isoformat() + "Z",
        "notesDir": str(Path(args.notes_dir).resolve()),
        "summary": summary,
        "rules": {
            "status": [
                "Use explicit status markers first.",
                "Infer draft/archive/abandoned from title markers when present.",
                "Unchecked task-list fallback => draft.",
                "Default active only when no lifecycle signal exists (manual review if this fallback is required).",
            ],
            "type": [
                "Boards/briefs/plans => project-note.",
                "Research/audit/analysis language => research.",
                "Decision language => decision.",
                "Publishing/article language => article.",
                "Draft status can safely map to draft type.",
                "Default reference only when category is ambiguous (manual review if this fallback is required).",
            ],
            "project": [
                "Use exact project-board namespace matches when title clearly maps to a board.",
                "Use blank project when a note does not match a board namespace.",
                "Multiple possible project matches => manual review.",
            ],
            "author": [
                "Explicit Jarvis signatures win.",
                "Other agent signatures normalize into the coarse jarvOS taxonomy as jarvis.",
                "Default andrew when no agent signature is present.",
            ],
            "dates": [
                "created prefers in-body YYYY-MM-DD, then filesystem birthtime/ctime.",
                "updated uses filesystem mtime.",
            ],
            "safety": [
                "Only straightforward notes are auto-edited.",
                "Review notes are surfaced for manual categorization instead of guessed.",
                "Apply mode writes backups plus a unified diff trail.",
            ],
        },
        "records": records,
    }
    audit_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    review_rows = [r for r in records if r["classification"] == "review"]
    with review_csv.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["path", "reasons", "proposed_fields"])
        for row in review_rows:
            writer.writerow([
                row["path"],
                "; ".join(row.get("reasons", [])),
                ", ".join(sorted(row.get("proposed", {}).keys())),
            ])

    straightforward_rows = [r["path"] for r in records if r["classification"] == "straightforward"]
    straightforward_txt.write_text("\n".join(straightforward_rows) + ("\n" if straightforward_rows else ""), encoding="utf-8")

    md_lines = [
        "# Note Contract Migration Audit",
        "",
        f"Generated: {dt.datetime.utcnow().isoformat()}Z",
        f"Notes dir: `{Path(args.notes_dir).resolve()}`",
        "",
        "## Summary",
        "",
        f"- Total notes: {summary['total_notes']}",
        f"- Compliant: {summary['compliant']}",
        f"- Straightforward auto-fix candidates: {summary['straightforward']}",
        f"- Manual review required: {summary['review']}",
        f"- Missing frontmatter: {summary['missing_frontmatter']}",
        f"- Malformed frontmatter: {summary['malformed_frontmatter']}",
        "",
        "## Required field coverage",
        "",
    ]
    for key, value in summary["field_coverage"].items():
        md_lines.append(f"- `{key}`: {value}/{summary['total_notes']}")
    md_lines += ["", "## Fallback/default rules", ""]
    for section, bullets in payload["rules"].items():
        md_lines.append(f"### {section}")
        md_lines.append("")
        for bullet in bullets:
            md_lines.append(f"- {bullet}")
        md_lines.append("")
    if review_rows:
        md_lines += ["## Review queue (first 50)", ""]
        for row in review_rows[:50]:
            md_lines.append(f"- `{row['path']}` — {', '.join(row.get('reasons', []))}")
        md_lines.append("")
    audit_md.write_text("\n".join(md_lines) + "\n", encoding="utf-8")


def summarize(records: List[Dict[str, object]]) -> Dict[str, object]:
    field_coverage = {k: 0 for k in REQ_KEYS}
    reasons = Counter()
    classifications = Counter()
    total = len(records)
    missing_frontmatter = 0
    malformed = 0

    for record in records:
        classifications[record["classification"]] += 1
        if not record.get("has_frontmatter"):
            missing_frontmatter += 1
        if record.get("malformed_frontmatter"):
            malformed += 1
        fields = record.get("existing_fields", {})
        for key in REQ_KEYS:
            if key in fields:
                field_coverage[key] += 1
        for reason in record.get("reasons", []):
            reasons[reason] += 1

    return {
        "total_notes": total,
        "compliant": classifications["compliant"],
        "straightforward": classifications["straightforward"],
        "review": classifications["review"],
        "missing_frontmatter": missing_frontmatter,
        "malformed_frontmatter": malformed,
        "field_coverage": field_coverage,
        "top_review_reasons": reasons.most_common(20),
    }


def run_audit(args: argparse.Namespace, report_dir: Path) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
    root = Path(args.notes_dir).expanduser().resolve()
    files = sorted([p for p in root.rglob("*.md") if p.is_file()], key=lambda p: str(p.relative_to(root)).lower())
    project_names = find_project_names(files)
    records = [assess_file(p, root, project_names) for p in files]
    summary = summarize(records)
    write_audit_outputs(report_dir, args, records, summary)
    return records, summary


def run_apply(args: argparse.Namespace, report_dir: Path, records: List[Dict[str, object]]) -> Dict[str, object]:
    root = Path(args.notes_dir).expanduser().resolve()
    backups_dir = report_dir / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    patch_path = report_dir / "changes.patch"
    manifest_path = report_dir / "apply.json"

    applied = []
    skipped = []
    diffs: List[str] = []

    by_path = {r["path"]: r for r in records}
    for rel, record in by_path.items():
        path = root / rel
        if record.get("classification") != "straightforward":
            skipped.append(rel)
            continue
        original = path.read_text(encoding="utf-8", errors="ignore")
        updated = apply_record(path, original, record)
        if updated == original:
            skipped.append(rel)
            continue
        backup_path = backups_dir / rel
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup_path)
        path.write_text(updated, encoding="utf-8")
        diff = difflib.unified_diff(
            original.splitlines(keepends=True),
            updated.splitlines(keepends=True),
            fromfile=f"a/{rel}",
            tofile=f"b/{rel}",
        )
        diffs.extend(diff)
        applied.append({
            "path": rel,
            "changes": record.get("changes", []),
            "backup": str(backup_path),
        })

    patch_path.write_text("".join(diffs), encoding="utf-8")
    result = {
        "generatedAt": dt.datetime.utcnow().isoformat() + "Z",
        "applied": applied,
        "appliedCount": len(applied),
        "skippedCount": len(skipped),
        "patchFile": str(patch_path),
        "backupsDir": str(backups_dir),
    }
    manifest_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["audit", "apply"])
    _notes_default = (os.environ.get("JARVOS_NOTES_DIR") or
                      os.environ.get("JARVOS_VAULT_NOTES") or
                      os.environ.get("VAULT_NOTES_DIR") or
                      os.path.join(os.path.expanduser("~"), "Documents", "Vault v3", "Notes"))
    ap.add_argument("--notes-dir", default=_notes_default)
    ap.add_argument("--report-dir")
    return ap


def main() -> int:
    args = build_parser().parse_args()
    report_dir = ensure_report_dir(args.report_dir)
    records, summary = run_audit(args, report_dir)
    print(json.dumps({"reportDir": str(report_dir), "summary": summary}, indent=2))

    if args.mode == "apply":
        result = run_apply(args, report_dir, records)
        print(json.dumps({"apply": result}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
