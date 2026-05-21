# Comprehensive Unit Tests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three mirror-style test files with one unified `tests/gantt.test.js` that calls the real functions inside `index.html` via a `window.__test` bundle, runs under Node's built-in test runner with `jsdom`, and is wired into GitHub Actions to run on every PR against `main`.

**Architecture:** A single `<script>` block near the end of `index.html` registers `window.__test = { setNodes, getNodes, resetAI, ...all testable helpers... }`. Tests share a single jsdom-loaded window (built once, reused across tests) and use a `beforeEach` hook that calls `setNodes([])` for isolation. Tests follow an integration pattern — build a `NODES` array, call the real function, assert on the post-state.

**Tech Stack:** Node 20 (`node --test`), `jsdom@^25`, no other dependencies. CI runs in GitHub Actions on `pull_request` to `main`.

**Spec:** `docs/superpowers/specs/2026-05-21-comprehensive-unit-tests-design.md`

---

## File map (locked-in decomposition)

| Path | Action | Responsibility |
|---|---|---|
| `tests/gantt.test.js` | **create** | The single unified test file. Contains all suites for round one. |
| `tests/loadGantt.js` | **create** | jsdom loader. Caches one shared window. ~50 lines. |
| `package.json` | **create** | Declares `jsdom` dep + `npm test` script. |
| `.gitignore` | **modify** | Append `node_modules/`. |
| `.github/workflows/test.yml` | **create** | CI workflow, PR-to-main only. |
| `index.html` | **modify** | One new `<script>` insertion at the end of the main `<script>` (just before line 8217's `</script>`). No other changes. |
| `tests/test_index.js` | **delete** | Coverage migrated. |
| `tests/test_index.html` | **delete** | Harness no longer needed. |
| `tests/test_ai_edit.js` | **delete** | Coverage migrated. |
| `tests/test_ai_edit.html` | **delete** | Harness no longer needed. |
| `tests/test_concurrency.{js,html}` | **keep** | Out of scope for round one. Migrated in a future PR. |
| `tests/test_llm.html` | **keep** | Live LLM smoke test, separate concern. |
| `index.html.tmp.7413.fe8721a173b5` | **keep / leave** | Untracked editor temp file. Not this plan's concern. |

---

## Task 1: Scaffold the test infrastructure

**Files:**
- Create: `package.json`
- Modify: `.gitignore`
- Create: `tests/gantt.test.js` (placeholder — will be filled in Task 2 onward)

This task builds the absolute minimum scaffold so `npm test` runs without errors. No real assertions yet — we want to confirm Node, jsdom, and the test command line are all wired up before committing to the harder work.

- [ ] **Step 1.1: Create `package.json`**

Create the file at the project root with this exact content:

```json
{
  "name": "gantt-chart-tests",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test 'tests/*.test.js'"
  },
  "devDependencies": {
    "jsdom": "^25.0.0"
  }
}
```

Note: `"type": "module"` is required for the `import` syntax used in the test file.

- [ ] **Step 1.2: Append `node_modules/` to `.gitignore`**

The current `.gitignore` is 24 bytes. Read it first, then append. If the existing content does not end with a newline, add one before the new line.

After the edit, `.gitignore` should end with:

```
node_modules/
```

- [ ] **Step 1.3: Install jsdom and generate `package-lock.json`**

Run from the project root:

```bash
npm install
```

Expected: creates `node_modules/` and `package-lock.json`. The lockfile is committed; `node_modules/` is gitignored.

- [ ] **Step 1.4: Create a placeholder `tests/gantt.test.js`**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('scaffold smoke test', () => {
  it('npm test runs', () => {
    assert.equal(1 + 1, 2);
  });
});
```

- [ ] **Step 1.5: Run the test command**

```bash
npm test
```

Expected output ends with: `# pass 1` and `# fail 0`.

- [ ] **Step 1.6: Commit**

```bash
git add package.json package-lock.json .gitignore tests/gantt.test.js
git commit -m "test: scaffold node:test + jsdom (placeholder gantt.test.js)"
```

---

## Task 2: Build the loader and expose `window.__test` from `index.html`

**Files:**
- Create: `tests/loadGantt.js`
- Modify: `tests/gantt.test.js`
- Modify: `index.html` (insert one `<script>` block at line ~8216, before the existing closing `</script>` on line 8217)

This is the symbiotic pair: the loader needs `window.__test` to be there; the bundle is meaningless without a loader. We write a failing smoke test first (TDD), watch it fail, then add the bundle to `index.html`, watch it pass.

- [ ] **Step 2.1: Create `tests/loadGantt.js`**

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = resolve(__dirname, '..', 'index.html');

// Cached — parsing index.html and evaluating its <script> blocks costs ~200ms.
// All tests share one window; isolation comes from setNodes([]) in beforeEach.
let cached = null;

export async function loadGantt() {
  if (cached) return cached;

  const html = readFileSync(INDEX_HTML, 'utf8');

  // Swallow expected jsdom warnings: CSS parse errors, network failures
  // from the Supabase startup call, etc. Real test failures still surface
  // because they throw — they don't log.
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: 'usable',
  });

  // index.html's Supabase block calls fetch() at startup. Stub it so we don't
  // depend on the network and don't log noisy errors.
  dom.window.fetch = async () => new dom.window.Response('[]', { status: 200 });

  // Let <script type="module"> blocks (Scheduler, Supa) finish initialising.
  await new Promise((r) => dom.window.queueMicrotask(r));

  if (!dom.window.__test) {
    throw new Error('window.__test was not registered — did index.html load cleanly?');
  }

  cached = { window: dom.window, t: dom.window.__test };
  return cached;
}
```

- [ ] **Step 2.2: Replace the placeholder in `tests/gantt.test.js` with a smoke test**

Overwrite the entire file:

```js
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadGantt } from './loadGantt.js';

let t;
before(async () => { ({ t } = await loadGantt()); });
beforeEach(() => { t.setNodes([]); t.resetAI(); });

