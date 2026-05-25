# Financial Rollup — PR 1: Data Model, Rollup Math, Modal Redesign, Template Bug Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the data backbone for the financial-rollup redesign — new field names, a migration shim that keeps existing saved data loading, the new rollup formulas (variance, project margin, final margin), a lifecycle-grouped edit modal, and a fix for the broken "From Template" button.

**Architecture:** All work happens in `index.html` (single-file app) plus a new test file under `tests/`. Migration shim copies legacy field names (`est_cost`, `cost_to_date`) into new fields (`estimated_raw_cost` at project level, `quoted_cost` at subtask level, `actual_spend_to_date`) on every load. New helpers `eQuoted`, `eActual`, `eCommitted` replace the old `eEst`/`eSpent` (which become thin aliases for backward compat in untouched call sites). The "Costs & budget" and "Sale & margin" modal sections are replaced with a single lifecycle-grouped block that switches visibility per row type. The "From Template" bug is fixed by inlining `scripts/scheduler.js` into `index.html` so it no longer depends on ES module imports under `file://`.

**Tech Stack:** Vanilla HTML/JS (no build step), `node --test` for unit tests, jsdom installed but tests stay DOM-free to match the existing `tests/` style.

**Spec reference:** `docs/superpowers/specs/2026-05-25-financial-rollup-redesign-design.md`

**Out of scope for this PR:** Status enum (PR 2), RTB code/type/sector/installer (PR 3), Summary CSV (PR 3), slack→buffer rename (PR 3), hover-tooltip rework (PR 2/3).

---

## Task 1: Migration shim — `migrateLegacyFields(nodes)`

**Files:**
- Modify: `index.html` (insert helper near other roll-up helpers, ~line 3220)
- Test: `tests/migration.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/migration.test.js`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure copy of the production helper (kept DOM-free to match existing test style).
function migrateLegacyFields(nodes) {
  for (const n of nodes) {
    const type = String(n.id || '').split('-').length;
    const isProject = type === 1;
    const isSubtask = type === 3;

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
```

- [ ] **Step 2: Run tests to confirm they pass against the test-local copy**

Run: `npm test -- --test-name-pattern="migrateLegacyFields"`
Expected: 8 passing tests (this validates the algorithm before adding it to production).

- [ ] **Step 3: Insert the production helper into `index.html`**

Find the cost roll-up block in `index.html` (search for `function childrenOf(node)` — around line 3223). Insert the helper just **above** `childrenOf`:

```javascript
  /* ── Legacy field migration ──
     Older saved boards used est_cost / cost_to_date instead of the new
     estimated_raw_cost / quoted_cost / actual_spend_to_date / committed_to_spend.
     Copy old → new on load. Idempotent. */
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
    }
    return nodes;
  }
```

- [ ] **Step 4: Wire `migrateLegacyFields` into every load path**

Three insertion points:

**4a.** In `loadBoard()` (~line 1186), after the `const nodes = rows.map(...)` block (line ~1203), before `if (typeof window.replaceNodes === "function") window.replaceNodes(nodes);`:

```javascript
      // existing: const nodes = rows.map(r => ({ ... }));
      if (typeof window.migrateLegacyFields === "function") {
        window.migrateLegacyFields(nodes);
      }
      if (typeof window.replaceNodes === "function") window.replaceNodes(nodes);
```

Then expose `migrateLegacyFields` on `window` near where other helpers are exposed (search for `window.replaceNodes` — set `window.migrateLegacyFields = migrateLegacyFields;` in the same neighborhood).

**4b.** In the EMBEDDED hydrate path (search for `NODES   = (EMBEDDED.nodes || []).slice();` — around line 3139):

```javascript
      NODES   = (EMBEDDED.nodes || []).slice();
      migrateLegacyFields(NODES);
```

**4c.** In the CSV import apply path (search for `for (const n of arr) NODES.push(n);` — around line 3527, and the same pattern around line 7096/7108/7115/7119/7188/7194). For every site that bulk-populates `NODES` from external data, call `migrateLegacyFields(NODES)` once after the population:

```javascript
      for (const n of arr) NODES.push(n);
      migrateLegacyFields(NODES);
