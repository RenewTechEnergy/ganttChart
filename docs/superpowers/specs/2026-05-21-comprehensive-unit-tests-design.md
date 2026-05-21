# Comprehensive Unit Tests — Design

**Date:** 2026-05-21
**Status:** Design approved → ready for implementation plan
**Scope:** Replace the three mirror-style test files with one unified test file that calls the real functions inside `index.html`, runs in CI via GitHub Actions, and is built to grow as features land.

---

## 1. Problem

The current tests in `tests/test_index.js`, `tests/test_ai_edit.js`, and `tests/test_concurrency.js` each **copy** their target functions verbatim from `index.html`, with a "if you change one there, mirror it here" warning at the top. This produces two failure modes:

1. **Silent drift** — `index.html` changes, the copy doesn't. Tests pass green while real code is broken.
2. **No integration signal** — each function is tested against a copy of itself, not against the way it's actually composed in the app. The user's load-bearing example was *"for shifting, it's best to actually create the node, apply shift function, and see the changes"* — which is integration, not isolated unit testing.

There is also no CI: tests must be run manually, locally, in Node or a browser harness.

## 2. Goals

- Tests call the **real** functions inside `index.html`, never copies.
- One unified test file as the canonical source of truth (`tests/gantt.test.js`).
- Tests follow an integration pattern: build a `NODES` array → call the function → assert on the resulting state.
- Run automatically on every pull request against `main` via GitHub Actions.
- Easy to extend: adding a test for a new feature should require touching `gantt.test.js` plus (at most) one line in `index.html` to expose the function.

## 3. Non-goals (round one)

- **Excel/CSV import/export tests** (`parseCSV`, `buildImportedNodes`, `colLetter`, `isoToExcelSerial`, `crc32`) — deferred to a follow-up PR.
- **Supabase concurrency tests** — the existing `test_concurrency.js` mirror suite stays in place untouched; it gets migrated into the unified harness in a follow-up PR.
- **Live LLM smoke tests** (`test_llm.html`) — separate concern, kept as-is.
- **UI/DOM tests** (drag, modals, rendering) — would require Playwright or similar. Out of scope.
- **Refactoring `index.html` itself** — the file stays one HTML blob; we only add one new `<script>` block to expose functions.

## 4. Decisions made (one-line each)

| Axis | Choice |
|---|---|
| How tests reach real functions | `window.__test` namespace registered from `index.html` |
| Test runner | Node's built-in `node:test` |
| DOM environment | `jsdom` (one npm dep) |
| Initial scope | Hierarchy + formatters + sort + CPM + AI applier core |
| CI trigger | Pull request to `main` only |
| Old test files | Delete `test_index.js` + `test_ai_edit.js` (overlapping); keep `test_concurrency.js` and `test_llm.html` |
| Documented-but-unimplemented AI features | `it.skip(...)` in the new file |
| `getNodes()` return semantics | JSON deep-clone — tests can't mutate live state |

## 5. Architecture

