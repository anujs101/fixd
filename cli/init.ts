import chalk from "chalk";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { askStream } from "./lib/llm.js";
import { proposeAndApply, resetBackupSession } from "./lib/patcher.js";
import { fetchDocsForStack, formatDocsForPrompt } from "./lib/context7.js";
import { runCommand } from "./lib/executor.js";
import { planScaffold, generateFixdMd, type StackSpec, type ScaffoldPlan } from "./lib/sub-agents.js";

import {
    printHeader,
    section,
    info,
    warn,
    success,
    spin,
    prompt,
    confirm,
    closePrompt,
} from "./lib/display.js";

// ─── Stack choices ────────────────────────────────────────────────────────────

const FRAMEWORKS     = ["hono", "express", "fastify"];
const DATABASES      = ["postgres", "mysql", "sqlite", "redis", "mongodb", "none"];
const POSTGRES_HOSTS = ["neon", "supabase", "railway", "local"];
const ORMS           = ["prisma", "drizzle", "none"];
const FRONTENDS      = ["next", "vite-react", "none"];
const PKG_MANAGERS   = ["bun", "pnpm", "npm"];

// Auth is intentionally open-ended — users can describe anything (firebase auth,
// passport.js + sessions, jwt in httponly cookies, etc.). We keep a hints list
// for display only, not as a validation enum.
const AUTH_HINTS = "better-auth / jwt / clerk / firebase / passport / none, or describe";

// ─── Input normalizer ─────────────────────────────────────────────────────────
// Corrects common typos (postgress → postgres) and normalises known aliases.
// Unknown values are passed through as-is — the model handles them correctly.

function normalizeInput(val: string, field: "database" | "framework" | "frontend" | "pkgManager"): string {
    const v = val.trim().toLowerCase();
    if (!v) return v;

    const maps: Record<typeof field, Record<string, string>> = {
        database: {
            postgress: "postgres", postgresql: "postgres", pg: "postgres",
            mysql2: "mysql", mariadb: "mysql",
            sqlite3: "sqlite", libsql: "sqlite",
            mongo: "mongodb",
        },
        framework: {
            expresss: "express", "express.js": "express", expressjs: "express",
            "fastify.js": "fastify", fastifyjs: "fastify",
            "hono.js": "hono",
        },
        frontend: {
            vite: "vite-react", "vite react": "vite-react", vitereact: "vite-react",
            react: "vite-react", "react vite": "vite-react",
            nextjs: "next", "next.js": "next",
        },
        pkgManager: {
            "bun.js": "bun", bunjs: "bun",
        },
    };

    return maps[field][v] ?? v;
}

// ─── Defaults for --yes mode ──────────────────────────────────────────────────

const DEFAULTS = {
    framework:  "hono",
    database:   "postgres",
    dbHost:     "neon",
    orm:        "prisma",
    auth:       "none",
    frontend:   "none",
    pkgManager: "bun",
};

function choose(label: string, options: string[]): string {
    return `${label} (${options.join(" / ")})`;
}

// ─── Path prefix stripper ─────────────────────────────────────────────────────
// Strips `projectName/` prefix from patch marker paths so the patcher resolves
// paths relative to projectDir (which is already the project root).

function stripProjectPrefix(response: string, projectName: string): string {
    const prefix = `${projectName}/`;
    return response.replace(
        /<<<(WRITE|EDIT|DELETE):\s*([^>\n]+)>>>/g,
        (_match, op: string, rawPath: string) => {
            const trimmed = rawPath.trim();
            return `<<<${op}: ${trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed}>>>`;
        }
    );
}

// ─── .env checklist ───────────────────────────────────────────────────────────

