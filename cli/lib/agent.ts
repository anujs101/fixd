// ─── fixd agent context manager ──────────────────────────────────────────────
// Wraps llm.ts with session history management and character-derived system prompt.
// Drop-in replacement for the old Socket.IO client.ts

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chat, ask, type Message, type Task } from "./llm.js";
import { loadMemory, formatMemoryForPrompt, type ProjectMemory } from "./memory.js";

// ─── System prompt — built from characters/agent.character.json ───────────────

const PATCH_INSTRUCTIONS = `

WHEN IMPLEMENTING CODE CHANGES:
Use these exact markers — no other format will be parsed:

To create or fully rewrite a file:
<<<WRITE: relative/path/to/file.ts>>>
full file content
<<<END>>>

To make a targeted edit (preferred for small changes):
<<<EDIT: relative/path/to/file.ts>>>
<<<SEARCH>>>
exact existing lines to find (copy verbatim, including indentation)
<<<REPLACE>>>
new lines to replace them with
<<<END>>>

To delete a file:
<<<DELETE: relative/path/to/file.ts>>>

To rename a file:
<<<RENAME: old/path.ts -> new/path.ts>>>

RULES:
- Always use EDIT over WRITE when changing less than 30% of a file
- SEARCH string must match exactly — copy lines verbatim including whitespace
- Paths are always relative to the project root
- After markers, explain what you changed and why in 1-2 sentences
- Never output partial file content in WRITE blocks — always full file
`;

function loadSystemPrompt(): string {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const characterPath = path.resolve(here, "../../characters/agent.character.json");
        const raw = readFileSync(characterPath, "utf-8");
        const char = JSON.parse(raw);

        const parts: string[] = [];
        if (char.system) parts.push(char.system);
        if (Array.isArray(char.bio) && char.bio.length > 0) parts.push("\n" + char.bio.join(" "));

        const styleRules: string[] = [
            ...(char.style?.all ?? []),
            ...(char.style?.chat ?? []),
        ];
        if (styleRules.length > 0) {
            parts.push("\nSTYLE RULES:\n" + styleRules.map((r: string) => `- ${r}`).join("\n"));
        }

        parts.push(PATCH_INSTRUCTIONS);
        return parts.join("\n");
    } catch {
        return "You are fixd, a terminal-native dev environment agent. Be terse and technical." + PATCH_INSTRUCTIONS;
    }
}

/**
 * Read FIXD.md from the project root if it exists.
 * Returns a formatted block ready for prepending to the system prompt.
 */
function loadFixdMd(projectPath: string): string {
    try {
        const fixdMdPath = path.join(projectPath, "FIXD.md");
        if (!existsSync(fixdMdPath)) return "";
        const content = readFileSync(fixdMdPath, "utf-8").trim();
        if (!content) return "";
        return `[PROJECT CONTEXT — from FIXD.md]\n${content}\n[END FIXD.md]`;
    } catch {
        return "";
    }
}

// ─── Session state ───────────────────────────────────────────────────

// B3: Active project path — set by runDoctor/runInit so sendMessage reads the
// correct project's memory regardless of process.cwd().
let activeProjectPath: string | null = null;

// A4: In-session memory cache — avoids a disk read on every agenticTurn recursion.
let _memoryCache: { projectPath: string; memory: ProjectMemory } | null = null;

/** Call at the start of runDoctor/runInit to anchor memory reads to the correct project. */
export function setActiveProject(projectPath: string): void {
    activeProjectPath = projectPath;
    _memoryCache = null; // invalidate on project switch
}

let history: Message[] = [];

const SYSTEM_PROMPT = loadSystemPrompt();

// History cap: token-estimated (1 token ≈ 4 chars), not just message count
// At 60k tokens we stay well within GPT-4-class context windows.
const MAX_HISTORY_CHARS = 60_000 * 4; // 60k tokens × 4 chars/token

/** Trim history from the oldest end to stay within the token budget. */
function trimHistoryByTokens(msgs: Message[]): Message[] {
    let total = 0;
    const result: Message[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        const len = msgs[i].content.length;
        if (total + len > MAX_HISTORY_CHARS) break;
        result.unshift(msgs[i]);
        total += len;
    }
    return result;
}


// ─── AgentResponse — same interface as the old client.ts ─────────────────────

export interface AgentResponse {
    text: string;
    actions?: string[];
}

// ─── sendMessage — drop-in for old sendMessage() ─────────────────────────────
//
// Takes an optional task type (defaults to "chat").
// Maintains conversation history across calls within the same session.

export async function sendMessage(
    text: string,
    task: Task = "chat"
): Promise<AgentResponse[]> {
    history.push({ role: "user", content: text });

    // B3/A4: use the correct project path (set by setActiveProject) and cache the memory
    const projPath = activeProjectPath ?? process.cwd();
    let memory: ProjectMemory;
    if (_memoryCache?.projectPath === projPath) {
        memory = _memoryCache.memory;
    } else {
        memory = await loadMemory(projPath);
        _memoryCache = { projectPath: projPath, memory };
    }
    const memoryContext = formatMemoryForPrompt(memory);

    // Prepend FIXD.md context if it exists in the active project
    // This gives the agent stack awareness from the first message with no extra LLM call
    const fixdMdContext = loadFixdMd(projPath);

    // Upgrade 5: static hypothesis rule — always injected so the agent knows
    // not to repeat a fix that was already marked NO CHANGE or REGRESSION.
    const HYPOTHESIS_RULE =
        "\nAGENT RULE: If a previously attempted fix appears in the session hypotheses " +
        "marked NO CHANGE or REGRESSION, do not attempt the same fix again. Form a new hypothesis.\n";

    const fullSystemPrompt = [fixdMdContext, memoryContext, SYSTEM_PROMPT + HYPOTHESIS_RULE]
        .filter(Boolean).join("\n\n");

    // Build full message array: system + history (capped by token budget)
    const trimmed = trimHistoryByTokens(history);
    const messages: Message[] = [
        { role: "system", content: fullSystemPrompt },
        ...trimmed,
    ];

    const reply = await chat(messages, task);

    history.push({ role: "assistant", content: reply });

    return [{ text: reply, actions: [] }];
}

// ─── resetSession — clear history (keep system prompt) ───────────────────────

export function resetSession(): void {
    history = [];
    _memoryCache = null; // also clear memory cache when session resets
}

// ─── checkHealth — verify GROQ_API_KEY + reachability ────────────────────────

export async function checkHealth(): Promise<boolean> {
    const key = process.env.GROQ_API_KEY;
    if (!key) return false;

    try {
        await ask("ping", "classify", "Reply with: pong");
        return true;
    } catch {
        return false;
    }
}

// ─── checkOpenRouterHealth — verify OPENROUTER_API_KEY reachability ───────────

export async function checkOpenRouterHealth(): Promise<"ok" | "no_key" | "unreachable"> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return "no_key";
    try {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(8_000),
        });
        return res.ok ? "ok" : "unreachable";
    } catch {
        return "unreachable";
    }
}

// ─── disconnect — no-op, kept for API compatibility ──────────────────────────
// Old client.ts exported disconnect() — callers still import it.

export function disconnect(): void {
    // Nothing to disconnect — Groq uses stateless HTTP
}