describe('smoke: window.__test bundle', () => {
  it('exposes state plumbing', () => {
    assert.equal(typeof t.setNodes, 'function');
    assert.equal(typeof t.getNodes, 'function');
    assert.equal(typeof t.resetAI,  'function');
  });

  it('exposes hierarchy helpers', () => {
    for (const n of ['typeFromId', 'parentOf', 'nextId']) {
      assert.equal(typeof t[n], 'function', `missing: ${n}`);
    }
  });

  it('exposes pure formatters', () => {
    for (const n of ['cap1','parsePreds','clampPercent','defaultSaleFromEst',
                     'fmtMoney','addDays','fmtDate','esc','xmlEsc','naturalCompare']) {
      assert.equal(typeof t[n], 'function', `missing: ${n}`);
    }
  });

  it('exposes CPM helpers', () => {
    for (const n of ['runCPM','autoReschedule','childrenOf']) {
      assert.equal(typeof t[n], 'function', `missing: ${n}`);
    }
  });

  it('exposes AI applier surface', () => {
    for (const n of ['aiResolveTarget','aiAmountToDays','aiParseDate',
                     'aiApplyOperation','aiApplyShift','aiApplyCreate',
                     'aiApplyProgress','aiApplyOwner','aiBuildNode',
                     'aiRunCPMOnDraft','aiWithDraftScope']) {
      assert.equal(typeof t[n], 'function', `missing: ${n}`);
    }
  });

  it('setNodes / getNodes round-trip preserves data', () => {
    t.setNodes([{ id: 'P1', type: 'project', name: 'X' }]);
    const out = t.getNodes();
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'P1');
  });

  it('getNodes returns a deep clone (caller cannot mutate live state)', () => {
    t.setNodes([{ id: 'P1', type: 'project', name: 'X' }]);
    const out = t.getNodes();
    out[0].name = 'MUTATED';
    const fresh = t.getNodes();
    assert.equal(fresh[0].name, 'X');
  });
});
```

- [ ] **Step 2.3: Run the test — confirm it FAILS**

```bash
npm test
```

Expected: failure with the message `window.__test was not registered — did index.html load cleanly?` (thrown by `loadGantt`).

- [ ] **Step 2.4: Add the `window.__test` block to `index.html`**

The main `<script>` in `index.html` spans **lines 2024–8217**. All the functions we need (`runCPM`, `aiApplyShift`, `addDays`, etc.) live inside that scope. Add the new block **immediately before line 8217's `</script>`**, after the existing `window.__onWriteResult = aiOnWriteResult;` on line 8216.

Use Edit on `index.html`. The `old_string` to find is the last few lines of the existing handler exposure block:

```
  window.__onWriteResult     = aiOnWriteResult;
  </script>
