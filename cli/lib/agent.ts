// ─── fixd agent context manager ──────────────────────────────────────────────
// Wraps llm.ts with session history management and character-derived system prompt.
// Drop-in replacement for the old Socket.IO client.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chat, ask, type Message, type Task } from "./llm.js";

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

        // Append patch marker instructions
        parts.push(PATCH_INSTRUCTIONS);

        return parts.join("\n");
    } catch {
        // Fallback if character file not found
        return "You are fixd, a terminal-native dev environment agent. Be terse and technical." + PATCH_INSTRUCTIONS;
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
