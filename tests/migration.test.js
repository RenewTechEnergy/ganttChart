import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure copy of the production helper (kept DOM-free to match existing test style).
// Production source lives in index.html (search: `function migrateLegacyFields`).
function migrateLegacyFields(nodes) {
  for (const n of nodes) {
    const parts = String(n.id || '').split('-');
    const isProject = parts.length === 1;
    const isSubtask = parts.length === 3;

    if (isSubtask && (n.quoted_cost == null || n.quoted_cost === '')
                  && n.est_cost != null && n.est_cost !== '') {
      n.quoted_cost = n.est_cost;
    }
    if (isProject && (n.estimated_raw_cost == null || n.estimated_raw_cost === '')
                  && n.est_cost != null && n.est_cost !== '') {
      n.estimated_raw_cost = n.est_cost;
    }
    if ((n.actual_spend_to_date == null || n.actual_spend_to_date === '')
        && n.cost_to_date != null && n.cost_to_date !== '') {
      n.actual_spend_to_date = n.cost_to_date;
    }
    if (n.committed_to_spend == null) n.committed_to_spend = '';

    // Status enum migration: pct_done → status (subtask-only).
    if (isSubtask && (n.status == null || n.status === '')) {
      const pd = Number(n.percent_done);
      if (!isNaN(pd)) {
        if      (pd >= 100) n.status = 'Done';
        else if (pd >    0) n.status = 'In Progress';
        else                n.status = 'Not Started';
      } else {
        n.status = 'Not Started';
      }
    }
  }
  return nodes;
}

describe('migrateLegacyFields', () => {
  it('copies subtask est_cost into quoted_cost', () => {
    const nodes = [{ id: 'P1-T1-S1', est_cost: 5000 }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].quoted_cost, 5000);
  });

  it('copies project est_cost into estimated_raw_cost (NOT quoted_cost)', () => {
    const nodes = [{ id: 'P1', est_cost: 75000 }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].estimated_raw_cost, 75000);
    assert.equal(nodes[0].quoted_cost, undefined);
  });

  it('does NOT touch task-level est_cost (tasks derive from subtasks)', () => {
    const nodes = [{ id: 'P1-T1', est_cost: 999 }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].quoted_cost, undefined);
    assert.equal(nodes[0].estimated_raw_cost, undefined);
  });

  it('copies cost_to_date into actual_spend_to_date at every level', () => {
    const nodes = [
      { id: 'P1', cost_to_date: 100 },
      { id: 'P1-T1', cost_to_date: 200 },
      { id: 'P1-T1-S1', cost_to_date: 300 },
    ];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].actual_spend_to_date, 100);
    assert.equal(nodes[1].actual_spend_to_date, 200);
    assert.equal(nodes[2].actual_spend_to_date, 300);
  });

  it('defaults committed_to_spend to empty string when missing', () => {
    const nodes = [{ id: 'P1-T1-S1' }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].committed_to_spend, '');
  });

  it('is idempotent — running twice changes nothing', () => {
    const nodes = [{ id: 'P1-T1-S1', est_cost: 5000, cost_to_date: 2000 }];
    migrateLegacyFields(nodes);
    const snapshot = JSON.stringify(nodes);
    migrateLegacyFields(nodes);
    assert.equal(JSON.stringify(nodes), snapshot);
  });

  it('does NOT overwrite existing new-field values', () => {
    const nodes = [{ id: 'P1-T1-S1', est_cost: 999, quoted_cost: 5000 }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].quoted_cost, 5000);
  });

  it('skips when est_cost is empty string (existing convention)', () => {
    const nodes = [{ id: 'P1-T1-S1', est_cost: '' }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].quoted_cost, undefined);
  });

  it('pct_done == 100 → status "Done"', () => {
    const nodes = [{ id: 'P1-T1-S1', percent_done: 100 }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].status, 'Done');
  });

  it('0 < pct_done < 100 → status "In Progress"', () => {
    const nodes = [{ id: 'P1-T1-S1', percent_done: 42 }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].status, 'In Progress');
  });

  it('pct_done == 0 → status "Not Started"', () => {
    const nodes = [{ id: 'P1-T1-S1', percent_done: 0 }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].status, 'Not Started');
  });

  it('does NOT add status to project rows', () => {
    const nodes = [{ id: 'P1', percent_done: 50 }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].status, undefined);
  });

  it('does NOT overwrite an existing status', () => {
    const nodes = [{ id: 'P1-T1-S1', percent_done: 50, status: 'Delayed' }];
    migrateLegacyFields(nodes);
    assert.equal(nodes[0].status, 'Delayed');
  });
});
