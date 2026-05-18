"""
Gantt Scheduler — CPM with DP forward/backward passes.

Core algorithm for computing optimal task schedules from a list of tasks
with predecessor dependencies. Supports incremental recomputation when a
task duration changes (the "battery delivery slipped" case).
"""

from __future__ import annotations
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional
import re


# ───────────────────────── Data Model ─────────────────────────

@dataclass
class Edge:
    """Dependency edge from a predecessor into a task."""
    pred_id: str
    type: str = "FS"   # "FS", "SS", or "FF"
    lag: int = 0       # days; negative = lead


@dataclass
class Task:
    id: str
    name: str
    duration: int                                          # working days
    predecessors: list[str] = field(default_factory=list)  # raw strings: "T1", "T1+14", "T1SS+5"
    owner: str = ""
    costs: float = 0.0
    prices: float = 0.0
    pct_done: float = 0.0


@dataclass
class ScheduleResult:
    ES: dict[str, int]
    EF: dict[str, int]
    LS: dict[str, int]
    LF: dict[str, int]
    slack: dict[str, int]
    critical_path: list[str]
    infeasible_tasks: list[str]
    project_span_T: int
    sched_start: dict[str, date]
    sched_end: dict[str, date]


# ─────────────────── Predecessor string parser ───────────────────

PRED_RE = re.compile(r"^(?P<id>[\w.\-]+)(?P<type>FS|SS|FF)?(?P<lag>[+-]\d+)?$")

def parse_predecessor(s: str) -> Edge:
    """
    "T1"      -> Edge("T1", "FS", 0)
    "T1+14"   -> Edge("T1", "FS", 14)
    "T1-3"    -> Edge("T1", "FS", -3)
    "T1SS+5"  -> Edge("T1", "SS", 5)
    "T1FF-2"  -> Edge("T1", "FF", -2)
    """
    m = PRED_RE.match(s.strip())
    if not m:
        raise ValueError(f"Cannot parse predecessor: {s!r}")
    return Edge(
        pred_id=m.group("id"),
        type=m.group("type") or "FS",
        lag=int(m.group("lag") or 0),
    )


# ───────────────────── Graph construction ─────────────────────

def build_graph(tasks: list[Task]):
    """Returns (successors, predecessors). Validates that every predecessor ID exists."""
    by_id = {t.id: t for t in tasks}
    successors: dict[str, list[tuple[str, Edge]]] = defaultdict(list)
    predecessors: dict[str, list[Edge]] = defaultdict(list)
    for t in tasks:
        if t.duration < 0:
            raise ValueError(f"Task {t.id!r} has negative duration {t.duration}")
        for raw in t.predecessors:
            e = parse_predecessor(raw)
            if e.pred_id not in by_id:
                raise ValueError(f"Task {t.id!r} references unknown predecessor {e.pred_id!r}")
            predecessors[t.id].append(e)
            successors[e.pred_id].append((t.id, e))
    return successors, predecessors


# ──────────── Topological sort + cycle detection (Kahn) ────────────

class CycleError(ValueError):
    pass


def topo_sort(tasks, successors, predecessors) -> list[str]:
    in_deg = {t.id: len(predecessors[t.id]) for t in tasks}
    queue = deque(t.id for t in tasks if in_deg[t.id] == 0)
    order: list[str] = []
    while queue:
        u = queue.popleft()
        order.append(u)
        for v, _ in successors[u]:
            in_deg[v] -= 1
            if in_deg[v] == 0:
                queue.append(v)
    if len(order) < len(tasks):
        cycle = _find_cycle_dfs(tasks, successors)
        raise CycleError(f"Cycle detected: {' → '.join(cycle)}")
    return order


def _find_cycle_dfs(tasks, successors) -> list[str]:
    """DFS to recover a cycle path for clear error reporting."""
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {t.id: WHITE for t in tasks}
    parent: dict[str, Optional[str]] = {t.id: None for t in tasks}

    def dfs(u: str):
        color[u] = GRAY
        for v, _ in successors[u]:
            if color[v] == GRAY:
                path = [v, u]
                node = parent[u]
                while node and node != v:
                    path.append(node)
                    node = parent[node]
                path.append(v)
                return list(reversed(path))
            if color[v] == WHITE:
                parent[v] = u
                cyc = dfs(v)
                if cyc: return cyc
        color[u] = BLACK
        return None

    for t in tasks:
        if color[t.id] == WHITE:
            cyc = dfs(t.id)
            if cyc: return cyc
    return ["?"]


