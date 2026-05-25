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
