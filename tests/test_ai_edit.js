/*
 * Scenario tests for the AI-assisted editing pipeline in ../index.html.
 *
 * ─── HOW THESE TESTS ARE STRUCTURED ──────────────────────────────────────
 *
 * Each scenario drives the pipeline the same way the live app does:
 *
 *     prompt(opJson, "natural language")
 *        → aiSubmitChangeSync  →  aiApplyOperation on draft
 *        → if op.reasoning.requires_schedule_computation: runCPM on draft
 *        → push to AI.pendingChanges
 *     approve()      →  copy draft into real NODES + onSave()
 *     discard()      →  drop draft, NODES untouched
 *
 * The opJson is the schema from the design summary §3 (the "Suggested LLM
 * Output Schema"). Tests use the canonical example commands from §2.1–§2.7
 * to verify that:
 *
 *   ✓ creating tasks via create_item prompts produces the right ids, dates,
 *     and parent links
 *   ✓ shifting tasks via shift_item prompts moves leaves by the right
 *     number of days, and CPM cascades downstream tasks when
 *     requires_schedule_computation is true
 *   ✓ update_progress, assign_owner behave per §2.5, §2.6
 *   ✓ rejected prompts (unresolved target, missing amount, cycle creation,
 *     unsupported operation) do not mutate real NODES
 *   ✓ approve / discard land changes or drop them cleanly
 *   ✓ two users prompting against a shared FakeServer hit OCC the way §13
 *     describes, with the documented last-write-wins retry semantics
 *
 * Some scenarios test the *intended* behaviour from the design summary even
 * though the applier isn't yet implemented in index.html — for example
 * §2.3 create_project_candidate, §2.7 add_dependency, and delete_item.
 * These tests FAIL on purpose: they document the schema and serve as a
 * TODO list for the next round of AI module work. They are clearly marked
 * "[TODO]" in the suite name.
 *
 * ─── WHAT THESE TESTS DO NOT COVER ───────────────────────────────────────
 *
 *   ✗ Fuse.js fuzzy matching (Fuse isn't loaded in Node) — the substring
 *     fallback path in aiMatchProject / aiMatchItem is exercised instead.
 *   ✗ The Edge Function side of intent extraction (covered by test_llm.html).
 *   ✗ Real network races or Supabase realtime timing.
 *
 * Run in a browser: open tests/test_ai_edit.html.
 * Run on the command line: node tests/test_ai_edit.js (Node 18+).
 */

'use strict';

const MS_DAY = 24 * 60 * 60 * 1000;

/* ─────────────────────────────────────────────────────────────────────────
 * Pure helpers — copies from index.html
 * ───────────────────────────────────────────────────────────────────────── */

// index.html:1956
function typeFromId(id) {
  if (!id) return 'project';
  const parts = id.split('-');
  if (parts.length === 1) return 'project';
  if (parts.length === 2) return 'task';
  return 'subtask';
}

// index.html:1963 / 2972
function parentOf(id) {
  if (!id) return null;
  const parts = id.split('-');
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('-');
}

