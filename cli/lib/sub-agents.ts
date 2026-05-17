/**
 * sub-agents.ts — Parallel worker sub-agents for fixd
 *
 * Each sub-agent is a focused, stateless, single-turn LLM call.
 * Pattern adapted from agent-prompt-worker-fork.md and agent-prompt-explore.md.
 *
 * Key principle: "execute ONE directive, then stop."
 * No conversation history, no session state — pure input → output.
 */

import { ask } from "./llm.js";
import { readRelevantFiles } from "./projectReader.js";
import type { DetectedIssue } from "../../src/actions/fixEnv.js";

// ─── Explore sub-agent ────────────────────────────────────────────────────────
//
// READ-ONLY. Analyses project structure and returns a structured summary.
// Runs on small model (fast). Adapted from agent-prompt-explore.md +
// agent-prompt-background-job-agent-instructions.md.
// Upgrade 3: iterative two-pass with confidence check.

const EXPLORE_SYSTEM_PROMPT = `You are a read-only project explorer for fixd, a developer CLI tool.
Your task: analyse the project structure and return a concise structured summary.

RULES:
- READ-ONLY. Never suggest creating, editing, or deleting files.
- One line narrating your approach before any analysis.
- Answer in structured JSON — no prose, no markdown, just the JSON object.
- Be concise. Missing info is fine — do not invent.
- At the end, emit: result: <one-line summary>

OUTPUT FORMAT (strict JSON):
{
  "framework": "<detected framework or null>",
  "language": "<primary language>",
  "runtime": "<node|bun|deno|python|go|rust|unknown>",
  "packageManager": "<npm|yarn|pnpm|bun|pip|cargo|go|unknown>",
  "hasTypeScript": <true|false>,
  "hasPrisma": <true|false>,
  "hasDocker": <true|false>,
  "hasTests": <true|false>,
  "testFramework": "<jest|vitest|mocha|pytest|go-test|cargo-test|null>",
  "entryPoint": "<main entry file or null>",
  "apiFramework": "<express|fastify|hono|fastapi|gin|axum|null>",
  "dbProvider": "<postgresql|mysql|sqlite|mongodb|null>",
  "missingEnvVars": ["<any env vars referenced in code but not in .env>"],
  "notes": "<one sentence of anything notable not covered above, or null>"
}`;

export interface ExploreResult {
    framework: string | null;
    language: string;
    runtime: string;
    packageManager: string;
    hasTypeScript: boolean;
    hasPrisma: boolean;
    hasDocker: boolean;
    hasTests: boolean;
    testFramework: string | null;
    entryPoint: string | null;
    apiFramework: string | null;
    dbProvider: string | null;
    missingEnvVars: string[];
    notes: string | null;
}

/**
 * Iterative project explorer (Upgrade 3).
 * Pass 1: small model — fast baseline.
 * Pass 2: large model — only if Pass 1 has low confidence on key fields.
 * Merges results (Pass 2 wins on non-null/non-unknown fields).
 */