# ──────────────────── Forward pass (DP) ────────────────────

def forward_pass(order, tasks_by_id, predecessors):
    ES, EF = {}, {}
    for u in order:
        d = tasks_by_id[u].duration
        if not predecessors[u]:
            ES[u] = 0
        else:
            cands = []
            for e in predecessors[u]:
                p = e.pred_id
                if   e.type == "FS": cands.append(EF[p] + e.lag)
                elif e.type == "SS": cands.append(ES[p] + e.lag)
                elif e.type == "FF": cands.append(EF[p] + e.lag - d)
                else: raise ValueError(f"Unknown edge type: {e.type}")
            ES[u] = max(cands)
        EF[u] = ES[u] + d
    T = max(EF.values()) if EF else 0
    return ES, EF, T


# ──────────────────── Backward pass ────────────────────

def backward_pass(order, tasks_by_id, successors, T, deadline=None):
    horizon = deadline if deadline is not None else T
    LF, LS = {}, {}
    for u in reversed(order):
        d = tasks_by_id[u].duration
        outs = successors[u]
        if not outs:
            LF[u] = horizon
        else:
            cands = []
            for v, e in outs:
                if   e.type == "FS": cands.append(LS[v] - e.lag)
                elif e.type == "SS": cands.append(LS[v] - e.lag + d)
                elif e.type == "FF": cands.append(LF[v] - e.lag)
            LF[u] = min(cands)
        LS[u] = LF[u] - d
    return LS, LF


# ──────── Slack + critical path + feasibility ────────

def analyse(tasks, ES, LS):
    slack = {t.id: LS[t.id] - ES[t.id] for t in tasks}
    critical = [t.id for t in tasks if slack[t.id] == 0]
    infeasible = [t.id for t in tasks if slack[t.id] < 0]
    return slack, critical, infeasible


# ─────────────────── Calendar projection ───────────────────

def add_days(start: date, offset: int, working_only: bool, holidays: Optional[set] = None) -> date:
    """Add offset days. Skips Sat/Sun (and any holiday dates) if working_only=True."""
    if not working_only:
        return start + timedelta(days=offset)
    holidays = holidays or set()
    d = start
    remaining = offset
    while remaining > 0:
        d += timedelta(days=1)
        if d.weekday() < 5 and d not in holidays:
            remaining -= 1
    return d


def project_dates(offsets, start, working_only, holidays=None):
    return {u: add_days(start, n, working_only, holidays) for u, n in offsets.items()}


# ────────────── Top-level orchestration ──────────────

def schedule(
    tasks: list[Task],
    project_start: date,
    working_days_only: bool = True,
    holidays: Optional[set] = None,
    deadline_offset: Optional[int] = None,
) -> ScheduleResult:
    tasks_by_id = {t.id: t for t in tasks}
    successors, predecessors = build_graph(tasks)
    order = topo_sort(tasks, successors, predecessors)
    ES, EF, T = forward_pass(order, tasks_by_id, predecessors)
    LS, LF = backward_pass(order, tasks_by_id, successors, T, deadline_offset)
    slack, critical, infeasible = analyse(tasks, ES, LS)
    return ScheduleResult(
        ES=ES, EF=EF, LS=LS, LF=LF,
        slack=slack, critical_path=critical, infeasible_tasks=infeasible,
        project_span_T=T,
        sched_start=project_dates(ES, project_start, working_days_only, holidays),
        sched_end=project_dates(EF, project_start, working_days_only, holidays),
    )


# ──────────── Perturbation: incremental recompute ────────────

def _forward_descendants(start_id, successors) -> set:
    seen: set = set()
    queue = deque([start_id])
    while queue:
        u = queue.popleft()
        for v, _ in successors[u]:
            if v not in seen:
                seen.add(v)
                queue.append(v)
    return seen