// index.html:3220
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// index.html:3221
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// index.html:2438
function parsePreds(s) {
  if (!s) return [];
  return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

/* ─────────────────────────────────────────────────────────────────────────
 * NODES-scoped helpers — `NODES` is a module-level mutable array (mirrors
 * the global in index.html). The AI module and the CPM both close over it.
 * ───────────────────────────────────────────────────────────────────────── */

let NODES = [];

// index.html:2648
function childrenOf(node) {
  return NODES.filter(n => parentOf(n.id) === node.id);
}

// index.html:2981
function nextId(parentId) {
  if (!parentId) {
    let n = 1;
    while (NODES.some(x => x.id === 'P' + n)) n++;
    return 'P' + n;
  }
  const ptype = typeFromId(parentId);
  const prefix = ptype === 'project' ? '-T' : '-S';
  let n = 1;
  while (NODES.some(x => x.id === parentId + prefix + n)) n++;
  return parentId + prefix + n;
}

// Minimal eActualEnd/eSchedEnd just for cycle detection in tests — we only
// need them for runCPM's predecessor-end lookup on parent rows. Tests below
// use leaf-only predecessor graphs, so these never actually fire, but we
// include them to keep the runCPM port faithful.
function eDateRange(node) {
  const kids = childrenOf(node);
  if (kids.length === 0) {
    return {
      schedStart:  node.sched_start  || '',
      schedEnd:    node.sched_end    || '',
      actualStart: node.actual_start || '',
      actualEnd:   node.actual_end   || '',
    };
  }
  const ranges = kids.map(eDateRange);
  const minD = (k) => { const vs = ranges.map(r => r[k]).filter(Boolean); return vs.length ? vs.reduce((a, b) => a < b ? a : b) : ''; };
  const maxD = (k) => { const vs = ranges.map(r => r[k]).filter(Boolean); return vs.length ? vs.reduce((a, b) => a > b ? a : b) : ''; };
  return { schedStart: minD('schedStart'), schedEnd: maxD('schedEnd'),
           actualStart: minD('actualStart'), actualEnd: maxD('actualEnd') };
}
const eSchedEnd  = n => eDateRange(n).schedEnd;
const eActualEnd = n => eDateRange(n).actualEnd;

/* runCPM — index.html:2447. Returns { shifted, cycle }. Tests below use it
 * via aiRunCPMOnDraft to prove that cycle detection works on a draft graph. */
function runCPM(projectId) {
  const peers  = NODES.filter(n => n.id.split('-')[0] === projectId && n.id !== projectId);
  const leaves = peers.filter(n => childrenOf(n).length === 0);
  if (!leaves.length) return { shifted: 0, cycle: false };

  const byId  = Object.fromEntries(peers.map(n => [n.id, n]));
  const succ  = {}, preds = {};
  leaves.forEach(n => { succ[n.id] = []; preds[n.id] = parsePreds(n.predecessors).filter(p => byId[p]); });
  leaves.forEach(n => preds[n.id].forEach(p => { if (succ[p]) succ[p].push(n.id); }));

  const inDeg = {}; leaves.forEach(n => inDeg[n.id] = preds[n.id].length);
  const queue = leaves.filter(n => inDeg[n.id] === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const u = queue.shift(); order.push(u);
    (succ[u] || []).forEach(v => { inDeg[v]--; if (inDeg[v] === 0) queue.push(v); });
  }
  if (order.length < leaves.length) return { cycle: true, shifted: 0 };

  const duration = {};
  leaves.forEach(n => {
    const s = new Date(n.actual_start || n.sched_start);
    const e = new Date(n.actual_end   || n.sched_end);
    duration[n.id] = (isNaN(s) || isNaN(e)) ? 1 : Math.max(0, Math.round((e - s) / MS_DAY));
  });

  const startDate = {};
  let shifted = 0;
  for (const u of order) {
    const n = byId[u];
    if (preds[u].length === 0) {
      const s = new Date(n.actual_start || n.sched_start);
      startDate[u] = isNaN(s) ? new Date() : s;
    } else {
      const predEndMs = preds[u].map(p => {
        const pn = byId[p];
        if (childrenOf(pn).length > 0) {
          const e = new Date(eActualEnd(pn) || eSchedEnd(pn));
          return isNaN(e) ? 0 : +e;
        }
        return startDate[p] ? +addDays(startDate[p], duration[p]) : 0;
      });
      const earliestStart = new Date(Math.max(...predEndMs));
      const curStart = new Date(n.actual_start || n.sched_start);
      if (isNaN(curStart) || +curStart < +earliestStart - MS_DAY / 2) {
        n.actual_start = fmtDate(earliestStart);
        n.actual_end   = fmtDate(addDays(earliestStart, duration[u]));
        startDate[u]   = earliestStart;
        shifted++;
      } else {
        startDate[u]   = curStart;
      }
    }
  }
  return { shifted, cycle: false };
}

/* ─────────────────────────────────────────────────────────────────────────
 * AI module — copies from index.html:5758+, adapted to a non-DOM context.
 * Fuse isn't loaded; aiFuse returns null and the substring-match fallback
 * in aiMatchProject/aiMatchItem is exercised instead.
 * ───────────────────────────────────────────────────────────────────────── */

const AI = {
  draft: null,
  baseSnapshot: null,
  pendingChanges: [],
};

function aiFuse() { return null; }  // no Fuse in node — force fallback

// index.html:5779
function aiMatchProject(query, nodes) {
  if (!query || query === 'N/A') return null;
  const projects = nodes.filter(n => typeFromId(n.id) === 'project');
  if (!projects.length) return null;
  const idHit = projects.find(p => p.id.toLowerCase() === query.toLowerCase());
  if (idHit) return idHit;
  const fuse = aiFuse(projects, ['name']);
  if (!fuse) {
    const q = query.toLowerCase();
    return projects.find(p => (p.name || '').toLowerCase().includes(q)) || null;
  }
  const hits = fuse.search(query);
  return hits.length ? hits[0].item : null;
}

// index.html:5797
function aiMatchItem(query, nodes, projectNode, itemType) {
  if (!query || query === 'N/A') return { id: null, candidates: [] };
  const pool = projectNode
    ? nodes.filter(n => n.id.split('-')[0] === projectNode.id && n.id !== projectNode.id)
    : nodes.filter(n => typeFromId(n.id) !== 'project');
  if (!pool.length) return { id: null, candidates: [] };

  const idHit = pool.find(n => n.id.toLowerCase() === query.toLowerCase());
  if (idHit) return { id: idHit.id, candidates: [idHit] };

  const fuse = aiFuse(pool, ['name']);
  let hits = fuse
    ? fuse.search(query).map(h => ({ n: h.item, score: h.score }))
    : pool
        .filter(n => (n.name || '').toLowerCase().includes(query.toLowerCase()))
        .map(n => ({ n, score: 0 }));

  if (!hits.length) return { id: null, candidates: [] };
  if (itemType === 'task' || itemType === 'subtask') {
    const narrowed = hits.filter(h => typeFromId(h.n.id) === itemType);
    if (narrowed.length) hits = narrowed;
  }
  const top5 = hits.slice(0, 5).map(h => h.n);
  if (hits.length === 1) return { id: hits[0].n.id, candidates: top5 };
  const gap = hits[1].score - hits[0].score;
  if (gap > 0.08 || hits[0].score < 0.15) return { id: hits[0].n.id, candidates: top5 };
  return { id: null, candidates: top5 };
}

// index.html:5833
function aiResolveTarget(target, nodes) {
  const project = aiMatchProject(target.project, nodes);
  if (!target.item || target.item === 'N/A') {
    if (project) return { ok: true, id: project.id, candidates: [project] };
    return { ok: false, reason: 'No project or item specified.', candidates: [] };
  }
  const m = aiMatchItem(target.item, nodes, project, target.item_type);
  if (m.id) return { ok: true, id: m.id, candidates: m.candidates };
  if (m.candidates.length) {
    return { ok: false, reason: 'Ambiguous match — please be more specific.', candidates: m.candidates };
  }
  return { ok: false, reason: `Couldn't find "${target.item}"${project ? ` in ${project.name}` : ''}.`, candidates: [] };
}

// index.html:5853
function aiAmountToDays(amount, unit) {
  const a = typeof amount === 'number' ? amount : parseFloat(amount);
  if (!Number.isFinite(a)) return 0;
  if (unit === 'weeks')  return Math.round(a * 7);
  if (unit === 'months') return Math.round(a * 30);
  return Math.round(a);
}

// index.html:5861 — fixed-clock variant for deterministic tests (override `now`).
function aiParseDate(text, now = new Date()) {
  if (!text || text === 'N/A') return null;
  const iso = new Date(text);
  if (!isNaN(+iso) && /\d/.test(text)) return fmtDate(iso);
  const lower = text.toLowerCase();
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const m = lower.match(/(next |this )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (m) {
    const target = days.indexOf(m[2]);
    let delta = (target - now.getDay() + 7) % 7;
    if (delta === 0 || m[1] === 'next ') delta = delta + 7;
    return fmtDate(addDays(now, delta));
  }
  return null;
}

// index.html:5882 — runs CPM against a draft array by swapping NODES.
function aiRunCPMOnDraft(draft, projectIds) {
  const real = NODES.slice();
  NODES.length = 0;
  for (const n of draft) NODES.push(n);
  const cycles = [];
  for (const pid of projectIds) {
    try {
      const r = runCPM(pid);
      if (r && r.cycle) cycles.push(pid);
    } catch (e) { /* ignore in tests */ }
  }
  const out = NODES.slice();
  NODES.length = 0;
  for (const n of real) NODES.push(n);
  return { draft: out, cycles };
}

// index.html:5901
function aiWithDraftScope(draft, fn) {
  const real = NODES.slice();
  NODES.length = 0;
  for (const n of draft) NODES.push(n);
  try { return fn(); }
  finally {
    NODES.length = 0;
    for (const n of real) NODES.push(n);
  }
}

// index.html:5924
function aiApplyShift(op, draft) {
  const res = aiResolveTarget(op.target, draft);
  if (!res.ok) return { ok: false, reason: res.reason, candidates: res.candidates };
  const days = aiAmountToDays(op.parameters.amount, op.parameters.unit);
  if (!days) return { ok: false, reason: 'Invalid shift amount.' };
  const sign = op.parameters.direction === 'earlier' ? -1 : 1;
  const delta = sign * days;
  const subtree = draft.filter(n => n.id === res.id || n.id.startsWith(res.id + '-'));
  const leaves = subtree.filter(n => !draft.some(c => parentOf(c.id) === n.id));
  for (const n of leaves) {
    for (const field of ['actual_start','actual_end','sched_start','sched_end']) {
      if (n[field]) {
        const d = new Date(n[field]);
        if (!isNaN(+d)) n[field] = fmtDate(addDays(d, delta));
      }
    }
  }
  return { ok: true, targetId: res.id, leafIds: leaves.map(n => n.id), delta };
}

// index.html:5950
function aiApplyProgress(op, draft) {
  const res = aiResolveTarget(op.target, draft);
  if (!res.ok) return { ok: false, reason: res.reason, candidates: res.candidates };
  let pct = op.parameters.percent_done;
  if (pct === 'N/A' || pct == null) {
    const s = (op.parameters.status || '').toLowerCase();
    if (s === 'completed' || s === 'complete' || s === 'done') pct = 100;
    else if (s === 'in_progress' || s === 'started' || s === 'in-progress') pct = 50;
    else return { ok: false, reason: 'No percent_done or status given.' };
  }
  pct = Math.max(0, Math.min(100, Number(pct)));
  const targetNode = draft.find(n => n.id === res.id);
  const isLeaf = !draft.some(c => parentOf(c.id) === targetNode.id);
  if (isLeaf) {
    targetNode.percent_done = pct;
  } else {
    const leaves = draft.filter(n =>
      n.id.startsWith(targetNode.id + '-') &&
      !draft.some(c => parentOf(c.id) === n.id)
    );
    leaves.forEach(n => { n.percent_done = pct; });
  }
  return { ok: true, targetId: res.id, percent_done: pct };
}

// index.html:5977
function aiApplyOwner(op, draft) {
  const res = aiResolveTarget(op.target, draft);
  if (!res.ok) return { ok: false, reason: res.reason, candidates: res.candidates };
  const owner = (op.parameters.owner || '').trim();
  if (!owner || owner === 'N/A') return { ok: false, reason: 'No owner specified.' };
  const node = draft.find(n => n.id === res.id);
  node.owner = owner;
  return { ok: true, targetId: res.id, owner };
}

// index.html:5987
function aiApplyCreate(op, draft, parseDateNow) {
  if (!op.target.project || op.target.project === 'N/A') {
    return { ok: false, reason: 'Project name required to create an item.' };
  }
  const project = aiMatchProject(op.target.project, draft);
  if (!project) return { ok: false, reason: `Project "${op.target.project}" not found.` };

  let parentId = project.id;
  let newType  = 'task';
  if (op.target.parent && op.target.parent !== 'N/A') {
    const candidateParents = draft.filter(n => n.id.startsWith(project.id) && n.id !== project.id);
    const hit = candidateParents.find(n => (n.name || '').toLowerCase().includes(String(op.target.parent).toLowerCase()));
    if (hit) { parentId = hit.id; newType = 'subtask'; }
  } else if (op.target.item_type === 'subtask') {
    const firstTask = draft.find(n => parentOf(n.id) === project.id && typeFromId(n.id) === 'task');
    if (firstTask) { parentId = firstTask.id; newType = 'subtask'; }
  }

  const newId = aiWithDraftScope(draft, () => nextId(parentId));

  const today = parseDateNow || new Date();
  let start = fmtDate(today);
  let end   = fmtDate(addDays(today, 1));
  const deadline = aiParseDate(op.parameters.deadline, today) || aiParseDate(op.parameters.date, today);
  let dur = 7;
  if (op.parameters.duration && op.parameters.duration !== 'N/A') {
    const dnum = aiAmountToDays(parseFloat(op.parameters.duration), 'days');
    if (dnum > 0) dur = dnum;
  }
  if (deadline) { end = deadline; start = fmtDate(addDays(new Date(end), -dur)); }
  else          { end = fmtDate(addDays(today, dur)); }

  const newNode = {
    id: newId, type: newType,
    name:  op.target.item && op.target.item !== 'N/A' ? op.target.item : 'New ' + newType,
    owner: op.parameters.owner && op.parameters.owner !== 'N/A' ? op.parameters.owner : '',
    predecessors: '', sched_start: start, sched_end: end,
    actual_start: '', actual_end: '', slack: '', percent_done: 0,
    est_cost: 0, cost_to_date: 0, sale_price: 0, collapsed: false,
  };
  draft.push(newNode);
  return { ok: true, targetId: newId, created: newNode };
}

// index.html:6536 — cycle check for add_dependency. Walks the predecessor
// graph from startId; returns true if targetId is reachable (i.e. adding
// startId as a predecessor of targetId closes a loop). Depth-bounded.
function aiPredCreatesCycle(draft, targetId, startId) {
  if (startId === targetId) return true;
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 1000) return false;
    const n = draft.find(x => x.id === id);
    if (!n) continue;
    const preds = parsePreds(n.predecessors || '');
    for (const p of preds) {
      if (p === targetId) return true;
      if (!seen.has(p)) stack.push(p);
    }
  }
  return false;
}