```
┌──────────────────── tests/gantt.test.js (single file) ────────────────────┐
│  before(): loadGantt()  ──►  jsdom evaluates index.html                   │
│                                └─►  <script> registers window.__test      │
│  beforeEach(): __test.setNodes([]); __test.resetAI();                     │
│  each test: build NODES → call function → assert on post-state            │
└───────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────── .github/workflows/test.yml ───────────────────────────────────┐
│  on: pull_request → main                                                  │
│  steps: setup-node@v4 → npm ci → npm test                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.1 New files

| Path | Purpose |
|---|---|
| `tests/gantt.test.js` | The unified test file |
| `tests/loadGantt.js` | jsdom loader (~50 lines) |
| `package.json` | Declares `jsdom` dep + `npm test` script |
| `.github/workflows/test.yml` | CI workflow |
| `.gitignore` (append) | `node_modules/` |

### 5.2 Modified file

`index.html` — add one `<script>` block near the end registering `window.__test` (no other changes).

### 5.3 Deleted files

`tests/test_index.js`, `tests/test_index.html`, `tests/test_ai_edit.js`, `tests/test_ai_edit.html`.

### 5.4 Kept (out of scope round one)

`tests/test_concurrency.js`, `tests/test_concurrency.html`, `tests/test_llm.html`.

## 6. The `window.__test` contract

A single block in `index.html`, after all helper functions are defined, exposes a flat namespace of **direct references** to the real functions:

```js
window.__test = {
  // state plumbing
  setNodes: (arr) => { NODES.length = 0; for (const n of arr) NODES.push(n); },
  getNodes: () => JSON.parse(JSON.stringify(NODES)),
  resetAI:  () => { AI.draft = null; AI.baseSnapshot = null; AI.pendingChanges.length = 0; },

  // hierarchy / ids
  typeFromId, parentOf, nextId,

  // pure helpers
  cap1, parsePreds, clampPercent, defaultSaleFromEst, fmtMoney,
  addDays, fmtDate, esc, xmlEsc, naturalCompare,

  // CPM / scheduling
  runCPM, autoReschedule, childrenOf,

  // AI applier
  aiResolveTarget, aiAmountToDays, aiParseDate,
  aiApplyOperation,
  aiApplyShift, aiApplyCreate, aiApplyProgress, aiApplyOwner,
  aiBuildNode,
  aiRunCPMOnDraft, aiWithDraftScope,
};
```

**Contract rules:**

- **Flat, not nested.** Tests should call `t.runCPM(...)`, mirroring the real call sites in `index.html`.
- **References, not wrappers.** No `function testRunCPM(...) { return runCPM(...); }`. Drift is exactly what we're trying to eliminate.
- **`setNodes` / `getNodes` are the only synthetic additions.** They're the seam between test-controlled state and the closure-bound `NODES` array.
- **`getNodes()` deep-clones** so tests can hold a snapshot without observing later mutations.
- **No gating.** Exposed unconditionally — harmless in prod, removes a config knob.
- **AI scope = applier layer only.** UI-facing pieces (`aiApprove`, `aiAskClarification`, panel rendering) are not exposed; they need DOM + user interaction and are out of scope for unit tests.

## 7. The jsdom loader

`tests/loadGantt.js` builds a single shared jsdom window with `index.html` evaluated inside it, caches it, and returns `{ window, t: window.__test }`.

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = resolve(__dirname, '..', 'index.html');

let cached = null;

export async function loadGantt() {
  if (cached) return cached;

  const html = readFileSync(INDEX_HTML, 'utf8');
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});  // swallow CSS / network warnings

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: 'usable',
  });

  // index.html's startup tries to talk to Supabase — stub the network out.
  dom.window.fetch = async () => new dom.window.Response('[]', { status: 200 });

  // Let <script type="module"> blocks (e.g. Scheduler) finish initialising.
  await new Promise((r) => dom.window.queueMicrotask(r));

  if (!dom.window.__test) {
    throw new Error('window.__test was not registered — did index.html load cleanly?');
  }

  cached = { window: dom.window, t: dom.window.__test };
  return cached;
}
```

**Design notes:**

- **Single jsdom across all tests.** Loading index.html costs ~200ms; per-test re-load would dominate the run. Isolation comes from `beforeEach: setNodes([])`, not DOM teardown.
- **`fetch` stub.** `index.html` calls `Supa.loadBoard()` on startup; without the stub, jsdom logs network errors but doesn't crash. Stubbing is cleaner.
- **`VirtualConsole` swallows jsdomError.** Real test failures still surface — they throw, they don't log.

## 8. Test structure & file layout

```
tests/
  gantt.test.js        ← THE unified test file
  loadGantt.js         ← jsdom loader
  test_concurrency.js  ← kept (migrated in a later PR)
  test_concurrency.html
  test_llm.html        ← kept (live LLM smoke test)
```

`gantt.test.js` is organised by `describe()` suites:

