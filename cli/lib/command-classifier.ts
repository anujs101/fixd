/**
 * command-classifier.ts — Fast command safety classifier
 *
 * Classifies proposed shell commands as:
 *   auto-run  — safe to execute silently without user prompt
 *   confirm   — should be shown to user for approval first
 *
 * Three-stage pipeline (fastest → slowest):
 *   1. ALWAYS_SAFE hardcoded fast path — no LLM call needed
 *   2. ALWAYS_CONFIRM hardcoded fast path — no LLM call needed
 *   3. LLM classifier for ambiguous commands
 *
 * Nothing is silently blocked. Worst case: confirm.
 *
 * Controlled by:
 *   FIXD_AUTO_RUN_LEVEL  conservative | moderate (default) | aggressive
 *   FIXD_EXPLORE_MODEL   small (default) | large  — model used for LLM classification
 */

import { ask } from "./llm.js";

// ─── Auto-run level ───────────────────────────────────────────────────────────

export type AutoRunLevel = "conservative" | "moderate" | "aggressive";
export type Classification = "auto-run" | "confirm";

function getAutoRunLevel(): AutoRunLevel {
    const val = process.env.FIXD_AUTO_RUN_LEVEL ?? "moderate";
    if (val === "conservative" || val === "moderate" || val === "aggressive") return val;
    return "moderate";
}

// ─── Hardcoded safe sets by level ─────────────────────────────────────────────
//
// Conservative: read-only commands that cannot modify state
// Moderate:     + common install / test / generate commands
// Aggressive:   + git commit/push, prisma migrate, docker

// Prefix = the first 1–3 tokens of the command
const CONSERVATIVE_PREFIXES = new Set([
    "ls", "ll", "la", "cat", "head", "tail", "echo", "pwd",
    "which", "whereis", "type", "file", "wc", "stat",
    "find",                    // find is read-only
    "grep", "rg", "ag",        // search tools
    "git status", "git log", "git diff", "git branch", "git remote", "git show",
    "git stash list", "git tag",
    "tsc --noEmit", "tsc --version",
    "node --version", "bun --version", "npm --version", "pnpm --version",
    "python --version", "python3 --version", "go version", "cargo --version",
    "curl --version", "wget --version",
    "env", "printenv", "export -p",
    "lsof", "ps", "ps aux", "top -b", "df", "du",
    "netstat", "ss",
    "ping",
    "open",            // mac: just opens a file/URL
    "xdg-open",
]);

const MODERATE_PREFIXES = new Set([
    ...CONSERVATIVE_PREFIXES,
    // Package installs
    "bun install", "bun add", "bun i",
    "npm install", "npm i", "npm ci",
    "pnpm install", "pnpm add",
    "yarn install", "yarn add",
    "pip install", "pip3 install",
    "cargo install", "go get", "go mod tidy",
    // Test runners
    "bun test", "npm test", "npm run test",
    "jest", "vitest", "mocha", "pytest",
    "go test", "cargo test",
    // Type checking / linting
    "tsc", "eslint", "mypy", "flake8", "pylint",
    // Code generation (non-destructive)
    "prisma generate", "drizzle-kit generate",
    // Build (read-like — generates dist, doesn't touch src)
    "bun build", "npm run build", "tsc --build",
    // Info commands
    "curl",           // curl for API testing — specific piped variants still go to confirm
    "wget",
    "bun run", "npm run",    // any script from package.json
]);

const AGGRESSIVE_PREFIXES = new Set([
    ...MODERATE_PREFIXES,
    // Git write operations
    "git add", "git commit", "git push", "git pull", "git fetch",
    "git merge", "git rebase", "git cherry-pick",
    // DB migrations
    "prisma migrate deploy", "prisma db push", "drizzle-kit push",
    // Docker
    "docker build", "docker run", "docker compose up",
    // Package removal
    "bun remove", "npm uninstall", "pnpm remove",
]);

// ─── Always-confirm patterns ──────────────────────────────────────────────────
//
// Regardless of auto-run level, these always go to confirm.
// Not a block — the user sees the command and decides.
//
// Matches command injection idioms: piped-to-shell, base64 exec, rm -rf,
// force git ops, db resets, kill, etc.

