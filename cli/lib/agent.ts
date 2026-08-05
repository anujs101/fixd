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

PATCH FORMAT — use these exact markers:

<<<EDIT: relative/path/to/file.ts>>>   ← DEFAULT: use for every single change
<<<SEARCH>>>
exact existing lines (copy verbatim from the file)
<<<REPLACE>>>
new lines to replace them with
<<<END>>>

<<<WRITE: relative/path/to/file.ts>>>  ← ONLY for files that genuinely do not exist
full file content
<<<END>>>

<<<DELETE: relative/path/to/file.ts>>>
<<<RENAME: old/path.ts -> new/path.ts>>>

CRITICAL RULES:
- EDIT is the default. Always prefer EDIT over WRITE.
- Use WRITE only when the file does not exist on disk. Never WRITE over an existing file.
- Make the SMALLEST possible change that resolves the issue.
- For a single-line compiler error, the SEARCH should be 1-3 lines, not the entire file.
- Never rewrite an entire file to fix a one-line syntax error.
- Copy SEARCH lines EXACTLY from the file — character-for-character including whitespace.
- Preserve all existing code that was not flagged by checkers.
- Never add new features, routes, middleware, models, or architecture.
- Paths are always relative to the project root.
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

    // P0 fix: retry once on transient failures (network errors, 5xx).
    // Auth errors (401/403) and other permanent errors are not retried.
    let reply: string;
    try {
        reply = await chat(messages, task);
    } catch (err: any) {
        // Don't retry auth errors — they won't resolve without config changes
        if (err.message?.includes("Invalid") || err.message?.includes("API key")) {
            history.pop(); // remove orphaned user message
            throw err;
        }
        // Transient: wait 2s and retry once
        const { warn: displayWarn } = await import("./display.js");
        displayWarn(`API call failed (${err.message}) — retrying once...`);
        try {
            reply = await chat(messages, task);
        } catch (retryErr: any) {
            history.pop(); // remove orphaned user message
            throw retryErr;
        }
    }

    history.push({ role: "assistant", content: reply });

    return [{ text: reply, actions: [] }];
}

// ─── resetSession — clear history (keep system prompt) ───────────────────────

export function resetSession(): void {
    history = [];
    _memoryCache = null; // also clear memory cache when session resets
}

// ─── primeContext — inject text into history without an LLM call ──────────────
// Used to seed the agent with e.g. the synthesis summary so it is context-aware
// from the first user message without paying for an extra LLM round-trip.

export function primeContext(text: string): void {
    if (!text?.trim()) return;
    history.push({ role: "assistant", content: text });
}

// ─── Endpoint health ─────────────────────────────────────────────────────────

import { loadConfig, getEndpoint, type Endpoint } from "./endpoints.js";

export async function checkEndpoint(endpoint: Endpoint): Promise<boolean> {
    try {
        // Simple connectivity check: try a minimal completion
        await ask("ping", "classify", "Reply with: pong");
        return true;
    } catch {
        return false;
    }
}

export async function checkAllEndpoints(): Promise<{ name: string; ok: boolean; error?: string }[]> {
    const config = await loadConfig();
    const results: { name: string; ok: boolean; error?: string }[] = [];
    for (const ep of config.endpoints) {
        try {
            const ok = await checkEndpoint(ep);
            results.push({ name: ep.name, ok, error: ok ? undefined : "unreachable" });
        } catch (err: any) {
            results.push({ name: ep.name, ok: false, error: err.message });
        }
    }
    return results;
}

// ─── disconnect — no-op, kept for API compatibility ──────────────────────────
// Old client.ts exported disconnect() — callers still import it.

export function disconnect(): void {
    // Nothing to disconnect — Groq uses stateless HTTP
}