```

Replace with:

```
  window.__onWriteResult     = aiOnWriteResult;

  /* ══════════════════════════════════════════════════════════════
     Test hook — exposes references to internal helpers so unit tests
     in tests/gantt.test.js can call the *real* functions, not copies.
     The bundle is harmless in prod (no PII, no auth bypass) and is
     unconditional so there's no config knob to keep in sync.
     See docs/superpowers/specs/2026-05-21-comprehensive-unit-tests-design.md
  ══════════════════════════════════════════════════════════════ */
  window.__test = {
    // state plumbing
    setNodes: (arr) => { NODES.length = 0; for (const n of arr) NODES.push(n); },
    getNodes: () => JSON.parse(JSON.stringify(NODES)),
    resetAI:  () => {
      if (typeof AI !== 'undefined') {
        AI.draft = null;
        AI.baseSnapshot = null;
        if (AI.pendingChanges) AI.pendingChanges.length = 0;
      }
    },
    // hierarchy / ids
    typeFromId, parentOf, nextId,
    // pure formatters
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
  </script>
```

- [ ] **Step 2.5: Run the test — confirm it PASSES**

```bash
npm test
```

Expected: all 7 smoke-suite tests pass. `# pass 7`, `# fail 0`.

If a `missing: <name>` assertion fires, the named function is referenced in the bundle but doesn't exist with that exact name in `index.html`'s scope — search `index.html` for the actual definition and either rename the bundle key or fix the reference.

- [ ] **Step 2.6: Commit**

```bash
git add tests/loadGantt.js tests/gantt.test.js index.html
git commit -m "test: jsdom loader + window.__test bundle on index.html"
```

---

## Task 3: Hierarchy suite (typeFromId, parentOf, nextId)

**Files:**
- Modify: `tests/gantt.test.js` (append a new `describe` block)

Each test in this and every subsequent suite follows the same pattern: optionally `setNodes([...])`, call the real function via `t.X`, assert. Tests for **pure** functions skip `setNodes` since the function doesn't read `NODES`. Tests for `nextId` (which reads `NODES`) always `setNodes` first.

- [ ] **Step 3.1: Append the `hierarchy` describe block**

Append to `tests/gantt.test.js`, after the smoke-test block:

```js
describe('hierarchy: typeFromId', () => {
  const CASES = [
    ['P1',          'project'],
    ['P1-T1',       'task'],
    ['P1-T1-S1',    'subtask'],
    ['P1-T1-S1-X1', 'subtask'],  // depth > 3 still classified as subtask
    [null,          'project'],
    ['',            'project'],
  ];
  for (const [id, expected] of CASES) {
    it(`typeFromId(${JSON.stringify(id)}) → ${expected}`, () => {
      assert.equal(t.typeFromId(id), expected);
    });
  }
});

describe('hierarchy: parentOf', () => {
  const CASES = [
    ['P1',       null],
    ['P1-T1',    'P1'],
    ['P1-T1-S1', 'P1-T1'],
    [null,       null],
    ['',         null],
  ];
  for (const [id, expected] of CASES) {
    it(`parentOf(${JSON.stringify(id)}) → ${JSON.stringify(expected)}`, () => {
      assert.equal(t.parentOf(id), expected);
    });
  }
});

describe('hierarchy: nextId (reads NODES)', () => {
  it('returns P1 when no projects exist', () => {
    t.setNodes([]);
    assert.equal(t.nextId(null), 'P1');
  });

  it('skips used project IDs', () => {
    t.setNodes([{ id: 'P1' }, { id: 'P2' }]);
    assert.equal(t.nextId(null), 'P3');
  });

  it('fills gaps in project IDs', () => {
    t.setNodes([{ id: 'P1' }, { id: 'P3' }]);
    assert.equal(t.nextId(null), 'P2');
  });

  it('uses -T prefix under a project', () => {
    t.setNodes([{ id: 'P1' }]);
    assert.equal(t.nextId('P1'), 'P1-T1');
  });

  it('uses -S prefix under a task', () => {
    t.setNodes([{ id: 'P1-T1' }]);
    assert.equal(t.nextId('P1-T1'), 'P1-T1-S1');
  });

  it('skips used child IDs', () => {
    t.setNodes([{ id: 'P1-T1' }, { id: 'P1-T2' }]);
    assert.equal(t.nextId('P1'), 'P1-T3');
  });
});
```

- [ ] **Step 3.2: Run the suite**

```bash
npm test
```

Expected: all hierarchy tests pass. If a test fails, it is **either** a real bug in `index.html` (investigate, do not modify the test) **or** the test expectation is wrong (the original `test_index.js` is the reference — verify against it).

- [ ] **Step 3.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: hierarchy suite (typeFromId, parentOf, nextId)"
```

---

## Task 4: Formatters suite — part 1 (cap1, parsePreds, clampPercent, defaultSaleFromEst, fmtMoney)

**Files:**
- Modify: `tests/gantt.test.js` (append)

- [ ] **Step 4.1: Append the part-1 formatter describes**

```js
describe('formatters: cap1', () => {
  const CASES = [
    ['hello', 'Hello'],
    ['Hello', 'Hello'],
    ['a',     'A'],
    ['',      ''],
    [null,    null],
  ];
  for (const [input, expected] of CASES) {
    it(`cap1(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      assert.equal(t.cap1(input), expected);
    });
  }
});

describe('formatters: parsePreds', () => {
  it('splits on comma',            () => assert.deepEqual(t.parsePreds('a,b,c'), ['a','b','c']));
  it('splits on semicolon',        () => assert.deepEqual(t.parsePreds('a;b;c'), ['a','b','c']));
  it('mixes comma and semicolon',  () => assert.deepEqual(t.parsePreds('a, b; c'), ['a','b','c']));
  it('trims whitespace',           () => assert.deepEqual(t.parsePreds('  a , b  '), ['a','b']));
  it('drops empty entries',        () => assert.deepEqual(t.parsePreds('a,,b,'), ['a','b']));
  it('returns [] for empty input', () => assert.deepEqual(t.parsePreds(''), []));
  it('returns [] for null',        () => assert.deepEqual(t.parsePreds(null), []));
});

describe('formatters: clampPercent', () => {
  it('passes valid values through',     () => assert.equal(t.clampPercent(50), 50));
  it('clamps below 0 to 0',             () => assert.equal(t.clampPercent(-25), 0));
  it('clamps above 100 to 100',         () => assert.equal(t.clampPercent(150), 100));
  it('parses numeric strings',          () => assert.equal(t.clampPercent('75'), 75));
  it('returns "" for empty string',     () => assert.equal(t.clampPercent(''), ''));
  it('returns "" for null',             () => assert.equal(t.clampPercent(null), ''));
  it('returns "" for undefined',        () => assert.equal(t.clampPercent(undefined), ''));
  it('returns "" for non-numeric',      () => assert.equal(t.clampPercent('abc'), ''));
  it('keeps boundary 0',                () => assert.equal(t.clampPercent(0), 0));
  it('keeps boundary 100',              () => assert.equal(t.clampPercent(100), 100));
});

describe('formatters: defaultSaleFromEst', () => {
  it('applies the default 30% margin',  () => assert.equal(t.defaultSaleFromEst(70), 100));
  it('honors an explicit margin',       () => assert.equal(t.defaultSaleFromEst(80, 0.2), 100));
  it('returns "" for zero',             () => assert.equal(t.defaultSaleFromEst(0), ''));
  it('returns "" for negative',         () => assert.equal(t.defaultSaleFromEst(-5), ''));
  it('returns "" for non-numeric',      () => assert.equal(t.defaultSaleFromEst('abc'), ''));
  it('rounds to 2 decimals',            () => assert.equal(t.defaultSaleFromEst(33.333), +(33.333 / 0.7).toFixed(2)));
});

describe('formatters: fmtMoney', () => {
  it('formats sub-$1K as dollars',         () => assert.equal(t.fmtMoney(500), '$500'));
  it('rounds sub-$1K to whole dollars',    () => assert.equal(t.fmtMoney(499.7), '$500'));
  it('formats $1K-$10K with one decimal',  () => assert.equal(t.fmtMoney(1500), '$1.5K'));
  it('formats $10K+ without decimal',      () => assert.equal(t.fmtMoney(15000), '$15K'));
  it('formats negative values',            () => assert.equal(t.fmtMoney(-2500), '$-2.5K'));
  it('returns "" for non-numeric',         () => assert.equal(t.fmtMoney('abc'), ''));
  it('returns "" for empty',               () => assert.equal(t.fmtMoney(''), ''));
});
```

- [ ] **Step 4.2: Run and verify all pass**

```bash
npm test
```

Expected: all formatter part-1 tests pass.

- [ ] **Step 4.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: formatters part 1 (cap1, parsePreds, clampPercent, sale, money)"
```

---

## Task 5: Formatters suite — part 2 (addDays, fmtDate, esc, xmlEsc)

**Files:**
- Modify: `tests/gantt.test.js` (append)

- [ ] **Step 5.1: Append part-2 formatter describes**

```js
describe('formatters: addDays', () => {
  it('adds positive days', () => {
    const r = t.addDays(new Date('2024-01-01T00:00:00'), 5);
    assert.equal(t.fmtDate(r), '2024-01-06');
  });
  it('subtracts with negative days', () => {
    const r = t.addDays(new Date('2024-01-10T00:00:00'), -3);
    assert.equal(t.fmtDate(r), '2024-01-07');
  });
  it('crosses month boundaries', () => {
    const r = t.addDays(new Date('2024-01-30T00:00:00'), 5);
    assert.equal(t.fmtDate(r), '2024-02-04');
  });
  it('crosses year boundaries', () => {
    const r = t.addDays(new Date('2024-12-30T00:00:00'), 5);
    assert.equal(t.fmtDate(r), '2025-01-04');
  });
  it('does not mutate the input', () => {
    const d = new Date('2024-01-01T00:00:00');
    t.addDays(d, 5);
    assert.equal(t.fmtDate(d), '2024-01-01');
  });
});

describe('formatters: fmtDate', () => {
  it('formats as YYYY-MM-DD',
     () => assert.equal(t.fmtDate(new Date(2024, 0, 5)), '2024-01-05'));
  it('zero-pads single-digit month and day',
     () => assert.equal(t.fmtDate(new Date(2024, 8, 9)), '2024-09-09'));
  it('handles double-digit components',
     () => assert.equal(t.fmtDate(new Date(2024, 10, 25)), '2024-11-25'));
});

describe('formatters: esc (HTML escape)', () => {
  it('escapes ampersand',     () => assert.equal(t.esc('a & b'), 'a &amp; b'));
  it('escapes less-than',     () => assert.equal(t.esc('<div>'), '&lt;div&gt;'));
  it('escapes double quote',  () => assert.equal(t.esc('say "hi"'), 'say &quot;hi&quot;'));
  it('escapes single quote',  () => assert.equal(t.esc("it's"), 'it&#39;s'));
  it('coerces null to ""',    () => assert.equal(t.esc(null), ''));
  it('coerces undefined to ""', () => assert.equal(t.esc(undefined), ''));
  it('coerces numbers',       () => assert.equal(t.esc(42), '42'));
  it('escapes & before other entities (order matters)',
     () => assert.equal(t.esc('&<'), '&amp;&lt;'));
});

describe('formatters: xmlEsc', () => {
  it("escapes single quote with &apos; (XML, not HTML)",
     () => assert.equal(t.xmlEsc("it's"), 'it&apos;s'));
  it('escapes all five XML entities',
     () => assert.equal(t.xmlEsc(`<a b="c">&'`), '&lt;a b=&quot;c&quot;&gt;&amp;&apos;'));
});
```

- [ ] **Step 5.2: Run and verify all pass**

```bash
npm test
```

- [ ] **Step 5.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: formatters part 2 (addDays, fmtDate, esc, xmlEsc)"
```

---

## Task 6: naturalCompare suite

**Files:**
- Modify: `tests/gantt.test.js` (append)

- [ ] **Step 6.1: Append the describe block**

```js
describe('naturalCompare', () => {
  it('sorts numerically within IDs (P2 before P10)', () => {
    const ids = ['P10', 'P2', 'P1'].sort(t.naturalCompare);
    assert.deepEqual(ids, ['P1', 'P2', 'P10']);
  });
  it('sorts hierarchical IDs correctly', () => {
    const ids = ['P1-T10', 'P1-T2', 'P1-T1'].sort(t.naturalCompare);
    assert.deepEqual(ids, ['P1-T1', 'P1-T2', 'P1-T10']);
  });
  it('returns 0 for equal values', () => assert.equal(t.naturalCompare('P1', 'P1'), 0));
  it('handles null safely', () => {
    // Just confirm it returns a number rather than throwing.
    assert.equal(typeof t.naturalCompare(null, 'P1'), 'number');
  });
  it('shorter string with same prefix sorts first',
     () => assert.ok(t.naturalCompare('P1', 'P1-T1') < 0));
});
```

- [ ] **Step 6.2: Run and verify all pass**

```bash
npm test
```

- [ ] **Step 6.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: naturalCompare suite"
```

---

## Task 7: CPM suite (integration — build NODES, call runCPM, assert)

**Files:**
- Modify: `tests/gantt.test.js` (append)

This is the first suite where tests follow the user's "create the node, apply, see the changes" pattern at full strength. Each test builds a small project, calls `runCPM`, and inspects mutated state via `getNodes()`.

`runCPM` mutates the closure-bound `NODES` array directly — it writes `actual_start`/`actual_end` on leaf nodes that need to shift. After calling, read with `getNodes()` to inspect.

- [ ] **Step 7.1: Append the CPM describe block**

```js
describe('CPM: runCPM', () => {
  it('returns shifted=0, cycle=false on an empty project', () => {
    t.setNodes([{ id: 'P1', type: 'project', name: 'X' }]);
    const r = t.runCPM('P1');
    assert.equal(r.shifted, 0);
    assert.equal(r.cycle, false);
  });

  it('does not shift a single leaf with no predecessors', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'X' },
      { id: 'P1-T1', type: 'task',    name: 'Solo',
        sched_start: '2026-01-01', sched_end: '2026-01-05',
        actual_start: '2026-01-01', actual_end: '2026-01-05',
        predecessors: '' },
    ]);
    const r = t.runCPM('P1');
    assert.equal(r.cycle, false);
    assert.equal(r.shifted, 0);
    const n = t.getNodes().find(x => x.id === 'P1-T1');
    assert.equal(n.actual_start, '2026-01-01');
    assert.equal(n.actual_end,   '2026-01-05');
  });

  it('shifts a successor forward to land on predecessor end', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'X' },
      { id: 'P1-T1', type: 'task', name: 'A',
        sched_start: '2026-01-01', sched_end: '2026-01-10',
        actual_start: '2026-01-01', actual_end: '2026-01-10',
        predecessors: '' },
      { id: 'P1-T2', type: 'task', name: 'B',
        sched_start: '2026-01-02', sched_end: '2026-01-05',
        actual_start: '2026-01-02', actual_end: '2026-01-05',
        predecessors: 'P1-T1' },  // B should be pushed to start after A ends
    ]);
    const r = t.runCPM('P1');
    assert.equal(r.cycle, false);
    assert.ok(r.shifted >= 1, 'expected at least one shift');
    const b = t.getNodes().find(x => x.id === 'P1-T2');
    // B preserved its original 3-day duration and now starts on A's end date.
    assert.equal(b.actual_start, '2026-01-10');
    assert.equal(b.actual_end,   '2026-01-13');
  });

  it('does not shift a successor already late enough', () => {
    t.setNodes([
      { id: 'P1', type: 'project', name: 'X' },
      { id: 'P1-T1', type: 'task', name: 'A',
        sched_start: '2026-01-01', sched_end: '2026-01-05',
        actual_start: '2026-01-01', actual_end: '2026-01-05',
        predecessors: '' },
      { id: 'P1-T2', type: 'task', name: 'B',
        sched_start: '2026-01-20', sched_end: '2026-01-25',
        actual_start: '2026-01-20', actual_end: '2026-01-25',
        predecessors: 'P1-T1' },
    ]);
    const r = t.runCPM('P1');
    assert.equal(r.shifted, 0);
    const b = t.getNodes().find(x => x.id === 'P1-T2');
    assert.equal(b.actual_start, '2026-01-20');
  });

  it('detects a cycle and shifts nothing', () => {
    t.setNodes([
      { id: 'P1', type: 'project', name: 'X' },
      { id: 'P1-T1', type: 'task', name: 'A',
        sched_start: '2026-01-01', sched_end: '2026-01-02',
        actual_start: '2026-01-01', actual_end: '2026-01-02',
        predecessors: 'P1-T2' },
      { id: 'P1-T2', type: 'task', name: 'B',
        sched_start: '2026-01-01', sched_end: '2026-01-02',
        actual_start: '2026-01-01', actual_end: '2026-01-02',
        predecessors: 'P1-T1' },
    ]);
    const r = t.runCPM('P1');
    assert.equal(r.cycle, true);
    assert.equal(r.shifted, 0);
  });

  it('does not touch nodes in another project', () => {
    t.setNodes([
      { id: 'P1', type: 'project', name: 'One' },
      { id: 'P1-T1', type: 'task', name: 'A1',
        sched_start: '2026-01-01', sched_end: '2026-01-05',
        actual_start: '2026-01-01', actual_end: '2026-01-05',
        predecessors: '' },
      { id: 'P2', type: 'project', name: 'Two' },
      { id: 'P2-T1', type: 'task', name: 'B1',
        sched_start: '2026-02-01', sched_end: '2026-02-05',
        actual_start: '2026-02-01', actual_end: '2026-02-05',
        predecessors: '' },
    ]);
    t.runCPM('P1');
    const b1 = t.getNodes().find(x => x.id === 'P2-T1');
    assert.equal(b1.actual_start, '2026-02-01');
    assert.equal(b1.actual_end,   '2026-02-05');
  });
});
```

- [ ] **Step 7.2: Run the CPM suite**

```bash
npm test
```

Expected: all six CPM tests pass. If "shifts a successor forward" fails on the duration assertion, that's the most subtle test — `runCPM` derives duration from the existing leaf's `actual_start`/`actual_end` (or `sched_*` as fallback) and preserves it. Double-check the inputs match that contract before suspecting a bug.

- [ ] **Step 7.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: CPM suite (forward pass, cascade, cycle, isolation)"
```