```

Grep before/after to confirm you got every site: `grep -n "NODES.push\|NODES.length = 0" index.html`. Skip sites that only push a single in-app-created node (e.g., the modal save path) — those nodes already use new field names after Task 4.

- [ ] **Step 5: Run all tests to confirm nothing else broke**

Run: `npm test`
Expected: all existing tests pass + new migration tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/migration.test.js index.html
git commit -m "feat(data): add migrateLegacyFields shim for new financial field names"
```

---

## Task 2: New rollup helpers — `eQuoted`, `eActual`, `eCommitted`

**Files:**
- Modify: `index.html` (~lines 3226–3238, the rollup-helpers block)
- Test: extend `tests/migration.test.js` with rollup cases (or new file `tests/rollup.test.js`)

- [ ] **Step 1: Write the failing tests**

Create `tests/rollup.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to confirm they pass against the test copy**

Run: `npm test -- --test-name-pattern="rollup helpers"`
Expected: 4 passing tests.

- [ ] **Step 3: Add the three new helpers to `index.html`**

Find the existing `const eEst = ...` / `const eSpent = ...` lines (around line 3235). Add the new helpers **below** them, then update the old aliases to point at the new ones so untouched call sites keep working:

```javascript
  // Convenience for displays — Estimated Cost is the budget baseline.
  // ↓ existing lines: keep eEst/eSpent as aliases for the new helpers
  //   until PR 2/3 finishes renaming the remaining call sites.
  const eQuoted    = n => getEffective(n, 'quoted_cost');
  const eActual    = n => getEffective(n, 'actual_spend_to_date');
  const eCommitted = n => getEffective(n, 'committed_to_spend');
  const eEst       = eQuoted;   // alias for legacy call sites
  const eSpent     = eActual;   // alias for legacy call sites
  const eSale      = n => parseFloat(n.sale_price) || 0;
  const eRawCost   = n => parseFloat(n.estimated_raw_cost) || 0;
```

Replace the old `const eEst = n => getEffective(n, 'est_cost');` / `const eSpent = n => getEffective(n, 'cost_to_date');` lines with the block above.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all passes.

- [ ] **Step 5: Commit**

```bash
git add tests/rollup.test.js index.html
git commit -m "feat(rollup): add eQuoted/eActual/eCommitted helpers; alias eEst/eSpent"
```

---

## Task 3: New formulas — variance, project margin, final margin

**Files:**
- Modify: `index.html` (~line 3377 `computeVariance`, ~line 3383 `computeMargin`)
- Test: `tests/formulas.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/formulas.test.js`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Helpers mirror the production shape so tests stay DOM-free.
const num = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };

function computeVariance(quoted, actual, committed) {
  // Empty when ALL three are missing (display "—" in UI).
  if (quoted === '' && actual === '' && committed === '') return '';
  return (num(quoted) - num(actual) - num(committed)).toFixed(2);
}

function computeProjectMargin(sale, rawCost) {
  if (sale === '' && rawCost === '') return '';
  return (num(sale) - num(rawCost)).toFixed(2);
}

function computeFinalMargin(sale, actual, committed, allSubtasksDone) {
  if (!allSubtasksDone) return '';
  if (sale === '' && actual === '' && committed === '') return '';
  return (num(sale) - num(actual) - num(committed)).toFixed(2);
}

describe('computeVariance', () => {
  it('matches the spec example: 80000 - 64000 - 19999 = -3999', () => {
    assert.equal(computeVariance(80000, 64000, 19999), '-3999.00');
  });

  it('returns 0 when quoted matches actual + committed exactly', () => {
    assert.equal(computeVariance(10000, 5000, 5000), '0.00');
  });

  it("returns '' when all three are empty strings", () => {
    assert.equal(computeVariance('', '', ''), '');
  });

  it('treats missing fields as 0, not NaN', () => {
    assert.equal(computeVariance(10000, '', ''), '10000.00');
  });
});

describe('computeProjectMargin', () => {
  it('matches the spec: 100000 - 75000 = 25000', () => {
    assert.equal(computeProjectMargin(100000, 75000), '25000.00');
  });

  it("returns '' when both inputs are empty", () => {
    assert.equal(computeProjectMargin('', ''), '');
  });
});

describe('computeFinalMargin', () => {
  it('returns "" when not all subtasks are Done (still in-flight)', () => {
    assert.equal(computeFinalMargin(100000, 64000, 19999, false), '');
  });

  it('locks at sale - (actual + committed) when all done', () => {
    assert.equal(computeFinalMargin(100000, 64000, 19999, true), '16001.00');
  });
});
```

