// ============================================================
// Scheduler — CPM with DP forward/backward passes
// JS port of scripts/scheduler.py. Same algorithm, same result shape.
//   • Edge types: FS (default), SS, FF, with integer lag/lead in days
//   • Forward pass → ES/EF, Backward pass → LS/LF
//   • slack, critical path, infeasibility detection
//   • Working-day calendar projection (skips Sat/Sun + optional holiday set)
//   • Incremental recompute when one task's duration changes
// ============================================================

// ───────────────────── Predecessor string parser ─────────────────────
// "T1" → FS+0   "T1+14" → FS+14   "T1SS+5" → SS+5   "T1FF-2" → FF-2
const PRED_RE = /^([\w.\-]+)(FS|SS|FF)?([+-]\d+)?$/;

export function parsePredecessor(s) {
  const m = PRED_RE.exec(String(s).trim());
  if (!m) throw new Error(`Cannot parse predecessor: ${JSON.stringify(s)}`);
  return { predId: m[1], type: m[2] || "FS", lag: m[3] ? parseInt(m[3], 10) : 0 };
}

// ───────────────────────── Graph construction ─────────────────────────
export function buildGraph(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const successors = new Map();   // id → [{ id, edge }]
  const predecessors = new Map(); // id → [edge]
  for (const t of tasks) {
    if (t.duration < 0) throw new Error(`Task ${t.id} has negative duration ${t.duration}`);
    successors.set(t.id, []);
    predecessors.set(t.id, []);
  }
  for (const t of tasks) {
    for (const raw of (t.predecessors || [])) {
      const e = parsePredecessor(raw);
      if (!byId.has(e.predId))
        throw new Error(`Task ${t.id} references unknown predecessor ${e.predId}`);
      predecessors.get(t.id).push(e);
      successors.get(e.predId).push({ id: t.id, edge: e });
    }
  }
  return { successors, predecessors };
}

// ───────────────── Topological sort + cycle detection ─────────────────
export class CycleError extends Error {}

export function topoSort(tasks, successors, predecessors) {
  const inDeg = new Map(tasks.map(t => [t.id, predecessors.get(t.id).length]));
  const queue = tasks.filter(t => inDeg.get(t.id) === 0).map(t => t.id);
  const order = [];
  while (queue.length) {
    const u = queue.shift();
    order.push(u);
    for (const { id: v } of successors.get(u)) {
      inDeg.set(v, inDeg.get(v) - 1);
      if (inDeg.get(v) === 0) queue.push(v);
    }
  }
  if (order.length < tasks.length) {
    const cyc = findCycleDFS(tasks, successors);
    throw new CycleError(`Cycle detected: ${cyc.join(" → ")}`);
  }
  return order;
}

function findCycleDFS(tasks, successors) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(tasks.map(t => [t.id, WHITE]));
  const parent = new Map(tasks.map(t => [t.id, null]));
  function dfs(u) {
    color.set(u, GRAY);
    for (const { id: v } of (successors.get(u) || [])) {
      if (color.get(v) === GRAY) {
        const path = [v, u];
        let node = parent.get(u);
        while (node && node !== v) { path.push(node); node = parent.get(node); }
        path.push(v);
        return path.reverse();
      }
      if (color.get(v) === WHITE) {
        parent.set(v, u);
        const cyc = dfs(v);
        if (cyc) return cyc;
      }
    }
    color.set(u, BLACK);
    return null;
  }
  for (const t of tasks) {
    if (color.get(t.id) === WHITE) {
      const cyc = dfs(t.id);
      if (cyc) return cyc;
    }
  }
  return ["?"];
}

// ───────────────────────── Forward pass ─────────────────────────
export function forwardPass(order, tasksById, predecessors) {
  const ES = {}, EF = {};
  for (const u of order) {
    const d = tasksById.get(u).duration;
    const preds = predecessors.get(u);
    if (!preds.length) {
      ES[u] = 0;
    } else {
      const cands = preds.map(e => {
        if (e.type === "FS") return EF[e.predId] + e.lag;
        if (e.type === "SS") return ES[e.predId] + e.lag;
        if (e.type === "FF") return EF[e.predId] + e.lag - d;
        throw new Error(`Unknown edge type: ${e.type}`);
      });
      ES[u] = Math.max(...cands);
    }
    EF[u] = ES[u] + d;
  }
  const T = order.length ? Math.max(...Object.values(EF)) : 0;
  return { ES, EF, T };
}

// ───────────────────────── Backward pass ─────────────────────────
export function backwardPass(order, tasksById, successors, T, deadline = null) {
  const horizon = deadline ?? T;
  const LS = {}, LF = {};
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i];
    const d = tasksById.get(u).duration;
    const outs = successors.get(u);
    if (!outs.length) {
      LF[u] = horizon;
    } else {
      const cands = outs.map(({ id: v, edge: e }) => {
        if (e.type === "FS") return LS[v] - e.lag;
        if (e.type === "SS") return LS[v] - e.lag + d;
        if (e.type === "FF") return LF[v] - e.lag;
        throw new Error(`Unknown edge type: ${e.type}`);
      });
      LF[u] = Math.min(...cands);
    }
    LS[u] = LF[u] - d;
  }
  return { LS, LF };
}

