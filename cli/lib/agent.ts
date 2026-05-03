// ─── fixd agent context manager ──────────────────────────────────────────────
// Wraps llm.ts with session history management and character-derived system prompt.
// Drop-in replacement for the old Socket.IO client.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chat, ask, type Message, type Task } from "./llm.js";

// ─── System prompt — built from characters/agent.character.json ───────────────

function loadSystemPrompt(): string {
    try {
        // Resolve relative to this file's location: cli/lib/ → ../../characters/
        const here = path.dirname(fileURLToPath(import.meta.url));
        const characterPath = path.resolve(here, "../../characters/agent.character.json");
        const raw = readFileSync(characterPath, "utf-8");
        const char = JSON.parse(raw);

        const parts: string[] = [];

        if (char.system) {
            parts.push(char.system);
        }

        if (Array.isArray(char.bio) && char.bio.length > 0) {
            parts.push("\n" + char.bio.join(" "));
        }

        const styleRules: string[] = [
            ...(char.style?.all ?? []),
            ...(char.style?.chat ?? []),
        ];
        if (styleRules.length > 0) {
            parts.push("\nSTYLE RULES:\n" + styleRules.map((r: string) => `- ${r}`).join("\n"));
        }

        return parts.join("\n");
    } catch {
        // Fallback if character file not found
        return "You are fixd, a terminal-native dev environment agent. Be terse and technical.";
    }
}

// ─── Session state ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = loadSystemPrompt();
const MAX_HISTORY = 20; // sliding window (user + assistant messages, not counting system)

let history: Message[] = [];

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

    // Build full message array: system + history (capped at MAX_HISTORY)
    const trimmed = history.slice(-MAX_HISTORY);
    const messages: Message[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...trimmed,
    ];

    const reply = await chat(messages, task);

    history.push({ role: "assistant", content: reply });

    return [{ text: reply, actions: [] }];
}

// ─── resetSession — clear history (keep system prompt) ───────────────────────

export function resetSession(): void {
    history = [];
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

// ─── disconnect — no-op, kept for API compatibility ──────────────────────────
// Old client.ts exported disconnect() — callers still import it.

export function disconnect(): void {
    // Nothing to disconnect — Groq uses stateless HTTP
}
