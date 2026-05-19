/*
 * Concurrency / multi-user tests for the Supabase sync logic in ../index.html.
 *
 * ─── SCOPE — read this before adding tests ───────────────────────────────
 *
 * JavaScript runs on a single thread, so these tests do NOT prove anything
 * about parallel execution. What they DO prove is that the conflict-resolution
 * state machine handles the *interleavings* of operations from multiple
 * simulated clients correctly.
 *
 * What is exercised:
 *   ✓ Optimistic concurrency control (OCC) via the `version` column —
 *     PATCH-with-stale-version returns 0 rows → marked conflict → refetch →
 *     local edit preserved for retry.
 *   ✓ Microtask coalescing — N rapid saves in the same tick produce 1 flush.
 *   ✓ Echo suppression — your own write echoed back via the realtime channel
 *     is dropped by the `recentWrites` Set.
 *   ✓ Dirty-id tracking — realtime updates for ids you've touched locally
 *     are suppressed; updates for other ids pass through.
 *   ✓ Row-level diff — only rows whose normalized shape changed are PATCHed.
 *   ✓ Predecessor signature stability across reordering / whitespace.
 *   ✓ Two-client interleavings against a shared fake server.
 *
 * What is NOT exercised (would need real infrastructure):
 *   ✗ Real network races, packet reordering, partial failures, retries
 *   ✗ Supabase Row-Level Security, triggers, the version-bumping trigger
 *   ✗ WebSocket realtime arrival timing
 *   ✗ Browser-tab races on localStorage (different concern)
 *   ✗ Actual parallel execution
 *
 * The helpers below are verbatim copies of pure logic from index.html — if
 * you change one there, mirror it here. The `FakeServer` and `Client` classes
 * are *not* copies; they're test doubles that mimic the PostgREST contract
 * and the index.html save path so we can drive deterministic interleavings.
 *
 * Run in a browser: open tests/test_concurrency.html.
 * Run on the command line: node tests/test_concurrency.js (Node 18+).
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────
 * Pure helpers — copied from index.html
 * ───────────────────────────────────────────────────────────────────────── */

// index.html:756
function parentIdOf(id) {
  const parts = String(id).split('-');
  return parts.length === 1 ? null : parts.slice(0, -1).join('-');
}

// index.html:761
function nodeToDbRow(n) {
  return {
    id: n.id,
    parent_id: parentIdOf(n.id),
    kind: n.type,
    name: n.name,
    owner: n.owner || null,
    duration_days: 0,
    sched_start: n.sched_start || null,
    sched_end: n.sched_end || null,
    actual_start: n.actual_start || null,
    actual_end: n.actual_end || null,
    slack_days: n.slack === '' || n.slack == null ? null : parseInt(n.slack, 10),
    pct_done: Number(n.percent_done) || 0,
    est_cost: Number(n.est_cost) || 0,
    cost_to_date: Number(n.cost_to_date) || 0,
    sale_price: Number(n.sale_price) || 0,
  };
}

// index.html:783
function normalizeForDiff(r) {
  const num = (v) => v == null || v === '' ? 0 : Number(v);
  return {
    kind:          r.kind ?? null,
    name:          r.name ?? null,
    owner:         r.owner || null,
    parent_id:     r.parent_id ?? null,
    duration_days: num(r.duration_days),
    sched_start:   r.sched_start || null,
    sched_end:     r.sched_end   || null,
    actual_start:  r.actual_start || null,
    actual_end:    r.actual_end   || null,
    slack_days:    r.slack_days == null ? null : Number(r.slack_days),
    pct_done:      num(r.pct_done),
    est_cost:      num(r.est_cost),
    cost_to_date:  num(r.cost_to_date),
    sale_price:    num(r.sale_price),
  };
}

// index.html:802
function rowChanged(a, b) {
  if (!b) return true;
  return JSON.stringify(normalizeForDiff(a)) !== JSON.stringify(normalizeForDiff(b));
}

// index.html:809
function predSignature(predStr) {
  if (!predStr) return '';
  const ids = String(predStr).split(/[,;]\s*/).map(s => s.trim()).filter(Boolean)
    .map(raw => {
      const m = raw.match(/^[A-Za-z]\d+(-[A-Za-z]\d+)*/);
      return m ? m[0] : raw;
    });
  return Array.from(new Set(ids)).sort().join(',');
}

