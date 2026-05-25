# Financial rollup, status enum, RTB code, UI cleanup — design

**Date:** 2026-05-25
**Status:** Draft for review
**Scope owner:** jackz@renewtechenergy.com.au

## Summary

This spec redesigns the project board around a proper financial-rollup data model, replaces the numeric `% Done` field with a four-value `Status` enum, adds project-level metadata (RTB code, project type, sector, installer name), tidies the edit modals into a 2-column lifecycle-grouped layout, adds a "Summary CSV" export that mirrors the currently-visible row state, renames the user-facing "slack" wording to "buffer", and fixes the broken "Load from Template" path that currently throws `window.Scheduler is not a function`.

The work ships as **three independently-mergeable PRs**, in order:

1. **PR 1 — Data + financials:** new fields, migration shim, rollup math, template bug fix.
2. **PR 2 — Status enum + Delayed rescheduling.**
3. **PR 3 — UI cleanup + RTB code + Summary CSV + slack→buffer + type/sector/installer.**

PR 1's data model is a hard prerequisite for PRs 2 and 3.

## Out of scope

- **SOW auto-selection** ("Complete SOW by sector and type of project") — picking a template automatically from the (sector × project_type) combination. Captured as a future spec.
- **Database column renames** in Supabase. The internal field name `slack_days` stays. Only UI text changes to "Buffer".
- **Round-trip CSV format change.** The existing `💾 CSV` save (used to reload board state) keeps its current schema and column names. The new export is an additional, summary-only button.
- **Resolution of any other open bugs** not listed in this spec.

## Data model

### Project node

| Field | Status | Type | Notes |
|---|---|---|---|
| `id` | existing | string (`P1`, `P2`, …) | Internal only. Predecessor wiring uses this. Never displayed. |
| `rtb_code` | **new** | string | Manually entered. Becomes the displayed project label. |
| `name` | existing | string | Project name (e.g., "pepes ducks mulgrave"). |
| `project_type` | **new** | enum: `Solar only`, `Solar and BESS`, `BESS only`, `Heat pump` | Single dropdown. |
| `sector` | **new** | enum: `Residential`, `Commercial` | Single dropdown. |
| `installer_name` | **new** | string | Editable any time. Not required. |
| `projected_start` | existing | ISO date | Already supported. Keep field name. |
| `sale_price` | existing | number | Manual. Project-level only. |
| `estimated_raw_cost` | **new** (absorbs `est_cost` when present at project level) | number | Manual. Project-level only (proposal-stage estimate). The old `est_cost` field, which today lives at every level, splits during migration: project-level `est_cost` → `estimated_raw_cost`; subtask-level `est_cost` → `quoted_cost`. |
| `project_margin` | **derived display-only** | number | `sale_price − estimated_raw_cost`. Read-only in modal. |
| `quoted_cost` (rolled) | **derived display-only** | number | Σ task `quoted_cost` (which is Σ subtask `quoted_cost`). |
| `actual_spend_to_date` (rolled) | **derived display-only** | number | Σ task. |
| `committed_to_spend` (rolled) | **derived display-only** | number | Σ task. |
| `variance` | **derived display-only** | number | `quoted_cost − (actual_spend_to_date + committed_to_spend)`. |
| `final_margin` | **derived display-only** | number | `sale_price − (actual_spend_to_date + committed_to_spend)`. Shown blank (`—`) until every subtask of the project has status `Done`; then it locks. |

### Task node

- No new manual fields. All financial fields are **derived from subtasks**:
  - `quoted_cost` = Σ subtask `quoted_cost`
  - `actual_spend_to_date` = Σ subtask `actual_spend_to_date`
  - `committed_to_spend` = Σ subtask `committed_to_spend`
  - `variance` = derived from rolled values.
- `status` = priority-rule rollup of subtasks (see Status rollup).

### Subtask node

| Field | Status | Type | Notes |
|---|---|---|---|
| `quoted_cost` | **new** (absorbs subtask `est_cost`) | number | Manual entry at subtask level. Migration copies `est_cost` → `quoted_cost` when present. |
| `actual_spend_to_date` | **new** (absorbs `cost_to_date`) | number | Manual. Migration copies `cost_to_date` → `actual_spend_to_date` when present. |
| `committed_to_spend` | **new** | number | Manual. |
| `variance` | **derived display-only** | number | Same formula as parent levels. |
| `status` | **new**, replaces `pct_done` | enum: `Not Started`, `In Progress`, `Delayed`, `Done` | Default `Not Started`. |

Subtask `pct_done` is removed. The `% Done` modal input is removed.