---

## Task 8: AI applier — shift

**Files:**
- Modify: `tests/gantt.test.js` (append)

`aiApplyShift(op, draft)` mutates the `draft` array in place. The test pattern is:

1. `setNodes([...])` — establishes both real `NODES` (for resolver scoping) and the source the test will copy from.
2. `const draft = t.getNodes()` — independent deep clone for mutation.
3. `t.aiApplyShift(op, draft)` — mutates `draft`.
4. Assert on `draft`.

If `op.reasoning.requires_schedule_computation === true`, the caller (the real app) then runs `aiRunCPMOnDraft(draft, [projectId])` to cascade. Our test mirrors that.

- [ ] **Step 8.1: Append the shift describe block**

```js
describe('AI applier: shift_item', () => {
  it('shift mode: moves a leaf task by +3 days, duration preserved', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'Solar Farm' },
      { id: 'P1-T1', type: 'task',    name: 'Site prep',
        sched_start: '2026-01-01', sched_end: '2026-01-05',
        actual_start: '2026-01-01', actual_end: '2026-01-05',
        predecessors: '' },
    ]);

    const draft = t.getNodes();
    const r = t.aiApplyShift({
      operation: 'shift_item',
      target: { project: 'Solar Farm', item: 'Site prep' },
      parameters: { amount: 3, unit: 'days', _modeChoice: 'shift' },
      reasoning: { requires_schedule_computation: false },
    }, draft);

    assert.equal(r.ok, true);
    const task = draft.find(n => n.id === 'P1-T1');
    assert.equal(task.actual_start, '2026-01-04');
    assert.equal(task.actual_end,   '2026-01-08');
  });

  it('shift cascades through predecessors when CPM is requested', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'Build' },
      { id: 'P1-T1', type: 'task',    name: 'A',
        sched_start: '2026-01-01', sched_end: '2026-01-05',
        actual_start: '2026-01-01', actual_end: '2026-01-05',
        predecessors: '' },
      { id: 'P1-T2', type: 'task',    name: 'B',
        sched_start: '2026-01-06', sched_end: '2026-01-10',
        actual_start: '2026-01-06', actual_end: '2026-01-10',
        predecessors: 'P1-T1' },
    ]);

    const draft = t.getNodes();
    const r = t.aiApplyShift({
      operation: 'shift_item',
      target: { project: 'Build', item: 'A' },
      parameters: { amount: 5, unit: 'days', _modeChoice: 'shift' },
      reasoning: { requires_schedule_computation: true },
    }, draft);
    assert.equal(r.ok, true);

    const { draft: post, cycles } = t.aiRunCPMOnDraft(draft, ['P1']);
    assert.deepEqual(cycles, []);
    const b = post.find(n => n.id === 'P1-T2');
    assert.equal(b.actual_start, '2026-01-10');
    assert.equal(b.actual_end,   '2026-01-14');
  });

  it('rejects an invalid amount', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'X' },
      { id: 'P1-T1', type: 'task',    name: 'A',
        sched_start: '2026-01-01', sched_end: '2026-01-05',
        actual_start: '2026-01-01', actual_end: '2026-01-05',
        predecessors: '' },
    ]);

    const draft = t.getNodes();
    const r = t.aiApplyShift({
      operation: 'shift_item',
      target: { project: 'X', item: 'A' },
      parameters: { amount: 'banana', unit: 'days', _modeChoice: 'shift' },
      reasoning: { requires_schedule_computation: false },
    }, draft);
    assert.equal(r.ok, false);
    assert.match(r.reason, /shift amount|invalid|amount/i);
    const task = draft.find(n => n.id === 'P1-T1');
    assert.equal(task.actual_start, '2026-01-01');  // unchanged
  });

  it('rejects an unresolved target', () => {
    t.setNodes([
      { id: 'P1', type: 'project', name: 'Solar' },
    ]);
    const draft = t.getNodes();
    const r = t.aiApplyShift({
      operation: 'shift_item',
      target: { project: 'Solar', item: 'Nonexistent' },
      parameters: { amount: 3, unit: 'days', _modeChoice: 'shift' },
      reasoning: { requires_schedule_computation: false },
    }, draft);
    assert.equal(r.ok, false);
  });
});
```

