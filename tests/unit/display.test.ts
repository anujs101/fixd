import { afterEach, describe, expect, test, vi } from "vitest";
import { agentSays, confirm } from "../../cli/lib/display.js";

function captureStdout(): { output: () => string; restore: () => void } {
  let output = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
    output += String(chunk);
    return true;
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation((chunk?: unknown) => {
    output += `${String(chunk ?? "")}\n`;
  });
  return {
    output: () => output,
    restore: () => {
      stdoutSpy.mockRestore();
      logSpy.mockRestore();
    },
  };
}

describe("display system", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("agentSays renders a markdown code block", () => {
    const cap = captureStdout();
    agentSays("```ts\nconst x = 1;\n```");
    expect(cap.output()).toMatch(/fixd.*says[\s\S]*const x = 1;[\s\S]*╰/);
    cap.restore();
  });

  test("agentSays strips thought XML blocks from public output", () => {
    const cap = captureStdout();
    agentSays("<thought>internal</thought><text>public content</text>");
    expect(cap.output()).not.toContain("internal");
    expect(cap.output()).toMatch(/fixd.*says[\s\S]*public content[\s\S]*╰/);
    cap.restore();
  });

  test("agentSays renders text content", () => {
    const cap = captureStdout();
    agentSays("<text>hello world</text>");
    expect(cap.output()).toMatch(/fixd.*says[\s\S]*hello world[\s\S]*╰/);
    cap.restore();
  });

  test("agentSays handles malformed tags without crashing", () => {
    const cap = captureStdout();
    agentSays("<thought>never closed");
    expect(cap.output()).toMatch(/fixd.*says[\s\S]*never closed[\s\S]*╰/);
    cap.restore();
  });

  test("confirm returns true on y input", async () => {
    const cap = captureStdout();
    const promise = confirm("continue?");
    process.stdin.emit("data", "y\n");
    await expect(promise).resolves.toBe(true);
    expect(cap.output()).toContain("continue?");
    cap.restore();
  });

  test("confirm returns false on n input", async () => {
    const cap = captureStdout();
    const promise = confirm("continue?");
    process.stdin.emit("data", "n\n");
    await expect(promise).resolves.toBe(false);
    expect(cap.output()).toContain("continue?");
    cap.restore();
  });

  test("confirm returns false on empty input", async () => {
    const cap = captureStdout();
    const promise = confirm("continue?");
    process.stdin.emit("data", "\n");
    await expect(promise).resolves.toBe(false);
    expect(cap.output()).toContain("continue?");
    cap.restore();
  });
});
