#!/usr/bin/env python3
import argparse
import os
import re
from pathlib import Path
from typing import Dict, List, Tuple

REQ_KEYS = ["status", "type", "project", "created", "updated", "author"]

STATUS_VALUES = {"active", "draft", "archived", "abandoned"}
TYPE_VALUES = {"project-note", "draft", "research", "decision", "reference", "article", "chapter"}
AUTHOR_VALUES = {"jarvis", "andrew", "both"}

DATE_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")
KEY_RE = re.compile(r"^([A-Za-z0-9_-]+):")


def to_date(ts: float) -> str:
    import datetime
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def find_project_names(files: List[Path]) -> List[str]:
    names = set()
    pat = re.compile(r"^(.*?)(?:\s+[—-]\s+|\s+-\s+|\s+—\s+)?Project Board$", re.IGNORECASE)
    for f in files:
        stem = f.stem
        m = pat.match(stem)
        if m:
            n = m.group(1).strip()
            if n:
                names.add(n)
    return sorted(names, key=lambda s: (-len(s), s.lower()))


def infer_author(content: str) -> str:
    c = content.lower()
    if "edited by jarvis" in c:
        return "both"
    if "written by jarvis" in c:
        return "jarvis"
    return "andrew"


def infer_status(stem: str, content: str) -> str:
    s = stem.lower()
    c = content.lower()

    # Explicit status markers (outside frontmatter) take precedence.
    explicit = re.search(r"(?mi)^status\s*:\s*(active|draft|archived|abandoned)\b", content)
    if explicit:
        return explicit.group(1).lower()

    if "abandoned" in s or "cancelled" in s or "canceled" in s:
        return "abandoned"
    if "archived" in s or "archive" in s:
        return "archived"
    if re.search(r"\b(draft|wip|tbd|todo|in progress)\b", s + "\n" + c) or "- [ ]" in c:
        return "draft"
    return "active"


def infer_type(stem: str, content: str, status: str) -> str:
    s = stem.lower()
    c = content.lower()
    text = s + "\n" + c

    if "project board" in s or "project brief" in s:
        return "project-note"
    if "chapter" in s:
        return "chapter"
    if any(k in text for k in ["research", "analysis", "lastxdays", "literature review", "market scan"]):
        return "research"
    if "decision" in text:
        return "decision"
    if any(k in text for k in ["newsletter", "x launch", "x post", "blog", "article", "essay"]):
        return "article"
    if status == "draft":
        return "draft"
    return "reference"


def infer_project(stem: str, project_names: List[str]) -> str:
    board_match = re.match(r"^(.*?)(?:\s+[—-]\s+|\s+-\s+|\s+—\s+)?Project (?:Board|Brief)$", stem, re.IGNORECASE)
    if board_match:
        return board_match.group(1).strip()

    for pname in project_names:
        if stem == pname or stem.startswith(pname + " ") or stem.startswith(pname + "-") or stem.startswith(pname + "—"):
            return pname
    return ""


def infer_created(content: str, stat) -> str:
    m = DATE_RE.search(content)
    if m:
        return m.group(1)
    birth = getattr(stat, "st_birthtime", None)
    if birth:
        return to_date(birth)
    return to_date(stat.st_ctime)


def infer_updated(stat) -> str:
    return to_date(stat.st_mtime)


def parse_frontmatter_keys(lines: List[str]) -> Dict[str, str]:
    keys = {}
    for line in lines:
        m = KEY_RE.match(line.strip())
        if m:
            key = m.group(1)
            value = line.split(":", 1)[1].strip()
            keys[key] = value
    return keys


def create_required_values(path: Path, content: str, project_names: List[str]) -> Dict[str, str]:
    stat = path.stat()
    status = infer_status(path.stem, content)
    typ = infer_type(path.stem, content, status)
    project = infer_project(path.stem, project_names)
    created = infer_created(content, stat)
    updated = infer_updated(stat)
    author = infer_author(content)
    return {
        "status": status if status in STATUS_VALUES else "active",
        "type": typ if typ in TYPE_VALUES else "reference",
        "project": project,
        "created": created,
        "updated": updated,
        "author": author if author in AUTHOR_VALUES else "andrew",
    }