```js
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadGantt } from './loadGantt.js';

let t;
before(async () => { ({ t } = await loadGantt()); });
beforeEach(() => { t.setNodes([]); t.resetAI(); });

describe('hierarchy',            () => { /* typeFromId, parentOf, nextId */ });
describe('formatters',           () => { /* parsePreds, clampPercent, fmtMoney, esc, ... */ });
describe('naturalCompare',       () => { /* ... */ });
describe('CPM',                  () => { /* runCPM scenarios */ });
describe('AI applier — shift',   () => { /* shift / extend / cascade */ });
describe('AI applier — create',  () => { /* task / subtask under project */ });
describe('AI applier — progress / owner', () => { /* clamp, set, clear */ });
describe('AI resolver',          () => { /* aiResolveTarget, aiAmountToDays, aiParseDate */ });
describe('AI applier — TODO',    () => { /* it.skip(...) for unimplemented ops */ });
```

## 9. Integration test patterns

Every CPM and AI test follows the same three-step shape: **build state → drive function → assert on post-state**.

### 9.1 Pure shift (mode='shift')

```js
it('shift: moves a leaf task by +3 days, both start and end', () => {
  t.setNodes([
    { id: 'P1',    type: 'project', name: 'Solar Farm' },
    { id: 'P1-T1', type: 'task',    name: 'Site prep',
      sched_start: '2026-01-01', sched_end: '2026-01-05',
      actual_start: '2026-01-01', actual_end: '2026-01-05',
      predecessors: '' },
  ]);

  const draft = t.getNodes();
  const result = t.aiApplyShift({
    operation: 'shift_item',
    parameters: { target: { project: 'Solar Farm', item: 'Site prep' },
                  amount: 3, unit: 'days', _modeChoice: 'shift' },
    reasoning: { requires_schedule_computation: false },
  }, draft);

  assert.equal(result.ok, true);
  const task = draft.find(n => n.id === 'P1-T1');
  assert.equal(task.actual_start, '2026-01-04');
  assert.equal(task.actual_end,   '2026-01-08');
});
```

### 9.2 CPM cascade

```js
it('shift cascades through predecessors via runCPM', () => {
  t.setNodes([
    { id: 'P1',     type: 'project', name: 'Build' },
    { id: 'P1-T1',  type: 'task',    name: 'A',
      sched_start: '2026-01-01', sched_end: '2026-01-05',
      actual_start: '2026-01-01', actual_end: '2026-01-05',
      predecessors: '' },
    { id: 'P1-T2',  type: 'task',    name: 'B',
      sched_start: '2026-01-06', sched_end: '2026-01-10',
      actual_start: '2026-01-06', actual_end: '2026-01-10',
      predecessors: 'P1-T1' },
  ]);

  const draft = t.getNodes();
  t.aiApplyShift({
    operation: 'shift_item',
    parameters: { target: { project: 'Build', item: 'A' }, amount: 5, unit: 'days', _modeChoice: 'shift' },
    reasoning: { requires_schedule_computation: true },
  }, draft);
  const { draft: post, cycles } = t.aiRunCPMOnDraft(draft, ['P1']);

  assert.deepEqual(cycles, []);
  const b = post.find(n => n.id === 'P1-T2');
  assert.equal(b.actual_start, '2026-01-11');
  assert.equal(b.actual_end,   '2026-01-15');
});
```

### 9.3 Create + resolve

```js
it('create_item adds a task under the matched project with a fresh id', () => {
  t.setNodes([{ id: 'P1', type: 'project', name: 'Solar Farm' }]);

  const draft = t.getNodes();
  const r = t.aiApplyCreate({
    operation: 'create_item',
    parameters: { target: { project: 'Solar Farm' },
                  new_item: { type: 'task', name: 'Survey',
                              sched_start: '2026-02-01', sched_end: '2026-02-03' } },
  }, draft);

  assert.equal(r.ok, true);
  const created = draft.find(n => n.name === 'Survey');
  assert.equal(created.id, 'P1-T1');
  assert.equal(t.parentOf(created.id), 'P1');
});
```

### 9.4 Cycle detection

