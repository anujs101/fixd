// ─── Endpoint-based LLM client ────────────────────────────────────────────────
// Routes every LLM call through the endpoint abstraction layer. No hardcoded
// providers. No hardcoded base URLs. Every request goes to whichever endpoint
// is configured for the task type.
//
// Required config: ~/.config/fixd/config.json (endpoints + task routing)
// Legacy env vars (GROQ_API_KEY, etc.) are auto-migrated on first run.

import { spin, warn } from "./display.js";
import { getConfig, getRouting, type TaskName } from "./endpoints.js";
import { endpointFetch, type ChatPayload } from "./adapters/dispatch.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Task = TaskName;

export interface Message {
    role: "user" | "assistant" | "system";
    content: string;
}

// ─── Model routing (task type → model size hint) ──────────────────────────────
// This is a HINT for endpoint selection. The actual endpoint+model is determined
// by the user's config.json routing table. This function is kept for backward
// compatibility with callers that use pickModel() directly.

const CODE_INTENT_RE =
    /\b(generat|scaffold|creat|write|build|implement|code|file|class|function|component)\b/i;

const ANALYSIS_INTENT_RE =
    /\b(analys|analyze|summary|overview|review|fix|debug|refactor|diagnos|issue|error|problem|implement|migrat)\b/i;

export function pickModel(task: Task, prompt?: string): "small" | "large" {
    switch (task) {
        case "generate":
        case "diagnose":
            return "large";
        case "classify":
        case "explain":
            return "small";
        case "chat":
            if (!prompt) return "small";
            if (prompt.includes("--- PROJECT FILES") || prompt.includes("--- FILE:")) return "large";
            if (prompt.includes("```")) return "large";
            if (CODE_INTENT_RE.test(prompt) || ANALYSIS_INTENT_RE.test(prompt)) return "large";
            return "small";
    }
}

// ─── Task-aware LLM parameters ──────────────────────────────────────────────────

