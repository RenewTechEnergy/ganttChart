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
import { systemMessage } from "./system-message.ts";

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
      let convo: Array<{ role: string; content: string }> = [];
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

      const apiKey = Deno.env.get("OPENROUTER_API_KEY");

      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "Missing OPENROUTER_API_KEY" }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Optional board context — the client sends a compact summary of the
      // projects currently in scope so the LLM can resolve hierarchy
      // ("under handover & documentation") and pick the right item_type /
      // parent without guessing. Capped at 8000 chars to bound tokens.
      const boardContextRaw = typeof body.boardContext === "string" ? body.boardContext : "";
      const boardContext = boardContextRaw.slice(0, 8000).trim();
      const contextMessages = boardContext
        ? [{
            role: "system",
            content:
              "Current board state (use the IDs verbatim in `target.parent` or `parameters.predecessor` when the user names something already on the board). Items not listed here do not exist yet — for those, use create_item.\n\n" +
              boardContext,
          }]
        : [];

      const openrouterModel = ({ haiku: "anthropic/claude-haiku-4-5", sonnet: "anthropic/claude-sonnet-4-5", opus: "anthropic/claude-opus-4-1" } as const)[requestedModel];

      const upstream = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "Project Gantt Action Extractor",
          },
          body: JSON.stringify({
            model: openrouterModel,
            messages: [systemMessage, ...contextMessages, ...convo],
            temperature: 0,
            // 4000 is plenty for a multi-op batch (each op ≈ 700 chars ≈ 180
            // tokens, so up to ~20 ops). Single-op responses stop well early.
            max_tokens: 4000,
          }),
        },
      );

      if (!upstream.ok) {
        const errorText = await upstream.text();

        return new Response(
          JSON.stringify({
            error: "OpenRouter request failed",
            status: upstream.status,
            details: errorText,
          }),
          {
            status: upstream.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const raw = await upstream.json();
      const content = raw?.choices?.[0]?.message?.content ?? "";

      const ops = parseCompletion(content);
      return Response.json({ operations: ops }, { headers: corsHeaders });
    },
  ),
};