```js
it('CPM reports a cycle when two leaves are mutual predecessors', () => {
  t.setNodes([
    { id: 'P1', type: 'project', name: 'X' },
    { id: 'P1-T1', type: 'task', name: 'A', predecessors: 'P1-T2',
      sched_start: '2026-01-01', sched_end: '2026-01-02',
      actual_start: '2026-01-01', actual_end: '2026-01-02' },
    { id: 'P1-T2', type: 'task', name: 'B', predecessors: 'P1-T1',
      sched_start: '2026-01-01', sched_end: '2026-01-02',
      actual_start: '2026-01-01', actual_end: '2026-01-02' },
  ]);
  const r = t.runCPM('P1');
  assert.equal(r.cycle, true);
  assert.equal(r.shifted, 0);
});
```

## 10. Coverage matrix (round one)

Target: ~90–100 tests across these suites. The formatters suite is heavy because the existing `test_index.js` already has dense per-function coverage (e.g., 9 `clampPercent` cases, 8 `esc` cases) which we port verbatim.

| Suite | Scenarios | Approx count |
|---|---|---|
| hierarchy | typeFromId variants, parentOf, nextId gap-filling | 15 |
| formatters | parsePreds, clampPercent, defaultSaleFromEst, fmtMoney, addDays, fmtDate, esc, xmlEsc | 47 |
| naturalCompare | numeric-within-id, hierarchical, equality, null-safe | 5 |
| CPM | empty/single-leaf, forward pass, predecessor cascade, no-op when already late, cycle, cross-project isolation | 6 |
| AI applier — shift | shift mode, extend mode, with CPM cascade, invalid amount, unresolved target | 5 |
| AI applier — create | task under project, subtask under task, fresh id allocation, missing parent | 4 |
| AI applier — progress / owner | clamp 0–100, empty string, set/clear owner | 4 |
| AI resolver | exact id, substring match, ambiguous, no match, N/A | 5 |
| AI applier — TODO (`.skip`) | create_project_candidate, add_dependency, delete_item, batch ops | 4 |

## 11. CI workflow

`.github/workflows/test.yml`:

```yaml
name: tests
on:
  pull_request:
    branches: [main]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm test
```

`package.json`:

```json
{
  "name": "gantt-chart-tests",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test 'tests/*.test.js'" },
  "devDependencies": { "jsdom": "^25.0.0" }
}
```

The glob picks up `tests/gantt.test.js` today and any future split files (see §12) without further script changes.

`.gitignore` (append):
```
node_modules/
```

## 12. Growth path

1. **New feature in `index.html`?** Expose its testable surface in the `window.__test` bundle in the same `<script>` block. Add a `describe()` suite in `gantt.test.js`. No new files.
2. **Files grow large?** Split only when a single suite is >300 lines AND suites are independent (no shared setup beyond `loadGantt`). New files match `tests/*.test.js`; CI picks them up automatically.
3. **Migration backlog:**
   - **PR 2** — port `test_concurrency.js` (Supabase OCC) into the unified harness; the `FakeServer` fixture moves to `tests/fixtures/`.
   - **PR 3** — port AI `[TODO]` scenarios as the features land (`create_project_candidate`, `add_dependency`, `delete_item`, batch ops). Remove `.skip()` calls as each one ships.
   - **PR 4 (optional)** — Excel/CSV import/export coverage (`parseCSV`, `buildImportedNodes`, `remapCollidingProjectIds`, `colLetter`, `isoToExcelSerial`, `crc32`).

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `jsdom` chokes on something in `index.html` (CDN scripts, layout APIs, audio, etc.) | The `loadGantt` loader stubs `fetch` and swallows `jsdomError`. If a specific API blocks startup, add a targeted shim in `loadGantt.js` (not in `index.html`). |
| Tests slow as scope grows | Single shared jsdom keeps per-test cost flat (≈ µs to set NODES). 200+ tests should still run in <2s wall time. |
| `window.__test` is forgotten when a new helper is added | Code review convention: any new pure helper in `index.html` should appear in the `window.__test` bundle. PR template line item to enforce it. |
| Drift between exposed functions and tests | Eliminated by construction — `window.__test` holds references, not copies. |
| State leaks between tests | `beforeEach` always runs `setNodes([])` and `resetAI()`. If a test needs more aggressive teardown, it does it explicitly. |
