import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupDir, makeTmpDir, sampleProjectFiles, writeFixture } from "../helpers.js";

vi.mock("../../cli/lib/llm.js", () => ({
  ask: vi.fn(async () => "[]"),
}));

import { normRelPath, readRelevantFiles } from "../../cli/lib/projectReader.js";

describe("normRelPath", () => {
  test.each([
    ["./src/foo.ts", "src/foo.ts"],
    ["src/foo.ts", "src/foo.ts"],
    ["./cli/lib/../lib/agent.ts", "cli/lib/agent.ts"],
    ["//double/slash.ts", "/double/slash.ts"],
    ["", "."],
  ])("normalizes %s", (input, expected) => {
    expect(normRelPath(input)).toBe(expected);
  });
});

describe("readRelevantFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeFixture(tmpDir, sampleProjectFiles());
  });

  afterEach(() => cleanupDir(tmpDir));

  test("always reads package.json regardless of query", async () => {
    const output = await readRelevantFiles("hello", tmpDir);
    expect(output).toContain("FILE: package.json");
    expect(output).toContain("sample-project");
  });

  test("query prisma causes prisma directory to be read", async () => {
    const output = await readRelevantFiles("fix prisma", tmpDir);
    expect(output).toContain("FILE: prisma/schema.prisma");
  });

  test("query agent causes cli/lib/agent.ts to be read", async () => {
    writeFixture(tmpDir, { "cli/lib/agent.ts": "export const agent = true;\n" });
    const output = await readRelevantFiles("agent", tmpDir);
    expect(output).toContain("FILE: cli/lib/agent.ts");
  });

  test("files over 50KB are skipped", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/large.ts"), "x".repeat(60_000), "utf-8");
    const output = await readRelevantFiles("project src", tmpDir);
    expect(output).not.toContain("large.ts");
  });

  test("output token budget is respected", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`src/file-${i}.ts`] = `export const v${i} = "${"x".repeat(6_000)}";\n`;
    writeFixture(tmpDir, files);
    const output = await readRelevantFiles("project src", tmpDir);
    expect(output.length).toBeLessThanOrEqual(90_000);
  });

  test("node_modules is never included", async () => {
    writeFixture(tmpDir, { "node_modules/some-lib/index.js": "module.exports = 1;\n" });
    const output = await readRelevantFiles("project src", tmpDir);
    expect(output).not.toContain("node_modules/some-lib");
  });

  test(".fixd is never included", async () => {
    writeFixture(tmpDir, { ".fixd/memory.json": "{}\n" });
    const output = await readRelevantFiles("project src", tmpDir);
    expect(output).not.toContain(".fixd/memory.json");
  });

  test("dist is never included", async () => {
    writeFixture(tmpDir, { "dist/index.js": "console.log('built');\n" });
    const output = await readRelevantFiles("project src", tmpDir);
    expect(output).not.toContain("dist/index.js");
  });

  test("output is wrapped in project file delimiters", async () => {
    const output = await readRelevantFiles("hello", tmpDir);
    expect(output).toContain("--- PROJECT FILES");
    expect(output).toContain("--- END PROJECT FILES ---");
  });

  test("explicit file paths from issues bypass relevance scoring", async () => {
    writeFixture(tmpDir, { "src/explicit.ts": "export const explicit = true;\n" });
    const output = await readRelevantFiles("unrelated", tmpDir, ["TYPE"], [{ file: "src/explicit.ts" }]);
    expect(output).toContain("FILE: src/explicit.ts");
  });
});