// index.html:601 — strip a server row down to the snapshot the client caches.
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

/* ─────────────────────────────────────────────────────────────────────────
 * FakeServer — mimics the PostgREST contract index.html relies on.
 *
 * The real Supabase row has a `version` column bumped by a trigger on UPDATE.
 * Here we bump it explicitly in patch(). PATCHes with a stale `seenVersion`
 * return an empty array (PostgREST behavior when the WHERE clause matches
 * nothing). That empty array is what triggers the client's conflict path.
 * ───────────────────────────────────────────────────────────────────────── */
class FakeServer {
  constructor() {
    this.rows = new Map();         // id -> full row including version
    this.opLog = [];               // chronological log of every accepted op
  }
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
  // OCC PATCH: returns [] if seenVersion is stale, else [updated row] with version bumped.
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

/* ─────────────────────────────────────────────────────────────────────────
 * Client — distilled version of the queueUpsertAll → flushPending →
 * upsertAll path from index.html. Drops UI bits, network logging, and the
 * predecessor sync; keeps the OCC + diff + microtask-coalescing + echo
 * suppression logic, which is what we want to test.
 *
 * One Client instance represents one signed-in user / browser tab.
 * ───────────────────────────────────────────────────────────────────────── */
class Client {
  constructor(server, opts = {}) {
    this.server = server;
    this.serverRows = new Map();   // local cache of what we last saw on the server
    this.dirtyIds = new Set();
    this.recentWrites = new Set(); // `${id}@${version}` strings, 10s TTL in real code
    this.pendingNodes = null;
    this.flushScheduled = false;
    this.visible = opts.visible !== false;  // default visible
    this.flushCount = 0;            // for "how many times did we hit the server?"
    this.conflictsObserved = [];    // ids that hit OCC conflict on last save
  }

  // Initial load — seeds the local cache from the server (loadBoard equivalent).
  loadBoard() {
    this.serverRows.clear();
    for (const r of this.server.rows.values()) {
      this.serverRows.set(r.id, rowToServerSnapshot(r));
    }
  }

  // Equivalent of saveLocal() → queueUpsertAll(NODES) in index.html.
  queueUpsertAll(nodes) {
    this.pendingNodes = nodes.map(n => ({ ...n }));   // structuredClone equivalent for plain data
    for (const n of nodes) {
      const seen = this.serverRows.get(n.id);
      if (!seen || rowChanged(nodeToDbRow(n), seen)) this.dirtyIds.add(n.id);
    }
    if (!this.visible) return;                 // hidden tab: stash only
    if (this.flushScheduled) return;           // microtask coalescing
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushPending();
    });
  }

  // Synchronous variant of flushPending — calls our sync upsertAll.
  flushPending() {
    if (!this.pendingNodes) return;
    if (!this.visible) return;
    const snap = this.pendingNodes;
    this.pendingNodes = null;
    this.flushCount++;
    this.upsertAllSync(snap);
  }

  // Sync version of upsertAll. (Real one is async; we make it sync against
  // the FakeServer so tests can drive deterministic interleavings.)
  upsertAllSync(nodes) {
    this.conflictsObserved = [];
    const inserts = [];
    const updates = [];
    for (const n of nodes) {
      const row = nodeToDbRow(n);
      const seen = this.serverRows.get(row.id);
      if (!seen)                          inserts.push(row);
      else if (rowChanged(row, seen))     updates.push({ row, seenVersion: seen.version || 1 });
    }
    if (inserts.length) {
      const created = this.server.insert(inserts);
      for (const r of created) {
        this.serverRows.set(r.id, rowToServerSnapshot(r));
        this.markRecentWrite(r.id, r.version);
        this.dirtyIds.delete(r.id);
      }
    }
    for (const { row, seenVersion } of updates) {
      const body = { ...row }; delete body.id;
      const after = this.server.patch(row.id, body, seenVersion);
      if (!after.length) {
        this.conflictsObserved.push(row.id);
        // Leave dirty — next save retries against the new version.
      } else {
        this.serverRows.set(after[0].id, rowToServerSnapshot(after[0]));
        this.markRecentWrite(after[0].id, after[0].version);
        this.dirtyIds.delete(after[0].id);
      }
    }
    // After conflicts: refetch (so the next save uses the new server version).
    if (this.conflictsObserved.length) {
      const fresh = this.server.getAll(this.conflictsObserved);
      for (const r of fresh) this.serverRows.set(r.id, rowToServerSnapshot(r));
    }
  }

  markRecentWrite(id, version) {
    this.recentWrites.add(`${id}@${version}`);
    // (Real code expires after 10s; we don't need timers in tests.)
  }

  // Simulate a realtime echo arriving from the server. Returns true if it
  // would be applied locally, false if suppressed.
  receiveRealtimeUpdate(row) {
    const key = `${row.id}@${row.version}`;
    if (this.recentWrites.has(key)) return false;        // our own echo
    if (this.dirtyIds.has(row.id))   return false;        // local edit in flight
    this.serverRows.set(row.id, rowToServerSnapshot(row));
    return true;
  }

  setVisibility(v) {
    const wasHidden = !this.visible;
    this.visible = v;
    if (v && wasHidden && this.pendingNodes) this.flushPending();
  }
}

