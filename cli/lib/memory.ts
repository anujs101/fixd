// ─── fixd persistent memory ──────────────────────────────────────────────────
// Stores project history in .fixd/memory.json — injected into every LLM prompt.

import fs from "node:fs/promises";
import path from "node:path";
import { ask } from "./llm.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CausalEntry {
    timestamp: string;
    file: string;           // which file was changed
    issueType: string;      // e.g. "PRISMA_POOLED_WITHOUT_DIRECT_URL"
    action: string;         // what the agent did (1 sentence)
    outcome: "resolved" | "no_change" | "regression";
    followupIssues: string[]; // any new issues that appeared after
}

export interface StackPattern {
    stack: string;              // e.g. "Next.js+Prisma+PostgreSQL"
    issueType: string;          // e.g. "PRISMA_POOLED_WITHOUT_DIRECT_URL"
    fixDescription: string;     // e.g. "added DIRECT_URL to .env and directUrl to schema"
    outcome: "success" | "failure";
    confidence: number;         // 0-1, increases with repeated success
    seenCount: number;
    lastSeen: string;
}

export interface ProjectMemory {
    projectRoot: string;
    lastScanned: string | null;
    fixedIssues: FixedIssue[];
    knownStack: Partial<StackSnapshot>;
    chatSummaries: ChatSummary[];
    userPreferences: Record<string, string>;
    causalChain: CausalEntry[];
    stackPatterns: StackPattern[];  // capped at 50
}

interface FixedIssue {
    type: string;
    description: string;
    fixedAt: string;
    filesChanged: string[];
}

interface StackSnapshot {
    packageManager: string;
    nodeVersion: string;
    frameworks: string[];
    orms: string[];
    databases: string[];
}

interface ChatSummary {
    sessionDate: string;
    summary: string;
    filesChanged: string[];
}

/** Shape passed to recordFix — derived from local fix results in doctor.ts */
export interface AppliedFix {
    type: string;
    description: string;
    filesChanged: string[];
}

/** Loose scan shape — avoids importing scanFiles.js */
interface ScanLike {
    detectedPackageManager?: string;
    nodeVersion?: string | null;
    packageJson?: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    } | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MEMORY_DIR      = ".fixd";
const MEMORY_FILENAME = "memory.json";
const MAX_FIXED_ISSUES    = 50;
const MAX_CHAT_SUMMARIES  = 10;
const MAX_CAUSAL_ENTRIES  = 30;
const MAX_STACK_PATTERNS  = 50;

// ─── Dep-pattern maps ─────────────────────────────────────────────────────────

const FRAMEWORK_MAP: Record<string, string> = {
    next: "Next.js", react: "React", vue: "Vue", svelte: "Svelte",
    nuxt: "Nuxt", astro: "Astro", express: "Express", fastify: "Fastify",
    hono: "Hono", koa: "Koa", "@nestjs/core": "NestJS",
};
const ORM_MAP: Record<string, string> = {
    "@prisma/client": "Prisma", prisma: "Prisma", drizzle: "Drizzle",
    typeorm: "TypeORM", sequelize: "Sequelize", mongoose: "Mongoose",
};
const DB_MAP: Record<string, string> = {
    pg: "PostgreSQL", postgres: "PostgreSQL", mysql2: "MySQL",
    sqlite3: "SQLite", "better-sqlite3": "SQLite",
    mongodb: "MongoDB", redis: "Redis", ioredis: "Redis",
};

