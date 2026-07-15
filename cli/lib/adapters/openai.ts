// ─── OpenAI-compatible adapter ────────────────────────────────────────────────
// Works with any OpenAI-compatible API: Groq, OpenRouter, Together, Fireworks,
// DeepInfra, Azure OpenAI, vLLM, LiteLLM, LM Studio, Open WebUI, custom gateways.
//
// All OpenAI-compatible providers accept the same /chat/completions endpoint
// with minor variations in model names and auth headers.

import type { Endpoint } from "../endpoints.js";

export type ChatPayload = {
  model: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

export async function openaiFetch(
  endpoint: Endpoint,
  payload: ChatPayload,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (endpoint.apiKey) {
    headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
  }

  // OpenRouter-specific headers (harmless for other providers)
  if (endpoint.baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/anujs101/fixd";
    headers["X-Title"] = "fixd";
  }

  return fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}
