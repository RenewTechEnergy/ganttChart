// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import {
  MODEL_KEYS,
  type ModelKey,
  fallbackExtraction,
  parseCompletion,
} from "./schema.ts";
import { openrouterProvider } from "./providers/openrouter.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import type { Provider } from "./providers/types.ts";

type EditableProject = { id: string; name: string };

async function resolveUser(authHeader: string): Promise<{ userId: string } | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey || !authHeader.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { "apikey": serviceKey, "Authorization": authHeader },
  });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  if (!u || typeof u.id !== "string") return null;
  return { userId: u.id };
}

async function getRole(userId: string): Promise<string | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return null;
  const res = await fetch(
    `${url}/rest/v1/profiles?select=role&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return null;
  return typeof rows[0].role === "string" ? rows[0].role : null;
}

// Returns the list of projects the user may edit. For admins: all projects.
// For users: their own + projects shared with can_edit=true. For viewers:
// empty (they're blocked earlier anyway).
async function getEditableProjects(userId: string, role: string): Promise<EditableProject[]> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return [];
  if (role === "viewer") return [];
  const hdr = { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` };

  if (role === "admin") {
    const r = await fetch(`${url}/rest/v1/tasks?select=id,name&parent_id=is.null&limit=500`, { headers: hdr });
    if (!r.ok) return [];
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows.map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })) : [];
  }

  // Regular user — own + shared-with-can_edit.
  const [ownR, sharedR] = await Promise.all([
    fetch(`${url}/rest/v1/tasks?select=id,name&parent_id=is.null&owner_user_id=eq.${encodeURIComponent(userId)}&limit=500`, { headers: hdr }),
    fetch(`${url}/rest/v1/project_shares?select=project_id&shared_with=eq.${encodeURIComponent(userId)}&can_edit=eq.true&limit=500`, { headers: hdr }),
  ]);
  const own    = ownR.ok    ? await ownR.json().catch(() => [])    : [];
  const shared = sharedR.ok ? await sharedR.json().catch(() => []) : [];
  const sharedIds = Array.isArray(shared) ? shared.map((s: { project_id: string }) => s.project_id) : [];
  let sharedProjects: EditableProject[] = [];
  if (sharedIds.length) {
    const inList = sharedIds.map((id) => `"${id.replace(/"/g, '""')}"`).join(",");
    const r = await fetch(`${url}/rest/v1/tasks?select=id,name&id=in.(${encodeURIComponent(inList)})`, { headers: hdr });
    if (r.ok) {
      const rows = await r.json().catch(() => []);
      if (Array.isArray(rows)) sharedProjects = rows.map((x: { id: string; name: string }) => ({ id: x.id, name: x.name }));
    }
  }
  const byId = new Map<string, EditableProject>();
  for (const p of (Array.isArray(own) ? own : []) as EditableProject[]) byId.set(p.id, p);
  for (const p of sharedProjects) byId.set(p.id, p);
  return [...byId.values()];
}

function buildScopePreamble(role: string, projects: EditableProject[]): string {
  if (role === "admin") {
    return `EDIT SCOPE: the current user is an admin and may edit ANY project.`;
  }
  if (!projects.length) {
    return `EDIT SCOPE: the current user has NO projects they can edit. The only operation you may suggest is creating a brand-new project (operation = "create_item" with item_type = "project", OR "create_project_candidate"). For any other request, set operation = "N/A" and explain in needs_clarification that the user needs to create or be shared on a project first.`;
  }
  const lines = projects
    .slice(0, 60)                                  // cap so the prompt stays bounded
    .map((p) => `- ${p.id} — ${p.name}`);
  return [
    `EDIT SCOPE: the current user may ONLY edit the following projects. Suggesting changes to any other project will be rejected by the client.`,
    ...lines,
    `Creating a NEW project (item_type = "project") is always allowed; the user will own it.`,
  ].join("\n");
}

const PROVIDERS: Record<string, Provider> = {
  openrouter: openrouterProvider,
  anthropic:  anthropicProvider,
};

