# Column detection + CSV schema reference

This file documents both the **canonical CSV format** the artifact reads and writes, and the heuristics `build_artifact.py` uses to map non-canonical inputs into that format.

## Canonical CSV structure

The skill reads and writes a fixed 15-column CSV. The header row must be these exact strings (in this order):

```
ID,Project / Task / Subtask,Owner,Predecessors,Sched. Start,Sched. End,Actual Start,Actual End,Slack (days),% Done,Estimated Cost ($),Cost to Date ($),Cost Variance ($),Sale Price ($),Margin ($)
```

### Field reference

| # | Header               | Type    | Notes                                                        |
| - | -------------------- | ------- | ------------------------------------------------------------ |
| 1 | ID                   | text    | `P1`, `P1-T1`, `P1-T1-S1` — see ID convention below          |
| 2 | Project / Task / Subtask | text | The display name                                            |
| 3 | Owner                | text    | Person responsible                                          |
| 4 | Predecessors         | text    | Comma-separated IDs (`P1-T1, P1-T2`) — Finish-to-Start       |
| 5 | Sched. Start         | date    | ISO `YYYY-MM-DD`                                            |
| 6 | Sched. End           | date    | ISO `YYYY-MM-DD`                                            |
| 7 | Actual Start         | date    | ISO `YYYY-MM-DD` — defaults to Sched. Start if blank        |
| 8 | Actual End           | date    | ISO `YYYY-MM-DD` — defaults to Sched. End if blank          |
| 9 | Slack (days)         | integer | 0 → critical-path row                                       |
| 10 | % Done              | integer | 0–100                                                       |
| 11 | Estimated Cost ($)  | number  | **Also serves as the Budget** for the over/under indicator. Parent rows: roll-up of child estimated costs |
| 12 | Cost to Date ($)    | number  | Dollars. Parent rows: roll-up of child costs                |
| 13 | Cost Variance ($)   | number  | **Computed** = `Cost to Date − Estimated`. Output only.      |
| 14 | Sale Price ($)      | number  | **Project rows only.** Manual entry. Not rolled up.          |
| 15 | Margin ($)          | number  | **Computed.** Project: `Sale − Cost`. Task/Subtask: `Est − Cost`. |

### ID convention

- `P1`, `P2` — projects (level 0)
- `P1-T1`, `P1-T2` — tasks under project `P1` (level 1)
- `P1-T1-S1`, `P1-T1-S2` — subtasks under task `P1-T1` (level 2)
- Predecessors use the same IDs, comma-separated

Older dot-notation (`P1-T1.1`) auto-normalizes to `P1-T1-S1` on import.

### Roll-up rules

When a row has children (e.g., a project with tasks, or a task with subtasks), its **Estimated Cost**, **Cost to Date**, and **Sale Price** columns display the *sum of its descendants' values*, not its own stored value. The artifact's cost-input fields are locked for parent rows. To change a parent's totals, edit its children.

A row with no children stores its own values directly. The artifact auto-fills Sale Price using `Sale = Estimated / (1 − margin%)` so that profit margin defaults to 40% (configurable per-row).

### Reading a CSV back into the artifact

The 15-column CSV is the session-storage format. To re-open a saved session:

1. User attaches the CSV file
2. Claude calls the skill again with the file path
3. `build_artifact.py` auto-detects columns (the exact header strings are explicit matches with the highest score)
4. Hierarchy is reconstructed from the ID prefixes
5. Computed columns (Cost Variance, Margin) are ignored on import — they're re-derived

## Auto-detection heuristics for non-canonical inputs

When the user attaches a spreadsheet that isn't in the canonical format, `build_artifact.py` scores each input header against keyword patterns and picks the best match per role.

### Roles

| Role          | Required? | What it maps to                                  |
| ------------- | --------- | ------------------------------------------------ |
| `name`        | Yes       | Column 2 in canonical CSV                       |
| `sched_start` | Yes       | Column 5                                         |
| `sched_end`   | Yes       | Column 6                                         |
| `id`          | No        | Column 1 — falls back to auto-assigned IDs       |
| `owner`       | No        | Column 3                                         |
| `predecessors`| No        | Column 4                                         |
| `actual_start`| No        | Column 7 — falls back to Sched. Start            |
| `actual_end`  | No        | Column 8 — falls back to Sched. End              |
| `slack`       | No        | Column 9                                         |
| `percent_done`| No        | Column 10                                        |
| `est_cost`    | No        | Column 11                                        |
| `cost_to_date`| No        | Column 12                                        |
| `sale_price`  | No        | Column 14                                        |

Patterns matched (after lowercasing and stripping non-alphanumeric):

- `name`: project name, project task subtask, task name, project, task, subtask, title, activity, name
- `start`: sched start, planned start, scheduled start, start date, start, begin, kickoff
- `end`: sched end, planned end, scheduled end, end date, end, finish, due, deadline
- `actual_start`: actual start, real start
- `actual_end`: actual end, real end, actual finish
- `slack`: slack, float
- `percent_done`: percent done, percent complete, done, complete
- `est_cost`: estimated cost, est cost, budget
- `cost_to_date`: cost to date, actual cost, spent, incurred
- `sale_price`: sale price, revenue, price, contract value

### When detection fails

If the script can't find headers for `name`, `sched_start`, or `sched_end`, it exits with code `2` and prints a JSON payload listing the available headers and what's missing. The caller (Claude) then uses AskUserQuestion to ask the user which column is which, and re-runs the script with `--mapping '{"name":"Col A","sched_start":"Col B","sched_end":"Col C"}'`.

### Hierarchy inference

If the input has no `ID` column, the script tries to infer hierarchy from leading characters in the name column:

- `▸`, `►` — level 1 (task)
- `•` — level 2 (subtask)
- Leading whitespace — every 2 spaces = 1 level

Once levels are inferred, IDs are auto-assigned in `P1` / `P1-T1` / `P1-T1-S1` form.

### Date parsing

The reader handles these formats and converts them to ISO `YYYY-MM-DD` before storing:

- ISO already: `2026-05-11`
- Slash form: `11/05/2026` — defaults to day-first (AU/EU). Disambiguates if a slot can't be a day.
- Excel serial number: `45698` → `2026-03-12` (1900 epoch)
- Word months: `11 May 2026`

If a date is unparseable, the cell is left empty and the row stays in the chart (you'll see it but it won't have a bar).
