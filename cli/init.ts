import chalk from "chalk";
import path from "node:path";
import { execa } from "execa";
import { askStream } from "./lib/llm.js";
import { disconnect } from "./lib/agent.js";
import { proposeAndApply } from "./lib/patcher.js";
import { fetchDocsForStack, formatDocsForPrompt } from "./lib/context7.js";

import {
    printHeader,
    agentSays,
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
const FRAMEWORKS = ["hono", "express", "fastify"];
const DATABASES = ["postgres", "mysql", "sqlite", "mongodb", "none"];
const POSTGRES_HOSTS = ["neon", "supabase", "railway", "local"];
const ORMS = ["prisma", "drizzle", "none"];
const AUTHS = ["better-auth", "clerk", "none"];
const FRONTENDS = ["next", "vite-react", "none"];
const PKG_MANAGERS = ["bun", "pnpm", "npm"];

function choose(label: string, options: string[]): string {
    return `${label} (${options.join(" / ")})`;
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

    const framework = await prompt(choose("backend framework", FRAMEWORKS));
    const database = await prompt(choose("database", DATABASES));

    let dbHost = "";
    if (database === "postgres") {
        dbHost = await prompt(choose("postgres hosting", POSTGRES_HOSTS));
    }

    const orm = await prompt(choose("ORM", ORMS));
    const auth = await prompt(choose("auth", AUTHS));
    const frontend = await prompt(choose("frontend", FRONTENDS));
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
        orm: orm !== "none" ? orm : undefined,
        auth: auth !== "none" ? auth : undefined,
        runtime: pkgManager === "bun" ? "bun" : "node",
        database: database !== "none" ? database : undefined,
    }).catch(() => ({ docs: [], totalTokens: 0, skipped: [] as string[] }));
    docsSpinner.stop();

    if (docsResult.docs.length > 0) {
        info(`fetched docs for: ${docsResult.docs.map((d) => d.libraryId.split("/").at(-1)).join(", ")}`);
    }
    if (docsResult.skipped.length > 0) {
        info(`skipped (no docs found): ${docsResult.skipped.join(", ")}`);
    }

    const docsContext = formatDocsForPrompt(docsResult.docs);

    // ── Stream scaffold from LLM ────────────────────────────────────────────
    section("scaffolding");

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

Generate ALL config files. Use this EXACT format for each file:
<<<WRITE: filename.ext>>>
<file content here>
<<<END>>>

Required files: tsconfig.json, .env.example, .gitignore, package.json (with correct scripts), README.md.
If ORM is prisma: include prisma/schema.prisma with correct connection string format.
If auth is not none: include the auth config file.
Use correct connection string format for the chosen database hosting.
Do not add explanations between files — just output the file blocks.
  `.trim();


    console.log();
    info("streaming scaffold — files will be written after completion...");
    console.log();

    let fullResponse = "";

    try {
        for await (const chunk of askStream(scaffoldPrompt, "generate")) {
            process.stdout.write(chunk);
            fullResponse += chunk;
        }
        console.log("\n");
    } catch (err: any) {
        warn(`Scaffold generation failed: ${err.message}`);
        closePrompt();
        return;
    }

    // ── Write files via patcher (autoApprove — user already confirmed above) ──────
    const projectDir = path.join(process.cwd(), projectName);
    const results = await proposeAndApply(fullResponse, projectDir, { autoApprove: true });
    const written = results.filter((r) => r.applied).map((r) => r.path);

    if (written.length === 0) {
        warn("No file blocks found in response. Check the output above and create files manually.");
    } else {
        section("writing files");
        for (const f of written) {
            success(`wrote: ${f}`);
        }
        console.log();

        // ── Git init ───────────────────────────────────────────────────────────
        const gitSpinner = spin("initialising git...");
        try {
            await execa("git", ["init"], { cwd: projectDir });
            await execa("git", ["add", "."], { cwd: projectDir });
            await execa("git", ["commit", "-m", "init: fixd scaffold"], { cwd: projectDir });
            gitSpinner.stop();
            success("git repository initialised with initial commit");
        } catch (err: any) {
            gitSpinner.stop();
            warn(`git init failed: ${err.message}`);
        }
    }


    console.log();
    closePrompt();
    bye();
    disconnect();
}