### Internal field that does NOT change

- `slack_days` — UI labels say "Buffer", JSON keys stay `slack_days`. CSV column header that is user-facing changes to "Buffer (days)" in the new Summary CSV; the round-trip CSV keeps `slack` for compatibility.

## Migration (alias-on-load)

Runs once per node when loading any saved board (Supabase rows, dropped CSV files, the in-memory legacy buffer):

```text
if node.quoted_cost is absent and node.est_cost is present and node is a subtask:
    node.quoted_cost = node.est_cost
if node.estimated_raw_cost is absent and node.est_cost is present and node is a project:
    node.estimated_raw_cost = node.est_cost
if node.actual_spend_to_date is absent and node.cost_to_date is present:
    node.actual_spend_to_date = node.cost_to_date
if node.status is absent and node.pct_done is present:
    if node.pct_done == 100: status = "Done"
    elif node.pct_done >  0:  status = "In Progress"
    else:                     status = "Not Started"
```

The migration is **idempotent** — running it twice is a no-op. After migration, saves go out under the new names; the old keys are dropped from the written JSON.

Existing saved CSV/Excel files keep loading without user intervention.

## Rollup math

**At each parent (task or project), for each cost field `f` in {`quoted_cost`, `actual_spend_to_date`, `committed_to_spend`}:**

```text
parent.f = sum of child.f over children (subtasks for a task, tasks for a project)
```

**Variance** is always computed locally from the (possibly rolled-up) values:

```text
node.variance = node.quoted_cost − (node.actual_spend_to_date + node.committed_to_spend)
```

**Project margin** (proposal-stage):

```text
project.project_margin = project.sale_price − project.estimated_raw_cost
```

**Final margin** (end-of-project, locked):

```text
if every subtask of project has status == "Done":
    project.final_margin = project.sale_price − (project.actual_spend_to_date + project.committed_to_spend)
else:
    project.final_margin = null  → displayed as "—"
```

**Status rollup** (task and project):

```text
if any descendant subtask has status "Delayed":      parent.status = "Delayed"
elif any descendant subtask has status "In Progress": parent.status = "In Progress"
elif every descendant subtask has status "Done":      parent.status = "Done"
else:                                                 parent.status = "Not Started"
```

A project with **zero subtasks** rolls up to `Not Started`.

Displays of variance, project_margin, final_margin show `—` when source inputs are missing — never `$0`.

## Status enum mechanics (subtask)

The Status dropdown sits on every subtask edit modal. Default `Not Started`. Behavior when the user changes it:

| Selection | Side effect on dates |
|---|---|
| `Not Started` | Clears `actual_start` and `actual_end`. If either was already populated, a small inline confirmation appears ("Reset actual dates?") before clearing — guards against accidental data loss when a subtask is misclicked. |
| `In Progress` | If `actual_start` is empty, sets it to today. Leaves `actual_end` alone. |
| `Done` | If `actual_end` is empty, sets it to today. If `actual_start` is also empty, sets it to today too. |
| `Delayed` | Opens an inline date prompt: *"New scheduled end date?"* Defaults to `today + (current scheduled_end − current scheduled_start)` working days. On confirm, sets `scheduled_end` to the new date and re-runs the CPM scheduler over the project to push downstream tasks. Status stays `Delayed` until the user manually changes it to `In Progress` or `Done`. On cancel, status reverts. |

The CPM rerun reuses the existing `window.Scheduler.schedule` adapter (`solveCPM`) — the same code path that drag-to-edit and predecessor changes already use.

### Validation
- The Delayed prompt rejects dates earlier than the subtask's `scheduled_start`. On rejection, the dropdown reverts to its previous value and the modal stays open with an inline error.

## UI changes

### Row label (left of bars)
- Project: shows `rtb_code` if set, else `(no RTB) {internal_id}` (e.g., `(no RTB) P1`). The internal id stays available for predecessor wiring.
- Task and subtask labels unchanged.

### Project Edit modal (Option A — lifecycle-grouped)

```text
┌─ Meta ──────────────────────────────────────────────────┐
│  RTB Code            │  Project Name                    │
│  Type of Project ▾   │  Sector ▾                        │
│  Installer Name      │  Projected Start Date            │
└──────────────────────────────────────────────────────────┘
┌─ Proposal stage ────────────────────────────────────────┐
│  Sale Price          │  Estimated Raw Cost              │
│  Project Margin (ro) │                                  │
└──────────────────────────────────────────────────────────┘
┌─ Live (rolled up) ──────────────────────────────────────┐
│  Quoted Cost (ro)        │  Actual Spend to Date (ro)   │
│  Committed to Spend (ro) │  Variance (ro)               │
└──────────────────────────────────────────────────────────┘
┌─ End of project ────────────────────────────────────────┐
│  Final Margin (ro)   │                                  │
└──────────────────────────────────────────────────────────┘
```