- [ ] **Step 2: Run tests, confirm they pass against the local copies**

Run: `npm test -- --test-name-pattern="compute"`
Expected: passing.

- [ ] **Step 3: Replace `computeVariance` in `index.html`**

Find `function computeVariance(node)` (~line 3377). Replace with:

```javascript
  // Variance = quoted_cost − (actual_spend_to_date + committed_to_spend).
  // Uses rolled-up values for parents. Returns '' when all three sources empty.
  function computeVariance(node) {
    const q = eQuoted(node), a = eActual(node), c = eCommitted(node);
    if (!q && !a && !c) return '';
    return (q - a - c).toFixed(2);
  }
```

- [ ] **Step 4: Replace `computeMargin` (rename to `computeProjectMargin` + add `computeFinalMargin`)**

Find `function computeMargin(node)` (~line 3383). Replace the whole function with two new ones:

```javascript
  // Project Margin (proposal-stage) = sale_price − estimated_raw_cost.
  // Only meaningful at project level. Tasks/subtasks return ''.
  function computeProjectMargin(node) {
    if (typeFromId(node.id) !== 'project') return '';
    const sp = eSale(node), rc = eRawCost(node);
    if (!sp && !rc) return '';
    return (sp - rc).toFixed(2);
  }

  // Final Margin (end-of-project, locked) = sale_price − (actual + committed).
  // Returns '' until every subtask of this project has pct_done === 100
  // (PR 2 switches this to status === 'Done').
  function computeFinalMargin(node) {
    if (typeFromId(node.id) !== 'project') return '';
    const subs = NODES.filter(n =>
      typeFromId(n.id) === 'subtask' && n.id.split('-')[0] === node.id
    );
    if (subs.length === 0) return '';
    const allDone = subs.every(s => Number(s.percent_done) >= 100);
    if (!allDone) return '';
    const sp = eSale(node), a = eActual(node), c = eCommitted(node);
    if (!sp && !a && !c) return '';
    return (sp - a - c).toFixed(2);
  }

  // Backwards-compat alias for any remaining `computeMargin` callers
  // (modal display call site is updated in Task 4). Remove in PR 3 cleanup.
  function computeMargin(node) {
    return computeProjectMargin(node) || '';
  }
```

- [ ] **Step 5: Run all tests + open `index.html` in a browser, confirm nothing crashes**

Run: `npm test`
Expected: all pass.

