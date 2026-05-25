# Design — CSV import conflict resolution, admin user removal, chat copy-paste

Date: 2026-05-25
Status: Draft (pending user review)

Three user-experience improvements driven by the run-up to user testing:

1. **CSV import wizard** — replace the silent "append everything" CSV drop with a
   picker + per-project conflict resolver.
2. **Admin user removal** — let admins remove non-self users with a reassign-
   ownership step and a clear non-reversibility warning.
3. **Chat panel copy-paste** — make user/assistant messages selectable so they
   can be copied with Cmd/Ctrl+C.

The three features are bundled in one spec because they are scoped to the same
admin-facing readiness pass before user testing and share no implementation
risk.

---

## 1. CSV import wizard

### 1.1 Problem

The current drop handler at `index.html:5571` parses the CSV, renumbers any
colliding P-ids via `remapCollidingProjectIds`, and appends every row as a new
project after a single `confirm()`. There is no way to:

- Pick which projects from the CSV to import.
- Detect that a project in the CSV matches an existing project on the board.
- Choose what to do on a match (keep, overwrite, merge, import-as-new).

### 1.2 Conflict detection rule

A project from the CSV is considered the same as an existing project on the
board iff:

- `imported.id === existing.id`, AND
- `imported.name === existing.name` (case-sensitive, no trim, no lowercase).

Detection runs on the freshly parsed `imported.nodes` **before**
`remapCollidingProjectIds` — that is the only point at which the imported ids
still reflect the user's source CSV. After detection, each row carries a
resolution choice that the renumber/insert pass consumes.

### 1.3 Per-project resolution choices

For each conflicting row the user picks one of:

- **Keep mine** — drop the imported project (and all its tasks/subtasks) from
  the import set. Nothing changes on the board.
- **Overwrite mine** — delete the existing project + all its descendants via
  `Supa.deleteRows`, then insert the imported project with its original id in
  full. Predecessor refs from *other* existing projects' tasks into the
  overwritten project become dangling; the modal surfaces this as a per-row
  warning but proceeds if the admin confirms.
- **Merge** — keep the existing project row untouched. Renumber each imported
  task/subtask so it slots under the existing project at the next free
  T-number (i.e. `max(existing T-num under this project) + 1`, then increment
  sequentially for the imported tasks preserving their relative order).
  Subtasks under each imported task adopt the task's new T-id but keep their
  own S-numbering (S1, S2, …). Predecessor refs *within* the imported set
  are rewritten to the new ids; refs *out* of the imported set are
  preserved.
- **Import as new** (default) — preserves current behaviour: `remapColliding-
  ProjectIds` gives the imported project a fresh P-id; both versions coexist.

Non-conflict rows are imported via the existing "as new" path (renumber if the
P-id happens to collide on id alone with a *different-named* existing project,
which is the only path that triggers the old behaviour).

### 1.4 UI

Trigger: when the dropped file is `.csv`, instead of `confirm()` open a new
modal `#importModal`.

Layout:

- **Header**: `📥 Import from <filename>` + sub-line `N projects, M tasks/
  subtasks found`.
- **Bulk controls**: `[Select all] [Deselect all] [Default all conflicts to: ▾]`.
- **List body** (scrollable, max 60vh): one row per imported project.
  - Row: `[✓] <project-name> <P-id-from-csv> <task-count badge>`.
  - Conflict rows additionally show a red `Conflict — exists on board` chip
    and a dropdown on the right: `[Import as new ▾]` (Keep mine / Overwrite
    mine / Merge / Import as new).
  - When the dropdown is `Keep mine`, the row checkbox is disabled (the
    project is excluded regardless).
  - When the dropdown is `Overwrite mine`, an inline sub-line appears if other
    existing projects' tasks reference any task inside the project being
    overwritten: `⚠ N tasks in other projects reference predecessors here —
    those refs will become dangling`.
- **Footer**: `N of M projects will be imported · K tasks/subtasks · [Cancel]
  [Import]`. The Import button is disabled when the included-row count is 0.

State held in a single object on the page:

```js
importState = {
  parsed: { headers, rows },
  mapping,                  // column-role mapping from detectColumns
  rows: [
    { id, name, included, conflict, resolution, taskCount,
      dependentRefCount }  // dependentRefCount only when conflict
  ],
}
```

### 1.5 On Import click

Sequenced steps:

1. Walk `importState.rows` to partition imported nodes into four sets by
   resolution. Drop `Keep mine` rows and any row with `included === false`.
2. For each `Overwrite mine` project, call `Supa.deleteRows` on the existing
   project id (cascade deletes its tasks/subtasks/shares).
3. For `Import as new` projects, run `remapCollidingProjectIds` scoped to that
   subset.
4. For `Merge` projects, find the max existing `T<n>` under the matching
   existing project; renumber the imported tasks/subtasks of that project
   accordingly. Build a per-project `remap` map.
5. Rewrite internal predecessor refs in the imported set using the union of
   the maps from steps 3 + 4.
6. `pushHistory()`, push the final nodes into `NODES`, then `saveLocal()`,
   `populateFilters()`, `render()`, and `flashHint` with a count summary.
7. `setTimeout(() => window.Supa.refreshEditableProjects(), 1500)` — same as
   current handler.

Cancel discards `importState`. No board changes, no history push.

### 1.6 Edge cases

- CSV with 0 projects → existing alert path, no modal.
- CSV with no conflicts → modal still opens (the picker step is always shown
  per requirement), every row default-checked, no dropdowns; the admin can
  simply hit Import.
- All rows unchecked + Import → button disabled.
- Headless tests need to drive the resolution logic without a DOM. We expose
  `window.__importApply(parsed, resolutions)` that wraps steps 1–7 minus DOM
  side effects, so unit tests can exercise keep/overwrite/merge/as-new and
  predecessor rewrite in isolation.

---

## 2. Admin user removal

### 2.1 Problem

The Manage Users modal at `index.html:4128` lets admins change roles and
invite users, but there is no affordance to remove a user. Per the
requirements, admins must be able to remove non-self users, the action is
irreversible, owned projects must be reassigned to another user picked by the
admin at the time of removal, and a warning must be shown.

### 2.2 Backend — new edge function `delete-user`

Same shape as `supabase/functions/invite-user/`: `withSupabase` wrapper,
service-role key for privileged operations, admin role check on the caller's
JWT.

**Request**: `POST /functions/v1/delete-user` body `{ user_id: string,
reassign_to: string }`.

**Server-side checks** (each returns a typed 4xx on failure):

1. Caller JWT resolves to a real user via `/auth/v1/user`.
2. Caller's `profiles.role === 'admin'`.
3. `user_id !== caller.userId` — self-deletion is refused outright.
4. `reassign_to` exists in `profiles` and is not equal to `user_id`.
5. The user being deleted exists in `profiles`.

**Server-side actions, sequenced** (Auth and Postgres can't share a
transaction, so order matters and steps must be idempotent on retry):

1. Reassign owned tasks — `PATCH /rest/v1/tasks?owner_user_id=eq.<user_id>`
   body `{ owner_user_id: <reassign_to> }`. Runs first so projects survive a
   downstream failure.
2. Clear shares granted to the user — `DELETE /rest/v1/project_shares?
   shared_with=eq.<user_id>`.
3. Null out shares granted by the user — `PATCH /rest/v1/project_shares?
   shared_by=eq.<user_id>` body `{ shared_by: null }`. We do not revoke
   access for others; we only clear the dangling reference.
4. Delete the profiles row — `DELETE /rest/v1/profiles?user_id=eq.<user_id>`.
5. Delete the auth user — `DELETE /auth/v1/admin/users/<user_id>` with the
   service-role key.

**Response on success**: `{ ok: true, reassigned_projects: N,
removed_shares: M }`. The UI uses these counts in the success toast.

**Failure mode**: if step 5 fails after 1–4 succeeded, the profile is gone but
the auth account remains. We log this loudly to function logs and return a
specific error code. Retrying is idempotent: steps 1–4 short-circuit on empty
result sets, step 5 succeeds on the second attempt.

### 2.3 Frontend — `window.Supa.deleteUser`