export async function exploreProject(projectPath: string): Promise<ExploreResult | null> {
    try {
        const fileContext = await readRelevantFiles("project structure overview", projectPath).catch(() => "");

        const pass1Prompt = fileContext
            ? `${fileContext}\n\n[Working directory: ${projectPath}]\n\nAnalyse the project structure above and return the JSON summary.`
            : `[Working directory: ${projectPath}]\n\nList files and analyse project structure. Return the JSON summary.`;

        const modelTask = (process.env.FIXD_EXPLORE_MODEL ?? "small") === "large" ? "diagnose" : "classify";
        const result1 = await ask(pass1Prompt, modelTask, EXPLORE_SYSTEM_PROMPT);

        const jsonMatch1 = result1.match(/\{[\s\S]*\}/);
        if (!jsonMatch1) return null;

        const pass1 = JSON.parse(jsonMatch1[0]) as ExploreResult;

        // ── Confidence check ─────────────────────────────────────────────────
        const lowConfidence =
            !pass1.framework ||
            !pass1.runtime || pass1.runtime === "unknown" ||
            !pass1.packageManager || pass1.packageManager === "unknown" ||
            pass1.hasTypeScript === undefined || pass1.hasTypeScript === null;

        if (!lowConfidence) return pass1;

        // ── Pass 2: large model to correct and complete ───────────────────────
        const pass2Prompt = [
            `Pass 1 exploration result (may be incomplete — low confidence on some fields):`,
            `\`\`\`json`,
            JSON.stringify(pass1, null, 2),
            `\`\`\``,
            ``,
            fileContext || `[Working directory: ${projectPath}]`,
            ``,
            `Correct and complete the ExploreResult JSON. Return only the corrected JSON object.`,
        ].join("\n");

        const result2 = await ask(pass2Prompt, "diagnose", EXPLORE_SYSTEM_PROMPT).catch(() => "");
        const jsonMatch2 = result2.match(/\{[\s\S]*\}/);
        if (!jsonMatch2) return pass1; // pass1 as fallback

        const pass2 = JSON.parse(jsonMatch2[0]) as Partial<ExploreResult>;

        // Merge: pass2 wins on non-null, non-"unknown" fields
        const merged: ExploreResult = { ...pass1 };
        for (const key of Object.keys(pass2) as Array<keyof ExploreResult>) {
            const val = (pass2 as any)[key];
            if (val !== null && val !== undefined && val !== "unknown") {
                (merged as any)[key] = val;
            }
        }

        return merged;
    } catch {
        return null;
    }
}

// ─── Diagnose sub-agent ───────────────────────────────────────────────────────
//
// Takes structured scan data + detected issues, returns structured issue blocks.
// Runs on large model.
// Upgrade 4: ExploreResult is injected as an explicit EXPLORATION CONTEXT block.

const DIAGNOSE_SYSTEM_PROMPT = `You are fixd, a terminal-native dev environment diagnostic agent.
Respond ONLY in the exact structured format below. No prose. No thinking out loud.

OUTPUT FORMAT (repeat block per issue, separated by ---):

ISSUES: {n} found

---
SEVERITY: HIGH | MEDIUM | LOW
TYPE: {ISSUE_TYPE}
PROBLEM: One sentence. What exactly is wrong.
FIX: One sentence. Exact action to take.
DIFF:
\`\`\`diff
- old line
+ new line
\`\`\`
---

RULES:
- No filler text before or after the blocks
- No "I recommend", "Let me", "Okay", "First" or any conversational openers
- For package.json fixes show JSON diff only, no install commands
- Only mention issues that appear in the DETECTED ISSUES list provided
- Max 1 sentence per PROBLEM and FIX field
- Include file:line_number when referencing code locations
- If no issues: respond with exactly "NO ISSUES FOUND"`;

export async function diagnoseWithAgent(
    scanContext: string,
    issueList: string,
    exploreContext: ExploreResult   // required — enforce sub-agent isolation
): Promise<string> {
    const parts: string[] = [
        // Upgrade 4: exploration context always opened first
        "--- EXPLORATION CONTEXT ---",
        `Framework: ${exploreContext.framework ?? "unknown"}`,
        `Runtime: ${exploreContext.runtime}`,
        `Package Manager: ${exploreContext.packageManager}`,
        `TypeScript: ${exploreContext.hasTypeScript}`,
        `Prisma: ${exploreContext.hasPrisma}`,
        `Missing Env Vars: ${exploreContext.missingEnvVars?.join(", ") || "none"}`,
        "--- END EXPLORATION CONTEXT ---",
        "",
        "Given the above project context and the scan data below, diagnose issues.",
        "",
        "SCAN DATA:",
        "```",
        scanContext,
        "```",
        "",
        `DETECTED ISSUES:`,
        issueList,
    ];

    const prompt = parts.join("\n");

    return ask(prompt, "diagnose", DIAGNOSE_SYSTEM_PROMPT);
}

// ─── Synthesis sub-agent ──────────────────────────────────────────────────────
//
// Upgrade 4: Merges explore + diagnose outputs into a single unified summary.
// Runs on small model — fast, no expensive LLM call needed for de-duplication.