function selectProvider(): Provider {
  const name = (Deno.env.get("LLM_PROVIDER") ?? "openrouter").toLowerCase();
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error(`Unknown LLM_PROVIDER "${name}". Set it to one of: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return p;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export default {
  fetch: withSupabase(
    { auth: ["publishable", "secret"] },
    async (req, _ctx) => {
      if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
      }

      if (req.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "Method not allowed" }),
          {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      let body: {
        messages?: Array<{ role?: string; content?: unknown }>;
        message?: string;
        model?: string;
        boardContext?: string;
      };

      try {
        body = await req.json();
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid JSON body" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const requestedModel = (body.model ?? "sonnet") as ModelKey;
      if (!(MODEL_KEYS as readonly string[]).includes(requestedModel)) {
        return new Response(
          JSON.stringify({ error: "Unknown model. Allowed: haiku, sonnet, opus" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Build the conversation history to send to the LLM. Accepts either a
      // single `message` string OR a `messages` array of { role, content }.
      // Cap at the last 12 messages to keep token usage bounded — the client
      // also caps at this, but defending here too.
      const HISTORY_CAP = 12;
      let convo: Array<{ role: "user" | "assistant"; content: string }> = [];
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (!m || typeof m !== "object") continue;
          const role = m.role;
          const content = typeof m.content === "string" ? m.content : "";
          if ((role === "user" || role === "assistant") && content.trim()) {
            convo.push({ role, content });
          }
        }
      } else if (typeof body.message === "string" && body.message.trim()) {
        convo.push({ role: "user", content: body.message });
      }
      convo = convo.slice(-HISTORY_CAP);
      // The latest user message must be the final turn for the extraction
      // contract to make sense. If the last message isn't from the user,
      // fall through to the fallback rather than ask the LLM to invent one.
      const latestUserContent = convo.length && convo[convo.length - 1].role === "user"
        ? convo[convo.length - 1].content
        : "";

      if (!latestUserContent.trim()) {
        return Response.json(fallbackExtraction, {
          headers: corsHeaders,
        });
      }

      // ─── Role + scope guard ──────────────────────────────────────────────
      // Block viewers entirely. For everyone else, fetch the list of
      // projects they may edit and inject it into the board context so the
      // LLM doesn't try to mutate anything out of scope. The client also
      // re-checks each op against canEditProject before applying it —
      // defence in depth.
      const authHeader = req.headers.get("authorization") || "";
      const caller = await resolveUser(authHeader);
      if (!caller) {
        return new Response(
          JSON.stringify({ error: "Sign in to use the AI assistant." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const role = (await getRole(caller.userId)) || "viewer";
      if (role === "viewer") {
        return new Response(
          JSON.stringify({ error: "Viewers cannot use the AI assistant." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const editableProjects = await getEditableProjects(caller.userId, role);
      const scopePreamble = buildScopePreamble(role, editableProjects);

      // Optional board context — the client sends a compact summary of the
      // projects currently in scope so the LLM can resolve hierarchy
      // ("under handover & documentation") and pick the right item_type /
      // parent without guessing. Capped at 8000 chars to bound tokens.
      const boardContextRaw = typeof body.boardContext === "string" ? body.boardContext : "";
      const boardContextBody = boardContextRaw.slice(0, 8000).trim();
      const boardContext = boardContextBody
        ? `${scopePreamble}\n\n${boardContextBody}`
        : scopePreamble;

      let provider: Provider;
      try {
        provider = selectProvider();
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : "Provider selection failed" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const result = await provider.chat({
        model: requestedModel,
        conversation: convo,
        boardContext,
      });

      if (!result.ok) {
        return new Response(
          JSON.stringify({
            error: `${provider.name} request failed`,
            status: result.status,
            details: result.error,
          }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const ops = parseCompletion(result.text);
      return Response.json({ operations: ops }, { headers: corsHeaders });
    },
  ),
};
