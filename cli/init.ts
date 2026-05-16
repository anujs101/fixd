import chalk from "chalk";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { askStream } from "./lib/llm.js";
import { disconnect } from "./lib/agent.js";
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
    bye,
} from "./lib/display.js";

// ─── Stack choices ────────────────────────────────────────────────────────────

const FRAMEWORKS   = ["hono", "express", "fastify"];
const DATABASES    = ["postgres", "mysql", "sqlite", "redis", "mongodb", "none"];
const POSTGRES_HOSTS = ["neon", "supabase", "railway", "local"];
const ORMS         = ["prisma", "drizzle", "none"];
const AUTHS        = ["better-auth", "jwt", "clerk", "none"];
const FRONTENDS    = ["next", "vite-react", "none"];
const PKG_MANAGERS = ["bun", "pnpm", "npm"];

// ─── Input normalizer ─────────────────────────────────────────────────────────
// Handles typos (postgress) and free-form descriptions ("jwt cookies based").

function normalizeInput(val: string, field: "database" | "framework" | "auth" | "frontend" | "pkgManager"): string {
    const v = val.trim().toLowerCase();
    if (!v) return v;

    const DB_MAP: Record<string, string> = {
        postgress: "postgres", postgresql: "postgres", pg: "postgres",
        mysql2: "mysql", mariadb: "mysql",
        sqlite3: "sqlite", libsql: "sqlite",
        mongo: "mongodb",
    };
    const AUTH_MAP: Record<string, string> = {
        jwt: "jwt", "jwt-cookies": "jwt", "jwt cookies": "jwt",
        "jwt based": "jwt", "jwt cookie": "jwt", "jwt cookie based": "jwt",
        "cookies jwt": "jwt", "httponly cookies": "jwt", "cookie based": "jwt",
        "jwt cookies based": "jwt", "session": "jwt", sessions: "jwt",
        betterauth: "better-auth", better_auth: "better-auth",
    };
    const FW_MAP: Record<string, string> = {
        expresss: "express", "express.js": "express", expressjs: "express",
        "fastify.js": "fastify", fastifyjs: "fastify",
        "hono.js": "hono",
    };
    const FE_MAP: Record<string, string> = {
        vite: "vite-react", "vite react": "vite-react", vitereact: "vite-react",
        react: "vite-react", "react vite": "vite-react",
        nextjs: "next", "next.js": "next",
    };
    const PKG_MAP: Record<string, string> = {
        "bun.js": "bun", bunjs: "bun",
    };

    switch (field) {
        case "database":   return DB_MAP[v]  ?? v;
        case "auth":       return AUTH_MAP[v] ?? v;
        case "framework":  return FW_MAP[v]  ?? v;
        case "frontend":   return FE_MAP[v]  ?? v;
        case "pkgManager": return PKG_MAP[v] ?? v;
    }
}

// Defaults for --yes mode
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

/**
 * Strip the `projectName/` prefix from all patch marker paths so patcher
 * resolves correctly when projectDir is already the project root.
 */
function stripProjectPrefix(response: string, projectName: string): string {
    const prefix = `${projectName}/`;
    return response.replace(
        /<<<(WRITE|EDIT|DELETE):\s*([^>\n]+)>>>/g,
        (_match, op: string, rawPath: string) => {
            const trimmed = rawPath.trim();
            const stripped = trimmed.startsWith(prefix)
                ? trimmed.slice(prefix.length)
                : trimmed;
            return `<<<${op}: ${stripped}>>>`;
        }
    );
}

// ─── .env var checker ─────────────────────────────────────────────────────────