const SYNTHESIS_SYSTEM_PROMPT = `You are fixd. Synthesize multiple sources of issue information into a single concise summary.
Remove duplicates. Escalate severity if multiple sources agree on the same issue.
Output plain text only. Max 20 lines. No filler. Be terse.`;

export async function synthesizeDiagnosis(
    exploreResult: ExploreResult,
    diagnoseOutput: string,
    detectedIssues: DetectedIssue[]
): Promise<string> {
    const issueList = detectedIssues.length > 0
        ? detectedIssues.map((i) => `- [${i.severity}] ${i.type}: ${i.description}`).join("\n")
        : "No structured issues detected.";

    const prompt = [
        `Given the following exploration result, agent diagnosis, and structured issue list,`,
        `produce a single unified issue summary. Remove duplicates. Escalate severity if multiple sources agree.`,
        `Output plain text, max 20 lines.`,
        ``,
        `EXPLORATION RESULT:`,
        JSON.stringify(exploreResult, null, 2),
        ``,
        `AGENT DIAGNOSIS:`,
        diagnoseOutput || "(no diagnosis output)",
        ``,
        `STRUCTURED ISSUES:`,
        issueList,
    ].join("\n");

    // Always uses small model — synthesis is a consolidation task, not analysis
    return ask(prompt, "classify", SYNTHESIS_SYSTEM_PROMPT);
}

// ─── Plan scaffold sub-agent ──────────────────────────────────────────────────
//
// READ-ONLY planning. Takes the stack spec and returns a file manifest + gotchas.
// Runs on small model (fast) before the expensive large-model scaffold call.
// Adapted from agent-prompt-plan-mode-enhanced.md.

const PLAN_SCAFFOLD_SYSTEM_PROMPT = `You are a scaffold planner for fixd.
Given a project stack spec, return a JSON plan of exactly which files to generate.

OUTPUT FORMAT (strict JSON, no markdown wrapping):
{
  "files": [
    { "path": "package.json", "reason": "project manifest with bun scripts" }
  ],
  "envVarsRequired": [
    { "name": "DATABASE_URL", "description": "Neon pooled connection string" }
  ],
  "gotchas": [
    "Neon requires directUrl in prisma schema for migrate to work"
  ],
  "installStepsAfter": [
    "prisma generate"
  ]
}

FILE PLANNING RULES:
- List files in dependency order: config files first, then shared libs, then backend, then frontend
- Always include: package.json, tsconfig.json, .env, .env.example, .gitignore, src/index.ts
- Auth: if auth is anything other than "none", you MUST include a dedicated auth source file
  (e.g. src/lib/auth.ts or src/middleware/auth.ts) that implements the described strategy
- ORM: if orm is "prisma", include prisma/schema.prisma; if "drizzle", include drizzle.config.ts and a schema file
- Frontend: if frontend is anything other than "none", include at minimum:
  frontend/package.json, frontend/src/App.tsx (or equivalent entry), and frontend config file
- Only include env vars that are non-obvious for this stack combination
- Gotchas: only stack-specific, not generic TypeScript/Node.js advice
- installStepsAfter: only commands required immediately after install (e.g. prisma generate)
- A free-form auth description like "cookies based jwt" or "firebase auth" is still valid auth —
  plan a dedicated file for it that implements exactly what was described`;


export interface ScaffoldPlan {
    files: Array<{ path: string; reason: string }>;
    envVarsRequired: Array<{ name: string; description: string }>;
    gotchas: string[];
    installStepsAfter: string[];
}

export interface StackSpec {
    projectName: string;
    framework: string;
    database: string;
    dbHost?: string;
    orm: string;
    auth: string;
    frontend: string;
    pkgManager: string;
}

