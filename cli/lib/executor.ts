/**
 * executor.ts — Human-in-the-loop command execution
 *
 * Parses agent responses for shell commands the agent INTENDS to run
 * (not retrospective mentions), prompts the user, executes approved commands,
 * and returns structured output for the agent's next turn.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execAsync = promisify(exec);

// ─── Known ElizaOS action tokens (not shell commands) ────────────────────────

const ELIZA_ACTIONS = new Set([
    "REPLY", "IGNORE", "NONE", "WAIT",
    "FOLLOW_ROOM", "UNFOLLOW_ROOM", "MUTE_ROOM", "UNMUTE_ROOM",
    "SEND_MESSAGE", "CALL_MCP_TOOL",
    "SCAN_PROJECT", "KILL_PORT", "DIAGNOSE_PROJECT", "FIX_ISSUES",
    "FIND_TYPE_SCRIPT_ISSUES", "REPORT_ISSUES", "GENERATE_ISSUE_REPORT",
    "FIX_PRISMA_POOLED_WITHOUT", "FIX_PRISMA_POOLED_WITHOUT_DIRECT_URL",
]);

// ─── PATH resolution for local node_modules tools ────────────────────────────
//
// Many tools (tsc, eslint, jest, prisma, etc.) are installed locally but not
// in the global PATH. We prefer ./node_modules/.bin/, then npx.

const LOCAL_BIN_ALIASES: Record<string, string[]> = {
    "tsc":     ["./node_modules/.bin/tsc",    "npx tsc"],
    "eslint":  ["./node_modules/.bin/eslint",  "npx eslint"],
    "jest":    ["./node_modules/.bin/jest",    "npx jest"],
    "prisma":  ["./node_modules/.bin/prisma",  "npx prisma"],
    "next":    ["./node_modules/.bin/next",    "npx next"],
    "vite":    ["./node_modules/.bin/vite",    "npx vite"],
    "ts-node": ["./node_modules/.bin/ts-node", "npx ts-node"],
};

export function resolveCommand(rawCommand: string, cwd: string): string {
    const parts = rawCommand.trim().split(/\s+/);
    const bin = parts[0];
    const args = parts.slice(1).join(" ");

    const aliases = LOCAL_BIN_ALIASES[bin];
    if (!aliases) return rawCommand;

    // Prefer local node_modules/.bin if it exists
    const localBin = path.join(cwd, "node_modules", ".bin", bin);
    if (fs.existsSync(localBin)) {
        return args ? `${localBin} ${args}` : localBin;
    }

    // Fall back to npx
    return `npx ${rawCommand}`;
}

// ─── Command extraction ───────────────────────────────────────────────────────
//
// IMPORTANT: Only match INTENT to run (future / imperative tense).
// Do NOT match retrospective mentions ("running X succeeded", "consider X").
//
// Priority:
//   1. ```bash / ```sh fenced code blocks  (strongest signal)
//   2. <actions> tag non-ElizaOS values that look like shell commands
//   3. Future-tense inline backtick patterns ("I will run `x`", "let me run `x`")

export interface PendingCommand {
    command: string;
    reason?: string;
}

// Only imperative / future-intent phrases — NOT "running X succeeded" past tense
const INTENT_PATTERNS = [
    /\bI(?:'ll| will| am going to) (?:run|execute)\s+`([^`]+)`/gi,
    /\blet me (?:run|execute)\s+`([^`]+)`/gi,
    /\bgoing to (?:run|execute)\s+`([^`]+)`/gi,
    /\bwill (?:execute|run) the (?:command|following).*?`([^`]+)`/gi,
    /\bexecuting\s+`([^`]+)`\s+(?:now|to\b)/gi,
];

const LOOKS_LIKE_SHELL = /^[a-z$.\/][a-z0-9._\-/]*(?:\s+.+)?$/i;

// Known CLI tools whose bare names also count as commands
const KNOWN_BINS = new Set([
    "bun", "npm", "npx", "yarn", "pnpm", "node",
    "pip", "pip3", "python", "python3", "uv",
    "cargo", "rustc",
    "go",
    "ruby", "gem", "bundle", "rails",
    "php", "composer",
    "gradle", "mvn",
    "make", "cmake",
    "git", "gh",
    "docker", "docker-compose", "kubectl", "helm",
    "terraform", "pulumi",
    "brew", "apt", "apt-get", "yum", "dnf",
    "tsc", "eslint", "jest", "vitest", "mocha",
    "prisma", "drizzle-kit",
    "next", "vite", "turbo", "nx",
    "mypy", "flake8", "pylint", "pytest",
    "rubocop", "rspec",
    "phpstan", "phpcs",
]);

function looksLikeCommand(text: string): boolean {
    if (!text || text.length > 200) return false;
    const first = text.split(/\s+/)[0].replace(/^\.?\/?/, "");
    return KNOWN_BINS.has(first) || LOOKS_LIKE_SHELL.test(text);
}

export function extractPendingCommands(
    agentText: string,
    alreadyRan: Set<string> = new Set()
): PendingCommand[] {
    const seen = new Set<string>(alreadyRan);
    const commands: PendingCommand[] = [];

    function add(raw: string, reason: string) {
        const clean = raw.replace(/^\$\s*/, "").trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        commands.push({ command: clean, reason });
    }

    // 1. Fenced code blocks — ```bash / ```sh / unlabelled
    const fenceRe = /```(?:bash|sh|shell|zsh|terminal|console)?\n([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(agentText)) !== null) {
        for (const line of m[1].split("\n")) {
            const clean = line.replace(/^\$\s*/, "").trim();
            if (clean && !clean.startsWith("#") && !clean.startsWith("//") && looksLikeCommand(clean)) {
                add(clean, "from code block");
            }
        }
    }

    // 2. <actions> tag — filter out ElizaOS action names
    const actionsMatch = agentText.match(/<actions>([\s\S]*?)<\/actions>/i);
    if (actionsMatch) {
        for (const tok of actionsMatch[1].split(",")) {
            const t = tok.trim();
            if (!ELIZA_ACTIONS.has(t) && t.includes(" ") && looksLikeCommand(t)) {
                add(t, "from agent actions");
            }
        }
    }

    // 3. Future-intent inline patterns only
    for (const re of INTENT_PATTERNS) {
        re.lastIndex = 0;
        while ((m = re.exec(agentText)) !== null) {
            add(m[1].trim(), "agent intends to run this");
        }
    }

    // 4. Agent's entire <text> content is a command (no code fence, plain response)
    //    e.g. agent just output "bun i --silent" with nothing else.
    //    Only match if the first token is a KNOWN_BINS entry or the line starts with
    //    a shell-path prefix ($, ./, /) — never treat plain English sentences as commands.
    const textMatch = agentText.match(/<text>([\s\S]*?)<\/text>/i);
    const rawText = textMatch ? textMatch[1].trim() : agentText.replace(/<[^>]+>/g, "").trim();
    const singleLines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

    if (singleLines.length === 1) {
        const line = singleLines[0];
        const firstToken = line.split(/\s+/)[0].replace(/^\.?\/?/, "");
        const isKnownBin = KNOWN_BINS.has(firstToken);
        const hasShellPrefix = /^(\$\s|\.\/|\/[a-z])/.test(line);
        if ((isKnownBin || hasShellPrefix) && looksLikeCommand(line)) {
            add(line, "agent suggested this command");
        }
    }

    return commands;
}

// ─── Execute ──────────────────────────────────────────────────────────────────

export interface CommandResult {
    command: string;
    resolvedCommand: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
}

export async function runCommand(command: string, cwd: string): Promise<CommandResult> {
    const resolved = resolveCommand(command, cwd);
    const start = Date.now();
    try {
        const { stdout, stderr } = await execAsync(resolved, {
            cwd,
            timeout: 60_000,
            maxBuffer: 5 * 1024 * 1024,
        });
        return { command, resolvedCommand: resolved, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, durationMs: Date.now() - start };
    } catch (err: any) {
        return {
            command,
            resolvedCommand: resolved,
            stdout: (err.stdout ?? "").trim(),
            stderr: (err.stderr ?? err.message ?? "").trim(),
            exitCode: typeof err.code === "number" ? err.code : 1,
            durationMs: Date.now() - start,
        };
    }
}

// ─── Format result for agent ──────────────────────────────────────────────────

export function formatResultForAgent(result: CommandResult): string {
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();

    const lines = [
        `Command \`${result.command}\` ran (as \`${result.resolvedCommand}\`), exit code ${result.exitCode}, took ${result.durationMs}ms.`,
        "",
    ];

    if (stdout) {
        lines.push("STDOUT:", "```", stdout, "```", "");
    } else {
        lines.push("STDOUT: (no output)", "");
    }

    if (stderr) {
        lines.push("STDERR:", "```", stderr, "```", "");
    }

    if (result.exitCode === 0 && !stdout && !stderr) {
        lines.push(
            "The command produced NO output and exited cleanly — this means no errors were found.",
            "Do NOT suggest running the same command again.",
            "Report this result to the user in one sentence and STOP."
        );
    } else if (result.exitCode === 0) {
        lines.push("Command succeeded. Report any notable findings from the output above in max 2 sentences, then STOP.");
    } else {
        lines.push("Command failed. Diagnose the error above and suggest the fix.");
    }

    return lines.join("\n");
}
