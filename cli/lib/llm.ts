// ─── Groq LLM client ─────────────────────────────────────────────────────────
// Talks directly to Groq's OpenAI-compatible API.
// No background server needed — just a GROQ_API_KEY in .env

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// Two models — routed by task type
const SMALL_MODEL =
    process.env.SMALL_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";
const LARGE_MODEL = process.env.LARGE_MODEL ?? "qwen/qwen3-32b";

export type Task = "classify" | "explain" | "generate" | "diagnose" | "chat";

export interface Message {
    role: "user" | "assistant" | "system";
    content: string;
}

// ─── Model routing ────────────────────────────────────────────────────────────

const CODE_INTENT_RE =
    /\b(generat|scaffold|creat|write|build|implement|code|file|class|function|component)\b/i;

function pickModel(task: Task, prompt?: string): string {
    switch (task) {
        case "generate":
        case "diagnose":
            return LARGE_MODEL;
        case "classify":
        case "explain":
            return SMALL_MODEL;
        case "chat":
            // Upgrade to large if message looks like code generation
            if (prompt && CODE_INTENT_RE.test(prompt)) return LARGE_MODEL;
            return SMALL_MODEL;
    }
}

// ─── Raw fetch helper ─────────────────────────────────────────────────────────

function getApiKey(): string {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("GROQ_API_KEY is not set. Add it to your .env file.");
    return key;
}

interface GroqChatPayload {
    model: string;
    messages: Message[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
}

async function groqFetch(payload: GroqChatPayload, attempt = 0): Promise<Response> {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getApiKey()}`,
        },
        body: JSON.stringify(payload),
    });

    // Retry once on rate-limit
    if (res.status === 429 && attempt === 0) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "2", 10);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        return groqFetch(payload, 1);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Groq API error ${res.status}: ${body}`);
    }

    return res;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Strip <think>...</think> blocks emitted by Qwen3 extended-thinking mode */
function stripThink(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Single-turn completion. Returns the full response text.
 * Uses streaming internally for generate/diagnose to avoid timeout.
 */
export async function ask(
    prompt: string,
    task: Task,
    systemPrompt?: string
): Promise<string> {
    const messages: Message[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const model = pickModel(task, prompt);

    const res = await groqFetch({ model, messages, stream: false });
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

    const model = pickModel(task, prompt);

    const res = await groqFetch({ model, messages, stream: true });

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
    const model = pickModel(
        task,
        messages.filter((m) => m.role === "user").at(-1)?.content
    );

    const res = await groqFetch({ model, messages, stream: false });
    const data = (await res.json()) as any;
    return stripThink(data.choices?.[0]?.message?.content ?? "");
}

// ─── Exports for model info ───────────────────────────────────────────────────

export { SMALL_MODEL, LARGE_MODEL };
