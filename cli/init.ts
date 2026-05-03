import chalk from "chalk";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { askStream } from "./lib/llm.js";
import { disconnect } from "./lib/agent.js";
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

// ─── Parse streamed response for file blocks ──────────────────────────────────
// Detects ``` filename.ext ... ``` blocks and writes them to disk.

interface ParsedFile {
    filename: string;
    content: string;
}

function parseFileBlocks(response: string): ParsedFile[] {
    const files: ParsedFile[] = [];
    // Match ```filename.ext\n...content...\n``` — filename must have an extension
    const blockRe = /```([\w./\-]+\.\w+)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(response)) !== null) {
        files.push({ filename: match[1], content: match[2] });
    }
    return files;
}

function writeScaffoldFiles(projectName: string, files: ParsedFile[]): string[] {
    const written: string[] = [];
    const base = path.join(process.cwd(), projectName);

    for (const f of files) {
        const dest = path.join(base, f.filename);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, f.content, "utf-8");
        written.push(f.filename);
    }

    return written;
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

    // ── Stream scaffold from LLM ───────────────────────────────────────────────
    section("scaffolding");

    const scaffoldPrompt = `
Scaffold a complete, production-ready project with these specs:
- Project name: ${projectName}
- Backend framework: ${framework || "hono"}
- Database: ${database || "postgres"}
${dbHost ? `- Database hosting: ${dbHost}` : ""}
- ORM: ${orm || "prisma"}
- Auth: ${auth || "none"}
- Frontend: ${frontend || "none"}
- Package manager: ${pkgManager || "bun"}
- Output directory: ${process.cwd()}/${projectName}

Generate ALL config files. For EACH file, output it in this exact format:
\`\`\`filename.ext
<file content here>
\`\`\`

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

    // ── Write files to disk ────────────────────────────────────────────────────
    const files = parseFileBlocks(fullResponse);

    if (files.length === 0) {
        warn("No file blocks found in response. Check the output above and create files manually.");
    } else {
        section("writing files");
        const written = writeScaffoldFiles(projectName, files);
        for (const f of written) {
            success(`wrote: ${projectName}/${f}`);
        }
        console.log();

        // ── Git init ───────────────────────────────────────────────────────────
        const gitSpinner = spin("initialising git...");
        const projectDir = path.join(process.cwd(), projectName);
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