// Helper: a minimal NODES-shape row.
function makeNode(id, overrides = {}) {
  return {
    id, type: id.includes('-') ? (id.split('-').length === 2 ? 'task' : 'subtask') : 'project',
    name: id, owner: '', predecessors: '',
    sched_start: '', sched_end: '', actual_start: '', actual_end: '',
    slack: '', percent_done: 0, est_cost: '', cost_to_date: '', sale_price: '',
    ...overrides,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Tiny test runner (same shape as test_index.js)
 * ───────────────────────────────────────────────────────────────────────── */
const tests = [];
let currentSuite = '';
function describe(name, fn) { currentSuite = name; fn(); }
function it(name, fn) { tests.push({ suite: currentSuite, name, fn, async: fn.constructor.name === 'AsyncFunction' }); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'eq'}: expected ${e}, got ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(`${label || 'ok'}: expected truthy, got ${cond}`); }

// Microtasks: queueMicrotask runs synchronously after the current task.
// `await Promise.resolve()` is enough to drain one round of microtasks; we
// loop a few times to be safe for nested queueMicrotask calls.
async function drainMicrotasks(n = 5) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/* ─────────────────────────────────────────────────────────────────────────
 * Pure helper tests — quick checks that the diff/signature primitives behave
 * correctly. These underpin everything else.
 * ───────────────────────────────────────────────────────────────────────── */

describe('rowChanged / normalizeForDiff', () => {
  it('returns true when seen is missing', () => {
    ok(rowChanged({ kind: 'task', name: 'a' }, null));
  });
  it('returns false for identical rows', () => {
    const a = nodeToDbRow(makeNode('P1', { name: 'Alpha' }));
    const b = { ...a, version: 1 };
    ok(!rowChanged(a, b));
  });
  it('coerces "" and null and 0 to the same shape', () => {
    const a = { kind: 'task', name: 'x', owner: '', pct_done: '', est_cost: null };
    const b = { kind: 'task', name: 'x', owner: null, pct_done: 0, est_cost: 0 };
    ok(!rowChanged(a, b));
  });
  it('detects a name change', () => {
    const a = nodeToDbRow(makeNode('P1', { name: 'Alpha' }));
    const b = { ...nodeToDbRow(makeNode('P1', { name: 'Beta' })), version: 1 };
    ok(rowChanged(a, b));
  });
  it('detects a percent_done change', () => {
    const a = nodeToDbRow(makeNode('P1', { percent_done: 50 }));
    const b = { ...nodeToDbRow(makeNode('P1', { percent_done: 60 })), version: 1 };
    ok(rowChanged(a, b));
  });
});

describe('predSignature', () => {
  it('is empty for blank input', () => eq(predSignature(''), ''));
  it('sorts ids alphabetically (order-independent)', () => {
    eq(predSignature('P1-T3, P1-T1, P1-T2'), 'P1-T1,P1-T2,P1-T3');
  });
  it('dedupes repeated ids', () => {
    eq(predSignature('P1-T1, P1-T1'), 'P1-T1');
  });
  it('strips suffixes like FS+2 to the bare id', () => {
    eq(predSignature('P1-T1FS+2, P1-T2SS-1'), 'P1-T1,P1-T2');
  });
  it('is equal for comma- and semicolon-separated lists', () => {
    eq(predSignature('P1-T1, P1-T2'), predSignature('P1-T1; P1-T2'));
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Microtask coalescing — same-tick edits should produce one flush.
 * ───────────────────────────────────────────────────────────────────────── */

describe('microtask coalescing (queueUpsertAll → flushPending)', () => {
  it('5 rapid saves in one tick → 1 flush, 1 server PATCH', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1', { name: 'v0' }))]);
    const client = new Client(server);
    client.loadBoard();

    for (let i = 1; i <= 5; i++) {
      client.queueUpsertAll([makeNode('P1', { name: `v${i}` })]);
    }
    await drainMicrotasks();

    eq(client.flushCount, 1, 'flushCount');
    const patches = server.opLog.filter(o => o.kind === 'PATCH').length;
    eq(patches, 1, 'PATCH count');
    eq(server.get('P1').name, 'v5', 'final name (last write wins)');
    eq(server.get('P1').version, 2, 'version bumped once');
  });

  it('saves in separate ticks each trigger their own flush', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1', { name: 'v0' }))]);
    const client = new Client(server);
    client.loadBoard();

    client.queueUpsertAll([makeNode('P1', { name: 'v1' })]);
    await drainMicrotasks();
    client.queueUpsertAll([makeNode('P1', { name: 'v2' })]);
    await drainMicrotasks();

    eq(client.flushCount, 2);
    eq(server.get('P1').version, 3, 'two version bumps');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Visibility deferral — hidden tab stashes, visible tab flushes on resume.
 * ───────────────────────────────────────────────────────────────────────── */

describe('visibility deferral', () => {
  it('hidden tab does not hit the server', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1', { name: 'v0' }))]);
    const client = new Client(server, { visible: false });
    client.loadBoard();

    client.queueUpsertAll([makeNode('P1', { name: 'v1' })]);
    await drainMicrotasks();
    eq(client.flushCount, 0);
    eq(server.get('P1').name, 'v0');
  });

  it('becoming visible flushes the pending snapshot', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1', { name: 'v0' }))]);
    const client = new Client(server, { visible: false });
    client.loadBoard();

    client.queueUpsertAll([makeNode('P1', { name: 'v1' })]);
    client.setVisibility(true);
    eq(client.flushCount, 1);
    eq(server.get('P1').name, 'v1');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * OCC — two clients editing the same row.
 * Real-world scenario: Alice and Bob both have the project open, both edit
 * task P1-T1, Alice saves first.
 * ───────────────────────────────────────────────────────────────────────── */

describe('OCC: two clients, same row', () => {
  it('first writer wins; second writer hits conflict and preserves local edit', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1-T1', { name: 'original' }))]);

    const alice = new Client(server);
    const bob   = new Client(server);
    alice.loadBoard();
    bob.loadBoard();

    // Both see version 1.
    eq(alice.serverRows.get('P1-T1').version, 1);
    eq(bob.serverRows.get('P1-T1').version, 1);

    // Alice saves first.
    alice.queueUpsertAll([makeNode('P1-T1', { name: 'alice-edit' })]);
    await drainMicrotasks();
    eq(server.get('P1-T1').name, 'alice-edit');
    eq(server.get('P1-T1').version, 2);
    eq(alice.conflictsObserved, []);

    // Bob saves with stale version → conflict.
    bob.queueUpsertAll([makeNode('P1-T1', { name: 'bob-edit' })]);
    await drainMicrotasks();
    eq(bob.conflictsObserved, ['P1-T1'], 'bob saw OCC conflict');
    eq(server.get('P1-T1').name, 'alice-edit', 'server still has alice value');
    eq(server.get('P1-T1').version, 2, 'no version bump from rejected PATCH');
    ok(bob.dirtyIds.has('P1-T1'), 'bob keeps row dirty for retry');
    eq(bob.serverRows.get('P1-T1').version, 2, 'bob refetched the new version');
  });

  it('bob retries after refetch and now wins (last-write-wins per row)', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1-T1', { name: 'original' }))]);
    const alice = new Client(server), bob = new Client(server);
    alice.loadBoard(); bob.loadBoard();

    alice.queueUpsertAll([makeNode('P1-T1', { name: 'alice-edit' })]);
    await drainMicrotasks();
    bob.queueUpsertAll([makeNode('P1-T1', { name: 'bob-edit' })]);
    await drainMicrotasks();
    // Bob retries with the value he still wants.
    bob.queueUpsertAll([makeNode('P1-T1', { name: 'bob-edit' })]);
    await drainMicrotasks();

    eq(server.get('P1-T1').name, 'bob-edit');
    eq(server.get('P1-T1').version, 3);
    eq(bob.conflictsObserved, []);
    ok(!bob.dirtyIds.has('P1-T1'), 'bob cleared dirty after successful retry');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * OCC — two clients editing different rows. Should NOT conflict.
 * ───────────────────────────────────────────────────────────────────────── */

describe('OCC: two clients, disjoint rows', () => {
  it('both writes succeed without conflict', async () => {
    const server = new FakeServer();
    server.insert([
      nodeToDbRow(makeNode('P1-T1', { name: 'task-1' })),
      nodeToDbRow(makeNode('P1-T2', { name: 'task-2' })),
    ]);
    const alice = new Client(server), bob = new Client(server);
    alice.loadBoard(); bob.loadBoard();

    alice.queueUpsertAll([makeNode('P1-T1', { name: 'alice-1' })]);
    bob.queueUpsertAll([makeNode('P1-T2', { name: 'bob-2' })]);
    await drainMicrotasks();

    eq(alice.conflictsObserved, []);
    eq(bob.conflictsObserved, []);
    eq(server.get('P1-T1').name, 'alice-1');
    eq(server.get('P1-T2').name, 'bob-2');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Three clients, interleaved edits on the same row.
 * ───────────────────────────────────────────────────────────────────────── */

describe('three clients, same row, interleaved', () => {
  it('only the writer holding the current version wins each round', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1-T1', { name: 'v0' }))]);
    const a = new Client(server), b = new Client(server), c = new Client(server);
    a.loadBoard(); b.loadBoard(); c.loadBoard();

    // All three queue edits while holding version 1.
    a.queueUpsertAll([makeNode('P1-T1', { name: 'a' })]);
    b.queueUpsertAll([makeNode('P1-T1', { name: 'b' })]);
    c.queueUpsertAll([makeNode('P1-T1', { name: 'c' })]);
    await drainMicrotasks();

    // a wins (first to land), b and c conflict.
    eq(server.get('P1-T1').name, 'a');
    eq(server.get('P1-T1').version, 2);
    eq(a.conflictsObserved, []);
    eq(b.conflictsObserved, ['P1-T1']);
    eq(c.conflictsObserved, ['P1-T1']);

    // Both b and c refetched to version 2. b retries; should win.
    b.queueUpsertAll([makeNode('P1-T1', { name: 'b' })]);
    await drainMicrotasks();
    eq(server.get('P1-T1').name, 'b');
    eq(server.get('P1-T1').version, 3);

    // c (still holding version 2) retries; should conflict again.
    c.queueUpsertAll([makeNode('P1-T1', { name: 'c' })]);
    await drainMicrotasks();
    eq(c.conflictsObserved, ['P1-T1']);
    eq(server.get('P1-T1').name, 'b', 'b still holds');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Realtime echo suppression — your own write echoing back must not clobber
 * a more recent local edit.
 * ───────────────────────────────────────────────────────────────────────── */

describe('realtime echo suppression', () => {
  it('client suppresses its own write echoed back', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1-T1', { name: 'v0' }))]);
    const client = new Client(server);
    client.loadBoard();

    client.queueUpsertAll([makeNode('P1-T1', { name: 'v1' })]);
    await drainMicrotasks();
    // Server "broadcasts" the row that the client just wrote.
    const applied = client.receiveRealtimeUpdate(server.get('P1-T1'));
    eq(applied, false, 'echo of own write was suppressed');
  });

  it('client applies a realtime update from another user', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1-T1', { name: 'v0' }))]);
    const alice = new Client(server), bob = new Client(server);
    alice.loadBoard(); bob.loadBoard();

    bob.queueUpsertAll([makeNode('P1-T1', { name: 'bob-edit' })]);
    await drainMicrotasks();
    // Server broadcasts Bob's write to Alice.
    const applied = alice.receiveRealtimeUpdate(server.get('P1-T1'));
    eq(applied, true, 'alice applied bob\'s update');
    eq(alice.serverRows.get('P1-T1').name, 'bob-edit');
  });

  it('dirty-id blocks realtime overwrite for an in-flight local edit', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1-T1', { name: 'v0' }))]);
    const alice = new Client(server), bob = new Client(server);
    alice.loadBoard(); bob.loadBoard();

    // Alice starts editing P1-T1 — this populates her dirtyIds before any save.
    alice.queueUpsertAll([makeNode('P1-T1', { name: 'alice-typing' })]);
    // Before alice's flush lands, bob's write arrives via realtime.
    // (Force a manual sync of bob's edit first so the realtime payload exists.)
    // Reset alice's flushScheduled so she hasn't flushed yet:
    // ...
    // Simpler: just check that dirtyIds blocks regardless of flush state.
    ok(alice.dirtyIds.has('P1-T1'), 'alice is dirty on P1-T1');
    // Construct a hypothetical incoming bob-write payload at version 2.
    const bobPayload = { ...server.get('P1-T1'), name: 'bob-edit', version: 2 };
    const applied = alice.receiveRealtimeUpdate(bobPayload);
    eq(applied, false, 'realtime overwrite suppressed while alice has unsaved local edit');
  });

  it('realtime updates for OTHER ids pass through even when some ids are dirty', async () => {
    const server = new FakeServer();
    server.insert([
      nodeToDbRow(makeNode('P1-T1', { name: 'task1-v0' })),
      nodeToDbRow(makeNode('P1-T2', { name: 'task2-v0' })),
    ]);
    const alice = new Client(server);
    alice.loadBoard();

    // Alice is editing T1, not T2.
    alice.queueUpsertAll([makeNode('P1-T1', { name: 'alice-typing' })]);
    const t2payload = { ...server.get('P1-T2'), name: 'bob-on-t2', version: 2 };
    const applied = alice.receiveRealtimeUpdate(t2payload);
    eq(applied, true, 'unrelated id passes through');
    eq(alice.serverRows.get('P1-T2').name, 'bob-on-t2');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Diff path — unchanged rows must NOT be PATCHed.
 * ───────────────────────────────────────────────────────────────────────── */

describe('unchanged rows are not PATCHed', () => {
  it('queueing a save with no actual changes triggers zero PATCHes', async () => {
    const server = new FakeServer();
    server.insert([nodeToDbRow(makeNode('P1', { name: 'Alpha' }))]);
    const client = new Client(server);
    client.loadBoard();

    // Same node, same values.
    client.queueUpsertAll([makeNode('P1', { name: 'Alpha' })]);
    await drainMicrotasks();

    const patches = server.opLog.filter(o => o.kind === 'PATCH').length;
    eq(patches, 0, 'no PATCH for unchanged row');
    eq(client.conflictsObserved, []);
  });

  it('mixed batch: only changed rows are PATCHed', async () => {
    const server = new FakeServer();
    server.insert([
      nodeToDbRow(makeNode('P1-T1', { name: 'a' })),
      nodeToDbRow(makeNode('P1-T2', { name: 'b' })),
      nodeToDbRow(makeNode('P1-T3', { name: 'c' })),
    ]);
    const client = new Client(server);
    client.loadBoard();

    client.queueUpsertAll([
      makeNode('P1-T1', { name: 'a' }),         // unchanged
      makeNode('P1-T2', { name: 'b-edited' }),  // changed
      makeNode('P1-T3', { name: 'c' }),         // unchanged
    ]);
    await drainMicrotasks();

    const patches = server.opLog.filter(o => o.kind === 'PATCH');
    eq(patches.length, 1, 'one PATCH');
    eq(patches[0].id, 'P1-T2', 'only the changed row');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * End-to-end multi-user scenario — narrative test mirroring a realistic
 * sequence of operations.
 * ───────────────────────────────────────────────────────────────────────── */

describe('scenario: two PMs editing the same board', () => {
  it('handles a realistic interleaving without data loss', async () => {
    const server = new FakeServer();
    server.insert([
      nodeToDbRow(makeNode('P1',    { name: 'Solar Install — Smith Residence', owner: 'alice' })),
      nodeToDbRow(makeNode('P1-T1', { name: 'Permitting', percent_done: 0 })),
      nodeToDbRow(makeNode('P1-T2', { name: 'Materials',  percent_done: 0 })),
      nodeToDbRow(makeNode('P1-T3', { name: 'Install',    percent_done: 0 })),
    ]);

    const alice = new Client(server);   // PM in the office
    const bob   = new Client(server);   // foreman in the field
    alice.loadBoard();
    bob.loadBoard();

    // Alice renames the project. The unchanged child rows are diffed and skipped.
    alice.queueUpsertAll([
      makeNode('P1',    { name: 'Solar — Smith (rev. b)', owner: 'alice' }),
      makeNode('P1-T1', { name: 'Permitting' }),
      makeNode('P1-T2', { name: 'Materials' }),
      makeNode('P1-T3', { name: 'Install' }),
    ]);
    await drainMicrotasks();
    eq(alice.conflictsObserved, []);
    eq(server.get('P1').name, 'Solar — Smith (rev. b)');
    eq(server.opLog.filter(o => o.kind === 'PATCH').length, 1, 'only P1 was PATCHed');

    // Bob (offline-ish, holds the old version of P1) tries to reassign the
    // owner AND marks T2 as in progress. This time he's actually editing P1,
    // so the OCC version check triggers.
    bob.queueUpsertAll([
      makeNode('P1',    { name: 'Solar Install — Smith Residence', owner: 'bob' }),
      makeNode('P1-T1', { name: 'Permitting' }),
      makeNode('P1-T2', { name: 'Materials', percent_done: 100 }),
      makeNode('P1-T3', { name: 'Install' }),
    ]);
    await drainMicrotasks();

    // T2 had no conflict — bob held the right version.
    eq(server.get('P1-T2').pct_done, 100);
    // P1 conflicted — alice bumped it to v=2 before bob's PATCH landed.
    eq(bob.conflictsObserved, ['P1']);
    eq(server.get('P1').name, 'Solar — Smith (rev. b)', 'alice\'s name survived');
    eq(server.get('P1').owner, 'alice', 'bob\'s owner change was rejected by OCC');
    eq(bob.serverRows.get('P1').version, 2, 'bob refetched and now sees v=2');
    ok(bob.dirtyIds.has('P1'), 'bob keeps P1 dirty for retry');

    // Alice sees bob's T2 update arrive via realtime.
    const applied = alice.receiveRealtimeUpdate(server.get('P1-T2'));
    eq(applied, true);
    eq(alice.serverRows.get('P1-T2').pct_done, 100);

    // Bob retries his owner change against the new project name. Now it sticks.
    bob.queueUpsertAll([
      makeNode('P1', { name: 'Solar — Smith (rev. b)', owner: 'bob' }),
    ]);
    await drainMicrotasks();
    eq(bob.conflictsObserved, []);
    eq(server.get('P1').owner, 'bob');
    eq(server.get('P1').name,  'Solar — Smith (rev. b)', 'alice\'s name change preserved');

    // No data was lost: every intended edit landed.
    eq(server.get('P1').name,        'Solar — Smith (rev. b)');
    eq(server.get('P1').owner,       'bob');
    eq(server.get('P1-T2').pct_done, 100);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Runner (mirrors test_index.js — supports both Node and browser).
 * ───────────────────────────────────────────────────────────────────────── */
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

  let passed = 0, failed = 0;
  let lastSuite = '';
  for (const t of tests) {
    if (t.suite !== lastSuite) {
      write('');
      write(t.suite, 'suite');
      lastSuite = t.suite;
    }
    try {
      await t.fn();
      write(`  ok   ${t.name}`, 'pass');
      passed++;
    } catch (e) {
      write(`  FAIL ${t.name}`, 'fail');
      write(`       ${e.message}`, 'fail');
      failed++;
    }
  }
  write('');
  write(`${passed} passed, ${failed} failed (of ${tests.length})`, failed ? 'fail' : 'pass');
  if (!isBrowser && typeof process !== 'undefined') process.exit(failed === 0 ? 0 : 1);
}

if (typeof window === 'undefined') {
  runTests();
} else {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runTests);
  else runTests();
}