def recompute_after_change(
    tasks: list[Task],
    changed_id: str,
    new_duration: int,
    prev: ScheduleResult,
    project_start: date,
    working_days_only: bool = True,
    holidays: Optional[set] = None,
    deadline_offset: Optional[int] = None,
):
    """
    Apply a single duration change and recompute only what's dirty.
    NOTE: this mutates tasks[changed_id].duration in place — intentional, so
    subsequent perturbations stack on the new state.
    """
    tasks_by_id = {t.id: t for t in tasks}
    tasks_by_id[changed_id].duration = new_duration

    successors, predecessors = build_graph(tasks)
    order = topo_sort(tasks, successors, predecessors)

    dirty = {changed_id} | _forward_descendants(changed_id, successors)
    sub_order = [u for u in order if u in dirty]

    ES = dict(prev.ES)
    EF = dict(prev.EF)
    for u in sub_order:
        d = tasks_by_id[u].duration
        if not predecessors[u]:
            ES[u] = 0
        else:
            cands = []
            for e in predecessors[u]:
                p = e.pred_id
                if   e.type == "FS": cands.append(EF[p] + e.lag)
                elif e.type == "SS": cands.append(ES[p] + e.lag)
                elif e.type == "FF": cands.append(EF[p] + e.lag - d)
            ES[u] = max(cands)
        EF[u] = ES[u] + d
    new_T = max(EF.values())

    # Always re-run backward pass: a duration change alters LS = LF - duration
    # for the changed task, which can cascade into ancestors' LF and slack.
    LS, LF = backward_pass(order, tasks_by_id, successors, new_T, deadline_offset)

    slack, critical, infeasible = analyse(tasks, ES, LS)
    moved = sorted(u for u in dirty if EF[u] != prev.EF.get(u))

    result = ScheduleResult(
        ES=ES, EF=EF, LS=LS, LF=LF,
        slack=slack, critical_path=critical, infeasible_tasks=infeasible,
        project_span_T=new_T,
        sched_start=project_dates(ES, project_start, working_days_only, holidays),
        sched_end=project_dates(EF, project_start, working_days_only, holidays),
    )
    return result, moved


# ─────────────────── Demo / smoke test ───────────────────

if __name__ == "__main__":
    # Mini residential solar (Template B, condensed to 11 tasks)
    tasks = [
        Task("T1",  "Site visit",                duration=2,  predecessors=[]),
        Task("T2",  "Design",                    duration=5,  predecessors=["T1"]),
        Task("T3",  "Customer sign-off",         duration=2,  predecessors=["T2"]),
        Task("T4",  "Panel procurement",         duration=12, predecessors=["T3"]),
        Task("T5",  "Inverter procurement",      duration=10, predecessors=["T3"]),
        Task("T6",  "Battery procurement",       duration=15, predecessors=["T3"]),
        Task("T7",  "Site prep",                 duration=1,  predecessors=["T3"]),
        Task("T8",  "Mounting + panel install",  duration=2,  predecessors=["T7", "T4"]),
        Task("T9",  "Inverter install",          duration=2,  predecessors=["T8", "T5"]),
        Task("T10", "Battery install",           duration=2,  predecessors=["T9", "T6"]),
        Task("T11", "Grid connection",           duration=3,  predecessors=["T10"]),
    ]

    result = schedule(tasks, project_start=date(2026, 6, 1), working_days_only=True)

    print(f"Project span: {result.project_span_T} working days")
    print(f"Critical path: {' → '.join(result.critical_path)}")
    print(f"Project end date: {result.sched_end[result.critical_path[-1]]}")
    print()
    print(f"{'ID':<5} {'Name':<30} {'Start':<12} {'End':<12} {'Slack':<6}")
    print("─" * 70)
    for t in tasks:
        print(f"{t.id:<5} {t.name:<30} {result.sched_start[t.id]!s:<12} "
              f"{result.sched_end[t.id]!s:<12} {result.slack[t.id]:<6}")

    # Perturbation: battery procurement slips from 15 → 22 days
    print("\n" + "═" * 70)
    print("Perturbation: battery procurement slips 15 → 22 days")
    print("═" * 70)

    new_result, moved = recompute_after_change(
        tasks, "T6", 22, result,
        project_start=date(2026, 6, 1), working_days_only=True,
    )

    delta = new_result.project_span_T - result.project_span_T
    print(f"New span: {new_result.project_span_T} days ({'+' if delta >= 0 else ''}{delta})")
    print(f"New end date: {new_result.sched_end[new_result.critical_path[-1]]}")
    print(f"New critical path: {' → '.join(new_result.critical_path)}")
    print(f"Tasks shifted: {', '.join(moved) or 'none'}")
    print()
    print(f"{'ID':<5} {'Name':<30} {'Was':<12} {'Now':<12} {'Δ days':<7}")
    print("─" * 75)
    for tid in moved:
        t = next(x for x in tasks if x.id == tid)
        was = result.sched_end[tid]
        now = new_result.sched_end[tid]
        print(f"{t.id:<5} {t.name:<30} {was!s:<12} {now!s:<12} {(now-was).days:<7}")
