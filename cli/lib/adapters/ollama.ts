// ─── Ollama adapter ──────────────────────────────────────────────────────────
// Normalizes Ollama's /api/chat API to OpenAI-compatible response format.
// Local endpoints typically have no API key.

import type { Endpoint } from "../endpoints.js";
import type { ChatPayload } from "./openai.js";

export async function ollamaFetch(
  endpoint: Endpoint,
  payload: ChatPayload,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: payload.model,
    messages: payload.messages.map((m) => ({
      role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
    stream: payload.stream ?? false,
    options: {} as Record<string, number>,
  };
  if (payload.temperature !== undefined) {
    (body.options as any).temperature = payload.temperature;
  }
  // Ollama uses num_predict for max tokens
  if (payload.max_tokens !== undefined) {
    (body.options as any).num_predict = payload.max_tokens;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (endpoint.apiKey) {
    headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
  }

  const res = await fetch(`${endpoint.baseUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!payload.stream) {
    const data = await res.json() as Record<string, unknown>;
    const content = (data as any)?.message?.content ?? "";
    const normalized = {
      choices: [{
        message: { role: "assistant", content },
        finish_reason: (data as any)?.done ? "stop" : "length",
      }],
    };
    return new Response(JSON.stringify(normalized), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Ollama streaming: NDJSON (one JSON object per line)
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body for streaming request");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode("data: [DONE]\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const text = event?.message?.content;
            if (text) {
              const oai = { choices: [{ delta: { content: text } }] };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(oai)}\n`));
            }
          } catch { /* skip */ }
        }
      }
    },
  });

  return new Response(stream, {
    status: res.status,
    headers: { "content-type": "text/event-stream" },
  });
}
