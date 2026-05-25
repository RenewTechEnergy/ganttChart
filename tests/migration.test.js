import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure copy of the production helper (kept DOM-free to match existing test style).
// Production source lives in index.html (search: `function migrateLegacyFields`).
function migrateLegacyFields(nodes) {
  for (const n of nodes) {
    const parts = String(n.id || '').split('-');
    const isProject = parts.length === 1;
    const isSubtask = parts.length === 3;

    // Subtask: est_cost is the per-subtask QUOTE in the new model.
    if (isSubtask && (n.quoted_cost == null || n.quoted_cost === '')
                  && n.est_cost != null && n.est_cost !== '') {
      n.quoted_cost = n.est_cost;
    }
    // Project: est_cost is the proposal-stage RAW estimate.
    if (isProject && (n.estimated_raw_cost == null || n.estimated_raw_cost === '')
                  && n.est_cost != null && n.est_cost !== '') {
      n.estimated_raw_cost = n.est_cost;
    }
    // Any level: cost_to_date is renamed.
    if ((n.actual_spend_to_date == null || n.actual_spend_to_date === '')
        && n.cost_to_date != null && n.cost_to_date !== '') {
      n.actual_spend_to_date = n.cost_to_date;
    }
    // committed_to_spend is a brand-new field — default to '' if missing.
    if (n.committed_to_spend == null) n.committed_to_spend = '';
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
});