def format_line(k: str, v: str) -> str:
    if k == "project":
        return f'{k}: "{v}"\n' if v else 'project: ""\n'
    return f"{k}: {v}\n"


def process_file(path: Path, project_names: List[str], dry_run: bool = False) -> Tuple[str, List[str]]:
    original = path.read_text(encoding="utf-8")
    inferred = create_required_values(path, original, project_names)
    notes = []

    lines = original.splitlines(keepends=True)
    if lines and lines[0].strip() == "---":
        end_idx = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                end_idx = i
                break
        if end_idx is None:
            return "skipped", ["Malformed frontmatter (no closing ---)"]

        fm_lines = lines[1:end_idx]
        keys = parse_frontmatter_keys(fm_lines)
        missing = [k for k in REQ_KEYS if k not in keys]
        if not missing:
            return "unchanged", []

        to_add = [format_line(k, inferred[k]) for k in missing]
        fm_text = "".join(fm_lines)
        if fm_text and not fm_text.endswith(("\n", "\r")):
            fm_text += "\n"

        new_text = lines[0] + fm_text + "".join(to_add) + lines[end_idx] + "".join(lines[end_idx + 1:])
        if not dry_run:
            path.write_text(new_text, encoding="utf-8")
        notes.append(f"added missing keys: {', '.join(missing)}")
        return "updated", notes

    # no frontmatter
    block_lines = ["---\n"]
    for k in REQ_KEYS:
        block_lines.append(format_line(k, inferred[k]))
    block_lines.append("---\n\n")
    new_text = "".join(block_lines) + original
    if not dry_run:
        path.write_text(new_text, encoding="utf-8")
    notes.append("prepended canonical frontmatter")
    return "added", notes


def verify_batch(files: List[Path]) -> Tuple[bool, List[str]]:
    problems = []
    for f in files:
        text = f.read_text(encoding="utf-8")
        lines = text.splitlines()
        if not lines or lines[0].strip() != "---":
            problems.append(f"{f}: missing frontmatter")
            continue
        try:
            end = lines[1:].index("---") + 1
        except ValueError:
            problems.append(f"{f}: malformed frontmatter")
            continue
        fm = lines[1:end]
        keys = set()
        for line in fm:
            m = KEY_RE.match(line.strip())
            if m:
                keys.add(m.group(1))
        miss = [k for k in REQ_KEYS if k not in keys]
        if miss:
            problems.append(f"{f}: missing keys {', '.join(miss)}")
    return (len(problems) == 0), problems


def main():
    ap = argparse.ArgumentParser()
    _notes_default = (os.environ.get("JARVOS_NOTES_DIR") or
                      os.environ.get("JARVOS_VAULT_NOTES") or
                      os.environ.get("VAULT_NOTES_DIR") or
                      os.path.join(os.path.expanduser("~"), "Documents", "Vault v3", "Notes"))
    ap.add_argument("--notes-dir", default=_notes_default)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--count", type=int, default=20)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()

    root = Path(args.notes_dir)
    files = sorted([p for p in root.rglob("*.md") if p.is_file()], key=lambda p: str(p.relative_to(root)).lower())

    batch = files[args.start: args.start + args.count]
    project_names = find_project_names(files)

    if args.verify_only:
        ok, problems = verify_batch(batch)
        print(f"verify_batch start={args.start} count={len(batch)} ok={ok}")
        if problems:
            for p in problems[:200]:
                print(p)
        return

    summary = {
        "processed": 0,
        "added": 0,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        "ambiguous": 0,
    }

    print(f"batch start={args.start} count={len(batch)} total_files={len(files)}")

    for f in batch:
        summary["processed"] += 1
        status, notes = process_file(f, project_names, dry_run=args.dry_run)
        summary[status] += 1
        rel = str(f.relative_to(root))
        if status in {"added", "updated", "skipped"}:
            print(f"{status.upper()} :: {rel} :: {'; '.join(notes)}")

    print("SUMMARY", summary)


if __name__ == "__main__":
    main()