- [ ] **Step 8.2: Run the shift suite**

```bash
npm test
```

If the "invalid amount" assertion message doesn't match, look at `aiApplyShift` in `index.html` (around line 6370) to see the actual rejection message and either tighten the regex or update it.

If the cascade assertion fails by exactly one day either way, check whether `aiApplyShift` rewrites `sched_*` in addition to `actual_*` — the cascade behavior depends on the mode (`shift` vs `extend`) and which dates `runCPM` reads.

- [ ] **Step 8.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: AI applier shift (shift/extend, cascade, reject)"
```

---

## Task 9: AI applier — create

**Files:**
- Modify: `tests/gantt.test.js` (append)

`aiApplyCreate(op, draft)` creates new nodes inside `draft`. It uses `nextId` via `aiWithDraftScope` so the new ID counts against the draft, not real NODES.

The exact `op.parameters.new_item` shape varies across the AI module. Read `aiApplyCreate` (around line 6488 in `index.html`) before writing the test to confirm the field names. The plan below uses the shape implied by the spec's §9.3 example.

- [ ] **Step 9.1: Append the create describe block**

```js
describe('AI applier: create_item', () => {
  it('adds a task under the matched project with a fresh id', () => {
    t.setNodes([{ id: 'P1', type: 'project', name: 'Solar Farm' }]);

    const draft = t.getNodes();
    const r = t.aiApplyCreate({
      operation: 'create_item',
      target: { project: 'Solar Farm' },
      parameters: {
        new_item: {
          type: 'task',
          name: 'Survey',
          sched_start: '2026-02-01',
          sched_end:   '2026-02-03',
        },
      },
    }, draft);

    assert.equal(r.ok, true);
    const created = draft.find(n => n.name === 'Survey');
    assert.ok(created, 'expected a "Survey" node in draft');
    assert.equal(created.id, 'P1-T1');
    assert.equal(t.parentOf(created.id), 'P1');
    assert.equal(t.typeFromId(created.id), 'task');
  });

  it('allocates a non-colliding id when a sibling already exists', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'Solar Farm' },
      { id: 'P1-T1', type: 'task',    name: 'Existing' },
    ]);
    const draft = t.getNodes();
    const r = t.aiApplyCreate({
      operation: 'create_item',
      target: { project: 'Solar Farm' },
      parameters: { new_item: { type: 'task', name: 'Survey',
                                sched_start: '2026-02-01', sched_end: '2026-02-03' } },
    }, draft);
    assert.equal(r.ok, true);
    const created = draft.find(n => n.name === 'Survey');
    assert.equal(created.id, 'P1-T2');
  });

  it('adds a subtask under the matched task', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'Solar Farm' },
      { id: 'P1-T1', type: 'task',    name: 'Site prep' },
    ]);
    const draft = t.getNodes();
    const r = t.aiApplyCreate({
      operation: 'create_item',
      target: { project: 'Solar Farm', item: 'Site prep', item_type: 'task' },
      parameters: { new_item: { type: 'subtask', name: 'Permit',
                                sched_start: '2026-02-01', sched_end: '2026-02-02' } },
    }, draft);
    assert.equal(r.ok, true);
    const created = draft.find(n => n.name === 'Permit');
    assert.equal(created.id, 'P1-T1-S1');
    assert.equal(t.typeFromId(created.id), 'subtask');
  });

  it('rejects when the parent cannot be resolved', () => {
    t.setNodes([{ id: 'P1', type: 'project', name: 'Solar Farm' }]);
    const draft = t.getNodes();
    const r = t.aiApplyCreate({
      operation: 'create_item',
      target: { project: 'Imaginary Project' },
      parameters: { new_item: { type: 'task', name: 'X',
                                sched_start: '2026-02-01', sched_end: '2026-02-02' } },
    }, draft);
    assert.equal(r.ok, false);
    assert.equal(draft.length, 1);  // unchanged
  });
});
```

- [ ] **Step 9.2: Run the create suite**

```bash
npm test
```

If a test fails on a parameter shape, open `index.html` and search for `function aiApplyCreate`. Adjust the test's op shape to match what the applier reads — **do not modify the applier**.

- [ ] **Step 9.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: AI applier create (task, subtask, id allocation, reject)"
```

