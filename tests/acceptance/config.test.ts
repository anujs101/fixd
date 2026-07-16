// ─── Acceptance: fixd config + migration ─────────────────────────────────────

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

describe("fixd config", () => {
  test("legacy migration produces a valid, routable config", async () => {
    const session = await newSession();
    const result = await fixdRun(session, ["status"], {
      input: "",
      timeout: 30_000,
      env: { GROQ_API_KEY: "gsk_test123", OPENROUTER_API_KEY: "sk-or-test456" },
    });
    await cleanup(session);

    // Migration must have run
    expect(existsSync(CONFIG_PATH)).toBe(true);

    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Version must be 1
    expect(config.version).toBe(1);

    // Must have at least 2 migrated endpoints
    expect(config.endpoints.length).toBeGreaterThanOrEqual(2);

    // Every endpoint must have all required fields with real values
    for (const ep of config.endpoints) {
      expect(typeof ep.name).toBe("string");
      expect(ep.name.length).toBeGreaterThan(0);
      expect(typeof ep.baseUrl).toBe("string");
      expect(ep.baseUrl).toMatch(/^https?:\/\//);
      expect(["openai", "anthropic", "gemini", "ollama"]).toContain(ep.compatibility);
      expect(Array.isArray(ep.models)).toBe(true);
      expect(ep.models.length).toBeGreaterThan(0);
      // API key must be set (it was provided via env)
      expect(typeof ep.apiKey).toBe("string");
      expect(ep.apiKey!.length).toBeGreaterThan(0);
    }

    // Every task must have a non-empty route
    for (const task of ["classify", "explain", "generate", "diagnose", "chat"]) {
      expect(config.routing[task].endpoint).toBeTruthy();
      expect(config.routing[task].model).toBeTruthy();
    }
  }, 60_000);

  test("each task routes to a different endpoint when both large and small endpoints exist", () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // classify/explain should route to Groq (small/fast)
    // generate/diagnose/chat should route to OpenRouter (large)
    const smallEp = config.routing.classify.endpoint;
    const largeEp = config.routing.diagnose.endpoint;
    // They should be different endpoints
    expect(smallEp).not.toBe(largeEp);
  });
});
