#!/usr/bin/env python3
"""Build a Gantt-chart artifact populated with a Project/Task/Subtask tree.

The artifact's schema is FIXED — 15 fields per the user spec.

Usage:
    python build_artifact.py [input.xlsx|.csv] <output-dir> [--mapping JSON] [--sheet NAME]

If no input file is given, builds an EMPTY artifact (user starts from scratch).

Maps input columns into the fixed schema. Auto-detects where it can, asks
the caller for mapping help when required fields are unmappable.

Required schema fields (the 15 columns):
    id, name, owner, predecessors,
    sched_start, sched_end, actual_start, actual_end,
    slack, percent_done,
    est_cost, cost_to_date, sale_price
    (cost_variance and margin are computed, never stored)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from read_data import read_any  # noqa: E402

# ── Header → role auto-detection ────────────────────────────────────────────
ROLE_PATTERNS = {
    "id":           ["id", "code", "wbs"],
    "name":         ["project name", "project task subtask", "task name", "project", "task", "subtask", "title", "activity", "name"],
    "owner":        ["assigned to", "assignee", "owner", "responsible", "lead", "manager", "pm"],
    "predecessors": ["predecessor", "depends on", "blocks", "blocked by", "dependency"],
    "sched_start":  ["sched start", "sched. start", "planned start", "scheduled start", "start date", "start", "begin", "kickoff"],
    "sched_end":    ["sched end", "sched. end", "planned end", "scheduled end", "end date", "end", "finish", "due", "deadline"],
    "actual_start": ["actual start", "real start", "ast start"],
    "actual_end":   ["actual end", "real end", "actual finish"],
    "slack":        ["slack", "float"],
    "percent_done": ["percent done", "percent complete", "done", "complete"],
    # Estimated Cost is treated as the budget — accept aliases like "budget" too
    "est_cost":     ["estimated cost", "est cost", "budget", "allocated", "allowance"],
    "cost_to_date": ["cost to date", "actual cost", "spent", "incurred"],
    "sale_price":   ["sale price", "revenue", "price", "contract value"],
}
REQUIRED_ROLES = ("name", "sched_start", "sched_end")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", str(s).lower()).strip()


def detect_columns(headers: list[str]) -> dict:
    """Return {'role': 'header'} for every role we can confidently match."""
    used = set()
    mapping = {}
    norm_headers = [(h, _norm(h)) for h in headers]
    for role, patterns in ROLE_PATTERNS.items():
        for pat in patterns:
            for original, norm in norm_headers:
                if original in used or not original:
                    continue
                if pat in norm:
                    mapping[role] = original
                    used.add(original)
                    break
            if role in mapping:
                break
    return mapping


# ── Date parsing ────────────────────────────────────────────────────────────
def parse_date(value, dayfirst=True):
    if not value:
        return ""
    s = str(value).strip()
    if not s:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        return s
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$", s)
    if m:
        a, b, c = map(int, m.groups())
        if c < 100:
            c += 2000 if c < 70 else 1900
        d, mo = (a, b) if dayfirst else (b, a)
        if d > 12 and mo <= 12: pass
        elif d > 31: d, mo = mo, d
        if 1 <= mo <= 12 and 1 <= d <= 31:
            return f"{c:04d}-{mo:02d}-{d:02d}"
    # Excel serial
    if re.match(r"^\d{4,5}$", s):
        serial = int(s)
        if 25000 < serial < 80000:
            from datetime import datetime, timedelta
            return (datetime(1899, 12, 30) + timedelta(days=serial)).strftime("%Y-%m-%d")
    return ""


def parse_num(v):
    if v is None or v == "": return ""
    s = re.sub(r"[$,\s]", "", str(v))
    try: return float(s)
    except ValueError: return ""


def parse_percent(v):
    """0.75 or '75%' or '75' → 75 (clamped to 0-100)."""
    if v is None or v == "": return ""
    s = str(v).strip().rstrip("%").strip()
    try:
        f = float(s)
        if 0 < f <= 1: f *= 100
        # Clamp to [0, 100]
        if f < 0:   f = 0
        if f > 100: f = 100
        return round(f)
    except ValueError:
        return ""


# ── Hierarchy inference ─────────────────────────────────────────────────────
def normalize_id(id_str: str) -> str:
    """Normalize various ID styles to the P / P-T / P-T-S convention.

    Accepts:
      P1                  → P1
      P1-T1               → P1-T1
      P1-T1-S1            → P1-T1-S1
      P1-T1.1             → P1-T1-S1   (V2.0 style: dot for subtask)
      P1-T1.2             → P1-T1-S2
      P1.1                → P1-T1      (no T marker)
      P1.1.1              → P1-T1-S1
    """
    if not id_str:
        return ""
    s = str(id_str).strip()
    # If it already has the right shape (-T -S), keep
    if re.match(r"^P\d+(-T\d+(-S\d+)?)?$", s):
        return s
    # Replace dots after a -T* segment with -S
    m = re.match(r"^(P\d+)-T(\d+)\.(\d+)$", s)
    if m:
        return f"{m.group(1)}-T{m.group(2)}-S{m.group(3)}"
    # P1.1 or P1.1.1 style
    m = re.match(r"^P(\d+)\.(\d+)(?:\.(\d+))?$", s)
    if m:
        p, t, sub = m.groups()
        out = f"P{p}-T{t}"
        if sub:
            out += f"-S{sub}"
        return out
    return s  # Unknown form — pass through


def infer_type_from_id(id_str: str) -> str:
    """P → project, P-T → task, P-T-S → subtask. Falls back to 'project'."""
    if not id_str:
        return "project"
    parts = str(id_str).split("-")
    if len(parts) == 1: return "project"
    if len(parts) == 2: return "task"
    return "subtask"


def infer_hierarchy_from_indent(name: str) -> int:
    """Detect indent level from leading whitespace, bullets, or markers."""
    if not name: return 0
    s = str(name)
    # Common bullet/indent markers in the user's template
    if s.startswith(("•", "  •", "   •")): return 2  # subtask
    if s.startswith(("▸", "  ▸", "►")): return 1     # task
    # Count leading spaces — every 2 spaces = 1 level (rough)
    leading = len(s) - len(s.lstrip(" \t"))
    return min(2, leading // 2)


def clean_name(name: str) -> str:
    if not name: return ""
    return re.sub(r"^[\s•▸►▶★*]+\s*", "", str(name)).strip()


def auto_assign_ids(rows: list[dict], mapping: dict) -> list[dict]:
    """If rows lack IDs, assign P/T/S IDs based on inferred hierarchy."""
    id_col = mapping.get("id")
    name_col = mapping.get("name", "")
    out = []
    proj_counter = 0
    task_counter = 0
    subt_counter = 0
    current_project_id = None
    current_task_id = None

    for row in rows:
        raw_id = (row.get(id_col, "") if id_col else "").strip()
        raw_name = row.get(name_col, "") if name_col else ""
        clean = clean_name(raw_name)

        if raw_id:
            normalized = normalize_id(raw_id)
            t = infer_type_from_id(normalized)
            row["_id"] = normalized
            row["_type"] = t
            row["_name"] = clean
            if t == "project":
                current_project_id = raw_id
                task_counter = 0
            elif t == "task":
                current_task_id = raw_id
                subt_counter = 0
        else:
            indent = infer_hierarchy_from_indent(raw_name)
            if indent == 0:
                proj_counter += 1
                task_counter = 0
                current_project_id = f"P{proj_counter}"
                row["_id"] = current_project_id
                row["_type"] = "project"
            elif indent == 1 and current_project_id:
                task_counter += 1
                subt_counter = 0
                current_task_id = f"{current_project_id}-T{task_counter}"
                row["_id"] = current_task_id
                row["_type"] = "task"
            elif indent == 2 and current_task_id:
                subt_counter += 1
                row["_id"] = f"{current_task_id}-S{subt_counter}"
                row["_type"] = "subtask"
            else:
                # Fallback: standalone project
                proj_counter += 1
                row["_id"] = f"P{proj_counter}"
                row["_type"] = "project"
            row["_name"] = clean
        out.append(row)
    return out


def row_to_node(row: dict, mapping: dict) -> dict:
    """Convert a raw row to a node with the fixed 15-field schema."""
    get = lambda role: row.get(mapping[role], "") if mapping.get(role) else ""
    raw_preds = str(get("predecessors") or "").strip()
    # Normalize any dot-style IDs in predecessor lists
    norm_preds = ", ".join(normalize_id(p.strip()) for p in re.split(r"[,;]", raw_preds) if p.strip()) if raw_preds else ""
    return {
        "id":             row["_id"],
        "name":           row["_name"],
        "owner":          str(get("owner") or "").strip(),
        "predecessors":   norm_preds,
        "sched_start":    parse_date(get("sched_start")),
        "sched_end":      parse_date(get("sched_end")),
        "actual_start":   parse_date(get("actual_start")),
        "actual_end":     parse_date(get("actual_end")),
        "slack":          parse_num(get("slack")),
        "percent_done":   parse_percent(get("percent_done")),
        "est_cost":       parse_num(get("est_cost")),
        "cost_to_date":   parse_num(get("cost_to_date")),
        "sale_price":     parse_num(get("sale_price")),
        "collapsed":      False,
    }


# ── Project-template parsing (markdown → JSON for the artifact) ──────────────
TEMPLATES_MD = Path(__file__).parent.parent / "references" / "project_templates.md"


def parse_templates_md(path: Path) -> dict:
    """Parse '## Template X — Name' blocks from a markdown file.

    Each block has a fenced code section with rows like:
        1. Initiation
           1.1 Contract award / KO              1
           1.2 Site visit                       2-3      1.1

    Returns {key: {"name": ..., "span": ..., "tasks": [...], "phases": {n: name}}}
    """
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    templates: dict = {}
    blocks = re.split(r"\n##\s*Template\s+([A-Z])\s*[—\-]\s*", text)
    # blocks = [preamble, "A", "Name\n...", "B", "Name\n...", ...]
    for i in range(1, len(blocks), 2):
        key = blocks[i].strip()
        body = blocks[i + 1]
        first_nl = body.find("\n")
        name = body[:first_nl].strip() if first_nl > -1 else body.strip()
        span_m = re.search(r"Typical span:\s*(.+)", body)
        span = span_m.group(1).strip() if span_m else ""
        code_m = re.search(r"```[a-zA-Z]*\n(.*?)\n```", body, re.DOTALL)
        if not code_m:
            continue
        tasks: list[dict] = []
        phases: dict[str, str] = {}
        current_phase = None
        for line in code_m.group(1).splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith(("Phase", "─")):
                continue
            # Phase header: "1. Initiation"
            ph_m = re.match(r"^(\d+)\.\s+(.+)$", stripped)
            if ph_m and not re.match(r"^\d+\.\d+", stripped):
                current_phase = ph_m.group(1)
                phases[current_phase] = ph_m.group(2).strip()
                continue
            # Task line — robust split: find leading tid, then duration token at end.
            head = re.match(r"^\s+(\d+\.\d+)\s+(.+)$", line)
            if not head:
                continue
            tid = head.group(1)
            rest = head.group(2)
            # Duration is the last numeric "N" or "N-M" token; optional predecessor list after it.
            dur_m = re.search(r"\s+(\d+(?:-\d+)?)(?:\s+([\d.,;+\s]+))?\s*$", rest)
            if not dur_m:
                continue
            tname = rest[:dur_m.start()].strip()
            durstr = dur_m.group(1)
            predstr = (dur_m.group(2) or "").strip()
            if "-" in durstr:
                lo, hi = (int(x) for x in durstr.split("-"))
                dur = [lo, hi]
            else:
                d = int(durstr); dur = [d, d]
            preds = re.findall(r"\d+\.\d+", predstr)
            tasks.append({"tid": tid, "name": tname, "dur": dur, "preds": preds})
        templates[key] = {"name": name, "span": span, "tasks": tasks, "phases": phases}
    return templates


# ── Template filling ────────────────────────────────────────────────────────
TEMPLATE_PATH = Path(__file__).parent.parent / "assets" / "template.html"


def fill_template(source_path: Path | None, nodes: list[dict], sheet_name: str = "") -> str:
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    payload = {
        # Per-build unique ID — used to namespace localStorage so two empty artifacts
        # built at different times don't share saved state.
        "session_id": str(uuid.uuid4()),
        "source_file": source_path.name if source_path else "",
        "sheet_name": sheet_name,
        "title": source_path.stem.replace("_", " ").replace("-", " ").title() if source_path else "Project Gantt",
        "nodes": nodes,
        "templates": parse_templates_md(TEMPLATES_MD),
    }
    return template.replace("/*__GANTT_DATA__*/null", json.dumps(payload, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", help="Optional: input file path. If omitted, builds an empty artifact.")
    ap.add_argument("output_dir", help="Where to write index.html")
    ap.add_argument("--mapping", help="JSON {role: header} overrides", default=None)
    ap.add_argument("--sheet", help="Sheet name for multi-sheet xlsx", default=None)
    ap.add_argument("--header-row", type=int, default=None)
    args = ap.parse_args()

    out_dir = Path(args.output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Empty start
    if not args.input:
        html = fill_template(None, [])
        (out_dir / "index.html").write_text(html, encoding="utf-8")
        print(json.dumps({"status": "ok", "output": str(out_dir / "index.html"), "node_count": 0, "mode": "empty"}, indent=2))
        return

    src = Path(args.input).expanduser().resolve()
    if not src.exists():
        print(json.dumps({"error": f"File not found: {src}"}), file=sys.stderr); sys.exit(1)

    try:
        data = read_any(src, sheet=args.sheet, header_row=args.header_row)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr); sys.exit(1)

    headers = data["headers"]
    rows = data["rows"]
    if not headers:
        print(json.dumps({"error": "No headers found"}), file=sys.stderr); sys.exit(1)

    detected = detect_columns(headers)
    if args.mapping:
        try:
            detected.update({k: v for k, v in json.loads(args.mapping).items() if v})
        except Exception as e:
            print(json.dumps({"error": f"Bad --mapping: {e}"}), file=sys.stderr); sys.exit(1)

    missing = [r for r in REQUIRED_ROLES if not detected.get(r)]
    if missing:
        print(json.dumps({
            "status": "needs_mapping",
            "headers": headers,
            "sample_rows": rows[:5],
            "detected": detected,
            "missing": missing,
            "sheet_used": data.get("used_sheet", ""),
            "sheet_names": data.get("sheet_names", []),
        }, indent=2))
        sys.exit(2)

    rows = auto_assign_ids(rows, detected)
    nodes = [row_to_node(r, detected) for r in rows if r.get("_name")]

    html = fill_template(src, nodes, data.get("used_sheet", ""))
    out_path = out_dir / "index.html"
    out_path.write_text(html, encoding="utf-8")

    counts = {"project": 0, "task": 0, "subtask": 0}
    for n in nodes:
        from_id = n["id"].count("-")
        counts[["project","task","subtask"][min(from_id, 2)]] += 1

    print(json.dumps({
        "status": "ok",
        "output": str(out_path),
        "mapping": detected,
        "node_count": len(nodes),
        "by_type": counts,
        "headers": headers,
    }, indent=2))


if __name__ == "__main__":
    main()