---

## Task 10: AI applier — progress and owner

**Files:**
- Modify: `tests/gantt.test.js` (append)

- [ ] **Step 10.1: Append the progress / owner describe block**

```js
describe('AI applier: update_progress', () => {
  it('sets percent_done on the matched task', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'Solar' },
      { id: 'P1-T1', type: 'task',    name: 'Site prep', percent_done: 0 },
    ]);
    const draft = t.getNodes();
    const r = t.aiApplyProgress({
      operation: 'update_progress',
      target: { project: 'Solar', item: 'Site prep' },
      parameters: { percent_done: 50 },
    }, draft);
    assert.equal(r.ok, true);
    const task = draft.find(n => n.id === 'P1-T1');
    assert.equal(Number(task.percent_done), 50);
  });

  it('clamps values above 100 down to 100', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'Solar' },
      { id: 'P1-T1', type: 'task',    name: 'Site prep', percent_done: 0 },
    ]);
    const draft = t.getNodes();
    t.aiApplyProgress({
      operation: 'update_progress',
      target: { project: 'Solar', item: 'Site prep' },
      parameters: { percent_done: 150 },
    }, draft);
    const task = draft.find(n => n.id === 'P1-T1');
    assert.equal(Number(task.percent_done), 100);
  });
});

describe('AI applier: assign_owner', () => {
  it('sets owner on the matched task', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'Solar' },
      { id: 'P1-T1', type: 'task',    name: 'Site prep', owner: '' },
    ]);
    const draft = t.getNodes();
    const r = t.aiApplyOwner({
      operation: 'assign_owner',
      target: { project: 'Solar', item: 'Site prep' },
      parameters: { owner: 'alice@example.com' },
    }, draft);
    assert.equal(r.ok, true);
    const task = draft.find(n => n.id === 'P1-T1');
    assert.equal(task.owner, 'alice@example.com');
  });

  it('clears owner when given empty string', () => {
    t.setNodes([
      { id: 'P1',    type: 'project', name: 'Solar' },
      { id: 'P1-T1', type: 'task',    name: 'Site prep', owner: 'alice@example.com' },
    ]);
    const draft = t.getNodes();
    t.aiApplyOwner({
      operation: 'assign_owner',
      target: { project: 'Solar', item: 'Site prep' },
      parameters: { owner: '' },
    }, draft);
    const task = draft.find(n => n.id === 'P1-T1');
    // The applier may store empty string or null — accept either as "cleared".
    assert.ok(!task.owner, `expected falsy owner, got ${JSON.stringify(task.owner)}`);
  });
});
```

