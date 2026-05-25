import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── detectImportConflicts ───────────────────────────────────────────────
// A project from the CSV is "the same" as an existing one iff its id AND
// its name both match (case-sensitive, exact). Re-implemented inline so
// tests stay DOM-free (same pattern as auth_rbac.test.js).
function detectImportConflicts(imported, existing) {
  // `imported` and `existing` are arrays of { id, type, name, ... }.
  // Returns a Map<importedProjectId, existingProjectId> for matches.
  const existingByKey = new Map();
  for (const n of existing) {
    if (n.type !== 'project') continue;
    existingByKey.set(`${n.id}${n.name}`, n.id);
  }
  const out = new Map();
  for (const n of imported) {
    if (n.type !== 'project') continue;
    const key = `${n.id}${n.name}`;
    if (existingByKey.has(key)) out.set(n.id, existingByKey.get(key));
  }
  return out;
}

describe('detectImportConflicts (CSV import conflict detection)', () => {
  it('matches on identical id AND identical name', () => {
    const existing = [{ id: 'P1', type: 'project', name: 'Solar A' }];
    const imported = [{ id: 'P1', type: 'project', name: 'Solar A' }];
    const m = detectImportConflicts(imported, existing);
    assert.equal(m.size, 1);
    assert.equal(m.get('P1'), 'P1');
  });

  it('does not match when only id matches', () => {
    const existing = [{ id: 'P1', type: 'project', name: 'Solar A' }];
    const imported = [{ id: 'P1', type: 'project', name: 'Solar B' }];
    const m = detectImportConflicts(imported, existing);
    assert.equal(m.size, 0);
  });

  it('does not match when only name matches', () => {
    const existing = [{ id: 'P1', type: 'project', name: 'Solar A' }];
    const imported = [{ id: 'P2', type: 'project', name: 'Solar A' }];
    const m = detectImportConflicts(imported, existing);
    assert.equal(m.size, 0);
  });

  it('is case-sensitive on name', () => {
    const existing = [{ id: 'P1', type: 'project', name: 'Solar A' }];
    const imported = [{ id: 'P1', type: 'project', name: 'solar a' }];
    const m = detectImportConflicts(imported, existing);
    assert.equal(m.size, 0);
  });

  it('ignores tasks and subtasks, only projects can conflict', () => {
    const existing = [
      { id: 'P1',       type: 'project', name: 'Solar A' },
      { id: 'P1-T1',    type: 'task',    name: 'Setup' },
    ];
    const imported = [
      { id: 'P1-T1',    type: 'task',    name: 'Setup' },
    ];
    const m = detectImportConflicts(imported, existing);
    assert.equal(m.size, 0);
  });
});

// ─── renumberMergedTasks ──────────────────────────────────────────────────
// Renumber imported tasks/subtasks so they slot under an existing project
// at the next free T-number. Returns { nodes, remap } where `remap` maps
// old-imported-id → new-id for all renumbered rows. Predecessor refs are
// NOT rewritten here — the caller does that across all conflict resolutions
// at once. Re-implemented inline (matches the inline-helper test pattern).
function renumberMergedTasks(existingProjectId, existingNodes, importedNodes) {
  // Find max existing T-num under existingProjectId.
  const re = new RegExp('^' + existingProjectId + '-T(\\d+)$');
  let maxT = 0;
  for (const n of existingNodes) {
    const m = (n.id || '').match(re);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxT) maxT = num;
    }
  }
  // Collect imported tasks under the imported project (their id is
  // <importedProjectId>-T<n> or -T<n>-S<m>); discover the imported project id
  // by inspecting tasks. There can be only one project per call.
  const importedProj = importedNodes.find(n => n.type === 'project');
  if (!importedProj) return { nodes: [], remap: new Map() };
  const importedPid = importedProj.id;

  // Group children by their original T-number to keep S-numbering stable.
  const tasksInOrder = importedNodes
    .filter(n => {
      const segs = (n.id || '').split('-');
      return segs.length === 2 && segs[0] === importedPid;
    })
    .sort((a, b) => {
      const an = parseInt((a.id.match(/-T(\d+)$/) || [0, 0])[1], 10);
      const bn = parseInt((b.id.match(/-T(\d+)$/) || [0, 0])[1], 10);
      return an - bn;
    });

  const remap = new Map();
  remap.set(importedPid, existingProjectId); // project itself goes away (merge keeps existing header)
  let nextT = maxT;
  for (const task of tasksInOrder) {
    nextT++;
    const newId = `${existingProjectId}-T${nextT}`;
    remap.set(task.id, newId);
  }
  // Subtasks: their new id is `<remappedTaskId>-S<originalS>`.
  for (const n of importedNodes) {
    const segs = (n.id || '').split('-');
    if (segs.length !== 3) continue;
    const taskOldId = `${segs[0]}-${segs[1]}`;
    const newTaskId = remap.get(taskOldId);
    if (!newTaskId) continue;
    remap.set(n.id, `${newTaskId}-${segs[2]}`);
  }
  // Build the new node list (drop the project — it's the merge-into one).
  const nodes = importedNodes
    .filter(n => n.type !== 'project')
    .map(n => ({ ...n, id: remap.get(n.id) || n.id }));
  return { nodes, remap };
}

