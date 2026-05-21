import type { Provider, ProviderRequest, ProviderResult } from "./types.ts";
import { systemPromptText, BOARD_CONTEXT_PREAMBLE } from "../system-message.ts";
import type { ModelKey } from "../schema.ts";

// Anthropic's Messages API takes raw model ids (no `anthropic/` prefix).
const ANTHROPIC_MODELS: Record<ModelKey, string> = {
  haiku:  "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-5",
  opus:   "claude-opus-4-1",
};

export const anthropicProvider: Provider = {
  name: "anthropic",

  async chat(req: ProviderRequest): Promise<ProviderResult> {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return { ok: false, status: 500, error: "Missing ANTHROPIC_API_KEY" };
    }

    // Anthropic puts the system prompt in a top-level `system` field, NOT as
    // a message with role:"system". Board context concatenates onto it so the
    // model still sees both pieces as system-level guidance. The preamble
    // is shared with the OpenRouter provider via system-message.ts.
    const fullSystem = req.boardContext
      ? `${systemPromptText}\n\n---\n\n${BOARD_CONTEXT_PREAMBLE}${req.boardContext}`
      : systemPromptText;

    const upstream = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODELS[req.model],
          max_tokens: 4000,
          temperature: 0,
          system: fullSystem,
          messages: req.conversation,
        }),
      },
    );

    if (!upstream.ok) {
      const errorText = await upstream.text();
      return { ok: false, status: upstream.status, error: errorText };
    }

    const raw = await upstream.json();
    // Messages API returns: { content: [ { type: "text", text: "..." }, ... ] }
    const block = Array.isArray(raw?.content)
      ? raw.content.find((b: { type?: string }) => b?.type === "text")
      : null;
    const text: string = block?.text ?? "";
    return { ok: true, text };
  },
};