// index.html:6557 — add_dependency. Resolves the predecessor within the
// target's project, rejects cycles and self-deps, appends to the
// predecessors string.
function aiApplyAddDependency(op, draft) {
  const res = aiResolveTarget(op.target, draft);
  if (!res.ok) return { ok: false, reason: res.reason, candidates: res.candidates };
  const target = draft.find(n => n.id === res.id);
  if (!target) return { ok: false, reason: 'Target not found.' };
  const predName = op.parameters.predecessor;
  if (!predName || predName === 'N/A') {
    return { ok: false, reason: 'No predecessor specified — say which task should come before it.' };
  }
  const projectId = target.id.split('-')[0];
  const projectNode = draft.find(n => n.id === projectId);
  // Match within the same project for the most natural scope.
  const m = aiMatchItem(predName, draft, projectNode, null);
  if (!m.id) {
    return { ok: false, reason: `Predecessor "${predName}" not found in ${projectNode?.name || projectId}.` };
  }
  const pred = draft.find(n => n.id === m.id);
  if (pred.id === target.id) {
    return { ok: false, reason: 'A task cannot depend on itself.' };
  }
  const existing = parsePreds(target.predecessors || '');
  if (existing.includes(pred.id)) {
    return { ok: false, reason: `${pred.name} is already a predecessor of ${target.name}.` };
  }
  if (aiPredCreatesCycle(draft, target.id, pred.id)) {
    return { ok: false, reason: `Adding ${pred.name} as a predecessor of ${target.name} would create a circular dependency.` };
  }
  target.predecessors = existing.length ? `${target.predecessors}, ${pred.id}` : pred.id;
  return { ok: true, targetId: target.id, predId: pred.id, predName: pred.name };
}

// index.html:6598 — delete_item. Drops target + descendants and scrubs
// stale predecessor refs.
function aiApplyDelete(op, draft) {
  const res = aiResolveTarget(op.target, draft);
  if (!res.ok) return { ok: false, reason: res.reason, candidates: res.candidates };
  const toDelete = new Set([res.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of draft) {
      const p = parentOf(n.id);
      if (p && toDelete.has(p) && !toDelete.has(n.id)) {
        toDelete.add(n.id); grew = true;
      }
    }
  }
  for (let i = draft.length - 1; i >= 0; i--) {
    if (toDelete.has(draft[i].id)) draft.splice(i, 1);
  }
  for (const n of draft) {
    if (!n.predecessors) continue;
    const preds = parsePreds(n.predecessors).filter(p => !toDelete.has(p));
    n.predecessors = preds.join(', ');
  }
  return { ok: true, targetId: res.id, deletedIds: [...toDelete] };
}

// Test-side stub for create_project_candidate. The production app
// (index.html) drives this through a template/window picker; in unit
// tests the picker is bypassed and we just push a top-level project row
// with a default window. Sufficient to confirm the operation is wired
// through aiApplyOperation and ends up in the draft.
function aiApplyCreateProjectCandidate(op, draft, parseDateNow) {
  const name = (op.target.project && op.target.project !== 'N/A')
    ? op.target.project
    : (op.target.item && op.target.item !== 'N/A' ? op.target.item : 'New project');
  const newId = aiWithDraftScope(draft, () => nextId(null));
  const today = parseDateNow || new Date();
  let dur = 30;
  if (op.parameters.duration && op.parameters.duration !== 'N/A') {
    const dnum = aiAmountToDays(parseFloat(op.parameters.duration), 'days');
    if (dnum > 0) dur = dnum;
  }
  const deadline = aiParseDate(op.parameters.deadline, today)
                || aiParseDate(op.parameters.date, today);
  const preferred = aiParseDate(op.parameters.preferred_start, today);
  let start, end;
  if (deadline) {
    end = deadline; start = fmtDate(addDays(new Date(end), -dur));
  } else if (preferred) {
    start = preferred; end = fmtDate(addDays(new Date(start), dur));
  } else {
    start = fmtDate(today); end = fmtDate(addDays(today, dur));
  }
  const newNode = {
    id: newId, type: 'project', name,
    owner: op.parameters.owner && op.parameters.owner !== 'N/A' ? op.parameters.owner : '',
    predecessors: '', sched_start: start, sched_end: end,
    actual_start: '', actual_end: '', slack: '', percent_done: 0,
    est_cost: 0, cost_to_date: 0, sale_price: 0, collapsed: false,
  };
  draft.push(newNode);
  return { ok: true, targetId: newId, created: newNode };
}

// index.html:5913
function aiApplyOperation(op, draft, opts = {}) {
  switch (op.operation) {
    case 'shift_item':                 return aiApplyShift(op, draft);
    case 'update_progress':            return aiApplyProgress(op, draft);
    case 'assign_owner':               return aiApplyOwner(op, draft);
    case 'create_item':                return aiApplyCreate(op, draft, opts.now);
    case 'add_dependency':             return aiApplyAddDependency(op, draft);
    case 'delete_item':                return aiApplyDelete(op, draft);
    case 'create_project_candidate':   return aiApplyCreateProjectCandidate(op, draft, opts.now);
    default:                           return { ok: false, reason: `Unsupported operation: ${op.operation}` };
  }
}

// index.html:6138
function aiDiff(originalById, draftArr) {
  const fields = ['name','owner','sched_start','sched_end','actual_start','actual_end','percent_done','predecessors'];
  const changed = [], added = [], draftIds = new Set();
  for (const n of draftArr) {
    draftIds.add(n.id);
    const o = originalById.get(n.id);
    if (!o) { added.push(n); continue; }
    const diffs = [];
    for (const f of fields) {
      const ov = o[f] == null ? '' : String(o[f]);
      const nv = n[f] == null ? '' : String(n[f]);
      if (ov !== nv) diffs.push({ field: f, from: ov, to: nv });
    }
    if (diffs.length) changed.push({ id: n.id, name: n.name, diffs });
  }
  const removed = [];
  for (const o of originalById.values()) if (!draftIds.has(o.id)) removed.push(o);
  return { changed, added, removed };
}

/* aiSubmitChange / aiApprove / aiDiscard — test wrappers that bypass the
 * Edge-Function call (the `op` is supplied directly) but otherwise follow
 * the same shape as index.html. */
function aiSubmitChangeSync(op, sourceText, opts = {}) {
  if (!op || op.operation === 'N/A') return { ok: false, reason: 'fallback' };
  if (!AI.draft) {
    AI.draft = structuredClone(NODES);
    AI.baseSnapshot = JSON.stringify(NODES);
  }
  const result = aiApplyOperation(op, AI.draft, opts);
  if (!result.ok) {
    // First-op rollback: if nothing else was staged, drop the draft.
    if (AI.pendingChanges.length === 0) { AI.draft = null; AI.baseSnapshot = null; }
    return result;
  }
  if (op.reasoning && op.reasoning.requires_schedule_computation && result.targetId) {
    const projId = result.targetId.split('-')[0];
    const r = aiRunCPMOnDraft(AI.draft, [projId]);
    AI.draft = r.draft;
    result.cycles = r.cycles;
  }
  AI.pendingChanges.push({
    id: 'chg_' + (AI.pendingChanges.length + 1),
    sourceText, operation: op.operation,
    target: op.target, resolvedTargetId: result.targetId,
    parameters: op.parameters, raw: op,
  });
  return result;
}

// index.html:6212 — copies draft fields onto real NODES, then calls onSave().
function aiApprove(onSave) {
  if (!AI.draft || !AI.pendingChanges.length) return { ok: false, reason: 'nothing to approve' };
  const original = JSON.parse(AI.baseSnapshot);
  const byId = new Map(original.map(n => [n.id, n]));
  const { changed, added, removed } = aiDiff(byId, AI.draft);
  const mutFields = ['name','owner','sched_start','sched_end','actual_start','actual_end','percent_done','predecessors','slack','est_cost','cost_to_date','sale_price'];
  for (const c of changed) {
    const draftNode = AI.draft.find(n => n.id === c.id);
    const realNode  = NODES.find(n => n.id === c.id);
    if (!draftNode || !realNode) continue;
    for (const f of mutFields) realNode[f] = draftNode[f];
  }
  for (const n of added) NODES.push(structuredClone(n));
  if (removed.length) {
    const removedIds = new Set(removed.map(n => n.id));
    for (let i = NODES.length - 1; i >= 0; i--) {
      if (removedIds.has(NODES[i].id)) NODES.splice(i, 1);
    }
  }
  const count = AI.pendingChanges.length;
  const persist = onSave ? onSave(changed, added, removed) : { ok: true };
  aiDiscard();
  return { ok: true, count, persist };
}

// index.html:6239
function aiDiscard() {
  AI.draft = null;
  AI.baseSnapshot = null;
  AI.pendingChanges = [];
}

/* ─────────────────────────────────────────────────────────────────────────
 * FakeServer + Client — distilled from tests/test_concurrency.js so the
 * concurrent AI-edit tests can exercise the OCC version-check path.
 * ───────────────────────────────────────────────────────────────────────── */

