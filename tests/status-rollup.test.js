import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure-function port of computeStatus's priority rollup. Mirrors the production
// helper in index.html (search: `function computeStatus`). DOM-free.
function makeWorld(nodes) {
  const parentOf = (id) => {
    const i = id.lastIndexOf('-');
    return i < 0 ? null : id.slice(0, i);
  };
  const childrenOf = (node) => nodes.filter(n => parentOf(n.id) === node.id);
  function computeStatus(node) {
    const kids = childrenOf(node);
    if (kids.length === 0) {
      const s = node.status || 'Not Started';
      return ['Not Started','In Progress','Delayed','Done'].includes(s) ? s : 'Not Started';
    }
    const subStatuses = [];
    (function walk(n) {
      for (const k of childrenOf(n)) {
        if (childrenOf(k).length === 0) {
          subStatuses.push(k.status || 'Not Started');
        } else {
          walk(k);
        }
      }
    })(node);
    if (subStatuses.length === 0)                                                 return 'Not Started';
    if (subStatuses.includes('Delayed'))                                          return 'Delayed';
    if (subStatuses.every(s => s === 'Done'))                                     return 'Done';
    if (subStatuses.some(s => s === 'Done' || s === 'In Progress'))               return 'In Progress';
    return 'Not Started';
  }
  return { computeStatus, byId: new Map(nodes.map(n => [n.id, n])) };
}

describe('computeStatus priority rollup', () => {
  it('leaf returns its own status', () => {
    const { computeStatus, byId } = makeWorld([{ id: 'P1-T1-S1', status: 'In Progress' }]);
    assert.equal(computeStatus(byId.get('P1-T1-S1')), 'In Progress');
  });

  it('leaf with no status defaults to "Not Started"', () => {
    const { computeStatus, byId } = makeWorld([{ id: 'P1-T1-S1' }]);
    assert.equal(computeStatus(byId.get('P1-T1-S1')), 'Not Started');
  });

  it('any Delayed in descendants → parent is Delayed (wins over In Progress)', () => {
    const { computeStatus, byId } = makeWorld([
      { id: 'P1' }, { id: 'P1-T1' },
      { id: 'P1-T1-S1', status: 'In Progress' },
      { id: 'P1-T1-S2', status: 'Delayed' },
      { id: 'P1-T1-S3', status: 'Done' },
    ]);
    assert.equal(computeStatus(byId.get('P1-T1')), 'Delayed');
    assert.equal(computeStatus(byId.get('P1')),    'Delayed');
  });

  it('no Delayed, any In Progress → parent is In Progress', () => {
    const { computeStatus, byId } = makeWorld([
      { id: 'P1' }, { id: 'P1-T1' },
      { id: 'P1-T1-S1', status: 'Not Started' },
      { id: 'P1-T1-S2', status: 'In Progress' },
      { id: 'P1-T1-S3', status: 'Done' },
    ]);
    assert.equal(computeStatus(byId.get('P1-T1')), 'In Progress');
  });

  it('all subtasks Done → parent is Done', () => {
    const { computeStatus, byId } = makeWorld([
      { id: 'P1' }, { id: 'P1-T1' },
      { id: 'P1-T1-S1', status: 'Done' },
      { id: 'P1-T1-S2', status: 'Done' },
    ]);
    assert.equal(computeStatus(byId.get('P1-T1')), 'Done');
    assert.equal(computeStatus(byId.get('P1')),    'Done');
  });

  it('some Done + some Not Started (none In Progress) → parent is In Progress (work has begun)', () => {
    const { computeStatus, byId } = makeWorld([
      { id: 'P1' }, { id: 'P1-T1' },
      { id: 'P1-T1-S1', status: 'Done' },
      { id: 'P1-T1-S2', status: 'Not Started' },
      { id: 'P1-T1-S3', status: 'Not Started' },
    ]);
    assert.equal(computeStatus(byId.get('P1-T1')), 'In Progress');
    assert.equal(computeStatus(byId.get('P1')),    'In Progress');
  });

  it('all subtasks Not Started → parent is Not Started', () => {
    const { computeStatus, byId } = makeWorld([
      { id: 'P1' }, { id: 'P1-T1' },
      { id: 'P1-T1-S1' },
      { id: 'P1-T1-S2' },
    ]);
    assert.equal(computeStatus(byId.get('P1-T1')), 'Not Started');
  });

  it('parent with zero subtasks → Not Started', () => {
    const { computeStatus, byId } = makeWorld([{ id: 'P1' }]);
    assert.equal(computeStatus(byId.get('P1')), 'Not Started');
  });

  it('project rolls across multiple tasks', () => {
    const { computeStatus, byId } = makeWorld([
      { id: 'P1' },
      { id: 'P1-T1' }, { id: 'P1-T1-S1', status: 'Done' },
      { id: 'P1-T2' }, { id: 'P1-T2-S1', status: 'In Progress' },
    ]);
    assert.equal(computeStatus(byId.get('P1')), 'In Progress');
  });
});
