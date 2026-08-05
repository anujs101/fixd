import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupDir, makeTmpDir } from "../helpers.js";

vi.mock("../../cli/lib/llm.js", () => ({
  chat: vi.fn(async () => "assistant reply"),
  ask: vi.fn(),
}));

import { chat } from "../../cli/lib/llm.js";
import { primeContext, resetSession, sendMessage, setActiveProject } from "../../cli/lib/agent.js";

const chatMock = vi.mocked(chat);

describe("agent session", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    resetSession();
    setActiveProject(tmpDir);
    chatMock.mockClear();
    chatMock.mockResolvedValue("assistant reply");
  });

  afterEach(() => cleanupDir(tmpDir));

  test("sendMessage appends user and assistant turns to history", async () => {
    await sendMessage("hello");
    await sendMessage("again");
    const secondMessages = chatMock.mock.calls[1][0];
    expect(secondMessages.filter((m) => m.role !== "system").map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("history is trimmed when total chars exceed limit", async () => {
    chatMock.mockResolvedValue("short");
    await sendMessage("x".repeat(250_000));
    await sendMessage("recent");
    const messages = chatMock.mock.calls[1][0];
    expect(messages.map((m) => m.role)).toEqual(["system", "assistant", "user"]);
    expect(messages.at(-1)).toEqual({ role: "user", content: "recent" });
    expect(messages.map((m) => m.content)).not.toContain("x".repeat(250_000));
  });

  test("trimming preserves most recent turns", async () => {
    await sendMessage("first");
    await sendMessage("x".repeat(250_000));
    await sendMessage("last");
    const messages = chatMock.mock.calls[2][0];
    expect(messages.map((m) => m.role)).toEqual(["system", "assistant", "user"]);
    expect(messages.at(-1)).toEqual({ role: "user", content: "last" });
    expect(messages.map((m) => m.content)).not.toContain("first");
  });

  test("system prompt is always present", async () => {
    await sendMessage("x".repeat(250_000));
    const messages = chatMock.mock.calls[0][0];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("PATCH FORMAT");
  });

  test("FIXD.md is prepended to system prompt", async () => {
    writeFileSync(join(tmpDir, "FIXD.md"), "Project-specific context", "utf-8");
    setActiveProject(tmpDir);
    await sendMessage("hello");
    expect(chatMock.mock.calls[0][0][0].content).toContain("Project-specific context");
  });

  test("FIXD.md absent uses base character prompt", async () => {
    await sendMessage("hello");
    expect(chatMock.mock.calls[0][0][0].content).toContain("fixd");
  });

  test("memory context is injected when memory exists", async () => {
    mkdirSync(join(tmpDir, ".fixd"), { recursive: true });
    writeFileSync(join(tmpDir, ".fixd/memory.json"), JSON.stringify({
      projectRoot: tmpDir,
      lastScanned: "2026-01-01T00:00:00.000Z",
      fixedIssues: [],
      knownStack: { packageManager: "bun" },
      chatSummaries: [],
      userPreferences: {},
      causalChain: [],
      stackPatterns: [],
    }), "utf-8");
    setActiveProject(tmpDir);
    await sendMessage("hello");
    expect(chatMock.mock.calls[0][0][0].content).toContain("--- PROJECT MEMORY ---");
    expect(chatMock.mock.calls[0][0][0].content).toContain("Stack: bun");
  });

  test("primeContext adds assistant turn without LLM call", async () => {
    primeContext("primed");
    expect(chatMock).not.toHaveBeenCalled();
    await sendMessage("hello");
    const messages = chatMock.mock.calls[0][0];
    expect(messages.slice(1).map((m) => [m.role, m.content])).toEqual([
      ["assistant", "primed"],
      ["user", "hello"],
    ]);
  });
});