Each section is a labeled block with a small badge (color-coded: pink/blue/green) matching the spreadsheet headers.

### Task Edit modal

Existing fields (name, predecessors, durations, dates, buffer) unchanged. Add one section:

```text
┌─ Financial (rolled up) ─────────────────────────────────┐
│  Quoted Cost (ro)        │  Actual Spend to Date (ro)   │
│  Committed to Spend (ro) │  Variance (ro)               │
└──────────────────────────────────────────────────────────┘
```

No status field on the task modal — the rolled-up status appears as a colored badge in the modal header.

### Subtask Edit modal

Existing fields (name, predecessors, durations, dates, buffer) unchanged. Replacements/additions:

- Remove the numeric `% Done` input.
- Add a `Status` dropdown (Not Started / In Progress / Delayed / Done).
- Add a financial section:

```text
┌─ Financial ─────────────────────────────────────────────┐
│  Quoted Cost            │  Actual Spend to Date         │
│  Committed to Spend     │  Variance (ro)                │
└──────────────────────────────────────────────────────────┘
```

### Hover tooltips

- **Project hover:** RTB code, name, status badge, sale price, est raw cost, project margin, quoted cost (rolled), actual spend (rolled), committed (rolled), variance.
- **Task hover:** name, status badge (rolled), quoted cost (rolled), actual spend (rolled), committed (rolled), variance.
- **Subtask hover:** name, status, quoted cost, actual spend to date, committed to spend, variance.

### Bar tinting

The existing five-state tinting (`Critical`, `Late Start`, `At Risk`, …) is replaced by the new four-state coloring derived from `status`:

