#!/usr/bin/env node
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load API keys in priority order (fix 5.1):
// 1. ~/.config/fixd/.env  — XDG user config (recommended, keeps keys out of repo)
// 2. ~/.fixd/.env         — legacy fallback for non-XDG systems
// 3. <pkg>/../.env        — package-local .env (last resort, dev convenience only)
import os from "node:os";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(os.homedir(), ".config", "fixd", ".env") });
dotenvConfig({ path: path.join(os.homedir(), ".fixd", ".env"),   override: false });
dotenvConfig({ path: path.resolve(__dirname, "../.env"),           override: false });
dotenvConfig({ path: path.resolve(__dirname, "../.env.local"),     override: false });
import chalk from "chalk";
import { checkHealth, checkOpenRouterHealth } from "./lib/agent.js";
import {
    printHeader,
    error,
    info,
    spin,
    bye,
} from "./lib/display.js";
import { SMALL_MODEL, LARGE_MODEL } from "./lib/llm.js";
import { checkForUpdate, getCurrentVersion } from "./lib/versionCheck.js";

const VERSION = getCurrentVersion();

// ─── Help text ────────────────────────────────────────────────────────────────

function printHelp() {
    console.log();
    console.log(`  ${chalk.bold.white("fixd")} ${chalk.dim(`v${VERSION}`)}`);
    console.log(`  ${chalk.dim("dev environment agent · powered by openrouter + groq")}`);
    console.log();
    console.log(`  ${chalk.bold("Usage:")}`);
    console.log(
        `    ${chalk.cyan("fixd doctor")}          ${chalk.dim("diagnose + fix your broken project")}`
    );
    console.log(
        `    ${chalk.cyan("fixd doctor --fast")}   ${chalk.dim("single-agent mode (faster, no parallel sub-agents)")}`
    );
    console.log(
        `    ${chalk.cyan("fixd doctor --plan")}   ${chalk.dim("show diagnosis and fix plan before applying any changes")}`
    );
    console.log(
        `    ${chalk.cyan("fixd plan")}            ${chalk.dim("diagnose project, preview fix plan, confirm before applying anything")}`
    );
    console.log(
        `    ${chalk.cyan("fixd init")}            ${chalk.dim("scaffold a new project from scratch")}`
    );
    console.log(
        `    ${chalk.cyan("fixd init --yes")}      ${chalk.dim("scaffold with all defaults (hono + neon + prisma + bun)")}`
    );
    console.log(
        `    ${chalk.cyan("fixd config")}          ${chalk.dim("manage API keys and configuration")}`
    );
    console.log(
        `    ${chalk.cyan("fixd update")}          ${chalk.dim("update fixd to the latest npm version")}`
    );
    console.log(
        `    ${chalk.cyan("fixd deploy")}          ${chalk.dim("containerize project with Docker")}`
    );
    console.log(
        `    ${chalk.cyan("fixd undo")}            ${chalk.dim("restore files from the last patch session")}`
    );
    console.log(
        `    ${chalk.cyan("fixd status")}          ${chalk.dim("check API connectivity")}`
    );
    console.log();
    console.log(`  ${chalk.bold("Options:")}`);
    console.log(
        `    ${chalk.cyan("--help, -h")}           ${chalk.dim("show this help message")}`
    );
    console.log(
        `    ${chalk.cyan("--version, -v")}        ${chalk.dim("show version")}`
    );
    console.log(
        `    ${chalk.cyan("--fast")}               ${chalk.dim("skip parallel sub-agents (doctor only)")}`
    );
    console.log();
    console.log(`  ${chalk.bold("Env vars:")}`);
    console.log(
        `    ${chalk.cyan("FIXD_AUTO_RUN_LEVEL")}  ${chalk.dim("conservative | moderate (default) | aggressive")}`
    );
    console.log(
        `    ${chalk.cyan("FIXD_EXPLORE_MODEL")}   ${chalk.dim("small (default) | large — model for classifier/explore")}`
    );
    console.log();
    console.log(
        `  ${chalk.dim("Requires: ")}${chalk.white("OPENROUTER_API_KEY")} + ${chalk.white("GROQ_API_KEY")} ${chalk.dim("in ~/.config/fixd/.env")}`
    );
    console.log();
}

function printConfigHelp() {
    console.log();
    console.log(`  ${chalk.bold.white("fixd config")}`);
    console.log();
    console.log(`  ${chalk.bold("Examples:")}`);
    console.log(`    ${chalk.cyan("fixd config")}                    ${chalk.dim("interactive setup wizard")}`);
    console.log(`    ${chalk.cyan("fixd config list")}               ${chalk.dim("show all configured keys")}`);
    console.log(`    ${chalk.cyan("fixd config set GROQ_API_KEY=sk-...")}`);
    console.log(`    ${chalk.cyan("fixd config get GROQ_API_KEY")}`);
    console.log(`    ${chalk.cyan("fixd config delete GROQ_API_KEY")}`);
    console.log();
}

// ─── Status command ───────────────────────────────────────────────────────────

