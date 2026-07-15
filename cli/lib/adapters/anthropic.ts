// ─── Anthropic adapter ────────────────────────────────────────────────────────
// Normalizes Anthropic's /v1/messages API to OpenAI-compatible response format.

import type { Endpoint } from "../endpoints.js";
import type { ChatPayload } from "./openai.js";

function toAnthropicMessages(messages: ChatPayload["messages"]) {
  // Anthropic requires messages to alternate user/assistant, no system in array
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemContent = systemMessages.map((m) => m.content).join("\n\n") || undefined;

  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  return { systemContent, conversation };
}

export async function anthropicFetch(
  endpoint: Endpoint,
  payload: ChatPayload,
): Promise<Response> {
  const { systemContent, conversation } = toAnthropicMessages(payload.messages);

  const body: Record<string, unknown> = {
    model: payload.model,
    messages: conversation,
    max_tokens: payload.max_tokens ?? 4096,
  };
  if (systemContent) body["system"] = systemContent;
  if (payload.temperature !== undefined) body["temperature"] = payload.temperature;
  if (payload.stream) body["stream"] = true;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": endpoint.apiKey ?? "",
    "anthropic-version": "2023-06-01",
  };

  const res = await fetch(`${endpoint.baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!payload.stream) {
    // Normalize non-streaming response to OpenAI shape
    const data = await res.json() as Record<string, unknown>;
    const content = (data as any)?.content?.[0]?.text ?? "";
    const normalized = {
      choices: [{
        message: { role: "assistant", content },
        finish_reason: (data as any)?.stop_reason ?? "stop",
      }],
    };
    return new Response(JSON.stringify(normalized), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  // For streaming, transform Anthropic SSE to OpenAI SSE format
  // Anthropic sends: data: {"type": "content_block_delta", "delta": {"text": "..."}}
  // OpenAI expects:  data: {"choices":[{"delta":{"content":"..."}}]}
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
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "content_block_delta" && event.delta?.text) {
              const oai = { choices: [{ delta: { content: event.delta.text } }] };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(oai)}\n`));
            }
          } catch { /* skip malformed */ }
        }
      }
    },
  });

  return new Response(stream, {
    status: res.status,
    headers: { "content-type": "text/event-stream" },
  });
}