const ALWAYS_CONFIRM_RES = [
    // Piped shell execution — the classic injection vector
    /\|\s*(sh|bash|zsh|fish|dash)\b/,
    /\|\s*sudo\b/,
    // Base64 / encoded exec
    /base64\s+-d/,
    /eval\s*\(/,
    /\$\(.*\)/,           // subshell substitution in the command itself
    // Destructive file ops
    /\brm\b/,
    /\brmdir\b/,
    /\btruncate\b/,
    /\bshred\b/,
    // Force git
    /git\s+(push|reset|rebase|clean)\s+.*-f/,
    /git\s+reset\s+--hard/,
    /git\s+clean\s+/,
    // DB destructive
    /prisma\s+migrate\s+reset/,
    /prisma\s+migrate\s+dev/,    // dev migration = potentially destructive
    /drop\s+(?:table|database|schema)/i,
    // Process management
    /\bkill\b/,
    /\bkillall\b/,
    /\bpkill\b/,
    /\bfuser\b/,
    // chmod / chown
    /\bchmod\b/,
    /\bchown\b/,
    // Sudo (anything with sudo gets confirm)
    /\bsudo\b/,
    // Port ops
    /kill.*port|lsof.*-i.*-t/,
];

function matchesPrefixSet(command: string, prefixes: Set<string>): boolean {
    const lower = command.toLowerCase().trim();
    for (const prefix of prefixes) {
        if (lower === prefix || lower.startsWith(prefix + " ") || lower.startsWith(prefix + "\t")) {
            return true;
        }
    }
    return false;
}

function alwaysConfirm(command: string): boolean {
    return ALWAYS_CONFIRM_RES.some((re) => re.test(command));
}

// ─── LLM classifier prompt ────────────────────────────────────────────────────
//
// Adapted from agent-prompt-bash-command-prefix-detection.md
// Only called for ambiguous commands that don't match the fast paths.

const CLASSIFIER_SYSTEM_PROMPT = `You are a command safety classifier for a developer CLI tool called fixd.
Your job: classify a shell command as either "auto-run" or "confirm".

auto-run: Safe dev-tool commands that any developer would run without hesitation.
  - Reading files, querying status, running tests, installing packages, generating code
  - Examples: ls, cat, git log, bun install, npm run dev, tsc --noEmit, curl https://api.example.com

confirm: Anything that modifies important state, affects production, or could cause data loss.
  - Deleting files/dirs, force git operations, db schema changes, killing processes, sudo commands
  - When uncertain, return "confirm" — never silently run something ambiguous

ONLY return exactly one word: "auto-run" or "confirm". No explanation. No punctuation. No quotes.`;

async function llmClassify(command: string): Promise<Classification> {
    const modelSize = (process.env.FIXD_EXPLORE_MODEL ?? "small") === "large" ? "large" : "small";
    // We re-use the ask() API but route to small model by default (fast + cheap)
    try {
        const result = await ask(
            `Classify this shell command:\n\`${command}\``,
            modelSize === "large" ? "diagnose" : "classify",
            CLASSIFIER_SYSTEM_PROMPT
        );
        const trimmed = result.trim().toLowerCase();
        if (trimmed.includes("auto-run") || trimmed === "auto") return "auto-run";
        return "confirm";
    } catch {
        // On classifier error, fall back to confirm — never auto-run on uncertainty
        return "confirm";
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ClassificationResult {
    classification: Classification;
    reason: "always-confirm-pattern" | "safe-prefix" | "llm" | "llm-error";
}

/**
 * Classify a proposed shell command.
 * Returns `auto-run` if it can be executed silently, `confirm` if user should approve.
 * Never returns a block — everything gets at least a confirm.
 */
export async function classifyCommand(command: string): Promise<ClassificationResult> {
    const level = getAutoRunLevel();

    // Stage 1: Always-confirm fast path (no LLM needed)
    if (alwaysConfirm(command)) {
        return { classification: "confirm", reason: "always-confirm-pattern" };
    }

    // Stage 2: Hardcoded safe prefix sets by level (no LLM needed)
    const prefixSet =
        level === "conservative" ? CONSERVATIVE_PREFIXES :
        level === "aggressive"   ? AGGRESSIVE_PREFIXES :
                                   MODERATE_PREFIXES;

    if (matchesPrefixSet(command, prefixSet)) {
        return { classification: "auto-run", reason: "safe-prefix" };
    }

    // Stage 3: LLM for ambiguous commands
    try {
        const classification = await llmClassify(command);
        return { classification, reason: "llm" };
    } catch {
        return { classification: "confirm", reason: "llm-error" };
    }
}