async function runStatus() {
    checkForUpdate().catch(() => {});
    printHeader("status");

    // Small model — Groq
    const s1 = spin("checking Groq API...");
    const groqOk = await checkHealth();
    s1.stop();
    if (groqOk) {
        console.log(`  ${chalk.green("✔")} Groq API reachable`);
    } else {
        console.log(`  ${chalk.red("✖")} Groq API unreachable — check GROQ_API_KEY`);
    }

    // Large model — OpenRouter (fix 10.2)
    const s2 = spin("checking OpenRouter API...");
    const orStatus = await checkOpenRouterHealth();
    s2.stop();
    if (orStatus === "ok") {
        console.log(`  ${chalk.green("✔")} OpenRouter API reachable`);
    } else if (orStatus === "no_key") {
        console.log(`  ${chalk.yellow("⚠")} OpenRouter: OPENROUTER_API_KEY not set`);
    } else {
        console.log(`  ${chalk.red("✖")} OpenRouter API unreachable — check OPENROUTER_API_KEY`);
    }

    console.log();
    info(`small model : ${SMALL_MODEL}`);
    info(`large model : ${LARGE_MODEL}`);
    info(`project     : ${process.cwd()}`);
    info(`config dir  : ${path.join(os.homedir(), ".config", "fixd")}`);
    console.log();
}

// ─── Pre-flight check ─────────────────────────────────────────────────────────

async function preflight(): Promise<boolean> {
    const key = process.env.GROQ_API_KEY;
    if (!key) {
        console.log();
        error("GROQ_API_KEY is not set.");
        info(`Add ${chalk.white("GROQ_API_KEY=<your-key>")} to your .env file.`);
        info("Get a key at: https://console.groq.com/keys");
        console.log();
        return false;
    }

    // Context7 is optional — warn but never block startup
    if (!process.env.CONTEXT7_API_KEY) {
        const { warn: displayWarn } = await import("./lib/display.js");
        displayWarn("CONTEXT7_API_KEY not set — live library docs unavailable");
    }

    const healthy = await checkHealth();
    if (!healthy) {
        console.log();
        error("Cannot reach the Groq API.");
        info("Check your GROQ_API_KEY or internet connection.");
        console.log();
        return false;
    }

    // R1: warn (don't block) if OPENROUTER_API_KEY is missing — large-model calls
    // will fall through to Clarifai, so the CLI is still usable.
    if (!process.env.OPENROUTER_API_KEY) {
        const { warn: displayWarn } = await import("./lib/display.js");
        displayWarn("OPENROUTER_API_KEY not set — large-model calls will fall back to Clarifai");
    }

    return true;
}

// ─── Lazy load commands ───────────────────────────────────────────────────────

// L136: renamed from runUndo — the old name caused the imported { runUndo } to
// shadow the outer function, which is a TS/lint error and confusing to read.
async function launchUndo() {
    const { runUndo } = await import("./undo.js");
    await runUndo();
}

async function runDoctor(fast = false, plan = false) {
    const { runDoctor: _runDoctor } = await import("./doctor.js");
    await _runDoctor(undefined, fast, plan);
}

async function runInit(useDefaults = false) {
    const { runInit: _runInit } = await import("./init.js");
    await _runInit(useDefaults);
}

async function runDeploy(options: { build?: boolean; run?: boolean; push?: boolean } = {}) {
    const { runDeploy } = await import("./deploy.js");
    await runDeploy(process.cwd(), options);
}

async function runUpdate() {
    const { runUpdate } = await import("./update.js");
    await runUpdate();
}

async function runConfig(subcommand?: string, value?: string) {
    const {
        runConfigWizard,
        runConfigSet,
        runConfigGet,
        runConfigList,
        runConfigDelete,
    } = await import("./config.js");

    if (!subcommand) {
        await runConfigWizard();
    } else if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
        printConfigHelp();
    } else if (subcommand === "list") {
        runConfigList();
    } else if (subcommand === "set") {
        if (!value) { error("Usage: fixd config set KEY=VALUE"); process.exit(1); }
        runConfigSet(value);
    } else if (subcommand === "get") {
        if (!value) { error("Usage: fixd config get KEY"); process.exit(1); }
        runConfigGet(value);
    } else if (subcommand === "delete") {
        if (!value) { error("Usage: fixd config delete KEY"); process.exit(1); }
        runConfigDelete(value);
    } else if (subcommand.includes("=")) {
        runConfigSet(subcommand);
    } else {
        error(`Unknown config subcommand: ${subcommand}. Run fixd config --help`);
        process.exit(1);
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const flags = args.slice(1);

    if (!command || command === "--help" || command === "-h" || flags.includes("--help") || flags.includes("-h") || command === "help") {
        printHelp();
        return;
    }

    if (command === "--version" || command === "-v" || flags.includes("--version") || flags.includes("-v") || command === "version") {
        console.log(`fixd v${VERSION}`);
        return;
    }

    switch (command) {
        case "doctor": {
            checkForUpdate().catch(() => {});
            if (!(await preflight())) break;
            await runDoctor(flags.includes("--fast"), flags.includes("--plan"));
            break;
        }
        case "init": {
            checkForUpdate().catch(() => {});
            if (!(await preflight())) break;
            await runInit(flags.includes("--yes") || flags.includes("-y"));
            break;
        }
        case "deploy": {
            await runDeploy({
                build: flags.includes("--build") ? true : undefined,
                run: flags.includes("--run") ? true : undefined,
                push: flags.includes("--push") ? true : undefined,
            });
            break;
        }
        case "config": {
            await runConfig(flags[0], flags[1]);
            break;
        }
        case "update": {
            await runUpdate();
            break;
        }
        case "plan": {
            if (!(await preflight())) break;
            // plan = doctor --plan --fast (show diagnosis without auto-applying)
            await runDoctor(true, true);
            break;
        }
        case "undo": {
            await launchUndo();
            break;
        }
        case "status": {
            await runStatus();
            break;
        }
        default: {
            error(`unknown command: ${chalk.white(command)}`);
            info(`run ${chalk.white("fixd --help")} to see available commands`);
            process.exit(1);
        }
    }
}

main().catch((err) => {
    error(err.message ?? "unexpected error");
    process.exit(1);
});