New method next to `inviteUser` in `index.html:2027`. Same `loggedFetch`
pattern. Signature: `async deleteUser(userId, reassignTo) → { ok, ...counts }`.

### 2.4 UI — trash icon + remove modal

In the Manage Users table at `index.html:4162`, add a third `<th>`/`<td>` for
the delete affordance.

**Per-row trash icon**: rendered as `🗑` in red for every row except the
current user's (we already detect `isMe` at `index.html:4170`). The icon
shows on other admin rows — admins can remove other admins, never themselves.
Click → `openRemoveUserModal(userId)`.

**Remove-user modal `#removeUserModal`** — single screen:

- Header: `Remove user — <email>`.
- Red warning banner: `⚠ This is irreversible. <email> will lose access
  immediately and all their owned projects must be reassigned to another
  user. To restore access, you'll need to re-invite them from scratch — their
  account will be recreated, but project ownership won't come back
  automatically.`
- Counts line (fetched on modal open): `Owns N project(s) · Has M project
  share(s)`. Fetched via two cheap count queries:
  - `tasks` where `owner_user_id = userId AND parent_id IS NULL`.
  - `project_shares` where `shared_with = userId`.
- Reassign dropdown (only if N > 0): `Reassign their N project(s) to: [▾ pick
  a user]`, populated from `_usersCache` minus the user being deleted, sorted
  by email, no default selection. The [Remove user] button is disabled until
  a reassignee is picked.
- Edge case — no one to reassign to: if N > 0 and the filtered list is empty,
  the modal shows `⚠ No one else to reassign these projects to. Invite
  another user first.` and the action button stays disabled.
- Actions: `[Cancel] [Remove user]` — red. Click → `await
  Supa.deleteUser(userId, reassignTo)` → close modal → refresh `_usersCache`
  → re-render the list → `flashHint('Removed <email> · reassigned N
  project(s)')`.

**Failure path**: if the edge function returns an error, show the message
inline in the modal (red banner under the action buttons). The modal stays
open so the admin can retry without re-picking.

---

## 3. Chat panel copy-paste

### 3.1 Problem

`body { user-select: none; }` at `index.html:22` disables text selection
globally (sensible for a drag-heavy gantt UI). The chat panel inherits the
rule, so user/assistant/system messages can't be highlighted or copied.

### 3.2 Fix

Scope a CSS override inside `#ai-panel`:

```css
#ai-panel .ai-log,
#ai-panel .ai-log *,
#ai-panel .ai-preview,
#ai-panel .ai-preview * {
  user-select: text;
  -webkit-user-select: text;
}
```

No JS, no new affordances, no new UI elements. The chat input textarea and
control buttons are unaffected (textareas accept input regardless of inherited
`user-select`; buttons remain clickable).

---

## 4. Testing

- **CSV wizard**: extend `tests/gantt.test.js` to cover the pure resolution
  logic via `window.__importApply`. Given a parsed CSV + resolution map, the
  resulting `NODES` set and the Supabase delete-list are correct for keep,
  overwrite, merge, and import-as-new in isolation and in combination.
  Predecessor-rewrite correctness on the merge path is the highest-value
  case.
- **User removal**: add cases to `tests/auth_rbac.test.js`. Hit the edge
  function with a non-admin token (expect 403), self-deletion (expect 400),
  reassign-to missing/invalid (expect 400), happy path (expect 200 with the
  documented response payload). Tests mock fetch in line with the existing
  test style; no live Supabase required.
- **Chat selection**: pure CSS with no observable behaviour beyond
  browser-native selection — verified by hand, not unit-tested.

---

## 5. Files touched

- `index.html` — new import modal, new remove-user modal, `Supa.deleteUser`,
  trash column in Manage Users, `#ai-panel` user-select rule, `__importApply`
  test hook.
- `supabase/functions/delete-user/index.ts` + `deno.json` — new edge function.
- `tests/gantt.test.js` — new CSV wizard cases.
- `tests/auth_rbac.test.js` — new delete-user cases.

No schema changes. RLS policies already permit admin writes to `profiles`,
`tasks`, and `project_shares` via the `is_admin()` helper; the service-role
key in the edge function bypasses RLS for the auth deletion.