async function printEnvChecklist(projectDir: string, required: Array<{ name: string; description: string }>): Promise<void> {
    if (required.length === 0) return;

    let envContent = "";
    try { envContent = await fs.readFile(path.join(projectDir, ".env"), "utf-8"); } catch { /* no .env yet */ }

    const missing = required.filter(({ name }) => !new RegExp(`^${name}\\s*=\\s*.+`, "m").test(envContent));
    if (missing.length === 0) return;

    console.log();
    console.log(chalk.yellow("  ⚠  fill these in .env before running:"));
    for (const { name, description } of missing) {
        console.log(`     ${chalk.white(name)}=${chalk.dim(`  # ${description}`)}`);
    }
}

// ─── Semantic git commit builder ──────────────────────────────────────────────

function buildCommitMessage(spec: StackSpec, rawAuth: string): string {
    const parts = ["init: scaffold", spec.framework];
    if (spec.orm !== "none") parts.push(`+ ${spec.orm}`);
    if (spec.database !== "none") parts.push(`+ ${spec.dbHost ? `${spec.database}/${spec.dbHost}` : spec.database}`);
    // Use rawAuth if it's more descriptive than the canonical value
    const authLabel = rawAuth && rawAuth !== spec.auth ? rawAuth : spec.auth;
    if (authLabel !== "none") parts.push(`+ ${authLabel}`);
    if (spec.frontend !== "none") parts.push(`+ ${spec.frontend}`);
    return parts.join(" ");
}

// ─── Post-generation completeness check ──────────────────────────────────────
// Scans the LLM output for signals that a requested component is missing.
// Returns a list of human-readable descriptions of what's absent.
// This is intentionally loose — false negatives are fine, false positives are not.

function checkCompleteness(response: string, spec: StackSpec): string[] {
    const missing: string[] = [];

    // Frontend: any file inside a `frontend/` directory signals inclusion
    if (spec.frontend !== "none" && !response.includes("frontend/")) {
        missing.push(`frontend (${spec.frontend}) — no frontend/ files found in output`);
    }

    // Prisma schema
    if (spec.orm === "prisma" && !response.includes("schema.prisma")) {
        missing.push("prisma/schema.prisma — no Prisma schema found");
    }

    // Auth implementation file (any file with "auth" in the path under src/)
    if (spec.auth !== "none" && !/src\/[^\n]*auth/i.test(response)) {
        missing.push(`auth implementation — no src/...auth... file found`);
    }

    return missing;
}

// ─── Scaffold system prompt ───────────────────────────────────────────────────
// This is the highest-leverage change: the scaffold model now knows its role.
// Without this, the model defaults to "frontend is a separate project" behaviour.

const SCAFFOLD_SYSTEM_PROMPT = `You are a code scaffolding agent.
Your job: generate a complete, production-ready project exactly as specified.

RULES:
1. Generate EVERY component the user requested in this single output. Never say a
   component is "not included" or "a separate project" — if the user asked for it,
   scaffold it here.
2. Follow the FILE MANIFEST exactly. Generate every file listed. Don't invent extras
   unless they are clearly required (e.g. a missing type definition file).
3. Use the user's exact intent (marked as "User said:") for implementation decisions.
   "User said: jwt cookies based" → implement JWT stored in HttpOnly cookies.
   "User said: firebase auth" → implement Firebase Admin SDK auth.
4. Output files in dependency order: config → shared libs → backend → frontend.
5. Every file must be complete and runnable — no TODOs, no placeholder content.
6. Use only this marker format (no other format will be parsed):
   <<<WRITE: path/to/file>>>
   full file content
   <<<END>>>
7. After ALL files, output exactly one line: SCAFFOLD_COMPLETE
8. No prose before the first <<<WRITE. No explanations between files.`;

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runInit(useDefaults = false) {
    printHeader("init");
    resetBackupSession();
    info("let's scaffold your project. answer a few questions.");
    console.log();

    // ── Interview ─────────────────────────────────────────────────────────────

    const projectName = useDefaults
        ? "my-app"
        : (await prompt("project name") || "");

    if (!projectName) { warn("project name is required"); closePrompt(); return; }

    const norm = (s: string) => s.trim().toLowerCase();

    // rawAnswers: the user's exact words, preserved for intent-passing to the LLM
    const rawAnswers: Record<string, string> = {};

    let framework: string, database: string, dbHost: string,
        orm: string, auth: string, frontend: string, pkgManager: string;

    if (useDefaults) {
        ({ framework, database, orm, auth, frontend, pkgManager } = DEFAULTS);
        dbHost = DEFAULTS.dbHost;
        info(`using defaults: ${chalk.white([framework, database, dbHost, orm].join(" + "))}`);
        console.log();
    } else {
        // Capture raw + normalize for typo-prone fields
        const rawFw = await prompt(choose("backend framework", FRAMEWORKS));
        rawAnswers.framework = rawFw;
        framework = normalizeInput(norm(rawFw), "framework");

        const rawDb = await prompt(choose("database", DATABASES));
        rawAnswers.database = rawDb;
        database = normalizeInput(norm(rawDb), "database");

        dbHost = "";
        if (database === "postgres") {
            dbHost = norm(await prompt(choose("postgres hosting", POSTGRES_HOSTS)));
        }

        // Skip ORM for non-relational databases
        const needsOrm = !["none", "redis", "mongodb"].includes(database);
        orm = needsOrm ? norm(await prompt(choose("ORM", ORMS))) : "none";

        // Auth is free-form — user can describe any strategy
        const rawAuth = await prompt(`auth strategy (${AUTH_HINTS})`);
        rawAnswers.auth = rawAuth;
        // Only normalize well-known aliases (e.g. "betterauth" → "better-auth")
        // Free-form values like "firebase auth" pass through unchanged
        auth = norm(rawAuth) || "none";

        const rawFe = await prompt(choose("frontend", FRONTENDS));
        rawAnswers.frontend = rawFe;
        frontend = normalizeInput(norm(rawFe), "frontend");

        pkgManager = normalizeInput(norm(await prompt(choose("package manager", PKG_MANAGERS))), "pkgManager");
    }

    const spec: StackSpec = {
        projectName,
        framework:  framework  || DEFAULTS.framework,
        database:   database   || DEFAULTS.database,
        dbHost:     dbHost     || undefined,
        orm:        orm        || "none",
        auth:       auth       || "none",
        frontend:   frontend   || "none",
        pkgManager: pkgManager || DEFAULTS.pkgManager,
    };

    // ── Confirm ───────────────────────────────────────────────────────────────

    section("your stack");
    console.log(`  ${chalk.dim("project")}      ${chalk.white(projectName)}`);
    console.log(`  ${chalk.dim("framework")}    ${chalk.white(spec.framework)}`);
    console.log(`  ${chalk.dim("database")}     ${chalk.white(spec.database)}`);
    if (spec.dbHost) console.log(`  ${chalk.dim("db host")}      ${chalk.white(spec.dbHost)}`);
    console.log(`  ${chalk.dim("orm")}          ${chalk.white(spec.orm)}`);
    // Show raw auth description if it differs from the canonical value
    const authDisplay = rawAnswers.auth && rawAnswers.auth.trim() !== spec.auth
        ? `${spec.auth} ${chalk.dim(`("${rawAnswers.auth.trim()}")`)}` : spec.auth;
    console.log(`  ${chalk.dim("auth")}         ${chalk.white(authDisplay)}`);
    console.log(`  ${chalk.dim("frontend")}     ${chalk.white(spec.frontend)}`);
    console.log(`  ${chalk.dim("pkg manager")}  ${chalk.white(spec.pkgManager)}`);
    console.log();

    if (!useDefaults) {
        const go = await confirm("scaffold this project?");
        if (!go) { info("cancelled."); closePrompt(); return; }
    }

    // ── Plan sub-agent ────────────────────────────────────────────────────────
    // Fast small-model call that returns a structured file manifest.
    // This becomes the authoritative list fed to the scaffold LLM.

    const planSpinner = spin("planning scaffold...");
    let scaffoldPlan = await planScaffold(spec).catch(() => null);
    planSpinner.stop();

    // ── Plan completeness guard ───────────────────────────────────────────────
    // Small models sometimes omit feature files from the manifest.
    // Enforce that auth, ORM schema, and frontend each have at least one entry.
    // We don't dictate the exact path — the model decides; we just ensure coverage.
    if (scaffoldPlan) {
        const paths = scaffoldPlan.files.map((f) => f.path.toLowerCase());

        const hasAuth     = paths.some((p) => p.includes("auth"));
        const hasPrisma   = spec.orm === "prisma" && !paths.some((p) => p.includes("schema.prisma"));
        const hasFrontend = spec.frontend !== "none" && !paths.some((p) => p.includes("frontend") || p.includes(spec.frontend));

        if (!hasAuth && spec.auth !== "none") {
            scaffoldPlan.files.push({
                path: "src/lib/auth.ts",
                reason: `${spec.auth} auth implementation — middleware, token logic, and route handlers`,
            });
        }
        if (hasPrisma) {
            scaffoldPlan.files.push({
                path: "prisma/schema.prisma",
                reason: "Prisma schema — data models and datasource config",
            });
        }
        if (hasFrontend) {
            scaffoldPlan.files.push({
                path: `frontend/src/App.${spec.frontend === "next" ? "tsx" : "tsx"}`,
                reason: `${spec.frontend} frontend entry component`,
            });
        }
    }


    if (scaffoldPlan?.files && scaffoldPlan.files.length > 0) {
        const SHOW_MAX = 8;
        console.log(chalk.dim(`  files to generate (${scaffoldPlan.files.length}):`));
        for (const f of scaffoldPlan.files.slice(0, SHOW_MAX)) {
            console.log(`    ${chalk.dim("·")} ${chalk.white(f.path)}`);
        }
        if (scaffoldPlan.files.length > SHOW_MAX) {
            console.log(`    ${chalk.dim(`… and ${scaffoldPlan.files.length - SHOW_MAX} more`)}`);
        }
        if (scaffoldPlan.gotchas?.length > 0) {
            console.log(chalk.dim("  stack notes:"));
            for (const g of scaffoldPlan.gotchas.slice(0, 3)) {
                console.log(`    ${chalk.yellow("⚠")} ${chalk.dim(g)}`);
            }
        }
        console.log();
    }

    // ── Fetch live docs ───────────────────────────────────────────────────────

    const docsSpinner = spin("fetching latest docs...");
    const docsResult = await fetchDocsForStack({
        framework: spec.framework,
        orm:       spec.orm      !== "none" ? spec.orm      : undefined,
        auth:      spec.auth     !== "none" ? spec.auth     : undefined,
        runtime:   spec.pkgManager === "bun" ? "bun" : "node",
        database:  spec.database !== "none" ? spec.database : undefined,
    }).catch(() => ({ docs: [], totalTokens: 0, skipped: [] as string[] }));
    docsSpinner.stop();

    if (docsResult.docs.length > 0) {
        info(`docs fetched: ${docsResult.docs.map((d) => d.libraryId.split("/").at(-1)).join(", ")}`);
    }

    const docsContext = formatDocsForPrompt(docsResult.docs);

    // ── Build scaffold prompt ─────────────────────────────────────────────────
    //
    // Three layers of context, in priority order:
    //   1. Live docs (highest fidelity for APIs)
    //   2. Authoritative FILE MANIFEST from planScaffold
    //   3. User intent — canonical spec + raw words side-by-side

    const fileManifest = scaffoldPlan?.files && scaffoldPlan.files.length > 0
        ? [
            `FILE MANIFEST — generate ALL of these, no omissions:`,
            scaffoldPlan.files
                .map((f, i) => `  ${i + 1}. ${projectName}/${f.path}  # ${f.reason}`)
                .join("\n"),
          ].join("\n")
        : "";

    const gotchaBlock = (scaffoldPlan?.gotchas?.length ?? 0) > 0
        ? `STACK GOTCHAS — apply these exactly:\n${scaffoldPlan!.gotchas.map((g) => `  - ${g}`).join("\n")}`
        : "";


    // User intent block: canonical spec + the user's exact words
    // The model uses canonical spec for routing, raw words for implementation decisions
    const intentLines: string[] = [
        `STACK SPEC (canonical):`,
        `  project: ${projectName}`,
        `  framework: ${spec.framework}`,
        `  database: ${spec.database}${spec.dbHost ? ` via ${spec.dbHost}` : ""}`,
        `  orm: ${spec.orm}`,
        `  auth: ${spec.auth}`,
        `  frontend: ${spec.frontend}`,
        `  pkgManager: ${spec.pkgManager}`,
    ];

    // Append raw user words for any field where they differ from canonical
    const intentOverrides: string[] = [];
    if (rawAnswers.auth && rawAnswers.auth.trim().toLowerCase() !== spec.auth) {
        intentOverrides.push(`  auth: "${rawAnswers.auth.trim()}" → implement exactly this auth strategy`);
    }
    if (rawAnswers.framework && rawAnswers.framework.trim().toLowerCase() !== spec.framework) {
        intentOverrides.push(`  framework: "${rawAnswers.framework.trim()}" → use ${spec.framework}`);
    }
    if (rawAnswers.frontend && rawAnswers.frontend.trim().toLowerCase() !== spec.frontend && spec.frontend !== "none") {
        intentOverrides.push(`  frontend: "${rawAnswers.frontend.trim()}" → scaffold as ${spec.frontend}`);
    }
    if (intentOverrides.length > 0) {
        intentLines.push(``, `USER'S EXACT WORDS (use for implementation decisions):`);
        intentLines.push(...intentOverrides);
    }

    const outputRules = [
        `OUTPUT FORMAT (follow exactly — other formats are not parsed):`,
        `  <<<WRITE: ${projectName}/path/to/file>>>`,
        `  full file content`,
        `  <<<END>>>`,
        ``,
        `After the last file, output exactly: SCAFFOLD_COMPLETE`,
    ].join("\n");

    const scaffoldPrompt = [
        docsContext,
        fileManifest,
        gotchaBlock,
        intentLines.join("\n"),
        ``,
        outputRules,
    ].filter(Boolean).join("\n\n").trim();

    // ── Generate ──────────────────────────────────────────────────────────────

    section("scaffolding");
    const genSpinner = spin("generating project...");

    let fullResponse = "";
    try {
        for await (const chunk of askStream(scaffoldPrompt, "generate", SCAFFOLD_SYSTEM_PROMPT)) {
            fullResponse += chunk;
            const fileCount = (fullResponse.match(/<<<WRITE:/g) ?? []).length;
            if (fileCount > 0) {
                genSpinner.text = `generating... (${fileCount} file${fileCount > 1 ? "s" : ""} so far)`;
            }
        }
    } catch (err: any) {
        genSpinner.stop();
        warn(`Scaffold generation failed: ${err.message}`);
        closePrompt();
        return;
    }

    genSpinner.stop();

    const clean = fullResponse.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    if (!clean.includes("<<<WRITE:")) {
        warn("agent did not output any file blocks — raw response:");
        console.log(chalk.dim(clean.slice(0, 600)));
        closePrompt();
        return;
    }

    // ── Completeness check ────────────────────────────────────────────────────
    // Verify the model included every requested component before writing to disk.

    const missing = checkCompleteness(clean, spec);
    if (missing.length > 0) {
        console.log();
        warn("some requested components may be missing from the generated output:");
        for (const m of missing) console.log(`  ${chalk.yellow("·")} ${m}`);
        console.log();
        const proceed = await confirm("write files anyway? (you can re-run fixd init to regenerate)");
        if (!proceed) { info("cancelled — nothing written."); closePrompt(); return; }
    }

    const normalised = stripProjectPrefix(clean, projectName);

    // ── Create project directory ──────────────────────────────────────────────

    const projectDir = path.join(process.cwd(), projectName);
    try {
        await fs.mkdir(projectDir, { recursive: true });
    } catch (err: any) {
        warn(`could not create ${projectDir}: ${err.message}`);
        closePrompt();
        return;
    }

    // ── Write files ───────────────────────────────────────────────────────────

    section("writing files");
    const results = await proposeAndApply(normalised, projectDir, { autoApprove: true });
    const written  = results.filter((r) => r.applied);
    const failed   = results.filter((r) => !r.applied);

    for (const r of written) success(`created: ${r.path}`);
    for (const r of failed)  warn(`failed:  ${r.path}${r.error ? ` — ${r.error}` : ""}`);

    if (written.length === 0) {
        warn("no files written — check agent output format");
        closePrompt();
        return;
    }

    // ── Git init ──────────────────────────────────────────────────────────────

    section("setup");
    const gitSpinner = spin("initialising git...");
    try {
        await execa("git", ["init"],    { cwd: projectDir });
        await execa("git", ["add", "."], { cwd: projectDir });
        const commitMsg = buildCommitMessage(spec, rawAnswers.auth ?? "");
        await execa("git", ["commit", "-m", commitMsg], { cwd: projectDir });
        gitSpinner.stop();
        success(`git: ${chalk.dim(commitMsg)}`);
    } catch {
        gitSpinner.stop();
        warn(`git init failed — run manually: cd ${projectName} && git init`);
    }

    // ── Install dependencies ──────────────────────────────────────────────────

    const installCmd = spec.pkgManager === "bun"  ? "bun install"
                     : spec.pkgManager === "pnpm" ? "pnpm install"
                     : spec.pkgManager === "yarn" ? "yarn"
                     : "npm install";

    const installSpinner = spin(`running ${installCmd}...`);
    const installResult  = await runCommand(installCmd, projectDir);
    installSpinner.stop();

    if (installResult.exitCode === 0) {
        success("dependencies installed");
    } else {
        warn(`install failed — run manually: cd ${projectName} && ${installCmd}`);
    }

    // ── Post-install steps ────────────────────────────────────────────────────

    const postInstallSteps: string[] = [...(scaffoldPlan?.installStepsAfter ?? [])];
    if (spec.orm === "prisma" && !postInstallSteps.includes("prisma generate")) {
        postInstallSteps.push("prisma generate");
    }

    for (const step of postInstallSteps) {
        const s = spin(`running: ${step}...`);
        const r = await runCommand(step, projectDir);
        s.stop();
        r.exitCode === 0 ? success(`${step} — done`) : warn(`${step} failed (run manually after filling .env)`);
    }

    // ── FIXD.md ───────────────────────────────────────────────────────────────

    const fixdMdSpinner = spin("generating FIXD.md...");
    const fixdMdContent = await generateFixdMd(spec, scaffoldPlan).catch(() => null);
    fixdMdSpinner.stop();

    if (fixdMdContent) {
        try {
            await fs.writeFile(path.join(projectDir, "FIXD.md"), fixdMdContent, "utf-8");
            success("FIXD.md created (project context for future fixd sessions)");
        } catch {
            warn("could not write FIXD.md");
        }
    }

    // ── .env checklist ────────────────────────────────────────────────────────

    if (scaffoldPlan?.envVarsRequired) {
        await printEnvChecklist(projectDir, scaffoldPlan.envVarsRequired);
    }

    // ── Done ──────────────────────────────────────────────────────────────────

    console.log();
    section("done");
    success(`${chalk.white(projectName)} scaffolded in ${chalk.dim(projectDir)}`);
    console.log();
    info("next steps:");
    console.log(`  ${chalk.dim("1.")} ${chalk.white(`cd ${projectName}`)}`);
    if (scaffoldPlan?.envVarsRequired && scaffoldPlan.envVarsRequired.length > 0) {
        console.log(`  ${chalk.dim("2.")} fill in ${chalk.white(".env")} (see checklist above)`);
        console.log(`  ${chalk.dim("3.")} ${chalk.white("fixd doctor")} — diagnose & verify`);
    } else {
        console.log(`  ${chalk.dim("2.")} ${chalk.white("fixd doctor")} — diagnose & verify`);
    }
    console.log();

    closePrompt();
}