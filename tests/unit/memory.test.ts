import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanupDir, makeTmpDir } from "../helpers.js";
import {
  addCausalEntry,
  formatMemoryForPrompt,
  loadMemory,
  recordFix,
  saveMemory,
  type ProjectMemory,
  type StackPattern,
} from "../../cli/lib/memory.js";

function memory(root: string): ProjectMemory {
  return {
    projectRoot: root,
    lastScanned: null,
    fixedIssues: [],
    knownStack: {},
    chatSummaries: [],
    userPreferences: {},
    causalChain: [],
    stackPatterns: [],
  };
}

function pattern(confidence: number, seenCount: number, lastSeen: string, issueType = "ISSUE"): StackPattern {
  return {
    stack: "Next.js+Prisma",
    issueType,
    fixDescription: "fix",
    outcome: "success",
    confidence,
    seenCount,
    lastSeen,
  };
}

describe("memory system", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => cleanupDir(tmpDir));

  test("loadMemory on non-existent path returns empty memory", async () => {
    const loaded = await loadMemory(tmpDir);
    expect(loaded).toEqual(memory(tmpDir));
  });

  test("saveMemory then loadMemory roundtrips correctly", async () => {
    const saved = { ...memory(tmpDir), userPreferences: { tone: "brief" }, lastScanned: "2026-01-01T00:00:00.000Z" };
    await saveMemory(saved);
    expect(await loadMemory(tmpDir)).toEqual(saved);
  });

  test("saveMemory creates .fixd directory", async () => {
    await saveMemory(memory(tmpDir));
    expect(existsSync(join(tmpDir, ".fixd"))).toBe(true);
  });

  test("saveMemory writes atomically with no tmp file left", async () => {
    await saveMemory(memory(tmpDir));
    expect(existsSync(join(tmpDir, ".fixd/memory.json.tmp"))).toBe(false);
    expect(existsSync(join(tmpDir, ".fixd/memory.json"))).toBe(true);
  });

  test("old memory without causalChain migrates", async () => {
    mkdirSync(join(tmpDir, ".fixd"), { recursive: true });
    writeFileSync(join(tmpDir, ".fixd/memory.json"), JSON.stringify({ projectRoot: tmpDir }), "utf-8");
    expect((await loadMemory(tmpDir)).causalChain).toEqual([]);
  });

  test("old memory without stackPatterns migrates", async () => {
    mkdirSync(join(tmpDir, ".fixd"), { recursive: true });
    writeFileSync(join(tmpDir, ".fixd/memory.json"), JSON.stringify({ projectRoot: tmpDir }), "utf-8");
    expect((await loadMemory(tmpDir)).stackPatterns).toEqual([]);
  });

  test("old memory without userPreferences migrates", async () => {
    mkdirSync(join(tmpDir, ".fixd"), { recursive: true });
    writeFileSync(join(tmpDir, ".fixd/memory.json"), JSON.stringify({ projectRoot: tmpDir }), "utf-8");
    expect((await loadMemory(tmpDir)).userPreferences).toEqual({});
  });

  test("fixedIssues capped at 50", async () => {
    let current = memory(tmpDir);
    current = recordFix(current, Array.from({ length: 55 }, (_, i) => ({ type: `T${i}`, description: `d${i}`, filesChanged: [] })));
    await saveMemory(current);
    const loaded = await loadMemory(tmpDir);
    expect(loaded.fixedIssues).toHaveLength(50);
    expect(loaded.fixedIssues[0].type).toBe("T5");
  });

  test("causalChain capped at 30", async () => {
    let current = memory(tmpDir);
    for (let i = 0; i < 35; i++) {
      current = addCausalEntry(current, {
        timestamp: "2026-01-01T00:00:00.000Z",
        file: `f${i}.ts`,
        issueType: "ISSUE",
        action: "changed",
        outcome: "resolved",
        followupIssues: [],
      });
    }
    await saveMemory(current);
    expect((await loadMemory(tmpDir)).causalChain).toHaveLength(30);
  });

  test("chatSummaries capped at 10 on save is not implemented", async () => {
    const current = memory(tmpDir);
    current.chatSummaries = Array.from({ length: 12 }, (_, i) => ({ sessionDate: "2026-01-01T00:00:00.000Z", summary: `s${i}`, filesChanged: [] }));
    await saveMemory(current);
    expect((await loadMemory(tmpDir)).chatSummaries).toHaveLength(10);
  });

  test("stackPatterns stale entries older than 90 days are dropped", async () => {
    const current = memory(tmpDir);
    current.stackPatterns = [
      pattern(0.9, 1, new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), "OLD"),
      ...Array.from({ length: 5 }, (_, i) => pattern(0.8, 1, new Date().toISOString(), `NEW${i}`)),
    ];
    await saveMemory(current);
    expect((await loadMemory(tmpDir)).stackPatterns.map((p) => p.issueType)).not.toContain("OLD");
  });

  test("stackPatterns low-confidence entries seen more than 5 times are dropped", async () => {
    const current = memory(tmpDir);
    current.stackPatterns = [
      pattern(0.1, 6, new Date().toISOString(), "LOW"),
      ...Array.from({ length: 5 }, (_, i) => pattern(0.8, 1, new Date().toISOString(), `KEEP${i}`)),
    ];
    await saveMemory(current);
    expect((await loadMemory(tmpDir)).stackPatterns.map((p) => p.issueType)).not.toContain("LOW");
  });

  test("pruning retains at least 5 highest-confidence entries", async () => {
    const current = memory(tmpDir);
    current.stackPatterns = Array.from({ length: 5 }, (_, i) => pattern(0.1 + i / 100, 6, new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), `P${i}`));
    await saveMemory(current);
    expect((await loadMemory(tmpDir)).stackPatterns).toHaveLength(5);
  });

  test("empty memory formats to empty string without undefined", () => {
    const output = formatMemoryForPrompt(memory(tmpDir));
    expect(output).toBe("");
    expect(output).not.toContain("undefined");
  });

  test("memory with causal entries renders causal history", () => {
    const current = memory(tmpDir);
    current.causalChain = Array.from({ length: 3 }, (_, i) => ({
      timestamp: "2026-01-01T00:00:00.000Z",
      file: `src/${i}.ts`,
      issueType: "TYPE",
      action: "patched",
      outcome: "resolved",
      followupIssues: [],
    }));
    const output = formatMemoryForPrompt(current);
    expect(output).toContain("--- CAUSAL HISTORY ---");
    expect(output).toContain("src/0.ts | TYPE → patched → resolved");
  });

  test("memory with knownStack renders stack info", () => {
    const current = memory(tmpDir);
    current.lastScanned = "2026-01-01T00:00:00.000Z";
    current.knownStack = { frameworks: ["Next.js"], orms: ["Prisma"], packageManager: "bun" };
    expect(formatMemoryForPrompt(current)).toContain("Stack: Next.js · Prisma · bun");
  });

  test("saveMemory creates a .fixd gitignore", async () => {
    await saveMemory(memory(tmpDir));
    expect(readFileSync(join(tmpDir, ".fixd/.gitignore"), "utf-8")).toBe("*\n");
    expect(readdirSync(join(tmpDir, ".fixd"))).toContain("memory.json");
  });
});
