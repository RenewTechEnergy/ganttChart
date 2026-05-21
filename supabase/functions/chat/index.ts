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

      // Optional board context — the client sends a compact summary of the
      // projects currently in scope so the LLM can resolve hierarchy
      // ("under handover & documentation") and pick the right item_type /
      // parent without guessing. Capped at 8000 chars to bound tokens.
      const boardContextRaw = typeof body.boardContext === "string" ? body.boardContext : "";
      const boardContext = boardContextRaw.slice(0, 8000).trim();

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
