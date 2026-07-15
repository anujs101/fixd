// ─── Endpoint abstraction layer ───────────────────────────────────────────────
// Replaces the old provider-centric model (Groq/OpenRouter/Clarifai) with a
// compatibility-based endpoint system. Every LLM call routes through an
// endpoint + model pair, regardless of whether the endpoint is a cloud API,
// a local Ollama instance, or a corporate gateway.
//
// Config is stored in ~/.config/fixd/config.json as a single file containing
// endpoints, task routing, and future settings.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Compatibility = "openai" | "anthropic" | "gemini" | "ollama";

export type Endpoint = {
  name: string;
  baseUrl: string;
  compatibility: Compatibility;
  apiKey?: string; // undefined = no auth (local endpoints)
  models: string[]; // discovered or manually entered
};

export type TaskName = "classify" | "explain" | "generate" | "diagnose" | "chat";

export type TaskRouting = Record<TaskName, {
  endpoint: string; // references Endpoint.name
  model: string;    // model name on that endpoint
}>;

export type FixdConfig = {
  version: 1;
  endpoints: Endpoint[];
  routing: TaskRouting;
};

// ─── Default routing (used until user configures endpoints) ───────────────────

export const DEFAULT_ROUTING: TaskRouting = {
  classify:  { endpoint: "", model: "" },
  explain:   { endpoint: "", model: "" },
  generate:  { endpoint: "", model: "" },
  diagnose:  { endpoint: "", model: "" },
  chat:      { endpoint: "", model: "" },
};

export function emptyConfig(): FixdConfig {
  return { version: 1, endpoints: [], routing: { ...DEFAULT_ROUTING } };
}

// ─── Config paths ─────────────────────────────────────────────────────────────

export const CONFIG_DIR  = path.join(os.homedir(), ".config", "fixd");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// ─── Config I/O ───────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<FixdConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Basic migration: ensure routing has all task keys
    const config: FixdConfig = {
      version: 1,
      endpoints: parsed.endpoints ?? [],
      routing: { ...DEFAULT_ROUTING, ...parsed.routing },
    };
    return config;
  } catch {
    return emptyConfig();
  }
}

export async function saveConfig(config: FixdConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmp, CONFIG_PATH);
}

// ─── Config cache ─────────────────────────────────────────────────────────────

let _configCache: FixdConfig | null = null;

export function invalidateConfig(): void {
    _configCache = null;
}

export async function getConfig(): Promise<FixdConfig> {
    if (!_configCache) _configCache = await loadConfig();
    return _configCache;
}

// ─── Endpoint lookup helpers ──────────────────────────────────────────────────

export function getEndpoint(config: FixdConfig, name: string): Endpoint | undefined {
  return config.endpoints.find((e) => e.name === name);
}

export function getRouting(
  config: FixdConfig,
  task: TaskName,
): { endpoint: Endpoint | undefined; model: string } {
  const route = config.routing[task];
  if (!route || !route.endpoint) return { endpoint: undefined, model: "" };
  return {
    endpoint: getEndpoint(config, route.endpoint),
    model: route.model,
  };
}

// ─── Auto-migration from legacy provider env vars ─────────────────────────────

/**
 * On first run after upgrading from the provider-centric model, detect legacy
 * env vars and create equivalent endpoints. Called once by the preflight check.
 * Returns true if migration was performed.
 */
export async function migrateLegacyConfig(config: FixdConfig): Promise<boolean> {
  // Only migrate if no endpoints exist yet AND legacy keys are present
  if (config.endpoints.length > 0) return false;

  const migrated: Endpoint[] = [];

  // Groq → OpenAI-compatible endpoint
  if (process.env.GROQ_API_KEY) {
    migrated.push({
      name: "Groq (migrated)",
      baseUrl: "https://api.groq.com/openai/v1",
      compatibility: "openai",
      apiKey: process.env.GROQ_API_KEY,
      models: [process.env.SMALL_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct"],
    });
  }

  // OpenRouter → OpenAI-compatible endpoint
  if (process.env.OPENROUTER_API_KEY) {
    const model = process.env.OPENROUTER_LARGE_MODEL ?? "openai/gpt-oss-120b:free";
    migrated.push({
      name: "OpenRouter (migrated)",
      baseUrl: "https://openrouter.ai/api/v1",
      compatibility: "openai",
      apiKey: process.env.OPENROUTER_API_KEY,
      models: [model],
    });
  }

  // Clarifai → OpenAI-compatible endpoint
  if (process.env.CLARIFAI_PAT) {
    const model = process.env.CLARIFAI_LARGE_MODEL
      ?? "https://clarifai.com/openai/chat-completion/models/gpt-oss-120b-high-throughput/versions/ce70fc95cef1411898db183e409e98d8";
    migrated.push({
      name: "Clarifai (migrated)",
      baseUrl: "https://api.clarifai.com/v2/ext/openai/v1",
      compatibility: "openai",
      apiKey: process.env.CLARIFAI_PAT,
      models: [model],
    });
  }

  if (migrated.length === 0) return false;

  config.endpoints = migrated;

  // Route tasks to migrated endpoints
  const groqEndpoint = migrated.find((e) => e.name.startsWith("Groq"));
  const openRouterEndpoint = migrated.find((e) => e.name.startsWith("OpenRouter"));

  if (groqEndpoint) {
    const smallModel = groqEndpoint.models[0];
    config.routing.classify = { endpoint: groqEndpoint.name, model: smallModel };
    config.routing.explain  = { endpoint: groqEndpoint.name, model: smallModel };
    config.routing.chat     = { endpoint: groqEndpoint.name, model: smallModel };
  }

  if (openRouterEndpoint) {
    const largeModel = openRouterEndpoint.models[0];
    config.routing.generate = { endpoint: openRouterEndpoint.name, model: largeModel };
    config.routing.diagnose = { endpoint: openRouterEndpoint.name, model: largeModel };
    // Chat also uses large model for follow-up turns — prefer OpenRouter if available
    config.routing.chat = { endpoint: openRouterEndpoint.name, model: largeModel };
  } else if (groqEndpoint) {
    // Fallback: use Groq for everything if no OpenRouter
    const smallModel = groqEndpoint.models[0];
    config.routing.generate = { endpoint: groqEndpoint.name, model: smallModel };
    config.routing.diagnose = { endpoint: groqEndpoint.name, model: smallModel };
  }

  await saveConfig(config);
  return true;
}