function taskParams(task: Task): { temperature: number; max_tokens: number } {
    switch (task) {
        case "classify":
            return { temperature: 0.1, max_tokens: 512 };
        case "explain":
            return { temperature: 0.5, max_tokens: 2048 };
        case "generate":
            return { temperature: 0.7, max_tokens: 8192 };
        case "diagnose":
            return { temperature: 0.3, max_tokens: 8192 };
        case "chat":
            return { temperature: 0.7, max_tokens: 4096 };
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Fetch with retry (endpoint-agnostic) ─────────────────────────────────────
// Preserves the P0-2 retry behavior: network errors, 429, and 5xx are retried
// with backoff. Auth errors (401/403) throw immediately.

async function fetchWithRetry(
    payload: ChatPayload,
    retries = 3,
): Promise<Response> {
    // Load config and resolve the endpoint + model for this task
    // The task is embedded in a custom property on the payload (set by callers)
    const task = (payload as any).__task as Task | undefined;
    if (!task) throw new Error("Internal error: payload missing __task");

    const config = await getConfig();
    const { endpoint, model } = getRouting(config, task);

    if (!endpoint) {
        throw new Error(
            `No endpoint configured for task "${task}". Run \`fixd config\` to set up endpoints and routing.`
        );
    }

    // Override the model in the payload with the configured model
    const resolvedPayload = { ...payload, model };
    delete (resolvedPayload as any).__task;

    for (let attempt = 1; attempt <= retries; attempt++) {
        let res: Response;
        try {
            res = await endpointFetch(endpoint, resolvedPayload);
        } catch (err: any) {
            if (attempt < retries) {
                const wait = attempt * 5;
                const s = spin(`${endpoint.name} network error — retrying in ${wait}s (attempt ${attempt}/${retries})...`);
                await sleep(wait * 1000);
                s.stop();
                continue;
            }
            throw new Error(`${endpoint.name} unreachable: ${err.message}`);
        }

        if (res.ok) return res;

        if (res.status === 429) {
            const retryAfter = res.headers.get("retry-after");
            const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : attempt * 15;
            if (attempt < retries) {
                const s = spin(`${endpoint.name} rate limited — waiting ${waitSeconds}s (attempt ${attempt}/${retries})...`);
                await sleep(waitSeconds * 1000);
                s.stop();
                continue;
            }
            throw new Error(`${endpoint.name} rate limit exceeded. Wait ${waitSeconds}s and retry.`);
        }

        if (res.status === 401 || res.status === 403) {
            throw new Error(`Invalid API key for endpoint "${endpoint.name}". Check \`fixd config\`.`);
        }

        if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
            if (attempt < retries) {
                const wait = attempt * 5;
                const s = spin(`${endpoint.name} unavailable (${res.status}) — retrying in ${wait}s...`);
                await sleep(wait * 1000);
                s.stop();
                continue;
            }
            throw new Error(`${endpoint.name} is currently unavailable. Try again in a moment.`);
        }

        const errBody = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(errBody?.error?.message ?? `${endpoint.name} API error ${res.status}`);
    }

    throw new Error(`${endpoint.name} request failed after all retries.`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Strip <think>...</think> blocks emitted by extended-thinking models */
function stripThink(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "");
}

/**
 * Single-turn completion. Returns the full response text.
 */
export async function ask(
    prompt: string,
    task: Task,
    systemPrompt?: string
): Promise<string> {
    const messages: Message[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const { temperature, max_tokens } = taskParams(task);

    const res = await fetchWithRetry({
        model: "", // overridden by fetchWithRetry
        messages,
        stream: false,
        temperature,
        max_tokens,
        __task: task,
    } as ChatPayload & { __task: Task });

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
        warn("⚠ agent response was truncated (token limit hit) — output may be incomplete");
    }
    return stripThink(choice?.message?.content ?? "").trim();
}

/**
 * Streaming variant — yields text chunks as they arrive.
 */
export async function* askStream(
    prompt: string,
    task: Task,
    systemPrompt?: string
): AsyncGenerator<string> {
    const messages: Message[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const { temperature, max_tokens } = taskParams(task);

    const res = await fetchWithRetry({
        model: "",
        messages,
        stream: true,
        temperature,
        max_tokens,
        __task: task,
    } as ChatPayload & { __task: Task });

    if (!res.body) throw new Error("No response body for streaming request");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let visible = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            try {
                const json = JSON.parse(trimmed.slice(6));
                const chunk = json.choices?.[0]?.delta?.content;
                if (chunk) {
                    visible += chunk;
                    if (/<think>[\s\S]*$/i.test(visible) && !/<\/think>/i.test(visible)) continue;
                    const stripped = stripThink(visible);
                    if (stripped) yield stripped;
                    visible = "";
                }
            } catch {
                // Malformed chunk — skip
            }
        }
    }
}

/**
 * Multi-turn conversation — accepts a full message history.
 */
export async function chat(messages: Message[], task: Task): Promise<string> {
    const lastUserContent = messages.filter((m) => m.role === "user").at(-1)?.content;
    // P0-1 fix: follow-up chat turns always use the "large" equivalent endpoint
    const userTurns = messages.filter((m) => m.role === "user").length;
    // P0-1: when conversation has history, prefer the configured chat endpoint
    // (which the user should configure to a capable model)
    const effectiveTask: Task = (userTurns > 1 && task === "chat") ? "chat" : task;

    const { temperature, max_tokens } = taskParams(effectiveTask);

    const res = await fetchWithRetry({
        model: "",
        messages,
        stream: false,
        temperature,
        max_tokens,
        __task: effectiveTask,
    } as ChatPayload & { __task: Task });

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
        warn("⚠ agent response was truncated (token limit hit) — output may be incomplete");
    }
    return stripThink(choice?.message?.content ?? "").trim();
}
