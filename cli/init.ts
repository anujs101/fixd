import chalk from "chalk";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { askStream } from "./lib/llm.js";
import { disconnect } from "./lib/agent.js";
import { proposeAndApply } from "./lib/patcher.js";
import { fetchDocsForStack, formatDocsForPrompt } from "./lib/context7.js";
import { runCommand } from "./lib/executor.js";

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

// Stack choices
const FRAMEWORKS   = ["hono", "express", "fastify"];
const DATABASES    = ["postgres", "mysql", "sqlite", "mongodb", "none"];
const POSTGRES_HOSTS = ["neon", "supabase", "railway", "local"];
const ORMS         = ["prisma", "drizzle", "none"];
const AUTHS        = ["better-auth", "clerk", "none"];
const FRONTENDS    = ["next", "vite-react", "none"];
const PKG_MANAGERS = ["bun", "pnpm", "npm"];

function choose(label: string, options: string[]): string {
    return `${label} (${options.join(" / ")})`;
}

/**
 * Strip the `projectName/` prefix from all <<<WRITE: paths so patcher
 * resolves correctly when projectDir is already the project root.
 * e.g. "myapp/src/index.ts" → "src/index.ts"
 */
function stripProjectPrefix(response: string, projectName: string): string {
    const prefix = `${projectName}/`;
    // Replace <<<WRITE: myapp/path>>> with <<<WRITE: path>>>
    return response.replace(
        /<<<WRITE:\s*([^>\n]+)>>>/g,
        (_match, rawPath: string) => {
            const trimmed = rawPath.trim();
            const stripped = trimmed.startsWith(prefix)
                ? trimmed.slice(prefix.length)
                : trimmed;
            return `<<<WRITE: ${stripped}>>>`;
        }
    );
}