| Status | Color | Note |
|---|---|---|
| Not Started | grey (#9ca3af) | |
| In Progress | blue (#3b82f6) | |
| Delayed | red (#dc2626) | |
| Done | green (#16a34a) | |

The "critical path" red highlight (slack=0) layered on top is **kept** — it stays a separate visual signal, distinguishable from Delayed by an outline rather than a fill.

## Summary CSV export

**Trigger:** new toolbar button `📊 Summary CSV` placed next to the existing `💾 CSV` button.

**Row selection:** walks the currently-rendered row list — i.e., rows produced by `buildRows()` after applying the current collapse state, filter popup, and any active search. Hidden / collapsed children are excluded because their numbers are already included in the parent's rollup.

**Columns (in order):**

```
Type, RTB Code, Name, Status, Sale Price, Estimated Raw Cost,
Project Margin, Quoted Cost, Actual Spend to Date,
Committed to Spend, Variance, Final Margin,
Scheduled Start, Scheduled End
```

- `Type` is one of `project` / `task` / `subtask`.
- `RTB Code` is blank for non-project rows.
- Money columns are plain numbers (no `$`, no thousands separators) so Excel reads them numerically.
- Empty / not-applicable values are blank (not zero, not `—`).
- Filename: `summary-YYYY-MM-DD.csv`.

The existing `💾 CSV` button (full round-trip export) stays exactly as it is today.

## Template bug fix

**Symptom:** clicking "📋 From Template" → load → throws `window.Scheduler is not a function` (or similar variant referencing `Scheduler`).

**Suspected root cause:** `index.html` uses `<script type="module">import * as Scheduler from './scripts/scheduler.js'; window.Scheduler = Scheduler;</script>`. Under the `file://` protocol, browsers block ES module imports for security. The import fails silently, `window.Scheduler` stays undefined, and `solveCPM`'s `window.Scheduler.schedule(...)` errors out.

**Plan-phase deliverables (PR 1):**

1. Reproduce the bug locally (open under `file://` in Chrome and click "From Template"). Capture exact console message.
2. Pick a fix from these candidates and document it in the plan:
   - **(a) Inline the scheduler.** Embed the contents of `scripts/scheduler.js` directly into `index.html` as a non-module `<script>` block. Same code, no import. Works under `file://`. Largest blast radius (the file gets bigger, ~250 lines).
   - **(b) Static-server script.** Add `scripts/serve.sh` (or document `python3 -m http.server`) and update README. Tiny code change, but adds a setup step for users.
   - **(c) Detect and warn.** If `window.Scheduler` is still undefined after DOMContentLoaded, show a friendly modal saying "Open this file via a local server, not directly." Doesn't fix the bug, just makes it understandable.
3. **Recommended approach (to confirm during planning): (a) Inline the scheduler.** It removes the failure mode entirely without forcing users to change how they open the file.
4. Add a regression test: load `index.html`, click `📋 From Template`, pick Template A, hit Load, assert the project appears with tasks. Use the same browser-driven harness the `tests/` directory already employs.

## Slack → Buffer rename (UI only)

Affected user-facing labels (illustrative, not exhaustive — final list confirmed in the plan):

- Toolbar: `Max slack (d)` → `Max buffer (d)`. Tooltip rewords.
- Subtask modal: `Slack (days)` → `Buffer (days)`. Modal field id stays `m-slack` (internal).
- Modal cap note text rewords ("Capped to N day(s) by global Max-buffer setting").
- Status descriptions and legend tooltips ("...the row has slack — some buffer before it would delay the project") reword to use "buffer".
- Bar tinting legend label "Slack ≈ 0" rewords to "Buffer ≈ 0" (consistent with the rest of the UI).

**Not changed:** `slack_days` JSON key, scheduler.js algorithm comments (those are internal — algorithm name is "slack" in the literature), Supabase column name, round-trip CSV column header `slack`.

## Error handling

- **Migration shim:** idempotent — re-running on already-migrated data is a no-op. If both old and new keys are present, the new key wins (assume the user has saved since the migration ran).
- **Variance, project_margin, final_margin:** display `—` when source inputs are missing. Never `$0` (which would imply a real zero).
- **Delayed date prompt:** rejects dates earlier than the subtask's `scheduled_start`. On rejection, the status reverts; an inline error explains why.
- **CSV summary:** if no projects exist, the button is disabled.
- **Final margin:** the "every subtask Done" check skips projects with zero subtasks (which would otherwise vacuously evaluate Done).

## Testing

**Unit tests** (`tests/`):
- Migration shim: each old-field combination (project est_cost only; subtask est_cost only; both; pct_done at 0 / 50 / 100; status pre-set; etc.).
- Rollup math: sums; variance with missing fields; project_margin; final_margin with not-all-done; final_margin with all-done.
- Status rollup priority rule: every input combination over up to 3 subtasks.
- Delayed reschedule: confirm downstream shift via the existing `Scheduler.schedule` adapter.

**Integration / smoke tests** (per PR, manual or scripted):
- Load an existing saved CSV → no errors, values appear under new field names.
- Load a board with `pct_done == 50` → subtask appears as `In Progress`.
- Click `📋 From Template` → project appears with tasks (regression for the bug).
- Open a project with no subtasks → `Final Margin` shows `—`.
- Click `📊 Summary CSV` after collapsing one project → exported file has the right row count.

## File touch list (rough)

- `index.html` — vast majority of changes. Sections: data model, edit modals, hover tooltips, toolbar, status enum logic, migration shim, Summary CSV writer, slack-label rewords.
- `scripts/scheduler.js` — no logic changes; possibly inlined into `index.html` for template bug fix (PR 1).
- `tests/` — new test files for migration, rollup math, status rollup, Summary CSV builder, template loader regression.
- `README.md` — update if we add `scripts/serve.sh` (template bug fix candidate b).

## PR breakdown

**PR 1 — Data + financials + template bug fix**
- Migration shim
- New fields on project/task/subtask (estimated_raw_cost, quoted_cost, actual_spend_to_date, committed_to_spend)
- Rollup math (sums, variance, project_margin, final_margin)
- Project Edit modal — financial section reorganized into lifecycle-grouped 2-col layout
- Task Edit modal — financial rolled-up section added
- Subtask Edit modal — financial editable section added (status enum NOT here — that's PR 2)
- Template bug fix
- Unit tests for migration + rollup math

**PR 2 — Status enum + Delayed rescheduling**
- Replace `pct_done` with `status` enum (with migration in PR 1's shim)
- Subtask modal status dropdown + Delayed prompt + CPM reschedule
- Status rollup priority rule
- Bar tinting switched to status-driven colors
- Hover tooltips updated to show status
- Unit tests for status rollup + Delayed reschedule

**PR 3 — UI cleanup + RTB code + Summary CSV + slack→buffer + type/sector/installer**
- `rtb_code` field on project + row label change
- `project_type`, `sector`, `installer_name` fields on project + Meta block in modal
- `📊 Summary CSV` toolbar button + export logic
- Slack → Buffer relabel across UI
- Final modal polish

Each PR is independently testable and reversible. PR 1 ships the data backbone; PRs 2 and 3 can be reordered or paused without leaving the system in a half-state.