describe('renumberMergedTasks (merge into existing project)', () => {
  it('renumbers tasks past the max existing T-num', () => {
    const existing = [
      { id: 'P1',     type: 'project', name: 'A' },
      { id: 'P1-T1',  type: 'task',    name: 'old1' },
      { id: 'P1-T2',  type: 'task',    name: 'old2' },
    ];
    const imported = [
      { id: 'P9',     type: 'project', name: 'A' },
      { id: 'P9-T1',  type: 'task',    name: 'new1' },
      { id: 'P9-T2',  type: 'task',    name: 'new2' },
    ];
    const { nodes, remap } = renumberMergedTasks('P1', existing, imported);
    assert.deepEqual(nodes.map(n => n.id), ['P1-T3', 'P1-T4']);
    assert.equal(remap.get('P9-T1'), 'P1-T3');
    assert.equal(remap.get('P9-T2'), 'P1-T4');
  });

  it('handles gaps in existing T-numbers (uses max, not count)', () => {
    const existing = [
      { id: 'P1',     type: 'project', name: 'A' },
      { id: 'P1-T1',  type: 'task',    name: 'old1' },
      { id: 'P1-T5',  type: 'task',    name: 'old2' },
    ];
    const imported = [
      { id: 'P9',     type: 'project', name: 'A' },
      { id: 'P9-T1',  type: 'task',    name: 'new1' },
    ];
    const { nodes } = renumberMergedTasks('P1', existing, imported);
    assert.deepEqual(nodes.map(n => n.id), ['P1-T6']);
  });

  it('renumbers subtasks alongside their parent task', () => {
    const existing = [
      { id: 'P1',     type: 'project', name: 'A' },
      { id: 'P1-T1',  type: 'task',    name: 'old' },
    ];
    const imported = [
      { id: 'P9',         type: 'project', name: 'A' },
      { id: 'P9-T1',      type: 'task',    name: 'new' },
      { id: 'P9-T1-S1',   type: 'subtask', name: 'a' },
      { id: 'P9-T1-S2',   type: 'subtask', name: 'b' },
    ];
    const { nodes } = renumberMergedTasks('P1', existing, imported);
    assert.deepEqual(
      nodes.map(n => n.id).sort(),
      ['P1-T2', 'P1-T2-S1', 'P1-T2-S2'],
    );
  });

  it('drops the imported project header (merge keeps the existing one)', () => {
    const existing = [{ id: 'P1', type: 'project', name: 'A' }];
    const imported = [{ id: 'P9', type: 'project', name: 'A' }];
    const { nodes } = renumberMergedTasks('P1', existing, imported);
    assert.equal(nodes.length, 0);
  });
});

// ─── rewriteImportPreds ──────────────────────────────────────────────────
// Given an import remap (old-id → new-id) and a list of nodes with a
// `predecessors` string field (comma-separated), produce a new node list
// where each pred id is replaced via the remap. Refs outside the remap
// are kept as-is (these are refs out of the imported set, into existing
// rows on the board).
function rewriteImportPreds(remap, nodes) {
  return nodes.map(n => {
    if (!n.predecessors) return n;
    const rewritten = n.predecessors
      .split(/[,;]/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => remap.get(p) || p)
      .join(', ');
    return { ...n, predecessors: rewritten };
  });
}

describe('rewriteImportPreds (predecessor remap)', () => {
  it('rewrites refs that are in the remap', () => {
    const remap = new Map([['P9-T1', 'P1-T3']]);
    const nodes = [{ id: 'P1-T4', predecessors: 'P9-T1' }];
    const out = rewriteImportPreds(remap, nodes);
    assert.equal(out[0].predecessors, 'P1-T3');
  });

  it('preserves refs not in the remap (refs out of the imported set)', () => {
    const remap = new Map([['P9-T1', 'P1-T3']]);
    const nodes = [{ id: 'P1-T4', predecessors: 'P9-T1, P2-T7' }];
    const out = rewriteImportPreds(remap, nodes);
    assert.equal(out[0].predecessors, 'P1-T3, P2-T7');
  });

  it('handles empty / null predecessors', () => {
    const remap = new Map([['P9-T1', 'P1-T3']]);
    const nodes = [{ id: 'A', predecessors: '' }, { id: 'B', predecessors: undefined }];
    const out = rewriteImportPreds(remap, nodes);
    assert.equal(out[0].predecessors, '');
    assert.equal(out[1].predecessors, undefined);
  });
});