export async function runInit() {
    printHeader("init");
    info("let's scaffold your project. answer a few questions.");
    console.log();

    // ── Interview ──────────────────────────────────────────────────────────────
    const projectName = await prompt("project name");
    if (!projectName) {
        warn("project name is required");
        closePrompt();
        return;
    }

    const framework  = await prompt(choose("backend framework", FRAMEWORKS));
    const database   = await prompt(choose("database", DATABASES));

    let dbHost = "";
    if (database === "postgres") {
        dbHost = await prompt(choose("postgres hosting", POSTGRES_HOSTS));
    }

    const orm        = await prompt(choose("ORM", ORMS));
    const auth       = await prompt(choose("auth", AUTHS));
    const frontend   = await prompt(choose("frontend", FRONTENDS));
    const pkgManager = await prompt(choose("package manager", PKG_MANAGERS));

    // ── Confirm ────────────────────────────────────────────────────────────────
    section("your stack");
    console.log(`  ${chalk.dim("project")}      ${chalk.white(projectName)}`);
    console.log(`  ${chalk.dim("framework")}    ${chalk.white(framework || "hono")}`);
    console.log(`  ${chalk.dim("database")}     ${chalk.white(database || "postgres")}`);
    if (dbHost) console.log(`  ${chalk.dim("db host")}      ${chalk.white(dbHost)}`);
    console.log(`  ${chalk.dim("orm")}          ${chalk.white(orm || "prisma")}`);
    console.log(`  ${chalk.dim("auth")}         ${chalk.white(auth || "none")}`);
    console.log(`  ${chalk.dim("frontend")}     ${chalk.white(frontend || "none")}`);
    console.log(`  ${chalk.dim("pkg manager")}  ${chalk.white(pkgManager || "bun")}`);
    console.log();

    const go = await confirm("scaffold this project?");
    if (!go) {
        info("cancelled.");
        closePrompt();
        return;
    }

    // ── Fetch live docs from Context7 before generating ──────────────────────
    const docsSpinner = spin("fetching latest docs...");
    const docsResult = await fetchDocsForStack({
        framework: framework || "hono",
        orm:       orm      !== "none" ? orm      : undefined,
        auth:      auth     !== "none" ? auth     : undefined,
        runtime:   pkgManager === "bun" ? "bun" : "node",
        database:  database  !== "none" ? database : undefined,
    }).catch(() => ({ docs: [], totalTokens: 0, skipped: [] as string[] }));
    docsSpinner.stop();

    if (docsResult.docs.length > 0) {
        info(`fetched docs for: ${docsResult.docs.map((d) => d.libraryId.split("/").at(-1)).join(", ")}`);
    }
    if (docsResult.skipped.length > 0) {
        info(`skipped (no docs found): ${docsResult.skipped.join(", ")}`);
    }

    const docsContext = formatDocsForPrompt(docsResult.docs);

    // ── Build scaffold prompt ────────────────────────────────────────────────
    const scaffoldPrompt = `
${docsContext ? docsContext + "\n\n" : ""}Scaffold a complete, production-ready project with these specs:
- Project name: ${projectName}
- Backend framework: ${framework || "hono"}
- Database: ${database || "postgres"}
${dbHost ? `- Database hosting: ${dbHost}` : ""}
- ORM: ${orm || "prisma"}
- Auth: ${auth || "none"}
- Frontend: ${frontend || "none"}
- Package manager: ${pkgManager || "bun"}
- Output directory: ${projectName}/

OUTPUT RULES — follow exactly or files will not be created:
1. Output EVERY file using this exact format:
<<<WRITE: ${projectName}/path/to/file>>>
full file content here
<<<END>>>

2. Files to generate (minimum):
   - ${projectName}/package.json
   - ${projectName}/tsconfig.json
   - ${projectName}/.env
   - ${projectName}/.env.example
   - ${projectName}/.gitignore
   - ${projectName}/README.md
   - ${projectName}/src/index.ts (entry point)
   ${orm === "prisma" ? `- ${projectName}/prisma/schema.prisma` : ""}
   ${auth !== "none" ? `- ${projectName}/src/lib/auth.ts` : ""}

3. After ALL file blocks, output exactly one line:
   SCAFFOLD_COMPLETE

4. No prose before the first <<<WRITE block.
5. No explanations between file blocks.
6. Use current syntax from the injected documentation above — not training data.
`.trim();

    // ── Collect full streamed response (don't print raw) ────────────────────
    section("scaffolding");
    const genSpinner = spin("generating project...");

    let fullResponse = "";
    try {
        for await (const chunk of askStream(scaffoldPrompt, "generate")) {
            fullResponse += chunk;
            // Show live file count without printing raw text
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

    // Strip <think>...</think> blocks from extended-thinking models
    const clean = fullResponse.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    if (!clean.includes("<<<WRITE:")) {
        warn("agent did not output any file blocks — raw response:");
        console.log(chalk.dim(clean.slice(0, 600)));
        closePrompt();
        return;
    }

    // ── Strip projectName prefix from paths so patcher resolves correctly ────
    // Agent outputs: <<<WRITE: myapp/src/index.ts>>>
    // projectDir is already: /cwd/myapp  — so we need: src/index.ts
    const normalised = stripProjectPrefix(clean, projectName);

    // ── Create project directory ─────────────────────────────────────────────
    const projectDir = path.join(process.cwd(), projectName);
    try {
        await fs.mkdir(projectDir, { recursive: true });
    } catch (err: any) {
        warn(`could not create ${projectDir}: ${err.message}`);
        closePrompt();
        return;
    }

    // ── Write files via patcher (autoApprove — user confirmed above) ─────────
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

    // ── Git init + initial commit ─────────────────────────────────────────────
    section("setup");
    const gitSpinner = spin("initialising git...");
    try {
        await execa("git", ["init"],                                              { cwd: projectDir });
        await execa("git", ["add", "."],                                          { cwd: projectDir });
        await execa("git", ["commit", "-m", "init: fixd scaffold"],               { cwd: projectDir });
        gitSpinner.stop();
        success("git repository initialised with initial commit");
    } catch (err: any) {
        gitSpinner.stop();
        warn(`git init failed — run manually: cd ${projectName} && git init`);
    }

    // ── Install dependencies ──────────────────────────────────────────────────
    const installCmd = pkgManager === "bun"  ? "bun install"
                     : pkgManager === "pnpm" ? "pnpm install"
                     : pkgManager === "yarn" ? "yarn"
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

    console.log();
    closePrompt();
    bye();
    disconnect();
}