Open `index.html` in a browser (use `python3 -m http.server` from the repo root if you don't have a server set up). The board should still render. The "Final Margin" displayed value may now read `—` for in-flight projects (this is correct per the spec — old display showed the live `sale − cost_to_date`).

- [ ] **Step 6: Commit**

```bash
git add tests/formulas.test.js index.html
git commit -m "feat(rollup): replace computeMargin with project_margin + final_margin"
```

---

## Task 4: Modal redesign — lifecycle-grouped financial sections

**Files:**
- Modify: `index.html`
  - HTML: replace lines ~819–844 (the "Costs & budget" + "Sale & margin" sections)
  - Read code: ~lines 4791–4831 (the populate-modal block for projects vs tasks vs subtasks)
  - Write code: ~lines 5364–5383 (the node-build block in the modal save)
  - Visibility/CSS: small additions

- [ ] **Step 1: Replace the two old modal sections with the new lifecycle-grouped block**

Find the section starting `<div class="modal-section">` containing `Costs &amp; budget` (~line 819) through the closing `</div>` of the `Sale & margin (projects only)` section (~line 844). Replace the entire block with:

```html
      <!-- ═════ Financial sections (lifecycle-grouped) ═════════════════════
           Visibility rules applied by openEdit():
             • Project rows: show Proposal + Live + End of project
             • Task    rows: show Live only (rolled-up, read-only)
             • Subtask rows: show Live only (editable)
      -->

      <!-- Proposal stage — project only -->
      <div class="modal-section" id="m-fin-proposal">
        <div class="modal-section-label">
          <span class="fin-badge fin-badge-proposal">Proposal stage</span>
          <span style="font-weight:400;color:#9ca3af;font-size:11px;">— set once at start</span>
        </div>
        <div class="modal-grid">
          <label>Sale Price ($)<input id="m-sale-price" type="number" step="0.01" placeholder="0.00"></label>
          <label>Estimated Raw Cost ($)<input id="m-estimated-raw-cost" type="number" step="0.01" placeholder="0.00"></label>
        </div>
        <div class="modal-grid">
          <label class="modal-readonly">Project Margin ($)<input id="m-project-margin" type="number" step="0.01" readonly></label>
          <label>&nbsp;</label>
        </div>
      </div>

      <!-- Live (rolled up) — visible at every level; editable only on subtasks -->
      <div class="modal-section" id="m-fin-live">
        <div class="modal-section-label">
          <span class="fin-badge fin-badge-live">Live</span>
          <span id="m-fin-live-hint" style="font-weight:400;color:#9ca3af;font-size:11px;"></span>
        </div>
        <div class="modal-grid">
          <label>Quoted Cost ($)<input id="m-quoted-cost" type="number" step="0.01" placeholder="0.00"></label>
          <label>Actual Spend to Date ($)<input id="m-actual-spend" type="number" step="0.01" placeholder="0.00"></label>
        </div>
        <div class="modal-grid">
          <label>Committed to Spend ($)<input id="m-committed" type="number" step="0.01" placeholder="0.00"></label>
          <label class="modal-readonly">Variance ($)<input id="m-variance" type="number" step="0.01" readonly></label>
        </div>
      </div>

      <!-- End of project — project only -->
      <div class="modal-section" id="m-fin-end">
        <div class="modal-section-label">
          <span class="fin-badge fin-badge-end">End of project</span>
          <span style="font-weight:400;color:#9ca3af;font-size:11px;">— locks when every subtask is Done</span>
        </div>
        <div class="modal-grid">
          <label class="modal-readonly">Final Margin ($)<input id="m-final-margin" type="number" step="0.01" readonly></label>
          <label>&nbsp;</label>
        </div>
      </div>
```

- [ ] **Step 2: Add CSS for the badge pills**

Find the existing `.modal-readonly` or similar style declarations in the `<style>` block (top of file). Add these rules:

```css
    .fin-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; margin-right: 6px; }
    .fin-badge-proposal { background: #fce7f3; color: #be185d; }
    .fin-badge-live     { background: #dbeafe; color: #1e40af; }
    .fin-badge-end      { background: #d1fae5; color: #065f46; }
```

- [ ] **Step 3: Add a visibility helper for the financial sections**

Just below the modal HTML in the script section (near the existing `openEdit` function — search for `function openEdit`), or near the modal init code, add:

```javascript
  /* Show/hide the three financial sections based on row type.
       project → all three. task → live only (read-only). subtask → live only (editable). */
  function applyFinancialSectionVisibility(rowType, isParent) {
    const propEl = document.getElementById('m-fin-proposal');
    const liveEl = document.getElementById('m-fin-live');
    const endEl  = document.getElementById('m-fin-end');
    const hintEl = document.getElementById('m-fin-live-hint');
    propEl.style.display = (rowType === 'project') ? '' : 'none';
    endEl.style.display  = (rowType === 'project') ? '' : 'none';
    liveEl.style.display = '';

    // Editability of the three Live inputs:
    //   - subtask without children → editable
    //   - anything else (task, project, parent subtask) → read-only (rolled up)
    const editableLive = (rowType === 'subtask') && !isParent;
    ['m-quoted-cost','m-actual-spend','m-committed'].forEach(id => {
      const el = document.getElementById(id);
      el.readOnly = !editableLive;
      el.classList.toggle('modal-readonly', !editableLive);
    });
    hintEl.textContent = editableLive
      ? '— enter actuals; parent rows show the rolled-up sum'
      : '— rolled up from subtasks';
  }
```

- [ ] **Step 4: Update the modal populate code**

Find the openEdit / populate block around lines 4791–4831 (search for `m-est-cost').value`). Replace the whole "populate cost fields" sub-block (both branches — parent vs leaf, project vs non-project) with a single unified block:

```javascript
    // ── Financial fields ─────────────────────────────────────────────────
    const rowType  = typeFromId(n.id);
    const isParent = NODES.some(x => parentOf(x.id) === n.id);
    applyFinancialSectionVisibility(rowType, isParent);

    if (rowType === 'project') {
      document.getElementById('m-sale-price').value         = n.sale_price ?? '';
      document.getElementById('m-estimated-raw-cost').value = n.estimated_raw_cost ?? '';
      document.getElementById('m-project-margin').value     = computeProjectMargin(n);
      document.getElementById('m-final-margin').value       = computeFinalMargin(n);
    }

    // Live fields — display rolled-up for parents, stored for leaves.
    const liveSource = isParent ? {
      quoted_cost: eQuoted(n),
      actual_spend_to_date: eActual(n),
      committed_to_spend: eCommitted(n),
    } : {
      quoted_cost: n.quoted_cost ?? '',
      actual_spend_to_date: n.actual_spend_to_date ?? '',
      committed_to_spend: n.committed_to_spend ?? '',
    };
    document.getElementById('m-quoted-cost').value   = liveSource.quoted_cost === 0 && isParent ? '' : liveSource.quoted_cost;
    document.getElementById('m-actual-spend').value  = liveSource.actual_spend_to_date === 0 && isParent ? '' : liveSource.actual_spend_to_date;
    document.getElementById('m-committed').value     = liveSource.committed_to_spend === 0 && isParent ? '' : liveSource.committed_to_spend;
    document.getElementById('m-variance').value      = computeVariance(n);
```

If a separate openAdd path also populates these fields (it might initialize them to empty), zero them all out for fresh projects:

```javascript
    // In openAdd (new node, no existing data):
    applyFinancialSectionVisibility(type, false);
    ['m-sale-price','m-estimated-raw-cost','m-project-margin','m-final-margin',
     'm-quoted-cost','m-actual-spend','m-committed','m-variance'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
```

(Search for `openAdd` in `index.html` and slot this in near the end of the function, before the modal becomes visible.)

- [ ] **Step 5: Update the live-recompute handlers**

Find the lines that wire `oninput` handlers for the modal cost fields (around line 4847, search for `refreshComputedFields`). Replace the existing handler bindings with bindings against the new ids:

```javascript
    // Recompute variance/project_margin/final_margin live as the user types.
    function refreshComputedFields() {
      const sp = parseFloat(document.getElementById('m-sale-price')?.value) || 0;
      const rc = parseFloat(document.getElementById('m-estimated-raw-cost')?.value) || 0;
      const q  = parseFloat(document.getElementById('m-quoted-cost')?.value)  || 0;
      const a  = parseFloat(document.getElementById('m-actual-spend')?.value) || 0;
      const c  = parseFloat(document.getElementById('m-committed')?.value)    || 0;

      const pm = document.getElementById('m-project-margin');
      const va = document.getElementById('m-variance');
      if (pm) pm.value = (sp || rc) ? (sp - rc).toFixed(2) : '';
      if (va) va.value = (q || a || c) ? (q - a - c).toFixed(2) : '';
      // Final margin only recomputes on save (depends on subtask states).
    }
    ['m-sale-price','m-estimated-raw-cost','m-quoted-cost','m-actual-spend','m-committed']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) el.oninput = refreshComputedFields;
      });
```

- [ ] **Step 6: Update the modal save (node-build) block**

Find the `const node = { ... }` block around line 5364. Replace the financial-field assignments (lines ~5378–5381) with:

```javascript
      // Financial fields — new model.
      // Project: sale_price + estimated_raw_cost are manual; live fields are derived (don't persist).
      // Task: live fields derived (don't persist).
      // Subtask: quoted_cost / actual_spend_to_date / committed_to_spend are manual.
      sale_price:           rowType === 'project' ? document.getElementById('m-sale-price').value : '',
      estimated_raw_cost:   rowType === 'project' ? document.getElementById('m-estimated-raw-cost').value : '',
      quoted_cost:          (rowType === 'subtask' && !isParent) ? document.getElementById('m-quoted-cost').value  : '',
      actual_spend_to_date: (rowType === 'subtask' && !isParent) ? document.getElementById('m-actual-spend').value : '',
      committed_to_spend:   (rowType === 'subtask' && !isParent) ? document.getElementById('m-committed').value    : '',
      // Legacy fields — cleared on save so storage stays clean. The migration shim
      // already copied them into the new fields on the previous load.
      est_cost:     '',
      cost_to_date: '',
```

- [ ] **Step 7: Manual smoke test in the browser**

```bash
# From the repo root
python3 -m http.server 8000
# Browse to http://localhost:8000 and:
#  1. Create a fresh project → confirm Proposal + Live + End sections are visible
#  2. Type a Sale Price + Estimated Raw Cost → confirm Project Margin updates live
#  3. Save the project → reopen → values persist
#  4. Create a task under it → confirm only the Live section shows, fields read-only
#  5. Create a subtask → confirm Live section editable, type quoted/actual/committed → variance updates live
#  6. Reopen the parent task → confirm Live section shows the rolled-up sum
#  7. Reopen the project → confirm Live section shows the project-wide rollup
```

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat(modal): lifecycle-grouped financial sections (proposal/live/end)"
```

---

## Task 5: Wire new fields into node creation (manual + template)

**Files:**
- Modify: `index.html`
  - Template loader: ~lines 2903, 2931, 2945 (the three `NODES.push({ ... })` blocks in `loadFromTemplate`)

- [ ] **Step 1: Update the three NODES.push blocks in `loadFromTemplate`**

Find the project-row NODES.push (~line 2903). Add the new fields alongside the legacy ones, defaulting to empty string (the migration shim already aliases on load; explicit empty here keeps storage tidy):

```javascript
    NODES.push({
      id: pid, type: 'project', name: projectName,
      owner: '', predecessors: '',
      sched_start: fmtDate(projStart), sched_end: fmtDate(projEnd),
      actual_start: fmtDate(projStart), actual_end: fmtDate(projEnd),
      slack: '', percent_done: 0,
      // New model:
      estimated_raw_cost: '',
      quoted_cost: '', actual_spend_to_date: '', committed_to_spend: '',
      sale_price: '',
      // Legacy (kept blank — shim handles older saved boards):
      est_cost: '', cost_to_date: '',
      collapsed: false,
    });
```

Same shape for the task-row NODES.push (~line 2931) and the subtask-row NODES.push (~line 2945). All three need the four new fields initialized to empty string.

- [ ] **Step 2: Confirm there are no other in-app node-creation sites that need new fields**

Run: `grep -n "percent_done:\s*0" index.html`
Each match is a candidate node-creation site. For PR 1, only the template-loader sites need updating (the modal save already handles new fields via Task 4). Other sites — like duplicate/clone (`NODES.push(copy)` around line 2610), undo/redo restoration, AI batch apply — clone existing nodes verbatim, so the new fields ride along automatically once the source nodes have them.

- [ ] **Step 3: Manual smoke test the template loader**

In the browser (with `python3 -m http.server` running), click **📋 From Template** → pick Template A → enter a name + start date → Load. *(This may still throw the bug we're about to fix in Task 6 — that's fine. The point of this step is just to confirm the field initialization is correct once the template loads.)*

If the template loads successfully (because someone already inlined the scheduler), reopen one of the generated subtasks. Confirm the Live section is editable and empty.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(template): initialize new financial fields on template-created nodes"
```

---

## Task 6: Fix the "From Template" bug — inline `scripts/scheduler.js`

**Files:**
- Modify: `index.html` (the `<script type="module">` block around line 905)
- Reference: `scripts/scheduler.js` (read and inline)
- Test: `tests/template-loader.test.js` (new)

### Why this fix

`scripts/scheduler.js` is loaded via `<script type="module">` + `import * as Scheduler from './scripts/scheduler.js'`. Under `file://`, browsers block ES module imports for security — the import fails silently, `window.Scheduler` never gets assigned, and `solveCPM` throws when "From Template" runs (`window.Scheduler.schedule is not a function` or similar).

Inlining the module into `index.html` removes the import path entirely. The file gets ~250 lines bigger but works in every environment.

- [ ] **Step 1: Reproduce the bug**

```bash
# In the repo root, open index.html directly in Chrome (file:// URL):
open "/Users/jack/Desktop/gantt chart/index.html"
```

Open DevTools → Console. Click **📋 From Template** → Template A → Load. Observe the error. Note the exact message.

- [ ] **Step 2: Read the full source of `scripts/scheduler.js`**

```bash
cat "/Users/jack/Desktop/gantt chart/scripts/scheduler.js"
```

The file ends with several `export function ...` declarations. We're going to copy the *body* of each function into `index.html`, dropping the `export` keyword.

- [ ] **Step 3: Replace the module `<script>` with an inline non-module `<script>`**

Find this block in `index.html` (~line 902–908):

```html
  <!-- Load the full CPM scheduler (ES module) and expose it on window.
       Module scripts are deferred, so window.Scheduler is defined before any
       user-triggered handler (e.g. Load-from-template) needs it. -->
  <script type="module">
    import * as Scheduler from './scripts/scheduler.js';
    window.Scheduler = Scheduler;
  </script>
```

Replace with:

```html
  <!-- Inline CPM scheduler — was an ES module import of scripts/scheduler.js,
       but file:// blocks module imports. Inlined to make Load-from-template
       work regardless of how index.html is opened. Source of truth remains
       scripts/scheduler.js; keep them in sync (the Python source scripts/scheduler.py
       is the original).
       Exposes window.Scheduler = { parsePredecessor, schedule, ... }. -->
  <script>
  (function () {
    // ===== BEGIN inlined scripts/scheduler.js =====
    // <paste the entire file body here, removing every `export ` keyword>
    // ===== END inlined scripts/scheduler.js =====
    window.Scheduler = {
      parsePredecessor, buildGraph, topoSort, forwardPass, backwardPass,
      analyse, addDays, projectDates, schedule, recomputeAfterChange,
      CycleError,
    };
  })();
  </script>
```

Do the inline copy in two passes:

**3a.** Copy the entire contents of `scripts/scheduler.js` between the BEGIN/END comment markers.

**3b.** Strip every `export ` keyword (both `export function` and `export class`). Leave the function/class itself intact.

- [ ] **Step 4: Verify in the browser**

Reload `index.html` via `file://` (no server). Open DevTools Console → confirm no errors at load. Click **📋 From Template** → Template A → fill name + start date → Load. The project should appear with phases and subtasks.

Also test via `http://localhost:8000` (`python3 -m http.server`) — should still work.

- [ ] **Step 5: Write a regression test**

Create `tests/template-loader.test.js`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'index.html');