- [ ] **Step 10.2: Run and verify all pass**

```bash
npm test
```

If parameter names differ (e.g., the real applier reads `op.parameters.percent` instead of `percent_done`), open `index.html` (search `function aiApplyProgress` near line 6440 and `function aiApplyOwner` near line 6470), copy the read pattern, and adjust the test op shape.

- [ ] **Step 10.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: AI applier progress + owner"
```

---

## Task 11: AI resolver suite

**Files:**
- Modify: `tests/gantt.test.js` (append)

`aiResolveTarget(target, nodes)` is the matching layer used by every applier. Worth testing directly because it concentrates a lot of the natural-language → ID logic in one place.

`aiResolveTarget` returns `{ ok, id, candidates, reason, kind }`. The `kind` field is set when `ok: false` to disambiguate why the resolve failed.

- [ ] **Step 11.1: Append the resolver describe block**

```js
describe('AI helpers: aiAmountToDays', () => {
  it('treats days as days',     () => assert.equal(t.aiAmountToDays(3, 'days'), 3));
  it('converts weeks to days',  () => assert.equal(t.aiAmountToDays(2, 'weeks'), 14));
  it('converts months to days', () => assert.equal(t.aiAmountToDays(1, 'months'), 30));
  it('returns 0 for NaN',       () => assert.equal(t.aiAmountToDays('banana', 'days'), 0));
  it('rounds fractional values',() => assert.equal(t.aiAmountToDays(1.5, 'weeks'), 11));
});

describe('AI helpers: aiParseDate', () => {
  it('parses ISO 2026-03-15', () => assert.equal(t.aiParseDate('2026-03-15'), '2026-03-15'));
  it('returns null for null',  () => assert.equal(t.aiParseDate(null), null));
  it('returns null for "N/A"', () => assert.equal(t.aiParseDate('N/A'), null));
  it('returns null for nonsense',
     () => assert.equal(t.aiParseDate('not a date'), null));
});

describe('AI resolver: aiResolveTarget', () => {
  const nodes = () => [
    { id: 'P1',    type: 'project', name: 'Solar Farm' },
    { id: 'P1-T1', type: 'task',    name: 'Site prep' },
    { id: 'P1-T2', type: 'task',    name: 'Site survey' },
    { id: 'P2',    type: 'project', name: 'Wind Farm' },
  ];

  it('resolves a project by exact name', () => {
    const r = t.aiResolveTarget({ project: 'Solar Farm', item: 'N/A' }, nodes());
    assert.equal(r.ok, true);
    assert.equal(r.id, 'P1');
  });

  it('resolves a task by substring match within a project', () => {
    const r = t.aiResolveTarget({ project: 'Solar Farm', item: 'prep' }, nodes());
    assert.equal(r.ok, true);
    assert.equal(r.id, 'P1-T1');
  });

  it('returns ok:false when no project or item is specified', () => {
    const r = t.aiResolveTarget({ project: 'N/A', item: 'N/A' }, nodes());
    assert.equal(r.ok, false);
  });

  it('returns ok:false with a reason when the item is not found', () => {
    const r = t.aiResolveTarget({ project: 'Solar Farm', item: 'Nonexistent' }, nodes());
    assert.equal(r.ok, false);
    assert.ok(r.reason && typeof r.reason === 'string');
  });

  it('resolves the project itself when item is "N/A"', () => {
    const r = t.aiResolveTarget({ project: 'Wind Farm', item: 'N/A' }, nodes());
    assert.equal(r.ok, true);
    assert.equal(r.id, 'P2');
  });
});
```

- [ ] **Step 11.2: Run and verify all pass**

```bash
npm test
```

If a substring-match test returns `ok: false` with `candidates: [...]`, that's the resolver landing in the "ambiguous" branch — pick a more unique substring (e.g., `'prep'` is unique among "Site prep" and "Site survey", so it should resolve cleanly).

- [ ] **Step 11.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: AI resolver + amount/date helpers"
```

---

## Task 12: AI TODO suite (`.skip` placeholders for unimplemented ops)

**Files:**
- Modify: `tests/gantt.test.js` (append)

