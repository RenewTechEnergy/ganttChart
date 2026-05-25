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
    if (n.type !== 'project' && (n.id || '').includes('-')) continue;
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