// ───────────── Slack / critical path / infeasibility ─────────────
export function analyse(tasks, ES, LS) {
  const slack = {};
  for (const t of tasks) slack[t.id] = LS[t.id] - ES[t.id];
  return {
    slack,
    critical:   tasks.filter(t => slack[t.id] === 0).map(t => t.id),
    infeasible: tasks.filter(t => slack[t.id] <   0).map(t => t.id),
  };
}

// ───────────────────────── Calendar projection ─────────────────────────
const MS_PER_DAY = 86_400_000;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export function addDays(start, offset, workingOnly, holidays = null) {
  if (!workingOnly) return new Date(start.getTime() + offset * MS_PER_DAY);
  const set = holidays instanceof Set ? holidays : new Set(holidays || []);
  let d = new Date(start);
  let remaining = offset;
  while (remaining > 0) {
    d = new Date(d.getTime() + MS_PER_DAY);
    const dow = d.getDay();   // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6 && !set.has(isoDate(d))) remaining -= 1;
  }
  return d;
}

export function projectDates(offsets, start, workingOnly, holidays = null) {
  const out = {};
  for (const [u, n] of Object.entries(offsets)) {
    out[u] = addDays(start, n, workingOnly, holidays);
  }
  return out;
}

// ───────────────────────── Top-level orchestration ─────────────────────────
export function schedule(tasks, projectStart, {
  workingDaysOnly = true,
  holidays = null,
  deadlineOffset = null,
} = {}) {
  const tasksById = new Map(tasks.map(t => [t.id, t]));
  const { successors, predecessors } = buildGraph(tasks);
  const order = topoSort(tasks, successors, predecessors);
  const { ES, EF, T } = forwardPass(order, tasksById, predecessors);
  const { LS, LF } = backwardPass(order, tasksById, successors, T, deadlineOffset);
  const { slack, critical, infeasible } = analyse(tasks, ES, LS);
  return {
    ES, EF, LS, LF, slack,
    criticalPath: critical,
    infeasibleTasks: infeasible,
    projectSpanT: T,
    schedStart: projectDates(ES, projectStart, workingDaysOnly, holidays),
    schedEnd:   projectDates(EF, projectStart, workingDaysOnly, holidays),
  };
}

// ───────────── Incremental recompute (one duration change) ─────────────
function forwardDescendants(startId, successors) {
  const seen = new Set();
  const q = [startId];
  while (q.length) {
    const u = q.shift();
    for (const { id: v } of (successors.get(u) || [])) {
      if (!seen.has(v)) { seen.add(v); q.push(v); }
    }
  }
  return seen;
}

export function recomputeAfterChange(tasks, changedId, newDuration, prev, projectStart, {
  workingDaysOnly = true,
  holidays = null,
  deadlineOffset = null,
} = {}) {
  const tasksById = new Map(tasks.map(t => [t.id, t]));
  tasksById.get(changedId).duration = newDuration;   // mutate in place, matches Python

  const { successors, predecessors } = buildGraph(tasks);
  const order = topoSort(tasks, successors, predecessors);

  const dirty = new Set([changedId, ...forwardDescendants(changedId, successors)]);
  const subOrder = order.filter(u => dirty.has(u));

  const ES = { ...prev.ES }, EF = { ...prev.EF };
  for (const u of subOrder) {
    const d = tasksById.get(u).duration;
    const preds = predecessors.get(u);
    if (!preds.length) {
      ES[u] = 0;
    } else {
      const cands = preds.map(e => {
        if (e.type === "FS") return EF[e.predId] + e.lag;
        if (e.type === "SS") return ES[e.predId] + e.lag;
        if (e.type === "FF") return EF[e.predId] + e.lag - d;
        throw new Error(`Unknown edge type: ${e.type}`);
      });
      ES[u] = Math.max(...cands);
    }
    EF[u] = ES[u] + d;
  }
  const newT = Math.max(...Object.values(EF));

  // Always re-run backward pass — duration change cascades into ancestor slack.
  const { LS, LF } = backwardPass(order, tasksById, successors, newT, deadlineOffset);
  const { slack, critical, infeasible } = analyse(tasks, ES, LS);

  const moved = [...dirty].filter(u => EF[u] !== prev.EF[u]).sort();

  return {
    result: {
      ES, EF, LS, LF, slack,
      criticalPath: critical,
      infeasibleTasks: infeasible,
      projectSpanT: newT,
      schedStart: projectDates(ES, projectStart, workingDaysOnly, holidays),
      schedEnd:   projectDates(EF, projectStart, workingDaysOnly, holidays),
    },
    moved,
  };
}
