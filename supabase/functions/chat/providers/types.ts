import type { ModelKey } from "../schema.ts";

export type ProviderMessage = { role: "user" | "assistant"; content: string };

export type ProviderRequest = {
  model: ModelKey;
  conversation: ProviderMessage[]; // ordered, last entry must be a user turn
  boardContext: string;            // already trimmed; empty string means no context
};

export type ProviderResult =
  | { ok: true; text: string }
  | { ok: false; status: number; error: string };

export interface Provider {
  readonly name: string;
  chat(req: ProviderRequest): Promise<ProviderResult>;
}

export class MissingApiKeyError extends Error {
  constructor(envVar: string) {
    super(`Missing ${envVar}`);
    this.name = "MissingApiKeyError";
  }
}