async function checkEnvVars(projectDir: string, required: Array<{ name: string; description: string }>): Promise<void> {
    if (required.length === 0) return;

    let envContent = "";
    try {
        envContent = await fs.readFile(path.join(projectDir, ".env"), "utf-8");
    } catch {
        // .env doesn't exist yet
    }

    const missing = required.filter(({ name }) => {
        const re = new RegExp(`^${name}\\s*=\\s*.+`, "m");
        return !re.test(envContent);
    });

    if (missing.length === 0) return;

    console.log();
    console.log(chalk.yellow("  ⚠  fill these in .env before running:"));
    for (const { name, description } of missing) {
        console.log(`     ${chalk.white(name)}=${chalk.dim(`  # ${description}`)}`);
    }
}

// ─── Semantic git commit message ──────────────────────────────────────────────

function buildCommitMessage(spec: StackSpec): string {
    const parts: string[] = ["init: scaffold"];
    parts.push(spec.framework);
    if (spec.orm !== "none") parts.push(`+ ${spec.orm}`);
    if (spec.database !== "none") {
        const db = spec.dbHost ? `${spec.database}/${spec.dbHost}` : spec.database;
        parts.push(`+ ${db}`);
    }
    if (spec.auth !== "none") parts.push(`+ ${spec.auth}`);
    if (spec.frontend !== "none") parts.push(`+ ${spec.frontend}`);
    return parts.join(" ");
}

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

    if (!projectName) {
        warn("project name is required");
        closePrompt();
        return;
    }

    const norm = (s: string) => s.trim().toLowerCase();

    let framework: string, database: string, dbHost: string,
        orm: string, auth: string, frontend: string, pkgManager: string;

    if (useDefaults) {
        framework  = DEFAULTS.framework;
        database   = DEFAULTS.database;
        dbHost     = DEFAULTS.dbHost;
        orm        = DEFAULTS.orm;
        auth       = DEFAULTS.auth;
        frontend   = DEFAULTS.frontend;
        pkgManager = DEFAULTS.pkgManager;
        info(`using defaults: ${chalk.white([framework, database, dbHost, orm].join(" + "))}`);
        console.log();
    } else {
        framework  = normalizeInput(norm(await prompt(choose("backend framework", FRAMEWORKS))), "framework");
        database   = normalizeInput(norm(await prompt(choose("database", DATABASES))), "database");
        dbHost     = "";
        if (database === "postgres") {
            dbHost = norm(await prompt(choose("postgres hosting", POSTGRES_HOSTS)));
        }
        // Skip ORM question if DB is none or redis/mongodb (non-relational)
        const needsOrm = !["none", "redis", "mongodb"].includes(database);
        orm        = needsOrm ? norm(await prompt(choose("ORM", ORMS))) : "none";
        auth       = normalizeInput(norm(await prompt(choose("auth", AUTHS))), "auth");
        frontend   = normalizeInput(norm(await prompt(choose("frontend", FRONTENDS))), "frontend");
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
    console.log(`  ${chalk.dim("auth")}         ${chalk.white(spec.auth)}`);
    console.log(`  ${chalk.dim("frontend")}     ${chalk.white(spec.frontend)}`);
    console.log(`  ${chalk.dim("pkg manager")}  ${chalk.white(spec.pkgManager)}`);
    console.log();

    if (!useDefaults) {
        const go = await confirm("scaffold this project?");
        if (!go) {
            info("cancelled.");
            closePrompt();
            return;
        }
    }

    // ── Plan sub-agent: get file manifest before generating ───────────────────

    const planSpinner = spin("planning scaffold...");
    const scaffoldPlan = await planScaffold(spec).catch(() => null);
    planSpinner.stop();

    if (scaffoldPlan?.files && scaffoldPlan.files.length > 0) {
        const SHOW_MAX = 8;
        const shown = scaffoldPlan.files.slice(0, SHOW_MAX);
        const extra = scaffoldPlan.files.length - SHOW_MAX;
        console.log(chalk.dim(`  files to generate (${scaffoldPlan.files.length}):`));
        for (const f of shown) {
            console.log(`    ${chalk.dim("·")} ${chalk.white(f.path)}`);
        }
        if (extra > 0) {
            console.log(`    ${chalk.dim(`  … and ${extra} more`)}`);
        }
        if (scaffoldPlan.gotchas?.length > 0) {
            console.log(chalk.dim("  stack notes:"));
            for (const g of scaffoldPlan.gotchas.slice(0, 3)) {
                console.log(`    ${chalk.yellow("⚠")} ${chalk.dim(g)}`);
            }
        }
        console.log();
    }

    // ── Fetch live docs from Context7 ─────────────────────────────────────────

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
        info(`fetched docs for: ${docsResult.docs.map((d) => d.libraryId.split("/").at(-1)).join(", ")}`);
    }
    if (docsResult.skipped.length > 0) {
        info(`skipped (no docs found): ${docsResult.skipped.join(", ")}`);
    }

    const docsContext = formatDocsForPrompt(docsResult.docs);

    // ── Build scaffold prompt (augmented with plan) ───────────────────────────

    const planContext = scaffoldPlan
        ? [
            `PRE-PLANNED FILE LIST (generate ALL of these):`,
            scaffoldPlan.files.map((f) => `  - ${projectName}/${f.path}  # ${f.reason}`).join("\n"),
            ``,
            scaffoldPlan.gotchas?.length > 0
                ? `IMPORTANT GOTCHAS FOR THIS STACK:\n${scaffoldPlan.gotchas.map((g) => `  - ${g}`).join("\n")}`
                : "",
          ].filter(Boolean).join("\n")
        : "";

    // Build frontend-specific minimum file list so the LLM can't skip it
    const frontendMinFiles: string[] = [];
    if (spec.frontend === "vite-react") {
        frontendMinFiles.push(
            `   - ${projectName}/frontend/package.json`,
            `   - ${projectName}/frontend/vite.config.ts`,
            `   - ${projectName}/frontend/index.html`,
            `   - ${projectName}/frontend/tsconfig.json`,
            `   - ${projectName}/frontend/src/main.tsx`,
            `   - ${projectName}/frontend/src/App.tsx`,
        );
    } else if (spec.frontend === "next") {
        frontendMinFiles.push(
            `   - ${projectName}/frontend/package.json`,
            `   - ${projectName}/frontend/next.config.ts`,
            `   - ${projectName}/frontend/tsconfig.json`,
            `   - ${projectName}/frontend/app/layout.tsx`,
            `   - ${projectName}/frontend/app/page.tsx`,
        );
    }

    const scaffoldPrompt = [
        docsContext ? docsContext + "\n" : "",
        planContext ? planContext + "\n" : "",
        `Scaffold a complete, production-ready project with these specs:`,
        `- Project name: ${projectName}`,
        `- Backend framework: ${spec.framework}`,
        `- Database: ${spec.database}`,
        spec.dbHost ? `- Database hosting: ${spec.dbHost}` : "",
        `- ORM: ${spec.orm}`,
        spec.auth !== "none" ? `- Auth: ${spec.auth} (implement fully with middleware and routes)` : `- Auth: none`,
        spec.frontend !== "none"
            ? `- Frontend: ${spec.frontend} — MUST be fully scaffolded inside ${projectName}/frontend/`
            : `- Frontend: none`,
        `- Package manager: ${spec.pkgManager}`,
        `- Output directory: ${projectName}/`,
        ``,
        `OUTPUT RULES — follow exactly or files will not be created:`,
        `1. Output EVERY file using this exact format:`,
        `<<<WRITE: ${projectName}/path/to/file>>>`,
        `full file content here`,
        `<<<END>>>`,
        ``,
        `2. Files to generate (minimum):`,
        `   - ${projectName}/package.json`,
        `   - ${projectName}/tsconfig.json`,
        `   - ${projectName}/.env`,
        `   - ${projectName}/.env.example`,
        `   - ${projectName}/.gitignore`,
        `   - ${projectName}/README.md`,
        `   - ${projectName}/src/index.ts (entry point)`,
        spec.orm === "prisma" ? `   - ${projectName}/prisma/schema.prisma` : "",
        spec.auth !== "none" ? `   - ${projectName}/src/lib/auth.ts` : "",
        ...frontendMinFiles,
        ``,
        `3. After ALL file blocks, output exactly one line:`,
        `   SCAFFOLD_COMPLETE`,
        ``,
        `4. No prose before the first <<<WRITE block.`,
        `5. No explanations between file blocks.`,
        `6. Use current syntax from the injected documentation — not training data.`,
        `7. Apply all gotchas listed above.`,
        spec.frontend !== "none"
            ? `8. CRITICAL: frontend is "${spec.frontend}" — generate ALL frontend files listed above. Do NOT say "frontend not included", "frontend is a separate project", or skip any frontend files. They are required in this scaffold.`
            : "",
    ].filter(Boolean).join("\n").trim();

    // ── Generate scaffold ─────────────────────────────────────────────────────

    section("scaffolding");
    const genSpinner = spin("generating project...");

    let fullResponse = "";
    try {
        for await (const chunk of askStream(scaffoldPrompt, "generate")) {
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

    for (const r of written) {
        success(`created: ${r.path}`);
    }
    for (const r of failed) {
        warn(`failed:  ${r.path}${r.error ? ` — ${r.error}` : ""}`);
    }

    if (written.length === 0) {
        warn("no files written — check agent output format");
        closePrompt();
        return;
    }

    // ── Git init ──────────────────────────────────────────────────────────────

    section("setup");
    const gitSpinner = spin("initialising git...");
    try {
        await execa("git", ["init"],                { cwd: projectDir });
        await execa("git", ["add", "."],            { cwd: projectDir });
        const commitMsg = buildCommitMessage(spec);
        await execa("git", ["commit", "-m", commitMsg], { cwd: projectDir });
        gitSpinner.stop();
        success(`git repository initialised: ${chalk.dim(commitMsg)}`);
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
        warn(`install failed — run manually:`);
        console.log(`  ${chalk.dim(`cd ${projectName} && ${installCmd}`)}`);
    }

    // ── Post-install: prisma generate ─────────────────────────────────────────

    const postInstallSteps = scaffoldPlan?.installStepsAfter ?? [];

    // Always run prisma generate if prisma is the ORM, regardless of plan
    if (spec.orm === "prisma" && !postInstallSteps.includes("prisma generate")) {
        postInstallSteps.push("prisma generate");
    }

    for (const step of postInstallSteps) {
        const stepSpinner = spin(`running: ${step}...`);
        const stepResult  = await runCommand(step, projectDir);
        stepSpinner.stop();
        if (stepResult.exitCode === 0) {
            success(`${step} — done`);
        } else {
            warn(`${step} failed (run manually after filling .env)`);
        }
    }

    // ── Generate FIXD.md ──────────────────────────────────────────────────────

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
        await checkEnvVars(projectDir, scaffoldPlan.envVarsRequired);
    }

    // ── Done — no auto-doctor ─────────────────────────────────────────────────

    console.log();
    section("done");
    success(`${chalk.white(projectName)} scaffolded in ${chalk.dim(projectDir)}`);
    console.log();
    info(`next steps:`);
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