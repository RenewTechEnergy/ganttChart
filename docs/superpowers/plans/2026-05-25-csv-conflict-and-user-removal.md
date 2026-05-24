# CSV Import Wizard, Admin User Removal, Chat Copy-Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three user-testing-readiness improvements: a CSV import picker/conflict-resolver, an admin "remove user" flow with reassign-ownership, and copy-paste support in the AI chat panel.

**Architecture:** All UI changes land inside the single-page `index.html`. A new edge function `delete-user` is added next to the existing `invite-user`, sharing its admin-auth and service-role patterns. Pure logic (conflict detection, resolution application) is implemented in JS inside `index.html` and unit-tested by re-implementing the same helpers inline in `tests/gantt.test.js` (matching the existing `tests/auth_rbac.test.js` pattern).

**Tech Stack:** Vanilla JS / HTML / CSS in `index.html`, Supabase Postgres + RLS, Deno edge functions, `node:test` for unit tests, jsdom available but not required.

**Spec:** `docs/superpowers/specs/2026-05-25-csv-conflict-and-user-removal-design.md`

**Execution order:** Feature C (chat) → Feature B (user removal) → Feature A (CSV wizard). Smallest first so we get one quick wins early; the CSV wizard is the largest and goes last.

---

## File Structure

**Create:**
- `supabase/functions/delete-user/deno.json`
- `supabase/functions/delete-user/index.ts`

**Modify:**
- `index.html`
  - CSS for chat user-select (around `:250` in the `#ai-panel` block)
  - Manage Users table (`:4162`): add trash column
  - Add `Supa.deleteUser` next to `inviteUser` (`:2027`)
  - Add `#removeUserModal` HTML (next to `#usersModal` at `:660`)
  - Add `openRemoveUserModal` / `confirmRemoveUser` JS (next to `changeUserRole` at `:4223`)
  - Add `#importModal` HTML (next to `#usersModal`)
  - Add pure conflict-detection + resolution-application helpers in the CSV IMPORT block (`:5288`)
  - Replace the `confirm()` flow inside the drop handler (`:5571`)
  - Add `window.__importApply` test hook
- `tests/gantt.test.js` — new CSV wizard cases
- `tests/auth_rbac.test.js` — new delete-user validation cases

---

## Feature C — Chat copy-paste

### Task 1: Enable text selection inside `#ai-panel`

**Files:**
- Modify: `index.html:250` (just before the `#ai-panel { … }` rule block)

- [ ] **Step 1: Add the CSS override**

Locate the `#ai-panel { position: fixed; … }` rule (currently at `index.html:251`). Insert this rule block immediately before it:

```css
    /* Chat content must be selectable so users can copy messages.
       body { user-select: none } higher up the tree blocks selection
       for the whole app — re-enable inside the chat scroll area only. */
    #ai-panel .ai-log,
    #ai-panel .ai-log *,
    #ai-panel .ai-preview,
    #ai-panel .ai-preview * {
      user-select: text;
      -webkit-user-select: text;
    }
```

- [ ] **Step 2: Verify in the browser**

Open `index.html` in a browser, sign in, open the AI panel (the toggle button), send a test message, then try to:
- Click-and-drag to highlight text in the user (green) bubble — should highlight.
- Click-and-drag to highlight text in the assistant (grey) bubble — should highlight.
- Cmd/Ctrl+C and paste somewhere else — pasted text matches the highlight.

Check the gantt grid is still NOT selectable (drag bars to confirm they drag, not select).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(chat): allow text selection in AI panel for copy-paste"
```

---

## Feature B — Admin user removal

### Task 2: Add validation-rule tests for the `delete-user` edge function

**Files:**
- Modify: `tests/auth_rbac.test.js` (append at end of file)

- [ ] **Step 1: Append the test block**

Open `tests/auth_rbac.test.js` and append:

```javascript
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
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
npm test
```

Expected: the new `validateDeleteUserBody` block has 6 passing tests (the function is defined inline, so they will actually pass — the test is a contract for the upcoming server function). The "failure" gate here is logical: the **server** does not yet enforce these rules. We will verify the server matches the spec in Task 3.

- [ ] **Step 3: Commit**

```bash
git add tests/auth_rbac.test.js
git commit -m "test(auth): add delete-user request validation cases"
```

### Task 3: Create the `delete-user` edge function

**Files:**
- Create: `supabase/functions/delete-user/deno.json`
- Create: `supabase/functions/delete-user/index.ts`

- [ ] **Step 1: Create deno.json**

```json
{
  "imports": {
    "@supabase/functions-js": "jsr:@supabase/functions-js@^2",
    "@supabase/server": "npm:@supabase/server@^1"
  }
}
```

- [ ] **Step 2: Create `supabase/functions/delete-user/index.ts`**

```typescript
// Admin-only: remove a user, reassign their owned projects, clear their
// shares, delete their profile row, then delete their auth account.
//
// Flow (no transactional guarantees across Auth + Postgres, so order
// matters and every step is idempotent on retry):
//   1. Caller presents their user JWT.
//   2. Resolve caller via auth/v1/user, check profiles.role === 'admin'.
//   3. Validate body { user_id, reassign_to }.
//   4. Reassign tasks.owner_user_id from <user_id> → <reassign_to>.
//   5. Delete project_shares where shared_with = <user_id>.
//   6. Null out project_shares.shared_by where shared_by = <user_id>.
//   7. Delete the profiles row for <user_id>.
//   8. Delete the auth user via /auth/v1/admin/users/<user_id>.
//
// If step 8 fails after 1-7 succeeded, the user's profile is gone but the
// auth account remains. We log loudly and surface a typed error code so
// the admin can retry; the earlier steps are idempotent (empty result
// sets short-circuit on a second pass).
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type AdminClient = { url: string; serviceKey: string };

function getAdminClient(): AdminClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

async function resolveCaller(admin: AdminClient, authHeader: string): Promise<{ userId: string } | null> {
  const res = await fetch(`${admin.url}/auth/v1/user`, {
    headers: { "apikey": admin.serviceKey, "Authorization": authHeader },
  });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  if (!u || typeof u.id !== "string") return null;
  return { userId: u.id };
}

