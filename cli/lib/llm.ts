// ─── Multi-service LLM client ────────────────────────────────────────────────
// Large model calls:
//   1. OpenRouter  → openai/gpt-oss-120b:free   (primary)
//   2. Clarifai    → gpt-oss-120b high-throughput (fallback on any OpenRouter error)
//
// Small model calls always go to Groq.
//
// Required env vars:
//   GROQ_API_KEY          — small model (always required)
//   OPENROUTER_API_KEY    — large model primary
//   CLARIFAI_PAT          — large model fallback
//   CLARIFAI_LARGE_MODEL  — optional, override the default Clarifai model URL

import { spin, warn } from "./display.js";

// ─── Base URLs ────────────────────────────────────────────────────────────────

const GROQ_BASE_URL       = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CLARIFAI_BASE_URL   = "https://api.clarifai.com/v2/ext/openai/v1";

// ─── Model identifiers ────────────────────────────────────────────────────────

// Small model — always served by Groq
const SMALL_MODEL = process.env.SMALL_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";

// Large model — OpenRouter (primary)
const OPENROUTER_LARGE_MODEL = process.env.OPENROUTER_LARGE_MODEL ?? "openai/gpt-oss-120b:free";

// Large model — Clarifai (fallback)
const CLARIFAI_DEFAULT_LARGE_MODEL =
    "https://clarifai.com/openai/chat-completion/models/gpt-oss-120b-high-throughput/versions/ce70fc95cef1411898db183e409e98d8";
const CLARIFAI_LARGE_MODEL =
    process.env.CLARIFAI_LARGE_MODEL ?? CLARIFAI_DEFAULT_LARGE_MODEL;

// Exported alias — refers to the primary large model
const LARGE_MODEL      = OPENROUTER_LARGE_MODEL;
const GROQ_LARGE_MODEL = OPENROUTER_LARGE_MODEL; // kept for backward-compat exports

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Task = "classify" | "explain" | "generate" | "diagnose" | "chat";

export interface Message {
    role: "user" | "assistant" | "system";
    content: string;
}

// ─── Model routing ────────────────────────────────────────────────────────────

const CODE_INTENT_RE =
    /\b(generat|scaffold|creat|write|build|implement|code|file|class|function|component)\b/i;

const ANALYSIS_INTENT_RE =
    /\b(analys|analyze|summary|overview|explain|review|understand|what|how|why|fix|debug|issue|error|problem)\b/i;

function pickModel(task: Task, prompt?: string): "small" | "large" {
    switch (task) {
        case "generate":
        case "diagnose":
            return "large";
        case "classify":
        case "explain":
            return "small";
        case "chat":
            if (!prompt) return "small";
            if (prompt.includes("--- PROJECT FILES")) return "large";
            if (CODE_INTENT_RE.test(prompt) || ANALYSIS_INTENT_RE.test(prompt)) return "large";
            return "small";
    }
}

// ─── API key helpers ──────────────────────────────────────────────────────────

function getGroqKey(): string {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("GROQ_API_KEY is not set. Add it to your .env file.");
    return key;
}

function getOpenRouterKey(): string {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set. Add it to your .env file.");
    return key;
}

function getClarifaiKey(): string {
    const key = process.env.CLARIFAI_PAT;
    if (!key)
        throw new Error(
            "CLARIFAI_PAT is not set. Add it to your .env file (used as OpenRouter fallback)."
        );
    return key;
}

// ─── Payload / error types ────────────────────────────────────────────────────

interface ChatPayload {
    model: string;
    messages: Message[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
}

interface LLMError {
    error: { message: string; type: string; code: string };
}

// ─── Groq fetch (small model, with retry + rate-limit handling) ───────────────

async function groqFetch(payload: ChatPayload, retries = 3): Promise<Response> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${getGroqKey()}`,
            },
            body: JSON.stringify(payload),
        });

        if (res.ok) return res;

        if (res.status === 429) {
            const retryAfter = res.headers.get("retry-after");
            const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : attempt * 15;
            if (attempt < retries) {
                const s = spin(`rate limited — waiting ${waitSeconds}s (attempt ${attempt}/${retries})...`);
                await sleep(waitSeconds * 1000);
                s.stop();
                continue;
            }
            throw new Error(
                `Groq rate limit exceeded. Wait ${waitSeconds}s and retry.\n` +
                `Tip: reduce usage or upgrade at console.groq.com`
            );
        }

        if (res.status === 401) throw new Error("Invalid GROQ_API_KEY. Check your .env file.");

        if (res.status === 503 || res.status === 502) {
            if (attempt < retries) {
                const wait = attempt * 5;
                const s = spin(`Groq unavailable — retrying in ${wait}s...`);
                await sleep(wait * 1000);
                s.stop();
                continue;
            }
            throw new Error("Groq API is currently unavailable. Try again in a moment.");
        }

        const errBody = (await res.json().catch(() => null)) as LLMError | null;
        throw new Error(errBody?.error?.message ?? `Groq API error ${res.status}`);
    }

    throw new Error("Groq request failed after all retries.");
}

// ─── OpenRouter fetch (large model primary) ───────────────────────────────────

async function openRouterFetch(payload: ChatPayload, retries = 3): Promise<Response> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${getOpenRouterKey()}`,
                "HTTP-Referer": "https://github.com/anujs101/fixd",
                "X-Title": "fixd",
            },
            body: JSON.stringify(payload),
        });

        if (res.ok) return res;

        if (res.status === 429) {
            const waitSeconds = attempt * 15;
            if (attempt < retries) {
                const s = spin(`OpenRouter rate limited — waiting ${waitSeconds}s (attempt ${attempt}/${retries})...`);
                await sleep(waitSeconds * 1000);
                s.stop();
                continue;
            }
            throw new Error(`OpenRouter rate limit exceeded. Wait ${waitSeconds}s and retry.`);
        }

        if (res.status === 401 || res.status === 403) {
            throw new Error("Invalid OPENROUTER_API_KEY. Check your .env file.");
        }

        if (res.status === 503 || res.status === 502) {
            if (attempt < retries) {
                const wait = attempt * 5;
                const s = spin(`OpenRouter unavailable — retrying in ${wait}s...`);
                await sleep(wait * 1000);
                s.stop();
                continue;
            }
            throw new Error("OpenRouter API is currently unavailable.");
        }

        const errBody = (await res.json().catch(() => null)) as LLMError | null;
        throw new Error(errBody?.error?.message ?? `OpenRouter API error ${res.status}`);
    }

    throw new Error("OpenRouter request failed after all retries.");
}