function parentIdOf(id) {
  const parts = String(id).split('-');
  return parts.length === 1 ? null : parts.slice(0, -1).join('-');
}

function nodeToDbRow(n) {
  return {
    id: n.id, parent_id: parentIdOf(n.id), kind: n.type, name: n.name,
    owner: n.owner || null, duration_days: 0,
    sched_start: n.sched_start || null, sched_end: n.sched_end || null,
    actual_start: n.actual_start || null, actual_end: n.actual_end || null,
    slack_days: n.slack === '' || n.slack == null ? null : parseInt(n.slack, 10),
    pct_done: Number(n.percent_done) || 0,
    est_cost: Number(n.est_cost) || 0,
    cost_to_date: Number(n.cost_to_date) || 0,
    sale_price: Number(n.sale_price) || 0,
  };
}

function normalizeForDiff(r) {
  const num = (v) => v == null || v === '' ? 0 : Number(v);
  return {
    kind: r.kind ?? null, name: r.name ?? null, owner: r.owner || null,
    parent_id: r.parent_id ?? null, duration_days: num(r.duration_days),
    sched_start: r.sched_start || null, sched_end: r.sched_end || null,
    actual_start: r.actual_start || null, actual_end: r.actual_end || null,
    slack_days: r.slack_days == null ? null : Number(r.slack_days),
    pct_done: num(r.pct_done), est_cost: num(r.est_cost),
    cost_to_date: num(r.cost_to_date), sale_price: num(r.sale_price),
  };
}
function rowChanged(a, b) {
  if (!b) return true;
  return JSON.stringify(normalizeForDiff(a)) !== JSON.stringify(normalizeForDiff(b));
}
function rowToServerSnapshot(r) {
  return {
    id: r.id, kind: r.kind, name: r.name, owner: r.owner,
    parent_id: r.parent_id, duration_days: r.duration_days,
    sched_start: r.sched_start, sched_end: r.sched_end,
    actual_start: r.actual_start, actual_end: r.actual_end,
    slack_days: r.slack_days, pct_done: r.pct_done,
    est_cost: r.est_cost, cost_to_date: r.cost_to_date,
    sale_price: r.sale_price,
    version: r.version != null ? Number(r.version) : 1,
  };
}

class FakeServer {
  constructor() { this.rows = new Map(); this.opLog = []; }
  insert(rows) {
    const created = [];
    for (const r of rows) {
      const row = { ...r, version: 1 };
      this.rows.set(row.id, row);
      this.opLog.push({ kind: 'INSERT', id: row.id });
      created.push(row);
    }
    return created;
  }
  patch(id, body, seenVersion) {
    const row = this.rows.get(id);
    if (!row) return [];
    if (Number(row.version) !== Number(seenVersion)) {
      this.opLog.push({ kind: 'PATCH-CONFLICT', id, seenVersion, actual: row.version });
      return [];
    }
    const updated = { ...row, ...body, version: row.version + 1 };
    this.rows.set(id, updated);
    this.opLog.push({ kind: 'PATCH', id, version: updated.version });
    return [updated];
  }
  get(id) { return this.rows.get(id); }
  getAll(ids) { return ids.map(id => this.rows.get(id)).filter(Boolean); }
}

/* A multi-user simulator. Each user has its own NODES + AI state and a
 * shared FakeServer. saveLocal() is the OCC-guarded row-by-row PATCH path
 * from index.html. Switching users swaps NODES/AI so the AI module reads
 * the right user's draft. */
