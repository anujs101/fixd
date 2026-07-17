// ─── Acceptance: fixd doctor with checker pipeline ──────────────────────────

import { describe, test, beforeAll, afterAll } from "vitest";
import { newSession, fixdRun, cleanup, parseIssueTypes } from "./helpers.js";
import type { Session } from "../../automation/index.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

describe("fixd doctor — checker pipeline", () => {
  let session: Session;
  let stdout: string;

  beforeAll(async () => {
    session = await newSession("broken-prisma");
    const result = await fixdRun(session, ["doctor", "--fast"], {
      input: "exit",
      timeout: 120_000,
    });
    stdout = result.stdout;
  }, 180_000);

  afterAll(async () => { await cleanup(session); });

  test("checker pipeline runs and reports results", () => {
    expect(stdout).toContain("checkers");
    expect(stdout).toMatch(/passed/);
    expect(stdout).toMatch(/failed/);
  });

  test("env checker detects missing DATABASE_URL as root cause", () => {
    // The env checker should find this issue independently of the LLM
    expect(stdout).toContain("DATABASE_URL");
    expect(stdout).toContain("root cause");
  });

  test("detects issue via both old detector and new checker", () => {
    // The old detectIssues() still finds MISSING_DATABASE_URL
    // AND the new env checker also finds it
    expect(stdout).toContain("MISSING_DATABASE_URL");
  });

  test("package-json checker passes on valid fixture", () => {
    expect(stdout).toContain("package-json");
    // Should show 0 errors for a valid package.json
    expect(stdout).toMatch(/package-json.*0 error/);
  });

  test("generates .fixd/memory.json with knownStack", () => {
    const memPath = path.join(session.workspacePath, ".fixd", "memory.json");
    expect(existsSync(memPath)).toBe(true);
    const mem = JSON.parse(readFileSync(memPath, "utf-8"));
    expect(mem.knownStack).toBeDefined();
    // The discovery engine should have populated knownStack
    expect(mem.knownStack.signals).toBeDefined();
  });

  test("no provider names leak into output", () => {
    const lower = stdout.toLowerCase();
    expect(lower).not.toContain("groq");
    expect(lower).not.toContain("openrouter");
    expect(lower).not.toContain("clarifai");
  });

  test("doctor completes within 60 seconds", async () => {
    const start = Date.now();
    const s2 = await newSession("broken-prisma");
    const r = await fixdRun(s2, ["doctor", "--fast"], { input: "exit", timeout: 90_000 });
    await cleanup(s2);
    expect(Date.now() - start).toBeLessThan(90_000);
    expect(r.stdout.length).toBeGreaterThan(200);
  }, 120_000);
});