// ─── Clarifai fetch (large model fallback) ────────────────────────────────────

async function clarifaiFetch(payload: ChatPayload, retries = 3): Promise<Response> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const res = await fetch(`${CLARIFAI_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${getClarifaiKey()}`,
            },
            body: JSON.stringify(payload),
        });

        if (res.ok) return res;

        if (res.status === 429) {
            const waitSeconds = attempt * 15;
            if (attempt < retries) {
                const s = spin(`Clarifai rate limited — waiting ${waitSeconds}s (attempt ${attempt}/${retries})...`);
                await sleep(waitSeconds * 1000);
                s.stop();
                continue;
            }
            throw new Error(`Clarifai rate limit exceeded. Wait ${waitSeconds}s and retry.`);
        }

        if (res.status === 401 || res.status === 403) {
            throw new Error("Invalid CLARIFAI_PAT. Check your .env file.");
        }

        if (res.status === 503 || res.status === 502) {
            if (attempt < retries) {
                const wait = attempt * 5;
                const s = spin(`Clarifai unavailable — retrying in ${wait}s...`);
                await sleep(wait * 1000);
                s.stop();
                continue;
            }
            throw new Error("Clarifai API is currently unavailable. Try again in a moment.");
        }

        const errBody = (await res.json().catch(() => null)) as LLMError | null;
        throw new Error(errBody?.error?.message ?? `Clarifai API error ${res.status}`);
    }

    throw new Error("Clarifai request failed after all retries.");
}

// ─── Unified fetch dispatcher ─────────────────────────────────────────────────
// Small model → Groq
// Large model → OpenRouter (primary) → Clarifai (fallback on any error)

async function llmFetch(
    modelSize: "small" | "large",
    messages: Message[],
    stream: boolean
): Promise<Response> {
    if (modelSize === "small") {
        return groqFetch({ model: SMALL_MODEL, messages, stream });
    }

    // Large model: OpenRouter first, Clarifai on any failure
    try {
        return await openRouterFetch({ model: OPENROUTER_LARGE_MODEL, messages, stream });
    } catch (err: any) {
        warn(`OpenRouter failed (${err.message}) — falling back to Clarifai`);
        return clarifaiFetch({ model: CLARIFAI_LARGE_MODEL, messages, stream });
    }
}

// ─── Fallback for large model on heavy tasks ──────────────────────────────────
// If both OpenRouter and Clarifai fail, fall back to the small model on Groq.

async function llmFetchWithFallback(
    messages: Message[],
    stream: boolean
): Promise<Response> {
    try {
        return await llmFetch("large", messages, stream);
    } catch (err: any) {
        warn(`All large-model services failed — falling back to ${SMALL_MODEL}`);
        return groqFetch({ model: SMALL_MODEL, messages, stream });
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Strip <think>...</think> blocks emitted by extended-thinking models */
function stripThink(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
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

    const modelSize = pickModel(task, prompt);

    let res: Response;
    if (modelSize === "large") {
        res = await llmFetchWithFallback(messages, false);
    } else {
        res = await llmFetch("small", messages, false);
    }

    const data = (await res.json()) as any;
    return stripThink(data.choices?.[0]?.message?.content ?? "");
}

/**
 * Streaming variant — yields text chunks as they arrive.
 * Best for generate tasks where real-time display matters.
 */
export async function* askStream(
    prompt: string,
    task: Task,
    systemPrompt?: string
): AsyncGenerator<string> {
    const messages: Message[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const modelSize = pickModel(task, prompt);
    const res = await llmFetch(modelSize, messages, true);

    if (!res.body) throw new Error("No response body for streaming request");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
                if (chunk) yield chunk;
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
    const modelSize = pickModel(task, lastUserContent);

    let res: Response;
    if (modelSize === "large") {
        res = await llmFetchWithFallback(messages, false);
    } else {
        res = await llmFetch("small", messages, false);
    }

    const data = (await res.json()) as any;
    return stripThink(data.choices?.[0]?.message?.content ?? "");
}

// ─── Exports for model info ───────────────────────────────────────────────────

export { SMALL_MODEL, LARGE_MODEL, GROQ_LARGE_MODEL, CLARIFAI_LARGE_MODEL };
export type { LLMService };

// Dummy type kept for backward compat (no longer used for routing)
type LLMService = "openrouter" | "clarifai" | "groq";