export async function planScaffold(spec: StackSpec): Promise<ScaffoldPlan | null> {
    const prompt = [
        `Plan the scaffold for this project:`,
        ``,
        `Backend framework: ${spec.framework}`,
        `Database: ${spec.database}${spec.dbHost ? ` (hosted on ${spec.dbHost})` : ""}`,
        `ORM: ${spec.orm}`,
        `Auth: ${spec.auth}`,
        `Frontend: ${spec.frontend}`,
        `Package manager: ${spec.pkgManager}`,
        ``,
        `Return the JSON plan with files, required env vars, gotchas, and post-install steps.`,
    ].join("\n");

    const modelTask = (process.env.FIXD_EXPLORE_MODEL ?? "small") === "large" ? "diagnose" : "classify";

    try {
        const result = await ask(prompt, modelTask, PLAN_SCAFFOLD_SYSTEM_PROMPT);
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return JSON.parse(jsonMatch[0]) as ScaffoldPlan;
    } catch {
        return null;
    }
}

// ─── FIXD.md generator sub-agent ─────────────────────────────────────────────
//
// Generates a FIXD.md for the new project — provides context to future
// fixd doctor/chat sessions. Adapted from skill-init-claudemd-and-skill-setup.
// Runs on small model.

const FIXD_MD_SYSTEM_PROMPT = `You are fixd. Generate a FIXD.md file for a newly scaffolded project.
FIXD.md is loaded by fixd agent sessions to provide project context.
Only include what would otherwise cause the agent to get things wrong.

OUTPUT (strict markdown):

# FIXD.md
> Project context for fixd agent sessions.

## Stack
- Runtime: <bun|node>
- Backend: <framework>
- ORM: <orm> (<database> via <host>)
- Auth: <auth or none>
- Frontend: <frontend or none>

## Required env vars
- VAR_NAME — description (one line each)

## Commands
- dev: <start command>
- db: <prisma generate / drizzle-kit push — only if non-obvious>

## Gotchas
- <one specific gotcha per line>

RULES:
- No generic advice
- Omit any section that has nothing non-obvious to say
- Max 40 lines total`;

export async function generateFixdMd(spec: StackSpec, plan: ScaffoldPlan | null): Promise<string> {
    const parts = [
        `Generate FIXD.md for: ${spec.framework} + ${spec.database} + ${spec.orm} + ${spec.auth} auth + ${spec.frontend} frontend`,
        `Package manager: ${spec.pkgManager}`,
        spec.dbHost ? `Database host: ${spec.dbHost}` : "",
    ];

    if (plan?.envVarsRequired && plan.envVarsRequired.length > 0) {
        parts.push("", "Required env vars:");
        for (const v of plan.envVarsRequired) parts.push(`  ${v.name}: ${v.description}`);
    }
    if (plan?.gotchas && plan.gotchas.length > 0) {
        parts.push("", "Known gotchas:");
        for (const g of plan.gotchas) parts.push(`  - ${g}`);
    }

    const prompt = parts.filter(Boolean).join("\n");
    const modelTask = (process.env.FIXD_EXPLORE_MODEL ?? "small") === "large" ? "diagnose" : "classify";

    try {
        const raw = await ask(prompt, modelTask, FIXD_MD_SYSTEM_PROMPT);
        return raw.includes("# FIXD.md") ? raw : `# FIXD.md\n\n${raw}`;
    } catch {
        // Minimal fallback without LLM
        const lines = [
            "# FIXD.md",
            "> Project context for fixd agent sessions.",
            "",
            "## Stack",
            `- Runtime: ${spec.pkgManager === "bun" ? "bun" : "node"}`,
            `- Backend: ${spec.framework}`,
            spec.orm !== "none" ? `- ORM: ${spec.orm} (${spec.database}${spec.dbHost ? ` via ${spec.dbHost}` : ""})` : "",
            spec.auth !== "none" ? `- Auth: ${spec.auth}` : "",
            spec.frontend !== "none" ? `- Frontend: ${spec.frontend}` : "",
        ].filter(Boolean);

        if (plan?.envVarsRequired && plan.envVarsRequired.length > 0) {
            lines.push("", "## Required env vars");
            for (const v of plan.envVarsRequired) lines.push(`- ${v.name} — ${v.description}`);
        }
        if (plan?.gotchas && plan.gotchas.length > 0) {
            lines.push("", "## Gotchas");
            for (const g of plan.gotchas) lines.push(`- ${g}`);
        }

        return lines.join("\n") + "\n";
    }
}
