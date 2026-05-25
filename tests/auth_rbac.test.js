// Targeted tests for the auth + RBAC additions. These mirror small pure
// helpers from index.html / the chat edge function; they do NOT exercise
// the live Supabase backend.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Manual-add dropdown sort (numeric-locale comparator) ──────────────────
// Used in index.html openAdd() to keep projects/tasks in PID order so
// "P1, P2, P3, P10" doesn't appear as "P1, P10, P2, P3".
const byIdNumeric = (a, b) =>
  String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' });

describe('byIdNumeric (manual-add sort)', () => {
  it('sorts P1, P2, P10, P3 by their numeric component', () => {
    const sorted = [{ id: 'P10' }, { id: 'P1' }, { id: 'P3' }, { id: 'P2' }].sort(byIdNumeric);
    assert.deepEqual(sorted.map(p => p.id), ['P1', 'P2', 'P3', 'P10']);
  });

  it('sorts subtask-style hyphenated ids naturally', () => {
    const sorted = [
      { id: 'P1-T10' }, { id: 'P1-T1' }, { id: 'P1-T2' },
    ].sort(byIdNumeric);
    assert.deepEqual(sorted.map(p => p.id), ['P1-T1', 'P1-T2', 'P1-T10']);
  });
});

// ─── AI op → project id (RBAC gate input) ─────────────────────────────────
// Mirrors aiOpProjectId from index.html. We re-implement here so the test
// stays runnable without a DOM. Verifies the cases the RBAC gate cares about.
const typeFromId = (id) => {
  const segs = String(id).split('-');
  if (segs.length === 1) return 'project';
  if (segs.length === 2) return 'task';
  return 'subtask';
};

function aiOpProjectId(op, draft, resolveByName) {
  if (!op || !op.operation) return null;
  if (op.operation === 'query_schedule') return null;
  if (op.operation === 'create_project_candidate') return null;
  if (op.operation === 'create_item' && op.target?.item_type === 'project') return null;

  if (op.operation === 'create_item') {
    const projName = String(op.target?.project || '').trim().toLowerCase();
    if (!projName || projName === 'n/a') return null;
    const proj = draft.find(n =>
      typeFromId(n.id) === 'project'
      && String(n.name || '').toLowerCase() === projName
    );
    return proj ? proj.id : null;
  }

  // For non-create ops, the real implementation calls aiResolveTarget;
  // tests pass in a simple resolver to keep the unit test pure.
  const res = resolveByName(op.target, draft);
  if (!res || !res.id) return null;
  return res.id.split('-')[0];
}

describe('aiOpProjectId (RBAC gate)', () => {
  const draft = [
    { id: 'P1',     name: 'Mulgrave Solar Farm' },
    { id: 'P2',     name: 'Glossodia BESS' },
    { id: 'P1-T1',  name: 'DA approval' },
    { id: 'P2-T1',  name: 'BESS delivery' },
  ];
  const resolveByName = (target, nodes) => {
    if (target?.item) {
      const lower = String(target.item).toLowerCase();
      const hit = nodes.find(n => String(n.name || '').toLowerCase() === lower);
      if (hit) return { id: hit.id };
    }
    return null;
  };

  it('returns null for query_schedule (read-only)', () => {
    assert.equal(aiOpProjectId({ operation: 'query_schedule', target: {} }, draft, resolveByName), null);
  });

  it('returns null for create-project (always allowed)', () => {
    assert.equal(
      aiOpProjectId(
        { operation: 'create_item', target: { item_type: 'project', item: 'X', project: 'X' } },
        draft,
        resolveByName,
      ),
      null,
    );
  });

  it('returns the parent project id for create_item under an existing project', () => {
    assert.equal(
      aiOpProjectId(
        { operation: 'create_item', target: { item_type: 'task', project: 'Mulgrave Solar Farm', item: 'New phase' } },
        draft,
        resolveByName,
      ),
      'P1',
    );
  });

  it('returns the project id for update_item by item name', () => {
    assert.equal(
      aiOpProjectId(
        { operation: 'update_item', target: { item: 'BESS delivery' } },
        draft,
        resolveByName,
      ),
      'P2',
    );
  });
});

// ─── delete-user request validation ───────────────────────────────────────
// Re-implemented inline (same pattern as byIdNumeric / aiOpProjectId above)
// so the unit test runs without booting Deno. The real function in
// supabase/functions/delete-user/index.ts MUST keep these rules in sync.
function validateDeleteUserBody(body, callerUserId) {
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'Invalid JSON body.' };
  const userId      = typeof body.user_id      === 'string' ? body.user_id.trim()      : '';
  const reassignTo  = typeof body.reassign_to  === 'string' ? body.reassign_to.trim()  : '';
  if (!userId)                   return { ok: false, status: 400, error: 'Missing user_id.' };
  if (!reassignTo)               return { ok: false, status: 400, error: 'Missing reassign_to.' };
  if (userId === callerUserId)   return { ok: false, status: 400, error: 'Admins cannot remove themselves.' };
  if (userId === reassignTo)     return { ok: false, status: 400, error: 'reassign_to must be a different user than user_id.' };
  return { ok: true, userId, reassignTo };
}

describe('validateDeleteUserBody (delete-user request validation)', () => {
  const ME = 'caller-uuid';

  it('accepts a well-formed body', () => {
    const out = validateDeleteUserBody({ user_id: 'u1', reassign_to: 'u2' }, ME);
    assert.equal(out.ok, true);
    assert.equal(out.userId, 'u1');
    assert.equal(out.reassignTo, 'u2');
  });

  it('rejects an empty body', () => {
    const out = validateDeleteUserBody(null, ME);
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
  });

  it('rejects when user_id is missing', () => {
    const out = validateDeleteUserBody({ reassign_to: 'u2' }, ME);
    assert.equal(out.ok, false);
    assert.match(out.error, /user_id/);
  });

  it('rejects when reassign_to is missing', () => {
    const out = validateDeleteUserBody({ user_id: 'u1' }, ME);
    assert.equal(out.ok, false);
    assert.match(out.error, /reassign_to/);
  });

  it('refuses self-deletion', () => {
    const out = validateDeleteUserBody({ user_id: ME, reassign_to: 'u2' }, ME);
    assert.equal(out.ok, false);
    assert.match(out.error, /themselves/);
  });

  it('refuses reassign-to-same-user', () => {
    const out = validateDeleteUserBody({ user_id: 'u1', reassign_to: 'u1' }, ME);
    assert.equal(out.ok, false);
    assert.match(out.error, /different user/);
  });
});
