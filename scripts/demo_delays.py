"""Demo: project schedule auto-recalculation when delays occur."""
from datetime import date
from scheduler import Task, schedule, recompute_after_change

def show(result, tasks, header):
    print(f"\n{'═'*78}\n {header}\n{'═'*78}")
    end_date = result.sched_end[result.critical_path[-1]]
    print(f" Project span: {result.project_span_T} working days   |   Ends: {end_date}")
    print(f" Critical path: {' → '.join(result.critical_path)}")
    print()
    print(f" {'ID':<5}{'Name':<30}{'Start':<13}{'End':<13}{'Slack':<7}{'Critical':<8}")
    print(" " + "─"*72)
    for t in tasks:
        crit = "★" if t.id in result.critical_path else ""
        print(f" {t.id:<5}{t.name:<30}{result.sched_start[t.id]!s:<13}"
              f"{result.sched_end[t.id]!s:<13}{result.slack[t.id]:<7}{crit:<8}")

def diff(prev, new, tasks, header):
    moved = [t for t in tasks if prev.sched_end[t.id] != new.sched_end[t.id]]
    print(f"\n{'─'*78}\n {header}\n{'─'*78}")
    delta = new.project_span_T - prev.project_span_T
    if delta == 0:
        print(" ✓ Delay absorbed — project end date UNCHANGED.")
    else:
        print(f" ⚠ Project end shifted by +{delta} working days "
              f"({prev.sched_end[prev.critical_path[-1]]} → "
              f"{new.sched_end[new.critical_path[-1]]})")
    print(f" Tasks affected: {len(moved)}")
    if moved:
        print(f"\n {'ID':<5}{'Name':<30}{'Was':<13}{'Now':<13}{'Slip':<7}")
        print(" " + "─"*72)
        for t in moved:
            was, now = prev.sched_end[t.id], new.sched_end[t.id]
            print(f" {t.id:<5}{t.name:<30}{was!s:<13}{now!s:<13}+{(now-was).days}d")

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
cfg = dict(project_start=date(2026, 6, 1), working_days_only=True)

r0 = schedule(tasks, **cfg)
show(r0, tasks, "INITIAL SCHEDULE")

# Delay 1 — Inverter procurement slips 10 → 12 days (should be absorbed)
print("\n\n>>> DELAY 1: Inverter procurement slips +2 days (10 → 12)")
r1, _ = recompute_after_change(tasks, "T5", 12, r0, **cfg)
diff(r0, r1, tasks, "After Delay 1")

# Delay 2 — Battery procurement slips 15 → 22 days (pushes end out)
print("\n\n>>> DELAY 2: Battery procurement slips +7 days (15 → 22)")
r2, _ = recompute_after_change(tasks, "T6", 22, r1, **cfg)
diff(r1, r2, tasks, "After Delay 2")
show(r2, tasks, "SCHEDULE AFTER BATTERY DELAY")

# Delay 3 — Panel procurement slips 12 → 18 days (no impact — battery is now bottleneck)
print("\n\n>>> DELAY 3: Panel procurement slips +6 days (12 → 18)")
r3, _ = recompute_after_change(tasks, "T4", 18, r2, **cfg)
diff(r2, r3, tasks, "After Delay 3")