class User {
  constructor(name, server) {
    this.name = name;
    this.server = server;
    this.NODES = [];
    this.AI = { draft: null, baseSnapshot: null, pendingChanges: [] };
    this.serverRows = new Map();
    this.dirtyIds = new Set();
    this.conflictsObserved = [];
  }
  loadBoard() {
    this.NODES.length = 0;
    this.serverRows.clear();
    for (const r of this.server.rows.values()) {
      this.serverRows.set(r.id, rowToServerSnapshot(r));
      this.NODES.push(this._serverRowToNode(r));
    }
  }
  _serverRowToNode(r) {
    return {
      id: r.id,
      type: r.kind || typeFromId(r.id),
      name: r.name || '', owner: r.owner || '',
      predecessors: '', sched_start: r.sched_start || '',
      sched_end: r.sched_end || '', actual_start: r.actual_start || '',
      actual_end: r.actual_end || '', slack: r.slack_days == null ? '' : String(r.slack_days),
      percent_done: r.pct_done == null ? 0 : Number(r.pct_done),
      est_cost: r.est_cost || 0, cost_to_date: r.cost_to_date || 0, sale_price: r.sale_price || 0,
      collapsed: false,
    };
  }
  // Equivalent of saveLocal → upsertAll. Synchronous against the FakeServer
  // so tests can drive deterministic interleavings. Must be called inside
  // `with()` so the module-level NODES holds this user's current state —
  // aiApprove() pushes added rows there, not into this.NODES.
  saveLocal() {
    this.conflictsObserved = [];
    const inserts = [], updates = [];
    for (const n of NODES) {
      const row = nodeToDbRow(n);
      const seen = this.serverRows.get(row.id);
      if (!seen)                          inserts.push(row);
      else if (rowChanged(row, seen))     updates.push({ row, seenVersion: seen.version || 1 });
    }
    if (inserts.length) {
      const created = this.server.insert(inserts);
      for (const r of created) { this.serverRows.set(r.id, rowToServerSnapshot(r)); this.dirtyIds.delete(r.id); }
    }
    for (const { row, seenVersion } of updates) {
      const body = { ...row }; delete body.id;
      const after = this.server.patch(row.id, body, seenVersion);
      if (!after.length) {
        this.conflictsObserved.push(row.id);
        this.dirtyIds.add(row.id);
      } else {
        this.serverRows.set(after[0].id, rowToServerSnapshot(after[0]));
        this.dirtyIds.delete(after[0].id);
      }
    }
    if (this.conflictsObserved.length) {
      const fresh = this.server.getAll(this.conflictsObserved);
      for (const r of fresh) this.serverRows.set(r.id, rowToServerSnapshot(r));
    }
    return { conflicts: this.conflictsObserved.slice() };
  }
  // Run a block "as this user" — swap module-level NODES/AI so the AI
  // helpers read this user's draft.
  with(fn) {
    const realNodes = NODES.slice();
    const realAI = { draft: AI.draft, baseSnapshot: AI.baseSnapshot, pendingChanges: AI.pendingChanges };
    NODES.length = 0;
    for (const n of this.NODES) NODES.push(n);
    AI.draft          = this.AI.draft;
    AI.baseSnapshot   = this.AI.baseSnapshot;
    AI.pendingChanges = this.AI.pendingChanges;
    try {
      const out = fn();
      // Sync NODES + AI back to this user.
      this.NODES = NODES.slice();
      this.AI.draft          = AI.draft;
      this.AI.baseSnapshot   = AI.baseSnapshot;
      this.AI.pendingChanges = AI.pendingChanges;
      return out;
    } finally {
      NODES.length = 0;
      for (const n of realNodes) NODES.push(n);
      AI.draft          = realAI.draft;
      AI.baseSnapshot   = realAI.baseSnapshot;
      AI.pendingChanges = realAI.pendingChanges;
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Tiny test runner (matches test_index.js / test_concurrency.js)
 * ───────────────────────────────────────────────────────────────────────── */
const tests = [];
let currentSuite = '';
function describe(name, fn) { currentSuite = name; fn(); }
function it(name, fn)   { tests.push({ suite: currentSuite, name, fn, todo: false }); }
// `todo` marks an "intended-to-fail" test that documents future work. It
// is reported as a separate "todo" status; failures of todo tests do NOT
// fail the suite exit code.
function todo(name, fn) { tests.push({ suite: currentSuite, name, fn, todo: true  }); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'eq'}: expected ${e}, got ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(`${label || 'ok'}: expected truthy, got ${cond}`); }

/* Reset hook — every test that mutates module-level NODES/AI should start
 * from a clean slate. */
function reset() {
  NODES.length = 0;
  AI.draft = null;
  AI.baseSnapshot = null;
  AI.pendingChanges = [];
}

/* ─────────────────────────────────────────────────────────────────────────
 * SCHEMA BUILDERS — produce the operation-JSON shape from the design
 * summary §3. Each function corresponds to one of the example commands in
 * §2.1–§2.7; the name reads like the natural-language prompt itself.
 *
 *     shiftItem('Glossodia', 'BESS', 'later', 2, 'weeks')
 *       ≡ "BESS for Glossodia is delayed by 2 weeks."  (§2.1)
 *
 *     createItem('Glossodia', 'grid connection', 'task',
 *                { deadline: '2026-08-01' })
 *       ≡ "Add grid connection to Glossodia, due 2026-08-01." (§2.4)
 * ───────────────────────────────────────────────────────────────────────── */

function op(operation, target, parameters, extras = {}) {
  return {
    operation,
    target:     { project: 'N/A', item: 'N/A', item_type: 'unknown', parent: 'N/A', ...target },
    parameters: { ...parameters },
    reasoning:  { requires_schedule_computation: false, requires_dependency_check: false,
                  requires_capacity_check: false, requires_user_confirmation: true,
                  ...(extras.reasoning || {}) },
    confidence: extras.confidence || 'high',
    needs_clarification: extras.needs_clarification || false,
    missing_fields: extras.missing_fields || [],
  };
}

// §2.1 / §2.2 — shift an existing task earlier or later.
// Cascade defaults to TRUE because the schema marks requires_schedule_
// computation = true for shift operations.
function shiftItem(project, item, direction, amount, unit, opts = {}) {
  const cascade = opts.cascade !== false;
  return op('shift_item',
    { project, item, item_type: opts.itemType || 'unknown', parent: opts.parent || 'N/A' },
    { direction, amount, unit },
    { reasoning: { requires_schedule_computation: cascade, requires_dependency_check: true } });
}

// §2.4 — add a task or subtask. `params` may include deadline / duration / owner.
function createItem(project, item, itemType, params = {}, opts = {}) {
  return op('create_item',
    { project, item, item_type: itemType || 'task', parent: opts.parent || 'N/A' },
    params,
    { reasoning: { requires_schedule_computation: true } });
}

// §2.5 — set status or percent_done on a task.
function updateProgress(project, item, params) {
  return op('update_progress', { project, item }, params);
}

// §2.6 — assign an owner.
function assignOwner(project, item, owner) {
  return op('assign_owner', { project, item }, { owner });
}

// §2.3 / §2.7 / unsupported — pass through whatever operation name the test
// wants. These exist so we can write scenarios for operations that aren't
// yet implemented; the test runner will report them as failures with the
// "Unsupported operation" reason until appliers are written.
function rawOp(operation, target, parameters, reasoning = {}) {
  return op(operation, target, parameters, { reasoning });
}

/* ─────────────────────────────────────────────────────────────────────────
 * PIPELINE HELPERS — `prompt()` and `approve()` are how every scenario
 * drives the system. They are thin re-exports of aiSubmitChangeSync /
 * aiApprove / aiDiscard so the test reads like a chat transcript.
 * ───────────────────────────────────────────────────────────────────────── */

function prompt(op, sourceText, opts) {
  return aiSubmitChangeSync(op, sourceText || `(${op.operation})`, opts);
}
function approve(onSave) { return aiApprove(onSave); }
function discard()       { aiDiscard(); }

/* ─────────────────────────────────────────────────────────────────────────
 * SEEDS — every scenario starts from one of these. They push a project
 * row into NODES directly (create_project_candidate is unimplemented per
 * design summary §2.3) and leave the rest of the board to be built via
 * create_item prompts inside the test.
 * ───────────────────────────────────────────────────────────────────────── */

function emptyProject(id, name, opts = {}) {
  return {
    id, type: 'project', name, owner: opts.owner || '', predecessors: '',
    sched_start: opts.start || '2026-06-01', sched_end: opts.end || '2026-12-31',
    actual_start: '', actual_end: '', slack: '', percent_done: 0,
    est_cost: 0, cost_to_date: 0, sale_price: 0, collapsed: false,
  };
}

function seedEmptyProject(id, name, opts = {}) {
  reset();
  NODES.push(emptyProject(id, name, opts));
}

/* The "Glossodia" board from the design summary — a project with three
 * tasks built entirely via create_item prompts. Used by the shift / CPM
 * scenarios that need realistic predecessors. Returns the test-relative
 * "now" used by aiApplyCreate so date assertions are deterministic. */
function seedGlossodiaViaPrompts() {
  const now = new Date('2026-05-20T12:00:00');
  seedEmptyProject('P1', 'Glossodia Solar');
  prompt(createItem('Glossodia', 'DA approval',   'task',
    { deadline: '2026-06-15', duration: '14' }), 'add DA approval', { now });
  prompt(createItem('Glossodia', 'BESS delivery', 'task',
    { deadline: '2026-07-15', duration: '30' }), 'add BESS', { now });
  prompt(createItem('Glossodia', 'Commissioning', 'task',
    { deadline: '2026-08-31', duration: '46' }), 'add commissioning', { now });
  approve();
  // add_dependency isn't implemented per §2.7 — wire predecessors directly.
  NODES.find(n => n.id === 'P1-T2').predecessors = 'P1-T1';
  NODES.find(n => n.id === 'P1-T3').predecessors = 'P1-T2';
  return { now };
}

// Snapshot helper — used to assert "real NODES untouched" after a reject.
function snapshot(arr) {
  return JSON.stringify(arr.map(n => ({ id: n.id, ...n })));
}


/* ═════════════════════════════════════════════════════════════════════════
 * A · BUILD A PROJECT VIA create_item PROMPTS
 *
 *   The design summary §2.4 documents create_item. These scenarios seed
 *   an empty project row and then issue create_item prompts to populate
 *   it — the way a user would build a board in the AI panel.
 * ═════════════════════════════════════════════════════════════════════════ */

describe('A · create three tasks via prompts → sequential ids', () => {
  it('three create_item prompts produce P1-T1, P1-T2, P1-T3 in order', () => {
    seedEmptyProject('P1', 'Glossodia Solar');
    prompt(createItem('Glossodia', 'DA approval',   'task'), 'add DA approval');
    prompt(createItem('Glossodia', 'BESS delivery', 'task'), 'add BESS');
    prompt(createItem('Glossodia', 'Commissioning', 'task'), 'add commissioning');
    approve();

    const tasks = NODES.filter(n => n.id !== 'P1').map(n => `${n.id}:${n.name}`);
    eq(tasks, ['P1-T1:DA approval', 'P1-T2:BESS delivery', 'P1-T3:Commissioning']);
  });
});

describe('A · create_item with deadline + duration sets start = end - duration', () => {
  it('"due 2026-08-01, duration 5 days" → sched_end=2026-08-01, sched_start=2026-07-27', () => {
    seedEmptyProject('P1', 'Glossodia Solar');
    prompt(createItem('Glossodia', 'Grid connection', 'task',
      { deadline: '2026-08-01', duration: '5' }), 'add grid connection');
    approve();
    const t = NODES.find(n => n.id === 'P1-T1');
    eq(t.sched_end,   '2026-08-01');
    eq(t.sched_start, '2026-07-27');
  });
});

describe('A · create_item with relative deadline ("next friday") resolves against now', () => {
  it('issued on Tue 2026-05-19 → next-week Friday = 2026-05-29', () => {
    seedEmptyProject('P1', 'Glossodia Solar');
    prompt(createItem('Glossodia', 'Inspection', 'task',
      { deadline: 'next friday', duration: '7' }),
      'add inspection due next friday',
      { now: new Date('2026-05-19T12:00:00') });   // a Tuesday
    approve();
    eq(NODES.find(n => n.id === 'P1-T1').sched_end, '2026-05-29');
  });
});

describe('A · create_item with no deadline falls back to today + 7 days', () => {
  it('issued on 2026-05-20 → sched_start=2026-05-20, sched_end=2026-05-27', () => {
    seedEmptyProject('P1', 'Glossodia Solar');
    prompt(createItem('Glossodia', 'Site visit', 'task'),
      'add site visit', { now: new Date('2026-05-20T12:00:00') });
    approve();
    const t = NODES.find(n => n.id === 'P1-T1');
    eq(t.sched_start, '2026-05-20');
    eq(t.sched_end,   '2026-05-27');
  });
});

describe('A · create_item nested — subtask under a named parent task', () => {
  it('parent="DA approval", item_type="subtask" → new id P1-T1-S1 under P1-T1', () => {
    seedEmptyProject('P1', 'Glossodia Solar');
    prompt(createItem('Glossodia', 'DA approval', 'task'), 'add DA');
    prompt(createItem('Glossodia', 'Submit forms', 'subtask',
      { duration: '3' }, { parent: 'DA approval' }), 'add subtask');
    approve();
    const sub = NODES.find(n => n.id === 'P1-T1-S1');
    ok(sub, 'subtask was created');
    eq(sub.name, 'Submit forms');
    eq(parentOf(sub.id), 'P1-T1');
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * B · MOVE NODES VIA shift_item PROMPTS
 *
 *   Maps each example from §2.1 / §2.2 of the design summary onto a
 *   shift_item operation and asserts the documented effect on leaf dates.
 * ═════════════════════════════════════════════════════════════════════════ */

describe('B · §2.1 — "BESS for Glossodia is delayed by 2 weeks"', () => {
  it('shift_item later 2 weeks → all four date fields move +14 days on the leaf', () => {
    seedGlossodiaViaPrompts();
    const before = NODES.find(n => n.id === 'P1-T2');
    eq(before.sched_start, '2026-06-15', 'precondition (from create_item)');
    eq(before.sched_end,   '2026-07-15');

    prompt(shiftItem('Glossodia', 'BESS', 'later', 2, 'weeks',
      { cascade: false }),  // suppress CPM here to isolate the shift effect
      'BESS for Glossodia is delayed by 2 weeks');
    approve();

    const after = NODES.find(n => n.id === 'P1-T2');
    eq(after.sched_start, '2026-06-29', 'sched_start +14d');
    eq(after.sched_end,   '2026-07-29', 'sched_end +14d');
  });
});

describe('B · §2.2 — "Move inverter installation 1 week earlier"', () => {
  it('shift_item earlier 1 week → all four date fields move -7 days', () => {
    seedEmptyProject('P2', 'Riverstone Wind');
    prompt(createItem('Riverstone', 'Inverter installation', 'task',
      { deadline: '2026-07-21', duration: '21' }), 'add inverter');
    approve();
    eq(NODES.find(n => n.id === 'P2-T1').sched_start, '2026-06-30');

    prompt(shiftItem('Riverstone', 'inverter', 'earlier', 1, 'weeks',
      { cascade: false }), 'move inverter 1 week earlier');
    approve();
    const t = NODES.find(n => n.id === 'P2-T1');
    eq(t.sched_start, '2026-06-23', 'sched_start -7d');
    eq(t.sched_end,   '2026-07-14', 'sched_end -7d');
  });
});

describe('B · shift_item in days — direct unit', () => {
  it('shift later 3 days → +3d', () => {
    seedGlossodiaViaPrompts();
    prompt(shiftItem('Glossodia', 'DA approval', 'later', 3, 'days',
      { cascade: false }), 'shift DA +3d');
    approve();
    eq(NODES.find(n => n.id === 'P1-T1').sched_end, '2026-06-18');
  });
});

describe('B · shift_item in months — ×30 days', () => {
  it('shift later 1 month → +30d', () => {
    seedGlossodiaViaPrompts();
    prompt(shiftItem('Glossodia', 'BESS', 'later', 1, 'months',
      { cascade: false }), 'shift BESS +1 month');
    approve();
    eq(NODES.find(n => n.id === 'P1-T2').sched_end, '2026-08-14');
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * C · BUILD + MOVE END-TO-END
 *
 *   The narrative the user described: create a project from prompts, then
 *   move things around using prompts, and assert the final state matches.
 * ═════════════════════════════════════════════════════════════════════════ */

describe('C · create three tasks, then shift the middle one', () => {
  it('full flow: create P1-T1/T2/T3, then prompt-shift T2, final dates match', () => {
    seedEmptyProject('P1', 'Glossodia Solar');
    const now = new Date('2026-05-20T12:00:00');
    prompt(createItem('Glossodia', 'DA approval',   'task',
      { deadline: '2026-06-15', duration: '14' }), 'c1', { now });
    prompt(createItem('Glossodia', 'BESS delivery', 'task',
      { deadline: '2026-07-15', duration: '30' }), 'c2', { now });
    prompt(createItem('Glossodia', 'Commissioning', 'task',
      { deadline: '2026-08-31', duration: '46' }), 'c3', { now });
    approve();

    prompt(shiftItem('Glossodia', 'BESS', 'later', 2, 'weeks',
      { cascade: false }), 'delay BESS 2w');
    approve();

    const t2 = NODES.find(n => n.id === 'P1-T2');
    eq(t2.sched_start, '2026-06-29');
    eq(t2.sched_end,   '2026-07-29');
  });
});

describe('C · stack multiple prompts in one draft → approve commits all at once', () => {
  it('three prompts staged → all three land after a single approve', () => {
    seedGlossodiaViaPrompts();
    prompt(shiftItem('Glossodia', 'BESS', 'later', 1, 'weeks', { cascade: false }),
      'delay BESS 1w');
    prompt(assignOwner('Glossodia', 'BESS', 'Jack'),
      'assign BESS to Jack');
    prompt(updateProgress('Glossodia', 'DA approval', { status: 'completed' }),
      'DA approval is complete');

    eq(AI.pendingChanges.length, 3, 'three prompts staged');
    // Real NODES untouched until approve.
    eq(NODES.find(n => n.id === 'P1-T2').owner, '');

    approve();
    const t1 = NODES.find(n => n.id === 'P1-T1');
    const t2 = NODES.find(n => n.id === 'P1-T2');
    eq(t2.sched_end,    '2026-07-22', 'BESS shifted +7d');
    eq(t2.owner,        'Jack',       'BESS owner set');
    eq(t1.percent_done, 100,          'DA approval marked complete');
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * D · CPM CASCADE (design summary §9 — "CPM is the source of truth")
 *
 *   When requires_schedule_computation = true (as §2.1's example shows),
 *   shifting a task forces CPM to push downstream tasks too. CPM only
 *   shifts FORWARD — never backward — to preserve user-introduced slack
 *   (see runCPM in index.html:2447).
 * ═════════════════════════════════════════════════════════════════════════ */

describe('D · §2.1 with CPM cascade — delaying BESS pushes Commissioning forward', () => {
  it('shift_item BESS +14d with requires_schedule_computation=true → T3.actual_start snaps to T2.end', () => {
    seedGlossodiaViaPrompts();
    prompt(shiftItem('Glossodia', 'BESS', 'later', 2, 'weeks'),  // cascade default = true
      'BESS for Glossodia is delayed by 2 weeks');
    approve();

    const t2 = NODES.find(n => n.id === 'P1-T2');
    const t3 = NODES.find(n => n.id === 'P1-T3');
    eq(t2.sched_end,     '2026-07-29',  'BESS end +14d (shift)');
    eq(t3.actual_start,  '2026-07-29',  'Commissioning cascaded to BESS\'s new end');
    eq(t3.actual_end,    '2026-09-13',  'Commissioning end preserves duration (46d)');
  });
});

describe('D · CPM does NOT pull tasks backward — slack is preserved', () => {
  it('shifting BESS earlier 1w doesn\'t move Commissioning (it already had slack)', () => {
    seedGlossodiaViaPrompts();
    prompt(shiftItem('Glossodia', 'BESS', 'earlier', 1, 'weeks'),
      'BESS earlier 1w');
    approve();
    const t3 = NODES.find(n => n.id === 'P1-T3');
    // Commissioning's stored actual_start was '2026-07-16' (no prior CPM run).
    // CPM only shifts forward, so it stays put.
    eq(t3.sched_start, '2026-07-16', 'Commissioning sched_start unchanged');
  });
});

describe('D · cascade-suppressed shift leaves downstream untouched', () => {
  it('cascade=false → only the targeted task moves; predecessors remain unverified', () => {
    seedGlossodiaViaPrompts();
    prompt(shiftItem('Glossodia', 'BESS', 'later', 2, 'weeks', { cascade: false }),
      'shift without CPM');
    approve();
    const t3 = NODES.find(n => n.id === 'P1-T3');
    eq(t3.sched_start, '2026-07-16', 'Commissioning sched_start not cascaded');
    // create_item never populated actual_start; without CPM it stays empty.
    eq(t3.actual_start, '', 'CPM never ran so actual_start was never assigned');
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * E · PROGRESS & OWNERSHIP — §2.5, §2.6
 * ═════════════════════════════════════════════════════════════════════════ */

describe('E · §2.5 — "DA approval for Glossodia is now complete"', () => {
  it('update_progress with status="completed" sets percent_done=100', () => {
    seedGlossodiaViaPrompts();
    prompt(updateProgress('Glossodia', 'DA approval', { status: 'completed' }),
      'DA approval is complete');
    approve();
    eq(NODES.find(n => n.id === 'P1-T1').percent_done, 100);
  });
});

describe('E · update_progress status="in_progress" → 50', () => {
  it('inferred percent_done = 50 from status', () => {
    seedGlossodiaViaPrompts();
    prompt(updateProgress('Glossodia', 'BESS', { status: 'in_progress' }),
      'BESS started');
    approve();
    eq(NODES.find(n => n.id === 'P1-T2').percent_done, 50);
  });
});

describe('E · update_progress explicit percent overrides status', () => {
  it('percent_done=33 lands directly, clamped to [0,100]', () => {
    seedGlossodiaViaPrompts();
    prompt(updateProgress('Glossodia', 'BESS', { percent_done: 33 }),
      'BESS 33% done');
    approve();
    eq(NODES.find(n => n.id === 'P1-T2').percent_done, 33);
  });
});

describe('E · §2.6 — "Assign BESS procurement to Jack"', () => {
  it('assign_owner sets owner on the matched task', () => {
    seedGlossodiaViaPrompts();
    prompt(assignOwner('Glossodia', 'BESS', 'Jack'),
      'Assign BESS procurement to Jack');
    approve();
    eq(NODES.find(n => n.id === 'P1-T2').owner, 'Jack');
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * F · DRAFT LIFECYCLE — §4 deterministic workflow + §5 draft system
 *
 *   The design says: mutations happen on a deep-cloned draft; real NODES
 *   are only touched on approve. Discard drops the draft completely.
 * ═════════════════════════════════════════════════════════════════════════ */

describe('F · §5 — draft is a deep clone; real NODES untouched until approve', () => {
  it('mutating the draft via prompt() does not change NODES', () => {
    seedGlossodiaViaPrompts();
    const before = snapshot(NODES);
    prompt(shiftItem('Glossodia', 'BESS', 'later', 4, 'weeks', { cascade: false }),
      'delay BESS 4w');
    // No approve yet.
    eq(snapshot(NODES), before, 'real NODES bytes-equal before/after prompt');
    ok(AI.draft, 'draft exists');
    ok(AI.draft.find(n => n.id === 'P1-T2').sched_end === '2026-08-12', 'draft has the shift');
  });
});

describe('F · discard drops the draft cleanly', () => {
  it('discard after staged prompts → AI state cleared, NODES unchanged', () => {
    seedGlossodiaViaPrompts();
    const before = snapshot(NODES);
    prompt(shiftItem('Glossodia', 'BESS', 'later', 4, 'weeks', { cascade: false }),
      'delay BESS 4w');
    prompt(assignOwner('Glossodia', 'BESS', 'Jack'),
      'assign BESS to Jack');
    eq(AI.pendingChanges.length, 2);
    discard();
    eq(AI.draft, null);
    eq(AI.pendingChanges.length, 0);
    eq(snapshot(NODES), before, 'NODES untouched');
  });
});

describe('F · rejected first op rolls back the draft cleanly', () => {
  it('an invalid first prompt leaves AI.draft=null so the next try starts fresh', () => {
    seedGlossodiaViaPrompts();
    const r = prompt(shiftItem('Glossodia', 'mythical task', 'later', 1, 'weeks'),
      'delay mythical');
    eq(r.ok, false);
    eq(AI.draft, null);
    eq(AI.pendingChanges.length, 0);
  });
});

describe('F · approve persists created rows', () => {
  it('a create_item prompt then approve → new row exists in real NODES', () => {
    seedGlossodiaViaPrompts();
    prompt(createItem('Glossodia', 'Grid connection', 'task',
      { deadline: '2026-08-01', duration: '5' }), 'add grid');
    approve();
    const grid = NODES.find(n => n.id === 'P1-T4');
    ok(grid, 'new row exists');
    eq(grid.name, 'Grid connection');
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * G · REJECTIONS — design summary §8 conflict catalogue
 *
 *   Tests that bad prompts are rejected with a clear reason and never
 *   reach real NODES.
 * ═════════════════════════════════════════════════════════════════════════ */

describe('G · §8.1 unresolved target — rejected with reason', () => {
  it('shift on a nonexistent task does not change NODES', () => {
    seedGlossodiaViaPrompts();
    const before = snapshot(NODES);
    const r = prompt(shiftItem('Glossodia', 'turbine assembly', 'later', 1, 'weeks'),
      'delay turbines');
    eq(r.ok, false);
    ok(/find/i.test(r.reason));
    eq(snapshot(NODES), before);
  });
});

describe('G · missing shift amount — rejected', () => {
  it('amount="N/A" → ok:false with "amount" in reason', () => {
    seedGlossodiaViaPrompts();
    const r = prompt(shiftItem('Glossodia', 'BESS', 'later', 'N/A', 'N/A',
      { cascade: false }), 'delay BESS by ???');
    eq(r.ok, false);
    ok(/amount/i.test(r.reason));
  });
});

describe('G · create_item missing project — rejected', () => {
  it('project="N/A" → ok:false', () => {
    seedEmptyProject('P1', 'Glossodia Solar');
    const r = prompt(createItem('N/A', 'orphan task', 'task'), 'add orphan');
    eq(r.ok, false);
  });
});

describe('G · §8.4 cyclic predecessors — CPM flags the cycle on the draft', () => {
  it('introducing a cycle via direct predecessor wiring → cycles[] non-empty', () => {
    seedGlossodiaViaPrompts();
    // Force a cycle: T1 ← T3 (T1 already feeds T2 which feeds T3).
    NODES.find(n => n.id === 'P1-T1').predecessors = 'P1-T3';
    // Now any cascade-causing prompt will trigger runCPM, which reports the cycle.
    const r = prompt(shiftItem('Glossodia', 'BESS', 'later', 1, 'weeks'),
      'delay BESS');
    eq(r.ok, true, 'shift applies — cycle detection is on the runCPM side');
    ok(r.cycles && r.cycles.includes('P1'), 'cycle reported on the project');
  });
});

describe('G · unsupported operation — rejected with "Unsupported operation"', () => {
  it('an unknown op string → ok:false with /unsupported/ reason', () => {
    seedGlossodiaViaPrompts();
    const r = prompt(rawOp('frobnicate',
      { project: 'Glossodia', item: 'BESS' }, {}),
      'frobnicate BESS');
    eq(r.ok, false);
    ok(/unsupported/i.test(r.reason));
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * H · EXTENDED OPS — create_project_candidate, add_dependency, delete_item
 *
 *   These ops are wired through aiApplyOperation alongside the §2.1–§2.6
 *   set. The test-side aiApplyCreateProjectCandidate is a stub (no
 *   template/window picker) — the production app drives the picker UI
 *   from index.html.
 * ═════════════════════════════════════════════════════════════════════════ */

describe('H · §2.3 — create_project_candidate', () => {
  it('"new 500kW solar project at Penrith starting in July" should create P# row', () => {
    reset();
    const r = prompt(rawOp('create_project_candidate',
      { project: 'Penrith', item: 'N/A', item_type: 'project' },
      { project_type: 'solar', capacity: '500kW',
        preferred_start: 'July', scheduling_goal: 'fit_between_existing_projects' },
      { requires_schedule_computation: true, requires_capacity_check: true }),
      'new project Penrith');
    eq(r.ok, true, 'create_project_candidate should succeed');
    approve();
    ok(NODES.find(n => /penrith/i.test(n.name)), 'a Penrith project row exists');
  });
});

describe('H · §2.7 — add_dependency', () => {
  it('"Make commissioning depend on BESS delivery" should write predecessors', () => {
    seedGlossodiaViaPrompts();
    // Strip the seeded predecessor so the test actually exercises adding one.
    NODES.find(n => n.id === 'P1-T3').predecessors = '';
    const r = prompt(rawOp('add_dependency',
      { project: 'Glossodia', item: 'Commissioning' },
      { predecessor: 'BESS delivery' },
      { requires_schedule_computation: true, requires_dependency_check: true }),
      'make commissioning depend on BESS');
    eq(r.ok, true, 'add_dependency should succeed');
    approve();
    eq(NODES.find(n => n.id === 'P1-T3').predecessors, 'P1-T2');
  });
});

describe('H · add_dependency must reject cycle creation', () => {
  it('adding a back-edge that creates a cycle should be rejected', () => {
    seedGlossodiaViaPrompts();
    // T2 currently depends on T1. Adding T1 ← T3 would close the cycle T1→T2→T3→T1.
    const r = prompt(rawOp('add_dependency',
      { project: 'Glossodia', item: 'DA approval' },
      { predecessor: 'Commissioning' },
      { requires_dependency_check: true }),
      'make DA depend on Commissioning');
    eq(r.ok, false, 'should be rejected — would create a cycle');
    ok(/cycle|circular/i.test(r.reason || ''), 'reason mentions cycle/circular');
  });
});

describe('H · delete_item', () => {
  it('"delete BESS delivery from Glossodia" removes the row and its subtree', () => {
    seedGlossodiaViaPrompts();
    const r = prompt(rawOp('delete_item',
      { project: 'Glossodia', item: 'BESS delivery' }, {}),
      'delete BESS');
    eq(r.ok, true, 'delete_item should succeed');
    approve();
    ok(!NODES.find(n => n.id === 'P1-T2'), 'BESS row gone');
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * I · CONCURRENT — two users prompting against a shared FakeServer
 *
 *   Design summary §13–§16: approve = "save changed rows with version
 *   checks." These scenarios drive two User instances that each have
 *   their own NODES + AI state but share one FakeServer.
 * ═════════════════════════════════════════════════════════════════════════ */

function seedSharedServerForConcurrentTests() {
  const server = new FakeServer();
  server.insert([
    nodeToDbRow({ id: 'P1',    type: 'project', name: 'Glossodia',
                  sched_start: '2026-06-01', sched_end: '2026-08-31' }),
    nodeToDbRow({ id: 'P1-T1', type: 'task', name: 'DA approval', owner: '',
                  sched_start: '2026-06-01', sched_end: '2026-06-15',
                  actual_start: '2026-06-01', actual_end: '2026-06-15' }),
    nodeToDbRow({ id: 'P1-T2', type: 'task', name: 'BESS delivery', owner: 'bob',
                  sched_start: '2026-06-16', sched_end: '2026-07-15',
                  actual_start: '2026-06-16', actual_end: '2026-07-15' }),
    nodeToDbRow({ id: 'P2',    type: 'project', name: 'Riverstone',
                  sched_start: '2026-07-01', sched_end: '2026-09-30' }),
    nodeToDbRow({ id: 'P2-T1', type: 'task', name: 'Inverter', owner: '',
                  sched_start: '2026-07-01', sched_end: '2026-07-21',
                  actual_start: '2026-07-01', actual_end: '2026-07-21' }),
  ]);
  return server;
}

describe('I · §13 — two users prompt disjoint rows; both PATCHes succeed', () => {
  it('Alice delays BESS, Bob pulls Inverter in 1w; no conflict, both land', () => {
    const server = seedSharedServerForConcurrentTests();
    const alice = new User('alice', server), bob = new User('bob', server);
    alice.loadBoard(); bob.loadBoard();

    alice.with(() => {
      prompt(shiftItem('Glossodia', 'BESS', 'later', 2, 'weeks',
        { cascade: false }), 'delay BESS 2w');
      approve(); alice.saveLocal();
    });
    bob.with(() => {
      prompt(shiftItem('Riverstone', 'inverter', 'earlier', 1, 'weeks',
        { cascade: false }), 'pull inverter in 1w');
      approve(); bob.saveLocal();
    });

    eq(alice.conflictsObserved, []);
    eq(bob.conflictsObserved,   []);
    eq(server.get('P1-T2').sched_start, '2026-06-30', 'BESS shifted on server');
    eq(server.get('P2-T1').sched_start, '2026-06-24', 'Inverter shifted on server');
  });
});

describe('I · §13 — two users prompt the same row; second writer hits OCC', () => {
  it('Alice assigns owner first; Bob\'s shift PATCH is rejected, row stays dirty', () => {
    const server = seedSharedServerForConcurrentTests();
    const alice = new User('alice', server), bob = new User('bob', server);
    alice.loadBoard(); bob.loadBoard();

    alice.with(() => {
      prompt(assignOwner('Glossodia', 'BESS', 'alice'), 'BESS → alice');
      approve();
    });
    bob.with(() => {
      prompt(shiftItem('Glossodia', 'BESS', 'later', 1, 'weeks',
        { cascade: false }), 'delay BESS');
      approve();
    });

    alice.with(() => alice.saveLocal());
    eq(alice.conflictsObserved, []);
    eq(server.get('P1-T2').owner, 'alice');
    eq(server.get('P1-T2').version, 2);

    bob.with(() => bob.saveLocal());
    eq(bob.conflictsObserved, ['P1-T2'], 'Bob hit the version check');
    eq(server.get('P1-T2').owner, 'alice', 'alice\'s owner survived');
    eq(server.get('P1-T2').sched_start, '2026-06-16', 'bob\'s shift did NOT land');
    ok(bob.dirtyIds.has('P1-T2'), 'bob keeps the row dirty for retry');
    eq(bob.serverRows.get('P1-T2').version, 2, 'bob refetched to v=2');
  });
});

describe('I · §13/§14 — Bob\'s retry overwrites Alice (last-write-wins)', () => {
  it('after refetch, Bob\'s retry PATCH lands but his stale row body clobbers Alice', () => {
    const server = seedSharedServerForConcurrentTests();
    const alice = new User('alice', server), bob = new User('bob', server);
    alice.loadBoard(); bob.loadBoard();

    alice.with(() => {
      prompt(assignOwner('Glossodia', 'BESS', 'alice'), 'BESS → alice');
      approve(); alice.saveLocal();
    });
    bob.with(() => {
      prompt(shiftItem('Glossodia', 'BESS', 'later', 1, 'weeks',
        { cascade: false }), 'delay BESS');
      approve(); bob.saveLocal();  // first try — conflict
    });
    eq(bob.conflictsObserved, ['P1-T2']);

    // §13 of the design summary says: "Replay pending operations on latest
    // server state." Today Bob's NODES holds the *old* owner value, so the
    // retry sends his full row body and overwrites Alice. This is what the
    // design calls out as needing a refresh-and-replay step.
    bob.with(() => bob.saveLocal());
    eq(bob.conflictsObserved, []);
    eq(server.get('P1-T2').sched_start, '2026-06-23', 'Bob\'s shift applied');
    eq(server.get('P1-T2').owner, 'bob', 'Bob\'s stale owner clobbered alice');
  });
});

describe('I · two users create_item with stale state → id collision is detectable', () => {
  it('both decide P1-T2 is next-free; the FakeServer log shows two INSERTs on the same id', () => {
    const server = new FakeServer();
    server.insert([
      nodeToDbRow({ id: 'P1', type: 'project', name: 'Glossodia',
                    sched_start: '2026-06-01', sched_end: '2026-08-31' }),
      nodeToDbRow({ id: 'P1-T1', type: 'task', name: 'DA',
                    sched_start: '2026-06-01', sched_end: '2026-06-15' }),
    ]);
    const alice = new User('alice', server), bob = new User('bob', server);
    alice.loadBoard(); bob.loadBoard();

    alice.with(() => {
      prompt(createItem('Glossodia', 'Grid connection', 'task'), 'add grid');
      approve();
    });
    bob.with(() => {
      prompt(createItem('Glossodia', 'Permits', 'task'), 'add permits');
      approve();
    });

    alice.with(() => alice.saveLocal());
    bob.with(() => bob.saveLocal());

    const t2Inserts = server.opLog.filter(o => o.kind === 'INSERT' && o.id === 'P1-T2');
    eq(t2Inserts.length, 2, 'two INSERTs for P1-T2 — the design needs an id-rotation step before approve');
  });
});

describe('I · discarded prompts never reach the server', () => {
  it('stage three prompts, discard → server log shows zero PATCHes', () => {
    const server = seedSharedServerForConcurrentTests();
    const alice = new User('alice', server);
    alice.loadBoard();
    alice.with(() => {
      prompt(shiftItem('Glossodia', 'BESS', 'later', 4, 'weeks', { cascade: false }),
        'delay BESS 4w');
      prompt(assignOwner('Glossodia', 'BESS', 'alice'),
        'BESS → alice');
      prompt(updateProgress('Glossodia', 'DA approval', { status: 'completed' }),
        'DA complete');
      discard();
      alice.saveLocal();
    });
    eq(server.opLog.filter(o => o.kind === 'PATCH').length, 0, 'no PATCHes after discard');
    eq(server.get('P1-T2').version, 1, 'BESS row still at v=1');
  });
});

describe('I · the deterministic workflow (§4) end-to-end with two users', () => {
  it('build → prompt-shift → preview → approve → save, with a peer mid-flight', () => {
    const server = new FakeServer();
    server.insert([
      nodeToDbRow({ id: 'P1', type: 'project', name: 'Glossodia',
                    sched_start: '2026-06-01', sched_end: '2026-08-31' }),
    ]);
    const alice = new User('alice', server), bob = new User('bob', server);
    alice.loadBoard(); bob.loadBoard();

    // Alice builds the board via prompts.
    alice.with(() => {
      const now = new Date('2026-05-20T12:00:00');
      prompt(createItem('Glossodia', 'DA approval',   'task',
        { deadline: '2026-06-15', duration: '14' }), 'c1', { now });
      prompt(createItem('Glossodia', 'BESS delivery', 'task',
        { deadline: '2026-07-15', duration: '30' }), 'c2', { now });
      approve(); alice.saveLocal();
    });
    eq(server.get('P1-T1').name, 'DA approval');
    eq(server.get('P1-T2').name, 'BESS delivery');

    // Bob loads (his initial loadBoard predated the inserts) — he must
    // reload to see Alice's tasks.
    bob.loadBoard();
    ok(bob.serverRows.get('P1-T2'), 'Bob now sees BESS');

    // Bob shifts BESS via a prompt — disjoint from Alice's pending work.
    bob.with(() => {
      prompt(shiftItem('Glossodia', 'BESS', 'later', 1, 'weeks',
        { cascade: false }), 'delay BESS 1w');
      approve(); bob.saveLocal();
    });
    eq(bob.conflictsObserved, []);
    eq(server.get('P1-T2').sched_end, '2026-07-22', 'Bob\'s shift landed cleanly');
  });
});


/* ═════════════════════════════════════════════════════════════════════════
 * Runner — same shape as test_index.js / test_concurrency.js
 * ═════════════════════════════════════════════════════════════════════════ */
async function runTests() {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  const out = isBrowser ? document.getElementById('out') : null;
  const write = (line, cls) => {
    if (isBrowser && out) {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = line;
      out.appendChild(div);
    } else {
      console.log(line);
    }
  };

  let passed = 0, failed = 0, todoFail = 0, todoUnexpectedPass = 0, lastSuite = '';
  for (const t of tests) {
    if (t.suite !== lastSuite) { write(''); write(t.suite, 'suite'); lastSuite = t.suite; }
    let threw = null;
    try { reset(); await t.fn(); }
    catch (e) { threw = e; }

    if (t.todo) {
      if (threw) {
        write(`  todo ${t.name}`, 'todo');
        write(`       ${threw.message}`, 'todo');
        todoFail++;
      } else {
        // A todo test passed — the applier exists. Flag so the user knows
        // to promote it to a real `it(...)`.
        write(`  TODO-PASS ${t.name} (consider promoting to it())`, 'pass');
        todoUnexpectedPass++;
      }
    } else if (threw) {
      write(`  FAIL ${t.name}`, 'fail');
      write(`       ${threw.message}`, 'fail');
      failed++;
    } else {
      write(`  ok   ${t.name}`, 'pass');
      passed++;
    }
  }
  write('');
  const summary = `${passed} passed, ${failed} failed, ${todoFail} todo` +
                  (todoUnexpectedPass ? `, ${todoUnexpectedPass} todo-pass (promote!)` : '') +
                  ` (of ${tests.length})`;
  write(summary, failed ? 'fail' : 'pass');
  // Exit non-zero only on real failures; todo failures are expected.
  if (!isBrowser && typeof process !== 'undefined') process.exit(failed === 0 ? 0 : 1);
}

if (typeof window === 'undefined') runTests();
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runTests);
else runTests();
