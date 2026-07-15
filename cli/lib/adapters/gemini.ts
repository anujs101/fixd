// ─── Gemini adapter ───────────────────────────────────────────────────────────
// Normalizes Google Gemini's generateContent API to OpenAI-compatible format.
// Auth: API key passed as query parameter (?key=...).

import type { Endpoint } from "../endpoints.js";
import type { ChatPayload } from "./openai.js";

function toGeminiContents(messages: ChatPayload["messages"]) {
  // Gemini uses "contents" array with role: "user" | "model"
  // System instructions go in systemInstruction config
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemInstruction = systemMessages.map((m) => m.content).join("\n\n") || undefined;

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  return { contents, systemInstruction };
}

export async function geminiFetch(
  endpoint: Endpoint,
  payload: ChatPayload,
): Promise<Response> {
  const { contents, systemInstruction } = toGeminiContents(payload.messages);

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: payload.max_tokens ?? 4096,
    },
  };
  if (systemInstruction) {
    body["systemInstruction"] = { parts: [{ text: systemInstruction }] };
  }
  if (payload.temperature !== undefined) {
    (body.generationConfig as any).temperature = payload.temperature;
  }

  // Gemini endpoint format: /v1beta/models/{model}:generateContent
  const url = `${endpoint.baseUrl}/v1beta/models/${payload.model}:generateContent`;
  const keyParam = endpoint.apiKey ? `?key=${endpoint.apiKey}` : "";
  const streamParam = payload.stream ? `${keyParam ? "&" : "?"}alt=sse` : "";

  const res = await fetch(`${url}${keyParam}${streamParam}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!payload.stream) {
    const data = await res.json() as Record<string, unknown>;
    const text = (data as any)?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const finishReason = (data as any)?.candidates?.[0]?.finishReason ?? "stop";
    const normalized = {
      choices: [{
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      }],
    };
    return new Response(JSON.stringify(normalized), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Streaming: Gemini sends SSE with "text" field in the JSON
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
            const text = event?.candidates?.[0]?.content?.parts?.[0]?.text;
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
