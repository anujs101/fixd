import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ask, askStream, chat, pickModel } from "../../cli/lib/llm.js";
import { invalidateConfig } from "../../cli/lib/endpoints.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after": "0" },
  });
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

// ── Test endpoint config ──────────────────────────────────────────────────────
// Mock loadConfig to return a config with a single "test" endpoint so all
// real LLM calls go through the endpoint routing layer.

function makeTestEndpoint(overrides?: { apiKey?: string }) {
  return {
    name: "Test",
    baseUrl: "https://test.local/v1",
    compatibility: "openai" as const,
    apiKey: overrides?.apiKey ?? "test-key",
    models: ["test-model"],
  };
}

vi.mock("../../cli/lib/endpoints.js", async () => {
  const actual = await vi.importActual("../../cli/lib/endpoints.js") as any;
  let testConfig = {
    version: 1,
    endpoints: [makeTestEndpoint()],
    routing: {
      classify:  { endpoint: "Test", model: "test-model" },
      explain:   { endpoint: "Test", model: "test-model" },
      generate:  { endpoint: "Test", model: "test-model" },
      diagnose:  { endpoint: "Test", model: "test-model" },
      chat:      { endpoint: "Test", model: "test-model" },
    },
  };
  return {
    ...actual,
    loadConfig: vi.fn(async () => testConfig),
    getConfig: vi.fn(async () => testConfig),
    getRouting: actual.getRouting,
    invalidateConfig: vi.fn(() => { testConfig = { ...testConfig }; }),
    __setTestConfig: (c: typeof testConfig) => { testConfig = c; },
  };
});

// Mock display to avoid spinner/sleep noise in tests
vi.mock("../../cli/lib/display.js", () => ({
  printHeader: vi.fn(),
  spin: vi.fn(() => ({ stop: vi.fn() })),
  section: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  agentSays: vi.fn(),
  printIssue: vi.fn(),
  printFix: vi.fn(),
  prompt: vi.fn(),
  confirm: vi.fn(),
  closePrompt: vi.fn(),
  bye: vi.fn(),
  agentWantsToRun: vi.fn(),
  printCommandResult: vi.fn(),
}));

describe("LLM client", () => {
  beforeEach(() => {
    invalidateConfig();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Model routing tests ──────────────────────────────────────────────────

  test.each([
    ["generate", undefined, "large"],
    ["diagnose", undefined, "large"],
    ["classify", undefined, "small"],
    ["explain", undefined, "small"],
    ["chat", "plain prompt", "small"],
    ["chat", "```ts\nconst x = 1;\n```", "large"],
    ["chat", "--- FILE: src/index.ts ---", "large"],
  ] as const)("pickModel routes %s", (task, prompt, expected) => {
    expect(pickModel(task, prompt)).toBe(expected);
  });

  // ── Basic API call tests ────────────────────────────────────────────────

  test("normal response returns content", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ask("hi", "classify")).resolves.toBe("hello");
  });

  test("response with think block is stripped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: { content: "<think>reasoning</think>actual response" }, finish_reason: "stop" }] })));
    await expect(ask("hi", "classify")).resolves.toBe("actual response");
  });

  test("finish_reason length returns content without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] })));
    // Should not throw — finish_reason "length" is a warning, not an error
    await expect(ask("hi", "classify")).resolves.toBe("partial");
  });

  // ── Parameter tests ─────────────────────────────────────────────────────

  test("classify task sends low temperature and small max_tokens", async () => {
    let receivedBody: any;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) receivedBody = JSON.parse(init.body as string);
      return jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await ask("classify this", "classify");
    expect(receivedBody.temperature).toBe(0.1);
    expect(receivedBody.max_tokens).toBe(512);
  });

  test("generate task sends creative temperature and large max_tokens", async () => {
    let receivedBody: any;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) receivedBody = JSON.parse(init.body as string);
      return jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await ask("generate a react component", "generate");
    expect(receivedBody.temperature).toBe(0.7);
    expect(receivedBody.max_tokens).toBe(8192);
  });

  test("diagnose task sends precise temperature and large max_tokens", async () => {
    let receivedBody: any;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) receivedBody = JSON.parse(init.body as string);
      return jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await ask("diagnose this error", "diagnose");
    expect(receivedBody.temperature).toBe(0.3);
    expect(receivedBody.max_tokens).toBe(8192);
  });

  // ── Retry tests ─────────────────────────────────────────────────────────

  test("HTTP 429 retries 3 times then throws after max retries", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "rate limit" } }, 429));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ask("hi", "classify")).rejects.toThrow(/rate limit/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("auth error (401) throws immediately without retry", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "unauthorized" } }, 401));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ask("hi", "classify")).rejects.toThrow(/Invalid API key/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Chat routing tests ──────────────────────────────────────────────────

  test("chat routes first simple message through configured endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await chat([{ role: "user", content: "hi" }], "chat");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("test.local");
  });

  // ── Streaming tests ─────────────────────────────────────────────────────

  test("askStream yields chunks incrementally", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n',
      "data: [DONE]\n",
    ])));
    await expect(collect(askStream("hi", "classify"))).resolves.toEqual(["a", "b"]);
  });

  test("askStream strips think blocks across chunk boundaries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"<think>rea"}}]}\n',
      'data: {"choices":[{"delta":{"content":"son</think>public"}}]}\n',
      "data: [DONE]\n",
    ])));
    await expect(collect(askStream("hi", "classify"))).resolves.toEqual(["public"]);
  });

  test("askStream handles DONE terminator cleanly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(["data: [DONE]\n"])));
    await expect(collect(askStream("hi", "classify"))).resolves.toEqual([]);
  });
});
