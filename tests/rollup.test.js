import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure-function copy of getEffective + the three new helpers, mirroring the
// production code's structure (no DOM dependency).
function makeWorld(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const parentOf = (id) => {
    const i = id.lastIndexOf('-');
    return i < 0 ? null : id.slice(0, i);
  };
  const childrenOf = (node) =>
    nodes.filter(n => parentOf(n.id) === node.id);
  const getEffective = (node, field) => {
    const kids = childrenOf(node);
    if (kids.length === 0) {
      const v = parseFloat(node[field]);
      return isNaN(v) ? 0 : v;
    }
    return kids.reduce((s, k) => s + getEffective(k, field), 0);
  };
  return { byId, childrenOf, getEffective };
}

describe('rollup helpers (eQuoted / eActual / eCommitted)', () => {
  it('sums quoted_cost across subtasks for a task', () => {
    const nodes = [
      { id: 'P1', estimated_raw_cost: 75000 },
      { id: 'P1-T1' },
      { id: 'P1-T1-S1', quoted_cost: 4000 },
      { id: 'P1-T1-S2', quoted_cost: 6000 },
    ];
    const { byId, getEffective } = makeWorld(nodes);
    assert.equal(getEffective(byId.get('P1-T1'), 'quoted_cost'), 10000);
  });

  it('rolls quoted_cost up to the project level (sum of tasks)', () => {
    const nodes = [
      { id: 'P1' },
      { id: 'P1-T1' },
      { id: 'P1-T1-S1', quoted_cost: 3000 },
      { id: 'P1-T2' },
      { id: 'P1-T2-S1', quoted_cost: 7000 },
    ];
    const { byId, getEffective } = makeWorld(nodes);
    assert.equal(getEffective(byId.get('P1'), 'quoted_cost'), 10000);
  });

  it('treats missing field as 0 in the sum (does not skip the row)', () => {
    const nodes = [
      { id: 'P1-T1' },
      { id: 'P1-T1-S1', quoted_cost: 5000 },
      { id: 'P1-T1-S2' /* no quoted_cost */ },
    ];
    const { byId, getEffective } = makeWorld(nodes);
    assert.equal(getEffective(byId.get('P1-T1'), 'quoted_cost'), 5000);
  });

  it('sums actual_spend_to_date and committed_to_spend independently', () => {
    const nodes = [
      { id: 'P1-T1' },
      { id: 'P1-T1-S1', actual_spend_to_date: 5000, committed_to_spend: 1000 },
      { id: 'P1-T1-S2', actual_spend_to_date: 2000, committed_to_spend: 3000 },
    ];
    const { byId, getEffective } = makeWorld(nodes);
    const t = byId.get('P1-T1');
    assert.equal(getEffective(t, 'actual_spend_to_date'), 7000);
    assert.equal(getEffective(t, 'committed_to_spend'), 4000);
  });
});
