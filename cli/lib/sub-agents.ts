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

// ─── Explore sub-agent ────────────────────────────────────────────────────────
//
// READ-ONLY. Analyses project structure and returns a structured summary.
// Runs on small model (fast). Adapted from agent-prompt-explore.md +
// agent-prompt-background-job-agent-instructions.md.

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

export async function exploreProject(projectPath: string): Promise<ExploreResult | null> {
    try {
        const fileContext = await readRelevantFiles("project structure overview", projectPath).catch(() => "");

        const prompt = fileContext
            ? `${fileContext}\n\n[Working directory: ${projectPath}]\n\nAnalyse the project structure above and return the JSON summary.`
            : `[Working directory: ${projectPath}]\n\nList files and analyse project structure. Return the JSON summary.`;

        const modelTask = (process.env.FIXD_EXPLORE_MODEL ?? "small") === "large" ? "diagnose" : "classify";
        const result = await ask(prompt, modelTask, EXPLORE_SYSTEM_PROMPT);

        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        return JSON.parse(jsonMatch[0]) as ExploreResult;
    } catch {
        return null;
    }
}

// ─── Diagnose sub-agent ───────────────────────────────────────────────────────
//
// Takes structured scan data + detected issues, returns structured issue blocks.
// Runs on large model.

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
    exploreContext?: ExploreResult | null
): Promise<string> {
    const parts: string[] = [
        "SCAN DATA:",
        "```",
        scanContext,
        "```",
        "",
    ];

    if (exploreContext) {
        parts.push("ADDITIONAL CONTEXT (from project explorer):");
        parts.push("```json");
        parts.push(JSON.stringify(exploreContext, null, 2));
        parts.push("```");
        parts.push("");
    }

    parts.push(`DETECTED ISSUES:`, issueList);

    const prompt = parts.join("\n");

    return ask(prompt, "diagnose", DIAGNOSE_SYSTEM_PROMPT);
}

// ─── Plan scaffold sub-agent ──────────────────────────────────────────────────
//
// READ-ONLY planning. Takes the stack spec and returns a file manifest + gotchas.
// Runs on small model (fast) before the expensive large-model scaffold call.
// Adapted from agent-prompt-plan-mode-enhanced.md.

const PLAN_SCAFFOLD_SYSTEM_PROMPT = `You are a scaffold planner for fixd.
Given a project stack spec, return a JSON plan of which files to generate and any non-obvious requirements.

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

RULES:
- List files in dependency order (configs first, then source files)
- Only include env vars that are non-obvious for this stack
- Gotchas must be specific to this exact stack combination, not generic tips
- installStepsAfter: only commands that MUST run after npm/bun install`;

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
