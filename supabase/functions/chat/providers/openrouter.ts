import type { Provider, ProviderRequest, ProviderResult } from "./types.ts";
import { systemMessage, BOARD_CONTEXT_PREAMBLE } from "../system-message.ts";
import type { ModelKey } from "../schema.ts";

// OpenRouter routes Anthropic models behind the `anthropic/` prefix.
const OPENROUTER_MODELS: Record<ModelKey, string> = {
  haiku:  "anthropic/claude-haiku-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",
  opus:   "anthropic/claude-opus-4-1",
};

export const openrouterProvider: Provider = {
  name: "openrouter",

  async chat(req: ProviderRequest): Promise<ProviderResult> {
    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) {
      return { ok: false, status: 500, error: "Missing OPENROUTER_API_KEY" };
    }

    const contextMessages = req.boardContext
      ? [{
          role: "system" as const,
          content: BOARD_CONTEXT_PREAMBLE + req.boardContext,
        }]
      : [];

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
          model: OPENROUTER_MODELS[req.model],
          messages: [systemMessage, ...contextMessages, ...req.conversation],
          temperature: 0,
          max_tokens: 4000,
        }),
      },
    );

    if (!upstream.ok) {
      const errorText = await upstream.text();
      return { ok: false, status: upstream.status, error: errorText };
    }

    const raw = await upstream.json();
    const text: string = raw?.choices?.[0]?.message?.content ?? "";
    return { ok: true, text };
  },
};