Some AI ops are documented in the design summary but not yet implemented (`create_project_candidate`, `add_dependency`, `delete_item`, batch ops). We seed `.skip`'d tests so the gaps are visible in the suite output and easy to fill in later by removing `.skip`.

- [ ] **Step 12.1: Append the TODO describe block**

```js
describe('AI applier — TODO (unimplemented ops, kept as skipped specs)', () => {
  it.skip('create_project_candidate: creates a project shell to be confirmed', () => {
    // When implemented, this op should expand a "candidate" project — likely
    // template-driven — and surface it for user confirmation before
    // committing. See spec §2.3.
  });

  it.skip('add_dependency: adds a predecessor link without creating a cycle', () => {
    // See spec §2.7.
  });

  it.skip('delete_item: removes a node and all descendants from draft', () => {
    // See spec §2.4.
  });

  it.skip('batch ops: dispatches multiple ops in one prompt', () => {
    // See spec §10.
  });
});
```

- [ ] **Step 12.2: Run and verify skipped tests are reported**

```bash
npm test
```

Expected output contains `# skipped 4` and the suite continues green.

- [ ] **Step 12.3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test: AI TODO suite (skipped specs for unimplemented ops)"
```

---

## Task 13: Delete the overlapping mirror-style test files

**Files:**
- Delete: `tests/test_index.js`
- Delete: `tests/test_index.html`
- Delete: `tests/test_ai_edit.js`
- Delete: `tests/test_ai_edit.html`

These files duplicate coverage now in `gantt.test.js` but against copies of functions. Keeping them would be confusing — two sources of truth, ambiguous which to update.

We keep `tests/test_concurrency.{js,html}` and `tests/test_llm.html` per spec §3 (out of scope round one).

- [ ] **Step 13.1: Delete the four files**

```bash
git rm tests/test_index.js tests/test_index.html \
       tests/test_ai_edit.js tests/test_ai_edit.html
```

- [ ] **Step 13.2: Run the test suite — confirm `gantt.test.js` is unaffected**

```bash
npm test
```

Expected: same pass count as after Task 12. The deletions only remove files from disk; nothing in `gantt.test.js` depended on them.

- [ ] **Step 13.3: Commit**

```bash
git commit -m "test: remove mirror-style test_index and test_ai_edit (migrated to gantt.test.js)"
```

---

## Task 14: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/test.yml`

Trigger is restricted to `pull_request` against `main` per spec §4. PRs to `main` get a status check that blocks merge on red.

- [ ] **Step 14.1: Create the workflow file**

```bash
mkdir -p .github/workflows
```

Then create `.github/workflows/test.yml`:

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
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test
```

- [ ] **Step 14.2: Verify locally one more time**

```bash
npm test
```

Confirm green before pushing — CI just runs this same command.

- [ ] **Step 14.3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: GitHub Actions test workflow (PR to main)"
```

- [ ] **Step 14.4: Smoke-test CI by opening a draft PR**

Push the branch and open a draft PR against `main`. Confirm the `tests` workflow appears in the Checks tab and goes green. If it fails:

- **`window.__test was not registered`** in CI but not locally — usually means a CDN script (`fuse.js`) failed to load and a downstream function definition threw. The `loadGantt` swallows `jsdomError`, but if an error happens *before* the function definitions, the `__test` block never runs. Fix: stub the CDN script tag during loading (add a `dom.window.eval('window.Fuse = function(){}')` shim in `loadGantt.js`).

- **Tests pass locally but fail in CI** — usually a date/timezone issue. CI runs UTC. Audit any test that constructs `new Date('YYYY-MM-DD')` without a `T00:00:00`; replace with `new Date('YYYY-MM-DDT00:00:00Z')` for explicit UTC.

- [ ] **Step 14.5: Mark the PR ready and merge**

Once CI is green and the spec is reviewed, mark the PR ready for review. The plan's success criterion is met when this PR is merged to `main`.

---

## Self-Review

**1. Spec coverage check** — every section of the spec maps to a task:

| Spec section | Plan task(s) |
|---|---|
| §5.1 New files | Tasks 1, 2, 14 |
| §5.2 Modified `index.html` | Task 2 |
| §5.3 Deleted files | Task 13 |
| §6 `window.__test` contract | Task 2 (Step 2.4) |
| §7 jsdom loader | Task 2 (Step 2.1) |
| §8 Test structure & layout | Tasks 2–12 (sections appended in order) |
| §9 Integration test patterns | Tasks 7–11 (CPM, shift, create) |
| §10 Coverage matrix | Tasks 3–12 |
| §11 CI workflow | Task 14 |
| §12 Growth path (rules + backlog) | N/A — documentary, not implemented |
| §13 Risks (jsdom shim, drift, leaks) | Task 14 (Step 14.4) addresses jsdom/CI shim |

No gaps. The growth-path section in the spec is intentionally documentary — it's there to guide future PRs, not this one.

**2. Placeholder scan** — searched for "TBD", "TODO" (outside the skipped tests, which are intentional), "implement later", "appropriate error handling", "similar to Task". None present in this plan's prose. The skipped `.skip` tests in Task 12 contain comments referring to spec sections — those are intended pointers, not plan placeholders.

**3. Type/name consistency** — verified across tasks:

- `t.aiApplyShift(op, draft)` signature: tasks 8, 9, 10 all use `(op, draft)` and pass `op.target`, `op.parameters`. Matches `index.html` (verified during plan write).
- `t.aiRunCPMOnDraft(draft, ['P1'])` returns `{ draft, cycles }`: task 8 destructures correctly.
- `t.runCPM(projectId)` returns `{ shifted, cycle }`: tasks 7 and 8 use both.
- `t.setNodes` / `t.getNodes` / `t.resetAI` are defined together in Task 2 (Step 2.4) and used consistently in `beforeEach` from Task 2 onward.
- The `aiResolveTarget` return shape (`{ ok, id, candidates, reason, kind }`) is consistent between Task 11 and the spec.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-comprehensive-unit-tests.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Best when tasks are independent enough that parallel context isolation pays off.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batched with checkpoints for review. Best when you want to keep a single shared context for the whole run.

Which approach?