function detectFromDeps(deps: string[], map: Record<string, string>): string[] {
    const found = new Set<string>();
    for (const dep of deps) {
        for (const [key, label] of Object.entries(map)) {
            if (dep === key || dep.startsWith(`${key}/`)) found.add(label);
        }
    }
    return [...found];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyMemory(projectRoot: string): ProjectMemory {
    return {
        projectRoot,
        lastScanned: null,
        fixedIssues: [],
        knownStack: {},
        chatSummaries: [],
        userPreferences: {},
        causalChain: [],
        stackPatterns: [],
    };
}

function memoryFilePath(projectRoot: string): string {
    return path.join(projectRoot, MEMORY_DIR, MEMORY_FILENAME);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Load memory from disk. Returns empty memory if file missing. Never throws. */
export async function loadMemory(projectRoot: string): Promise<ProjectMemory> {
    try {
        const raw = await fs.readFile(memoryFilePath(projectRoot), "utf-8");
        // Safe migration: old schema without causalChain gets [] default from emptyMemory
        return { ...emptyMemory(projectRoot), ...JSON.parse(raw) };
    } catch {
        return emptyMemory(projectRoot);
    }
}

/** Atomically write memory to .fixd/memory.json. Never throws. */
export async function saveMemory(memory: ProjectMemory): Promise<void> {
    try {
        const dir = path.join(memory.projectRoot, MEMORY_DIR);
        await fs.mkdir(dir, { recursive: true });

        // S2: Auto-gitignore .fixd/ so memory.json is never accidentally committed
        const gitignorePath = path.join(dir, ".gitignore");
        try {
            await fs.writeFile(gitignorePath, "*\n", { flag: "wx" }); // wx = only create, never overwrite
        } catch { /* already exists */ }

        const fp  = memoryFilePath(memory.projectRoot);
        const tmp = `${fp}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(memory, null, 2), "utf-8");
        await fs.rename(tmp, fp);
    } catch (err: any) {
        // B4: non-fatal but visible — user should know if history won't persist
        console.error(`\n  ⚠ fixd: could not save session memory — ${(err as Error).message ?? "disk error"}`);
    }
}

/** Update lastScanned + knownStack from a fresh scan result. Caller saves. */
export function updateFromScan(memory: ProjectMemory, scan: ScanLike): ProjectMemory {
    const allDeps = Object.keys({
        ...(scan.packageJson?.dependencies  ?? {}),
        ...(scan.packageJson?.devDependencies ?? {}),
    });

    const frameworks = detectFromDeps(allDeps, FRAMEWORK_MAP);
    const orms       = detectFromDeps(allDeps, ORM_MAP);
    const databases  = detectFromDeps(allDeps, DB_MAP);

    return {
        ...memory,
        lastScanned: new Date().toISOString(),
        knownStack: {
            ...memory.knownStack,
            packageManager: scan.detectedPackageManager ?? memory.knownStack.packageManager,
            nodeVersion:    scan.nodeVersion            ?? memory.knownStack.nodeVersion,
            frameworks:     frameworks.length > 0 ? frameworks : memory.knownStack.frameworks,
            orms:           orms.length      > 0 ? orms       : memory.knownStack.orms,
            databases:      databases.length > 0 ? databases  : memory.knownStack.databases,
        },
    };
}

/** Append applied fixes to fixedIssues (capped at 50). Caller saves. */
export function recordFix(memory: ProjectMemory, fixes: AppliedFix[]): ProjectMemory {
    if (fixes.length === 0) return memory;

    const newEntries: FixedIssue[] = fixes.map((f) => ({
        type:         f.type,
        description:  f.description,
        fixedAt:      new Date().toISOString(),
        filesChanged: f.filesChanged,
    }));

    const fixedIssues = [...memory.fixedIssues, ...newEntries].slice(-MAX_FIXED_ISSUES);
    return { ...memory, fixedIssues };
}

/**
 * Append a causal entry to the chain (capped at 30). Caller saves.
 * Safe even if causalChain is undefined (old schema).
 */
export function addCausalEntry(memory: ProjectMemory, entry: CausalEntry): ProjectMemory {
    const existing = memory.causalChain ?? [];
    const causalChain = [...existing, entry].slice(-MAX_CAUSAL_ENTRIES);
    return { ...memory, causalChain };
}

/**
 * Record a stack pattern — what fix works (or fails) for a given stack+issueType.
 * Updates confidence in place if the pattern already exists.
 * Safe even if stackPatterns is undefined (old schema).
 */
export function recordStackPattern(
    memory: ProjectMemory,
    stack: Partial<StackSnapshot>,
    issueType: string,
    fixDescription: string,
    outcome: "success" | "failure"
): ProjectMemory {
    const stackKey = [
        stack.frameworks?.join("+") || "unknown",
        stack.databases?.join("+") || "",
        stack.orms?.join("+") || "",
    ].filter(Boolean).join("+");

    const patterns: StackPattern[] = memory.stackPatterns ? [...memory.stackPatterns] : [];
    const idx = patterns.findIndex(
        (p) => p.stack === stackKey && p.issueType === issueType
    );

    if (idx >= 0) {
        const existing = { ...patterns[idx] };
        existing.seenCount++;
        existing.lastSeen = new Date().toISOString();
        if (outcome === "success") {
            existing.confidence = Math.min(1, existing.confidence + 0.15);
            existing.outcome = "success";
        } else {
            existing.confidence = Math.max(0, existing.confidence - 0.1);
        }
        patterns[idx] = existing;
    } else {
        patterns.push({
            stack:           stackKey,
            issueType,
            fixDescription,
            outcome,
            confidence:      outcome === "success" ? 0.6 : 0.3,
            seenCount:       1,
            lastSeen:        new Date().toISOString(),
        });
    }

    // Cap at 50, keep highest confidence
    const trimmed = patterns
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_STACK_PATTERNS);

    return { ...memory, stackPatterns: trimmed };
}

/** Ask LLM for a 2-sentence session summary and append to chatSummaries.
 *  changedFiles — list of relative file paths patched during the session (fix 8.1). */
export async function summarizeSession(
    memory: ProjectMemory,
    sessionLog: string,
    changedFiles: string[] = []
): Promise<ProjectMemory> {
    if (!sessionLog.trim()) return memory;

    try {
        const summary = await ask(
            `Summarize this fixd session in 2 sentences max. What was broken, what was fixed.\nSession log:\n${sessionLog.slice(0, 3000)}`,
            "classify"
        );

        const entry: ChatSummary = {
            sessionDate:  new Date().toISOString(),
            summary:      summary.trim().slice(0, 500),
            filesChanged: [...new Set(changedFiles)], // deduplicated
        };

        const chatSummaries = [...memory.chatSummaries, entry].slice(-MAX_CHAT_SUMMARIES);
        return { ...memory, chatSummaries };
    } catch {
        return memory;
    }
}

/** Format memory as a prompt prefix. Returns empty string if memory is blank. */
export function formatMemoryForPrompt(memory: ProjectMemory): string {
    const chain = memory.causalChain ?? [];
    const hasContent =
        memory.lastScanned ||
        memory.fixedIssues.length > 0 ||
        memory.chatSummaries.length > 0 ||
        chain.length > 0;

    if (!hasContent) return "";

    const lines: string[] = ["--- PROJECT MEMORY ---"];

    if (memory.lastScanned) {
        const d = new Date(memory.lastScanned);
        lines.push(`Last scanned: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`);
    }

    const { packageManager, frameworks, orms } = memory.knownStack;
    const stackParts = [frameworks?.join(", "), orms?.join(", "), packageManager].filter(Boolean);
    if (stackParts.length > 0) lines.push(`Stack: ${stackParts.join(" · ")}`);

    if (memory.fixedIssues.length > 0) {
        lines.push("");
        lines.push("Previously fixed:");
        for (const issue of memory.fixedIssues.slice(-10)) {
            const date = new Date(issue.fixedAt).toLocaleDateString();
            lines.push(`- ${issue.type}: ${issue.description} (fixed ${date})`);
        }
    }

    if (memory.chatSummaries.length > 0) {
        lines.push("");
        lines.push("Past sessions:");
        for (const s of memory.chatSummaries) {
            const date = new Date(s.sessionDate).toLocaleDateString();
            lines.push(`- ${date}: ${s.summary}`);
        }
    }

    // ─── Causal history ───────────────────────────────────────────────────────
    if (chain.length > 0) {
        lines.push("");
        lines.push("--- CAUSAL HISTORY ---");
        for (const entry of chain.slice(-10)) {
            const date = new Date(entry.timestamp).toLocaleDateString();
            const followup = entry.followupIssues.length > 0
                ? ` → followup: ${entry.followupIssues.join(", ")}`
                : "";
            lines.push(
                `[${date}] ${entry.file} | ${entry.issueType} → ${entry.action} → ${entry.outcome}${followup}`
            );
        }
        lines.push("--- END CAUSAL HISTORY ---");
    }

    // ─── Stack patterns ───────────────────────────────────────────────────────
    const patterns = memory.stackPatterns ?? [];
    const relevantPatterns = patterns.filter((p) => p.confidence > 0.5).slice(0, 5);
    if (relevantPatterns.length > 0) {
        lines.push("");
        lines.push("--- STACK PATTERNS (proven fixes for this type of project) ---");
        for (const p of relevantPatterns) {
            lines.push(
                `[${p.stack}] ${p.issueType} → "${p.fixDescription}" (confidence: ${(p.confidence * 100).toFixed(0)}%, seen ${p.seenCount}x)`
            );
        }
        lines.push("--- END STACK PATTERNS ---");
    }

    lines.push("--- END MEMORY ---");
    return lines.join("\n");
}