describe('template loader bug fix', () => {
  it("does not load scheduler via <script type='module'>", () => {
    const html = readFileSync(HTML_PATH, 'utf8');
    assert.equal(
      html.includes("import * as Scheduler from './scripts/scheduler.js'"),
      false,
      "scheduler.js should be inlined, not imported as a module (breaks under file://)"
    );
  });

  it('exposes a Scheduler.schedule function (inline check)', () => {
    const html = readFileSync(HTML_PATH, 'utf8');
    // After inlining, the schedule function definition should be inside the
    // single-file artifact and window.Scheduler.schedule should be wired up.
    assert.match(html, /window\.Scheduler\s*=\s*\{[^}]*schedule\b/);
    assert.match(html, /function schedule\(tasks,\s*projectStart/);
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: all pass, including the two new regression checks.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/template-loader.test.js
git commit -m "fix(template): inline scheduler.js so From-Template works under file://"
```

---

## Task 7: Final smoke test + close out PR 1

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 2: Manual end-to-end smoke**

```bash
# Reset to a clean tab and walk the happy path:
open "/Users/jack/Desktop/gantt chart/index.html"
```

Checklist (each row must hold):
- Load an existing saved CSV (or a Supabase board if signed in) → no console errors, values appear under new field names.
- Open a project edit modal → Proposal + Live + End-of-project sections visible; old "Costs & budget" / "Sale & margin" gone.
- Open a task edit modal → only the Live section visible; fields read-only; values match the rolled-up sum.
- Open a subtask edit modal → only the Live section visible; fields editable; type a quoted_cost → variance updates live.
- Save a subtask → reopen → values persist.
- Click **📋 From Template** → Template A → fill name + start → Load → project appears with phases.
- Old field migration: load an old CSV that has `est_cost` + `cost_to_date` columns → reopen any subtask → values appear under the new field names.

- [ ] **Step 3: Document the legacy field aliases in the spec or top-of-file comment**

Add a short note near the migration shim in `index.html`:

```javascript
  // NOTE: legacy field names (est_cost, cost_to_date) are NOT removed from
  // existing saved boards on first load — the shim only ADDS the new keys.
  // Subsequent saves (via the modal) write only new keys; the old ones drop
  // out organically as nodes are edited. Direct round-trip CSVs may still
  // contain both columns for one save cycle — that's fine.
```

No commit needed if this comment was already added in Task 1; otherwise:

```bash
git add index.html
git commit -m "docs: clarify legacy field shim behavior near migrateLegacyFields"
```

- [ ] **Step 4: Ready PR 1 for review**

```bash
git log --oneline main..HEAD   # confirm 6–7 commits
# Push the branch + open a PR (or merge to main if working solo):
#   gh pr create --title "PR1: financial data model + lifecycle modal + template fix" \
#                --body "Implements docs/superpowers/specs/2026-05-25-financial-rollup-redesign-design.md (PR 1 scope)."
```

PR 2 (status enum + Delayed rescheduling) and PR 3 (RTB code + Summary CSV + slack→buffer + type/sector/installer) follow after this lands.

---

## Self-Review Notes

This plan implements the **PR 1 scope** from the spec: data + financials + modal redesign + template bug fix.

**Spec coverage check:**
- Migration shim → Task 1 ✓
- New fields on project (`estimated_raw_cost`) + subtask (`quoted_cost`, `actual_spend_to_date`, `committed_to_spend`) → Tasks 1, 4, 5 ✓
- Rollup math (sums) → Task 2 ✓
- Variance formula → Task 3 ✓
- Project margin formula → Task 3 ✓
- Final margin formula (with "all subtasks Done" gate) → Task 3 ✓
- Project Edit modal — lifecycle-grouped 2-col layout → Task 4 ✓
- Task Edit modal — rolled-up financial section → Task 4 ✓
- Subtask Edit modal — editable financial section → Task 4 ✓
- Template bug fix → Task 6 ✓
- Unit tests for migration + rollup math → Tasks 1, 2, 3, 6 ✓

**Out of PR 1 (by design):**
- Status enum dropdown / Delayed rescheduling → PR 2
- Bar tinting switched to status-driven colors → PR 2
- Hover tooltips updated → PR 2/3
- RTB code label → PR 3
- Project type / sector / installer fields → PR 3
- Summary CSV button → PR 3
- Slack → Buffer relabel → PR 3