async function getRole(admin: AdminClient, userId: string): Promise<string | null> {
  const res = await fetch(
    `${admin.url}/rest/v1/profiles?select=role&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { headers: { "apikey": admin.serviceKey, "Authorization": `Bearer ${admin.serviceKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return null;
  return typeof rows[0].role === "string" ? rows[0].role : null;
}

async function profileExists(admin: AdminClient, userId: string): Promise<boolean> {
  const res = await fetch(
    `${admin.url}/rest/v1/profiles?select=user_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { headers: { "apikey": admin.serviceKey, "Authorization": `Bearer ${admin.serviceKey}` } },
  );
  if (!res.ok) return false;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

function validateBody(body: unknown, callerUserId: string):
  | { ok: true; userId: string; reassignTo: string }
  | { ok: false; status: number; error: string }
{
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "Invalid JSON body." };
  const b = body as Record<string, unknown>;
  const userId = typeof b.user_id === "string" ? b.user_id.trim() : "";
  const reassignTo = typeof b.reassign_to === "string" ? b.reassign_to.trim() : "";
  if (!userId)                  return { ok: false, status: 400, error: "Missing user_id." };
  if (!reassignTo)              return { ok: false, status: 400, error: "Missing reassign_to." };
  if (userId === callerUserId)  return { ok: false, status: 400, error: "Admins cannot remove themselves." };
  if (userId === reassignTo)    return { ok: false, status: 400, error: "reassign_to must be a different user than user_id." };
  return { ok: true, userId, reassignTo };
}

async function reassignOwnedTasks(admin: AdminClient, userId: string, reassignTo: string): Promise<number> {
  const res = await fetch(
    `${admin.url}/rest/v1/tasks?owner_user_id=eq.${encodeURIComponent(userId)}&parent_id=is.null`,
    {
      method: "PATCH",
      headers: {
        "apikey": admin.serviceKey,
        "Authorization": `Bearer ${admin.serviceKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({ owner_user_id: reassignTo }),
    },
  );
  if (!res.ok) {
    console.error("[delete-user] reassign failed:", res.status, await res.text().catch(() => ""));
    throw new Error("reassign-failed");
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

async function removeShares(admin: AdminClient, userId: string): Promise<number> {
  const res = await fetch(
    `${admin.url}/rest/v1/project_shares?shared_with=eq.${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        "apikey": admin.serviceKey,
        "Authorization": `Bearer ${admin.serviceKey}`,
        "Prefer": "return=representation",
      },
    },
  );
  if (!res.ok) {
    console.error("[delete-user] removeShares failed:", res.status, await res.text().catch(() => ""));
    throw new Error("remove-shares-failed");
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

async function nullSharedBy(admin: AdminClient, userId: string): Promise<void> {
  const res = await fetch(
    `${admin.url}/rest/v1/project_shares?shared_by=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        "apikey": admin.serviceKey,
        "Authorization": `Bearer ${admin.serviceKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({ shared_by: null }),
    },
  );
  if (!res.ok) {
    console.error("[delete-user] nullSharedBy failed:", res.status, await res.text().catch(() => ""));
    throw new Error("null-shared-by-failed");
  }
}

async function deleteProfile(admin: AdminClient, userId: string): Promise<void> {
  const res = await fetch(
    `${admin.url}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        "apikey": admin.serviceKey,
        "Authorization": `Bearer ${admin.serviceKey}`,
        "Prefer": "return=minimal",
      },
    },
  );
  if (!res.ok) {
    console.error("[delete-user] deleteProfile failed:", res.status, await res.text().catch(() => ""));
    throw new Error("delete-profile-failed");
  }
}

async function deleteAuthUser(admin: AdminClient, userId: string): Promise<void> {
  const res = await fetch(`${admin.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: {
      "apikey": admin.serviceKey,
      "Authorization": `Bearer ${admin.serviceKey}`,
    },
  });
  if (!res.ok && res.status !== 404) {
    console.error("[delete-user] deleteAuthUser failed:", res.status, await res.text().catch(() => ""));
    throw new Error("delete-auth-user-failed");
  }
}

export default {
  fetch: withSupabase(
    { auth: ["publishable", "secret"] },
    async (req: Request) => {
      if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
      if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405);

      const admin = getAdminClient();
      if (!admin) return json({ error: "Server not configured (missing SUPABASE_SERVICE_ROLE_KEY)." }, 500);

      const authHeader = req.headers.get("authorization") || "";
      if (!authHeader.toLowerCase().startsWith("bearer ")) {
        return json({ error: "Missing user authorization." }, 401);
      }

      const caller = await resolveCaller(admin, authHeader);
      if (!caller) return json({ error: "Could not identify caller." }, 401);

      const callerRole = await getRole(admin, caller.userId);
      if (callerRole !== "admin") return json({ error: "Only admins can remove users." }, 403);

      let body: unknown;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }

      const v = validateBody(body, caller.userId);
      if (!v.ok) return json({ error: v.error }, v.status);

      if (!(await profileExists(admin, v.userId))) {
        return json({ error: "User does not exist." }, 404);
      }
      if (!(await profileExists(admin, v.reassignTo))) {
        return json({ error: "reassign_to user does not exist." }, 400);
      }

      try {
        const reassigned = await reassignOwnedTasks(admin, v.userId, v.reassignTo);
        const removedShares = await removeShares(admin, v.userId);
        await nullSharedBy(admin, v.userId);
        await deleteProfile(admin, v.userId);
        await deleteAuthUser(admin, v.userId);
        return json({ ok: true, reassigned_projects: reassigned, removed_shares: removedShares });
      } catch (e) {
        const code = (e instanceof Error && e.message) || "unknown";
        return json({ error: `Step failed: ${code}. Retry safely — earlier steps are idempotent.` }, 500);
      }
    },
  ),
};
```

- [ ] **Step 3: Verify the file compiles via `deno check`**

```bash
cd "supabase/functions/delete-user" && deno check index.ts
```

Expected: no errors. If `deno` isn't installed locally, skip — Supabase deploy will catch type errors.

- [ ] **Step 4: Deploy to Supabase**

```bash
cd "/Users/jack/Desktop/gantt chart" && supabase functions deploy delete-user
```

Expected: deploy succeeds.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/delete-user
git commit -m "feat(supa): add delete-user edge function for admin user removal"
```

### Task 4: Add `Supa.deleteUser` frontend wrapper

**Files:**
- Modify: `index.html` (after `inviteUser` at `:2027`, before `window.Supa = {…}` at `:2055`)

- [ ] **Step 1: Insert the wrapper**

After the closing `}` of `inviteUser` (at the end of the function block around line 2053), add:

```javascript
    // ─── Admin: remove a user via the delete-user edge function ───
    // Reassigns the user's owned projects to <reassignTo>, clears their
    // shares, deletes their profile, and deletes their auth account.
    // Returns { ok, reassigned_projects, removed_shares }. Throws on error.
    async function deleteUser(userId, reassignTo) {
      const useLocal = SUPA_CONFIG.useLocalEdge === true;
      const base   = useLocal ? SUPA_CONFIG.localFunctionsBase  : SUPA_CONFIG.supabaseUrl;
      const apikey = useLocal ? SUPA_CONFIG.localPublishableKey : SUPA_CONFIG.publishableKey;
      const token  = supaToken || apikey;
      const url    = `${base}/functions/v1/delete-user`;
      const res = await loggedFetch(url, {
        method: "POST",
        headers: {
          "apikey": apikey,
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: userId, reassign_to: reassignTo }),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        let msg = text;
        try { msg = JSON.parse(text)?.error || text; } catch (_) {}
        throw new Error(msg || `HTTP ${res.status}`);
      }
      try { return JSON.parse(text); } catch { return { ok: true }; }
    }
```

- [ ] **Step 2: Export on `window.Supa`**

Find the `window.Supa = { … }` literal at `index.html:2055`. The `// admin` block currently reads:

```javascript
      // admin
      listAllProfiles, setUserRole, inviteUser,
```

Replace with:

```javascript
      // admin
      listAllProfiles, setUserRole, inviteUser, deleteUser,
```

- [ ] **Step 3: Verify in the browser console**

Open the app, sign in as admin, open devtools console:

```javascript
typeof window.Supa.deleteUser
```

Expected: `"function"`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(supa): expose Supa.deleteUser wrapper for the new edge function"
```

### Task 5: Add `#removeUserModal` HTML

**Files:**
- Modify: `index.html` (after the closing `</div>` of `#usersModal` at around `:691`, before the next `<div class="modal-overlay" id="modal" …>` at `:694`)

- [ ] **Step 1: Insert the modal markup**

```html
  <!-- Remove-user modal (admin only) — single-screen confirm w/ reassign picker -->
  <div class="modal-overlay" id="removeUserModal" style="display:none" onclick="if(event.target===this)closeRemoveUserModal()">
    <div class="modal" style="max-width:520px;">
      <h3>🗑 Remove user</h3>
      <div style="padding:10px 12px; background:#fef2f2; border:1px solid #fecaca; border-radius:8px; margin-bottom:10px; font-size:11px; color:#7f1d1d; line-height:1.5;">
        ⚠ <b>This is irreversible.</b> <span id="ru-email" style="font-weight:600;"></span> will lose access immediately and all their owned projects must be reassigned to another user. To restore access, you'll need to re-invite them from scratch — their account will be recreated, but project ownership won't come back automatically.
      </div>
      <div id="ru-counts" style="font-size:12px; color:#374151; margin-bottom:10px;">Loading…</div>
      <div id="ru-reassign-row" style="display:none; margin-bottom:10px;">
        <label style="font-size:12px; color:#374151;">
          Reassign their <span id="ru-owned-count">0</span> project(s) to:
          <select id="ru-reassign-pick" style="margin-top:4px; font-size:12px; width:100%; padding:6px 8px;">
            <option value="" disabled selected>— pick a user —</option>
          </select>
        </label>
      </div>
      <div id="ru-noone" style="display:none; padding:8px 10px; background:#fef3c7; border:1px solid #fde68a; border-radius:6px; font-size:11px; color:#92400e; margin-bottom:10px;">
        ⚠ No one else to reassign these projects to. Invite another user first.
      </div>
      <div id="ru-error" style="display:none; padding:8px 10px; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; font-size:11px; color:#7f1d1d; margin-bottom:10px;"></div>
      <div class="modal-actions">
        <button class="btn btn-cancel" onclick="closeRemoveUserModal()">Cancel</button>
        <button class="btn btn-del" id="ru-confirm" onclick="confirmRemoveUser()" disabled>Remove user</button>
      </div>
    </div>
  </div>

```

- [ ] **Step 2: Reload the app, confirm no rendering breakage**

Open `index.html` in a browser — no console errors, the page still renders normally.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(users): add Remove user modal markup"
```

### Task 6: Wire `openRemoveUserModal` / counts / reassign dropdown

**Files:**
- Modify: `index.html` — first add count helpers inside the Supa IIFE (around `:1982`), then add the modal wiring after `changeUserRole` at `:4223`.

- [ ] **Step 1: Add count helpers to `Supa`**

Inside the IIFE at `index.html`, find the `setUserRole` function (currently ending around `:1982`). Immediately after it, before `// Has this row id been seen on the server` at `:1984`, insert:

```javascript
    // Counts used by the Remove user modal so the admin sees what they're
    // about to nuke before confirming. Returns 0 on any error (modal will
    // still let the deletion proceed; backend is authoritative).
    async function countProjectsOwnedBy(userId) {
      const { count, error } = await supabase
        .from("tasks").select("id", { count: "exact", head: true })
        .eq("owner_user_id", userId).is("parent_id", null);
      if (error) { console.warn("[Supa] countProjectsOwnedBy failed", error); return 0; }
      return count || 0;
    }
    async function countSharesFor(userId) {
      const { count, error } = await supabase
        .from("project_shares").select("project_id", { count: "exact", head: true })
        .eq("shared_with", userId);
      if (error) { console.warn("[Supa] countSharesFor failed", error); return 0; }
      return count || 0;
    }
```

Then in the `window.Supa = { … }` object literal at `:2055`, replace the admin export line `listAllProfiles, setUserRole, inviteUser, deleteUser,` with:

```javascript
      // admin
      listAllProfiles, setUserRole, inviteUser, deleteUser,
      countProjectsOwnedBy, countSharesFor,
```

- [ ] **Step 2: Append the modal-wiring helpers**

Just before the `/* ══════════════════════════════════════════════════════════════ CSV EXPORT` comment at around `index.html:4243`, insert:

```javascript
  // ── Remove user (admin only) ──
  let _ruTarget = null;   // { user_id, email } of the user being removed

  async function openRemoveUserModal(userId) {
    const role = window.Supa?.currentRole?.();
    if (role !== 'admin') { flashHint('Admins only'); return; }
    const me = window.Supa.currentUserId();
    if (userId === me) { flashHint("You can't remove yourself"); return; }

    const target = _usersCache.find(p => p.user_id === userId);
    if (!target) { flashHint('User not found'); return; }
    _ruTarget = { user_id: userId, email: target.email || '(no email)' };

    document.getElementById('ru-email').textContent = _ruTarget.email;
    document.getElementById('ru-counts').textContent = 'Loading project + share counts…';
    document.getElementById('ru-reassign-row').style.display = 'none';
    document.getElementById('ru-noone').style.display = 'none';
    document.getElementById('ru-error').style.display = 'none';
    document.getElementById('ru-confirm').disabled = true;
    document.getElementById('removeUserModal').style.display = 'flex';

    // Fetch counts via the Supa wrapper (the bare supabase client is
    // scoped inside the IIFE — only Supa.* is reachable from out here).
    let ownedCount = 0, sharesCount = 0;
    try {
      ownedCount  = await window.Supa.countProjectsOwnedBy(userId);
      sharesCount = await window.Supa.countSharesFor(userId);
    } catch (e) {
      console.warn('[ru] count fetch failed', e);
    }
    document.getElementById('ru-counts').textContent =
      `Owns ${ownedCount} project(s) · Has ${sharesCount} project share(s).`;
    document.getElementById('ru-owned-count').textContent = String(ownedCount);

    // Populate the reassign dropdown — every user in cache except the target.
    const candidates = _usersCache
      .filter(p => p.user_id !== userId)
      .sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')));
    const sel = document.getElementById('ru-reassign-pick');
    sel.innerHTML = '<option value="" disabled selected>— pick a user —</option>'
      + candidates.map(p => `<option value="${esc(p.user_id)}">${esc(p.email || '(no email)')}</option>`).join('');
    sel.onchange = () => {
      document.getElementById('ru-confirm').disabled = !sel.value;
    };

    if (ownedCount > 0) {
      if (!candidates.length) {
        document.getElementById('ru-noone').style.display = '';
        // Confirm stays disabled — there's no one to reassign to.
      } else {
        document.getElementById('ru-reassign-row').style.display = '';
      }
    } else {
      // No owned projects → no reassign needed → enable the button immediately.
      document.getElementById('ru-confirm').disabled = false;
    }
  }

  function closeRemoveUserModal() {
    document.getElementById('removeUserModal').style.display = 'none';
    _ruTarget = null;
  }

  async function confirmRemoveUser() {
    if (!_ruTarget) return;
    const btn = document.getElementById('ru-confirm');
    const errEl = document.getElementById('ru-error');
    errEl.style.display = 'none';
    btn.disabled = true;

    // If owned-count > 0, require a selection. Otherwise pass through any
    // admin id (the server enforces userId !== reassignTo too).
    const ownedCount = parseInt(document.getElementById('ru-owned-count').textContent || '0', 10);
    let reassignTo = document.getElementById('ru-reassign-pick').value;
    if (!reassignTo) {
      if (ownedCount > 0) {
        errEl.textContent = 'Pick a user to reassign their projects to.';
        errEl.style.display = '';
        btn.disabled = false;
        return;
      }
      // No projects to reassign — pass the current admin's own id; server
      // will accept since the reassign is a no-op (zero rows updated).
      reassignTo = window.Supa.currentUserId();
    }

    try {
      const out = await window.Supa.deleteUser(_ruTarget.user_id, reassignTo);
      const email = _ruTarget.email;
      const reassigned = out?.reassigned_projects ?? 0;
      closeRemoveUserModal();
      _usersCache = await window.Supa.listAllProfiles();
      renderUsersList();
      flashHint(`Removed ${email}${reassigned ? ` · reassigned ${reassigned} project(s)` : ''}`);
    } catch (e) {
      errEl.textContent = e?.message || 'Remove failed.';
      errEl.style.display = '';
      btn.disabled = false;
    }
  }
```

- [ ] **Step 3: Verify wiring in console**

Open the Manage Users modal as admin. In devtools console:

```javascript
typeof openRemoveUserModal
typeof window.Supa.countProjectsOwnedBy
```

Expected: both `"function"`. (Don't call `openRemoveUserModal` yet — Task 7 wires the trash icon.)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(users): wire openRemoveUserModal with counts and reassign picker"
```

### Task 7: Add the trash column to the Manage Users table

**Files:**
- Modify: `index.html:4162-4188` (the `renderUsersList` function)

- [ ] **Step 1: Replace `renderUsersList`**

Replace the existing `function renderUsersList() { … }` block at `index.html:4153-4188` with:

```javascript
  function renderUsersList() {
    const wrap = document.getElementById('usersList');
    const q    = (document.getElementById('usersSearch')?.value || '').toLowerCase().trim();
    const me   = window.Supa.currentUserId();
    const rows = _usersCache.filter(p => !q || (p.email || '').toLowerCase().includes(q));
    if (!rows.length) {
      wrap.innerHTML = `<div style="padding:14px; color:#9ca3af;">${q ? 'No matches.' : 'No users yet.'}</div>`;
      return;
    }
    wrap.innerHTML = `
      <table style="width:100%; font-size:12px; border-collapse:collapse;">
        <thead><tr style="background:#f9fafb; text-align:left;">
          <th style="padding:8px 10px;">Email</th>
          <th style="padding:8px 10px; width:140px;">Role</th>
          <th style="padding:8px 10px; width:40px;"></th>
        </tr></thead>
        <tbody>
          ${rows.map(p => {
            const isMe = p.user_id === me;
            return `
              <tr style="border-top:1px solid #f3f4f6;">
                <td style="padding:6px 10px;">
                  ${esc(p.email || '(no email)')}
                  ${isMe ? '<span style="font-size:10px; color:#0e7490; margin-left:6px;">(you)</span>' : ''}
                </td>
                <td style="padding:6px 10px;">
                  <select onchange="changeUserRole('${esc(p.user_id)}', this.value)" ${isMe ? 'data-self="1"' : ''}>
                    <option value="admin"  ${p.role === 'admin'  ? 'selected' : ''}>admin</option>
                    <option value="user"   ${p.role === 'user'   ? 'selected' : ''}>user</option>
                    <option value="viewer" ${p.role === 'viewer' ? 'selected' : ''}>viewer</option>
                  </select>
                </td>
                <td style="padding:6px 10px; text-align:right;">
                  ${isMe ? '' : `<button onclick="openRemoveUserModal('${esc(p.user_id)}')" title="Remove user" style="background:transparent; border:none; cursor:pointer; font-size:14px; color:#b91c1c; padding:2px 6px;">🗑</button>`}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }
```

- [ ] **Step 2: Verify in the browser**

Open Manage Users as admin. The table should show three columns: Email · Role · (trash icon). The trash icon should be **hidden on your own row** but visible on every other row, including other admins.

- [ ] **Step 3: End-to-end test the flow**

Use an account you don't mind losing (e.g. a previously invited test user that owns no projects):

1. Click the trash icon next to their email.
2. Modal opens with the warning, counts line shows `Owns 0 · Has 0`.
3. The reassign-row is hidden (no projects), Remove button is enabled.
4. Click Remove user.
5. Toast confirms removal; user disappears from the list.
6. Re-open the Manage Users modal — user is gone.
7. In a separate browser/incognito, try the removed user's email at sign-in — should be rejected with the "ask an admin to invite you" message.

If you have a test user who owns a project, redo with that user and verify the reassign picker appears + the project gets reassigned.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(users): add trash column to Manage Users for admin removal"
```

---

## Feature A — CSV import wizard

### Task 8: Add conflict-detection unit tests (TDD red)

**Files:**
- Modify: `tests/gantt.test.js`

- [ ] **Step 1: Replace the scaffold test with conflict-detection tests**

Open `tests/gantt.test.js` and replace its entire contents with:

```javascript
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
    existingByKey.set(`${n.id}${n.name}`, n.id);
  }
  const out = new Map();
  for (const n of imported) {
    if (n.type !== 'project') continue;
    const key = `${n.id}${n.name}`;
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
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all 5 `detectImportConflicts` tests pass (the function is inline). The auth_rbac suite still passes.

- [ ] **Step 3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test(import): add conflict-detection cases for CSV wizard"
```

### Task 9: Add merge-renumber unit tests + helper

**Files:**
- Modify: `tests/gantt.test.js` (append)

- [ ] **Step 1: Append the helper + tests**

```javascript

// ─── renumberMergedTasks ──────────────────────────────────────────────────
// Renumber imported tasks/subtasks so they slot under an existing project
// at the next free T-number. Returns { nodes, remap } where `remap` maps
// old-imported-id → new-id for all renumbered rows. Predecessor refs are
// NOT rewritten here — the caller does that across all conflict resolutions
// at once. Re-implemented inline (matches the inline-helper test pattern).
function renumberMergedTasks(existingProjectId, existingNodes, importedNodes) {
  // Find max existing T-num under existingProjectId.
  const re = new RegExp('^' + existingProjectId + '-T(\\d+)$');
  let maxT = 0;
  for (const n of existingNodes) {
    const m = (n.id || '').match(re);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxT) maxT = num;
    }
  }
  // Collect imported tasks under the imported project (their id is
  // <importedProjectId>-T<n> or -T<n>-S<m>); discover the imported project id
  // by inspecting tasks. There can be only one project per call.
  const importedProj = importedNodes.find(n => n.type === 'project');
  if (!importedProj) return { nodes: [], remap: new Map() };
  const importedPid = importedProj.id;

  // Group children by their original T-number to keep S-numbering stable.
  const tasksInOrder = importedNodes
    .filter(n => {
      const segs = (n.id || '').split('-');
      return segs.length === 2 && segs[0] === importedPid;
    })
    .sort((a, b) => {
      const an = parseInt((a.id.match(/-T(\d+)$/) || [0, 0])[1], 10);
      const bn = parseInt((b.id.match(/-T(\d+)$/) || [0, 0])[1], 10);
      return an - bn;
    });

  const remap = new Map();
  remap.set(importedPid, existingProjectId); // project itself goes away (merge keeps existing header)
  let nextT = maxT;
  for (const task of tasksInOrder) {
    nextT++;
    const newId = `${existingProjectId}-T${nextT}`;
    remap.set(task.id, newId);
  }
  // Subtasks: their new id is `<remappedTaskId>-S<originalS>`.
  for (const n of importedNodes) {
    const segs = (n.id || '').split('-');
    if (segs.length !== 3) continue;
    const taskOldId = `${segs[0]}-${segs[1]}`;
    const newTaskId = remap.get(taskOldId);
    if (!newTaskId) continue;
    remap.set(n.id, `${newTaskId}-${segs[2]}`);
  }
  // Build the new node list (drop the project — it's the merge-into one).
  const nodes = importedNodes
    .filter(n => n.type !== 'project')
    .map(n => ({ ...n, id: remap.get(n.id) || n.id }));
  return { nodes, remap };
}

describe('renumberMergedTasks (merge into existing project)', () => {
  it('renumbers tasks past the max existing T-num', () => {
    const existing = [
      { id: 'P1',     type: 'project', name: 'A' },
      { id: 'P1-T1',  type: 'task',    name: 'old1' },
      { id: 'P1-T2',  type: 'task',    name: 'old2' },
    ];
    const imported = [
      { id: 'P9',     type: 'project', name: 'A' },
      { id: 'P9-T1',  type: 'task',    name: 'new1' },
      { id: 'P9-T2',  type: 'task',    name: 'new2' },
    ];
    const { nodes, remap } = renumberMergedTasks('P1', existing, imported);
    assert.deepEqual(nodes.map(n => n.id), ['P1-T3', 'P1-T4']);
    assert.equal(remap.get('P9-T1'), 'P1-T3');
    assert.equal(remap.get('P9-T2'), 'P1-T4');
  });

  it('handles gaps in existing T-numbers (uses max, not count)', () => {
    const existing = [
      { id: 'P1',     type: 'project', name: 'A' },
      { id: 'P1-T1',  type: 'task',    name: 'old1' },
      { id: 'P1-T5',  type: 'task',    name: 'old2' },
    ];
    const imported = [
      { id: 'P9',     type: 'project', name: 'A' },
      { id: 'P9-T1',  type: 'task',    name: 'new1' },
    ];
    const { nodes } = renumberMergedTasks('P1', existing, imported);
    assert.deepEqual(nodes.map(n => n.id), ['P1-T6']);
  });

  it('renumbers subtasks alongside their parent task', () => {
    const existing = [
      { id: 'P1',     type: 'project', name: 'A' },
      { id: 'P1-T1',  type: 'task',    name: 'old' },
    ];
    const imported = [
      { id: 'P9',         type: 'project', name: 'A' },
      { id: 'P9-T1',      type: 'task',    name: 'new' },
      { id: 'P9-T1-S1',   type: 'subtask', name: 'a' },
      { id: 'P9-T1-S2',   type: 'subtask', name: 'b' },
    ];
    const { nodes } = renumberMergedTasks('P1', existing, imported);
    assert.deepEqual(
      nodes.map(n => n.id).sort(),
      ['P1-T2', 'P1-T2-S1', 'P1-T2-S2'],
    );
  });

  it('drops the imported project header (merge keeps the existing one)', () => {
    const existing = [{ id: 'P1', type: 'project', name: 'A' }];
    const imported = [{ id: 'P9', type: 'project', name: 'A' }];
    const { nodes } = renumberMergedTasks('P1', existing, imported);
    assert.equal(nodes.length, 0);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all 4 new `renumberMergedTasks` tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test(import): add merge-renumber cases for CSV wizard"
```

### Task 10: Add predecessor-rewrite unit tests

**Files:**
- Modify: `tests/gantt.test.js` (append)

- [ ] **Step 1: Append the helper + tests**

```javascript

// ─── rewriteImportPreds ──────────────────────────────────────────────────
// Given an import remap (old-id → new-id) and a list of nodes with a
// `predecessors` string field (comma-separated), produce a new node list
// where each pred id is replaced via the remap. Refs outside the remap
// are kept as-is (these are refs out of the imported set, into existing
// rows on the board).
function rewriteImportPreds(remap, nodes) {
  return nodes.map(n => {
    if (!n.predecessors) return n;
    const rewritten = n.predecessors
      .split(/[,;]/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => remap.get(p) || p)
      .join(', ');
    return { ...n, predecessors: rewritten };
  });
}

describe('rewriteImportPreds (predecessor remap)', () => {
  it('rewrites refs that are in the remap', () => {
    const remap = new Map([['P9-T1', 'P1-T3']]);
    const nodes = [{ id: 'P1-T4', predecessors: 'P9-T1' }];
    const out = rewriteImportPreds(remap, nodes);
    assert.equal(out[0].predecessors, 'P1-T3');
  });

  it('preserves refs not in the remap (refs out of the imported set)', () => {
    const remap = new Map([['P9-T1', 'P1-T3']]);
    const nodes = [{ id: 'P1-T4', predecessors: 'P9-T1, P2-T7' }];
    const out = rewriteImportPreds(remap, nodes);
    assert.equal(out[0].predecessors, 'P1-T3, P2-T7');
  });

  it('handles empty / null predecessors', () => {
    const remap = new Map([['P9-T1', 'P1-T3']]);
    const nodes = [{ id: 'A', predecessors: '' }, { id: 'B', predecessors: undefined }];
    const out = rewriteImportPreds(remap, nodes);
    assert.equal(out[0].predecessors, '');
    assert.equal(out[1].predecessors, undefined);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: 3 new `rewriteImportPreds` tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/gantt.test.js
git commit -m "test(import): add predecessor-remap cases for CSV wizard"
```

### Task 11: Add `#importModal` HTML

**Files:**
- Modify: `index.html` — insert immediately after the `#removeUserModal` block added in Task 5

- [ ] **Step 1: Insert the modal markup**

```html
  <!-- CSV import modal — picker + per-project conflict resolver -->
  <div class="modal-overlay" id="importModal" style="display:none" onclick="if(event.target===this)closeImportModal()">
    <div class="modal" style="max-width:720px;">
      <h3 id="im-title">📥 Import from CSV</h3>
      <div id="im-summary" style="font-size:11px; color:#6b7280; margin-bottom:10px;"></div>
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:8px; font-size:11px;">
        <button class="btn btn-cancel" style="padding:3px 8px;" onclick="imSelectAll(true)">Select all</button>
        <button class="btn btn-cancel" style="padding:3px 8px;" onclick="imSelectAll(false)">Deselect all</button>
        <span style="flex:1;"></span>
        <label>Default conflicts to:
          <select id="im-default-resolution" onchange="imApplyDefaultResolution(this.value)">
            <option value="">— choose —</option>
            <option value="new">Import as new</option>
            <option value="keep">Keep mine</option>
            <option value="overwrite">Overwrite mine</option>
            <option value="merge">Merge</option>
          </select>
        </label>
      </div>
      <div id="im-rows" style="max-height:55vh; overflow:auto; border:1px solid #e5e7eb; border-radius:8px;"></div>
      <div id="im-footer" style="font-size:12px; color:#374151; margin-top:10px;"></div>
      <div class="modal-actions">
        <button class="btn btn-cancel" onclick="closeImportModal()">Cancel</button>
        <button class="btn btn-ok" id="im-confirm" onclick="confirmImport()" disabled>Import</button>
      </div>
    </div>
  </div>

```

- [ ] **Step 2: Verify the page still renders**

Reload the app — no console errors, layout unchanged.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(import): add CSV import modal markup"
```

### Task 12: Wire `openImportModal` (render rows + per-row dropdowns)

**Files:**
- Modify: `index.html` — insert after `remapCollidingProjectIds` at `:5558`, before `const dropOverlay = …` at `:5560`

- [ ] **Step 1: Add the pure logic + modal wiring**

```javascript
  // ── CSV import wizard: pure helpers (also used by tests) ──
  // detectImportConflicts: returns Map<importedProjId, existingProjId>
  // for projects whose id AND name both match (case-sensitive).
  function detectImportConflicts(imported, existing) {
    const existingByKey = new Map();
    for (const n of existing) {
      if (n.type !== 'project') continue;
      existingByKey.set(`${n.id}${n.name}`, n.id);
    }
    const out = new Map();
    for (const n of imported) {
      if (n.type !== 'project') continue;
      const key = `${n.id}${n.name}`;
      if (existingByKey.has(key)) out.set(n.id, existingByKey.get(key));
    }
    return out;
  }

  // Renumber imported tasks/subtasks of one project to slot under an
  // existing project at the next free T-number. Returns { nodes, remap }.
  function renumberMergedTasks(existingProjectId, existingNodes, importedNodesForProject) {
    const re = new RegExp('^' + existingProjectId + '-T(\\d+)$');
    let maxT = 0;
    for (const n of existingNodes) {
      const m = (n.id || '').match(re);
      if (m) {
        const num = parseInt(m[1], 10);
        if (num > maxT) maxT = num;
      }
    }
    const proj = importedNodesForProject.find(n => n.type === 'project');
    if (!proj) return { nodes: [], remap: new Map() };
    const importedPid = proj.id;
    const tasksInOrder = importedNodesForProject
      .filter(n => {
        const segs = (n.id || '').split('-');
        return segs.length === 2 && segs[0] === importedPid;
      })
      .sort((a, b) => {
        const an = parseInt((a.id.match(/-T(\d+)$/) || [0, 0])[1], 10);
        const bn = parseInt((b.id.match(/-T(\d+)$/) || [0, 0])[1], 10);
        return an - bn;
      });
    const remap = new Map();
    remap.set(importedPid, existingProjectId);
    let nextT = maxT;
    for (const t of tasksInOrder) {
      nextT++;
      remap.set(t.id, `${existingProjectId}-T${nextT}`);
    }
    for (const n of importedNodesForProject) {
      const segs = (n.id || '').split('-');
      if (segs.length !== 3) continue;
      const taskOldId = `${segs[0]}-${segs[1]}`;
      const newTaskId = remap.get(taskOldId);
      if (!newTaskId) continue;
      remap.set(n.id, `${newTaskId}-${segs[2]}`);
    }
    const nodes = importedNodesForProject
      .filter(n => n.type !== 'project')
      .map(n => ({ ...n, id: remap.get(n.id) || n.id }));
    return { nodes, remap };
  }

  function rewriteImportPreds(remap, nodes) {
    return nodes.map(n => {
      if (!n.predecessors) return n;
      const rewritten = n.predecessors
        .split(/[,;]/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => remap.get(p) || p)
        .join(', ');
      return { ...n, predecessors: rewritten };
    });
  }

  // ── CSV import wizard: modal state + render ──
  let importState = null;  // { fileName, parsed, mapping, rows[], conflictMap }

  function openImportModal(fileName, importedNodes) {
    const conflicts = detectImportConflicts(importedNodes, NODES);
    const projects = importedNodes.filter(n => n.type === 'project');
    const taskCountByProj = new Map();
    for (const n of importedNodes) {
      if (n.type === 'project') continue;
      const pid = (n.id || '').split('-')[0];
      taskCountByProj.set(pid, (taskCountByProj.get(pid) || 0) + 1);
    }
    importState = {
      fileName,
      importedNodes,
      conflictMap: conflicts,
      rows: projects.map(p => ({
        id: p.id,
        name: p.name,
        included: true,
        conflict: conflicts.has(p.id),
        existingId: conflicts.get(p.id) || null,
        resolution: conflicts.has(p.id) ? 'new' : null,
        taskCount: taskCountByProj.get(p.id) || 0,
      })),
    };
    document.getElementById('im-title').textContent = `📥 Import from ${fileName}`;
    document.getElementById('im-summary').textContent =
      `${projects.length} project(s), ${importedNodes.length - projects.length} task/subtask(s) found. ` +
      `${conflicts.size} conflict(s) detected.`;
    renderImportRows();
    document.getElementById('importModal').style.display = 'flex';
  }

  function closeImportModal() {
    document.getElementById('importModal').style.display = 'none';
    importState = null;
  }

  function imRowsBy(id) { return importState?.rows.find(r => r.id === id); }

  function renderImportRows() {
    const wrap = document.getElementById('im-rows');
    if (!importState) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = importState.rows.map(r => {
      const conflictChip = r.conflict
        ? '<span style="font-size:10px; padding:2px 6px; border-radius:10px; background:#fee2e2; color:#7f1d1d; margin-left:6px;">Conflict — exists on board</span>'
        : '';
      const dropdown = r.conflict ? `
        <select onchange="imSetResolution('${esc(r.id)}', this.value)" style="font-size:11px; padding:3px 6px; margin-left:8px;">
          <option value="new"        ${r.resolution === 'new'        ? 'selected' : ''}>Import as new</option>
          <option value="keep"       ${r.resolution === 'keep'       ? 'selected' : ''}>Keep mine</option>
          <option value="overwrite"  ${r.resolution === 'overwrite'  ? 'selected' : ''}>Overwrite mine</option>
          <option value="merge"      ${r.resolution === 'merge'      ? 'selected' : ''}>Merge</option>
        </select>` : '';
      const includeDisabled = r.conflict && r.resolution === 'keep';
      const includeChecked  = r.included && !includeDisabled;
      const warn = (r.conflict && r.resolution === 'overwrite')
        ? `<div style="font-size:10px; color:#92400e; margin-top:4px; margin-left:24px;">⚠ Predecessor refs from other projects into this one will become dangling.</div>`
        : '';
      return `
        <div style="padding:8px 12px; border-bottom:1px solid #f3f4f6; display:flex; align-items:center; flex-wrap:wrap;">
          <input type="checkbox" ${includeChecked ? 'checked' : ''} ${includeDisabled ? 'disabled' : ''}
                 onchange="imSetIncluded('${esc(r.id)}', this.checked)" style="margin-right:8px;">
          <span style="font-weight:600; color:#111827;">${esc(r.name || '(no name)')}</span>
          <span style="font-size:10px; color:#9ca3af; margin-left:6px;">${esc(r.id)}</span>
          <span style="font-size:10px; color:#6b7280; margin-left:6px;">· ${r.taskCount} task/subtask(s)</span>
          ${conflictChip}
          ${dropdown}
          <div style="flex-basis:100%;">${warn}</div>
        </div>`;
    }).join('');
    updateImportFooter();
  }

  function imSetIncluded(id, checked) {
    const r = imRowsBy(id); if (!r) return;
    r.included = checked;
    updateImportFooter();
  }
  function imSetResolution(id, resolution) {
    const r = imRowsBy(id); if (!r) return;
    r.resolution = resolution;
    if (resolution === 'keep') r.included = false;
    else if (!r.included)      r.included = true;
    renderImportRows();
  }
  function imSelectAll(checked) {
    if (!importState) return;
    for (const r of importState.rows) {
      if (r.conflict && r.resolution === 'keep') continue;
      r.included = checked;
    }
    renderImportRows();
  }
  function imApplyDefaultResolution(value) {
    if (!importState || !value) return;
    for (const r of importState.rows) {
      if (!r.conflict) continue;
      r.resolution = value;
      if (value === 'keep') r.included = false;
      else if (!r.included) r.included = true;
    }
    renderImportRows();
  }
  function updateImportFooter() {
    if (!importState) return;
    const included = importState.rows.filter(r => r.included);
    const taskCount = included.reduce((s, r) => s + r.taskCount, 0);
    document.getElementById('im-footer').textContent =
      `${included.length} of ${importState.rows.length} project(s) will be imported · ${taskCount} task/subtask(s)`;
    document.getElementById('im-confirm').disabled = !included.length;
  }
```

- [ ] **Step 2: Verify modal renders correctly**

Drop a small CSV with 2-3 projects onto the page. The modal should appear with one row per project. Toggle dropdowns and checkboxes — UI updates, footer counter updates. (Don't click Import yet — Task 14 wires the apply.)

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(import): wire CSV import modal rendering + resolution state"
```

### Task 13: Replace the existing CSV drop confirm with the new modal

**Files:**
- Modify: `index.html:5571-5638` (the entire `document.body.addEventListener('drop', …)` handler)

- [ ] **Step 1: Replace the drop handler**

Find the drop handler at `index.html:5571`. Replace the whole `document.body.addEventListener('drop', async e => { … });` block with:

```javascript
  document.body.addEventListener('drop', async e => {
    e.preventDefault();
    dropOverlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (!file) return;

    const lname = file.name.toLowerCase();
    if (!lname.endsWith('.csv')) {
      alert('In-browser import supports .csv only. For Excel, "Save As… CSV UTF-8" first.');
      return;
    }

    let text;
    try { text = await file.text(); }
    catch (err) { alert('Could not read file: ' + err.message); return; }

    const { headers, rows } = parseCSV(text);
    if (!headers.length || !rows.length) { alert('CSV is empty or has no data rows.'); return; }

    const result = buildImportedNodes(headers, rows);
    if (result.error) { alert(result.error); return; }
    if (!result.nodes.length) { alert('No usable rows in this CSV.'); return; }

    // Open the picker / conflict-resolution modal; apply happens in
    // confirmImport() once the user clicks Import.
    openImportModal(file.name, result.nodes);
  });
```

- [ ] **Step 2: Verify drop now opens the modal**

Drop a CSV — the import modal opens. Cancel — no board changes. Drop again, Import button is disabled (since `confirmImport` is undefined; that's Task 14).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(import): route CSV drop through the new picker modal"
```

### Task 14: Implement `confirmImport` — apply resolutions

**Files:**
- Modify: `index.html` — append to the import-wizard helpers added in Task 12 (right after `updateImportFooter`)

- [ ] **Step 1: Append `confirmImport`**

```javascript
  async function confirmImport() {
    if (!importState) return;
    const btn = document.getElementById('im-confirm');
    btn.disabled = true;

    // Partition imported nodes by project resolution.
    const importedByProj = new Map();
    for (const n of importState.importedNodes) {
      const pid = (n.type === 'project') ? n.id : (n.id || '').split('-')[0];
      if (!importedByProj.has(pid)) importedByProj.set(pid, []);
      importedByProj.get(pid).push(n);
    }

    const finalNodes = [];
    const toDeleteIds = new Set();   // ids to remove from board + Supabase
    const globalRemap = new Map();   // union of all per-project remaps (for cross-project preds)

    // 1. Walk per-project rows.
    const overwriteProjectIds = [];
    const asNewProjects = [];        // arrays of node-arrays, one per project, for renumber pass
    for (const r of importState.rows) {
      if (!r.included || (r.conflict && r.resolution === 'keep')) continue;
      const projNodes = importedByProj.get(r.id) || [];

      if (r.conflict && r.resolution === 'overwrite') {
        // Mark the existing project + descendants for deletion.
        const existPid = r.existingId;
        for (const n of NODES) {
          if (n.id === existPid || (n.id || '').startsWith(existPid + '-')) {
            toDeleteIds.add(n.id);
          }
        }
        overwriteProjectIds.push(r.id);
        // Imported keeps its original id (which == existPid by definition of conflict match).
        finalNodes.push(...projNodes);
      } else if (r.conflict && r.resolution === 'merge') {
        const { nodes, remap } = renumberMergedTasks(r.existingId, NODES, projNodes);
        for (const [k, v] of remap.entries()) globalRemap.set(k, v);
        finalNodes.push(...nodes);
      } else {
        // 'new' (or no conflict): renumber via the existing helper.
        asNewProjects.push(projNodes);
      }
    }

    // 2. Renumber all 'as-new' projects together so they don't collide
    //    with each other or with existing P-ids.
    if (asNewProjects.length) {
      const flat = asNewProjects.flat();
      const beforeIds = flat.map(n => n.id);
      remapCollidingProjectIds(flat);  // mutates in place
      // Build the remap entries from before→after so cross-project preds rewrite.
      flat.forEach((n, i) => {
        if (n.id !== beforeIds[i]) globalRemap.set(beforeIds[i], n.id);
      });
      finalNodes.push(...flat);
    }

    // 3. Rewrite predecessors across the entire finalNodes set using the
    //    union remap. Refs not in the remap are kept (refs into existing board).
    const rewritten = rewriteImportPreds(globalRemap, finalNodes);

    // 4. Apply: delete overwritten rows, push new rows, refresh.
    pushHistory();
    if (toDeleteIds.size) {
      const ids = [...toDeleteIds];
      // Remove from NODES locally first so render is immediate.
      for (let i = NODES.length - 1; i >= 0; i--) {
        if (toDeleteIds.has(NODES[i].id)) NODES.splice(i, 1);
      }
      if (window.Supa?.deleteRows) {
        try { await window.Supa.deleteRows(ids); } catch (e) { console.warn('[import] deleteRows failed', e); }
      }
    }
    // Dedupe against existing ids (paranoia — should never trip after renumber).
    const existingIds = new Set(NODES.map(n => n.id));
    let skipped = 0;
    for (const n of rewritten) {
      if (existingIds.has(n.id)) { skipped++; continue; }
      NODES.push(n);
      existingIds.add(n.id);
    }
    if (skipped) console.warn(`[import] skipped ${skipped} duplicate id(s)`);

    // 5. Selection + editable-set fixups (mirrors original handler).
    for (const r of importState.rows) {
      if (!r.included || (r.conflict && r.resolution === 'keep')) continue;
      // Determine the final project id we just pushed.
      let finalPid = r.id;
      if (r.conflict && r.resolution === 'overwrite') finalPid = r.existingId;
      else if (r.conflict && r.resolution === 'merge') finalPid = r.existingId;
      else finalPid = globalRemap.get(r.id) || r.id;
      selectedProjects.add(finalPid);
      if (window.__editableProjectIds) window.__editableProjectIds.add(finalPid);
    }

    const fileName = importState.fileName;
    const importedCount = rewritten.length;
    closeImportModal();
    saveLocal(); populateFilters(); render();
    flashHint(`📥 Imported ${importedCount} row${importedCount === 1 ? '' : 's'} from ${fileName}`);
    if (window.Supa?.refreshEditableProjects) {
      setTimeout(() => window.Supa.refreshEditableProjects(), 1500);
    }
  }
```

- [ ] **Step 2: End-to-end test**

Make a tiny CSV with two projects in a text editor; drop it onto the app:

```
ID,Project Task Subtask,Start date,End date,Owner
P1,Test Solar A,2026-06-01,2026-06-15,Test
P1-T1,Setup,2026-06-01,2026-06-05,Test
P2,Test Solar B,2026-07-01,2026-07-30,Test
```

Verify:
1. Modal opens, lists both projects, no conflicts (since this is a fresh board).
2. Click Import — both projects appear on the board.
3. Drop the same CSV again — now both rows are flagged as conflicts.
4. For P1: pick `Keep mine`. For P2: pick `Overwrite mine`. Click Import.
5. P1 is unchanged. P2 is replaced with the imported version.
6. Drop the same CSV a third time. For P1 pick `Merge`. Verify a new T1 appears under the existing P1 (renumbered to T2).
7. Drop a fourth time. For both pick `Import as new`. Verify P3 and P4 appear with the imported content.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(import): apply keep/overwrite/merge/as-new resolutions on confirm"
```

### Task 15: Expose `window.__importApply` for integration tests

**Files:**
- Modify: `index.html` — add an export inside the existing IIFE near where Supa is exposed (`:2055-2069`) but after the import helpers are defined.

- [ ] **Step 1: Add the export**

After the `confirmImport` function defined in Task 14, append:

```javascript
  // Test hook: expose pure helpers for integration tests. Production code
  // does not depend on this — it's a no-op except in tests where a unit
  // test directly invokes the helpers via window.__importApply.
  if (typeof window !== 'undefined') {
    window.__importApply = {
      detectImportConflicts,
      renumberMergedTasks,
      rewriteImportPreds,
    };
  }
```

- [ ] **Step 2: Sanity-check exposure**

In devtools console:

```javascript
typeof window.__importApply.detectImportConflicts
```

Expected: `"function"`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(import): expose __importApply test hook for integration coverage"
```

---

## Final verification

### Task 16: Run the full test suite and manual e2e checklist

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

Expected: every test passes, including the auth_rbac + gantt suites with all new cases.

- [ ] **Step 2: Manual e2e checklist**

Sign in as admin in a real browser (not headless) and walk through:

1. AI chat: open panel, send a message, highlight + Cmd/Ctrl+C the response → paste somewhere → matches.
2. Manage Users: open modal. Trash icon hidden on your row, visible on others. Click trash on a test user → modal shows email + warning + counts + reassign picker (if needed) → click Remove user → toast confirms and user is gone.
3. CSV drop: drop a CSV → import modal opens → each of the 4 resolutions behaves as covered in Task 14 Step 2.
4. No regressions: open the gantt grid, drag a bar, edit a row, sign out / sign in. All existing flows work.

- [ ] **Step 3: Final commit if any cleanup needed**

If the manual run surfaced fixes, commit them with descriptive messages. Otherwise we're done.

```bash
git status
```

Expected: clean (or just the cleanup commits).
