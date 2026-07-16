// ─── Acceptance: fixd status ────────────────────────────────────────────────
// Verifies status command reports endpoint health correctly.

import { describe, test, beforeAll, afterAll } from "vitest";
import { newSession, fixdRun, cleanup } from "./helpers.js";
import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_PATH = path.join(os.homedir(), ".config", "fixd", "config.json");
let savedConfig: string | null = null;

beforeAll(() => {
  if (existsSync(CONFIG_PATH)) {
    savedConfig = readFileSync(CONFIG_PATH, "utf-8");
    unlinkSync(CONFIG_PATH);
  }
});

afterAll(() => {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  if (savedConfig) {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, savedConfig, "utf-8");
  }
});

describe("fixd status", () => {
  test("reports each configured endpoint as reachable or unreachable", async () => {
    // First, create a config via migration
    const s1 = await newSession();
    await fixdRun(s1, ["status"], {
      input: "",
      timeout: 30_000,
      env: { GROQ_API_KEY: "gsk_test123", OPENROUTER_API_KEY: "sk-or-test456" },
    });
    await cleanup(s1);

    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Run status again — should report on ALL configured endpoints
    const s2 = await newSession();
    const result = await fixdRun(s2, ["status"], { input: "", timeout: 30_000 });
    await cleanup(s2);

    // Every endpoint name must appear in the output
    for (const ep of config.endpoints) {
      expect(result.stdout).toContain(ep.name);
    }

    // Must show task routing for all 5 task types
    expect(result.stdout).toContain("task routing");
  }, 90_000);

  test("shows clear guidance when no endpoints exist", async () => {
    // Remove config
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);

    const session = await newSession();
    const result = await fixdRun(session, ["status"], {
      input: "",
      timeout: 15_000,
      env: {}, // no legacy keys — can't migrate
    });
    await cleanup(session);

    // Must give actionable guidance
    expect(result.stdout).toContain("No endpoints");
    expect(result.stdout).toContain("fixd config");
  }, 30_000);
});
