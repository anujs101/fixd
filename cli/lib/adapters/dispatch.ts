// ─── Adapter dispatch ─────────────────────────────────────────────────────────
// Routes a payload to the correct compatibility adapter based on endpoint type.

import type { Endpoint } from "../endpoints.js";
import { openaiFetch, type ChatPayload } from "./openai.js";
import { anthropicFetch } from "./anthropic.js";
import { geminiFetch } from "./gemini.js";
import { ollamaFetch } from "./ollama.js";

export async function endpointFetch(
  endpoint: Endpoint,
  payload: ChatPayload,
): Promise<Response> {
  switch (endpoint.compatibility) {
    case "openai":
      return openaiFetch(endpoint, payload);
    case "anthropic":
      return anthropicFetch(endpoint, payload);
    case "gemini":
      return geminiFetch(endpoint, payload);
    case "ollama":
      return ollamaFetch(endpoint, payload);
  }
}

export type { ChatPayload };
