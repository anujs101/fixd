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
import { checkAllEndpoints } from "./lib/agent.js";
import { loadConfig, migrateLegacyConfig } from "./lib/endpoints.js";
import {
    printHeader,
    error,
    info,
    spin,
    bye,
    warn as displayWarn,
} from "./lib/display.js";
import { checkForUpdate, getCurrentVersion } from "./lib/versionCheck.js";

const VERSION = getCurrentVersion();

// ─── Help text ────────────────────────────────────────────────────────────────

function printHelp() {
    console.log();
    console.log(`  ${chalk.bold.white("fixd")} ${chalk.dim(`v${VERSION}`)}`);
    console.log(`  ${chalk.dim("dev environment agent · configure endpoints via fixd config")}`);
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
        `    ${chalk.cyan("fixd config")}          ${chalk.dim("manage LLM endpoints and task routing")}`
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
    console.log(`  ${chalk.bold("Configuration:")}`);
    console.log(
        `    ${chalk.cyan("fixd config")}              ${chalk.dim("manage LLM endpoints and task routing")}`
    );
    console.log(
        `    ${chalk.dim("Config: ")}${chalk.white("~/.config/fixd/config.json")}`
    );
    console.log();
}

function printConfigHelp() {
    console.log();
    console.log(`  ${chalk.bold.white("fixd config")}`);
    console.log();
    console.log(`  ${chalk.bold("Commands:")}`);
    console.log(`    ${chalk.cyan("fixd config")}                    ${chalk.dim("interactive endpoint manager")}`);
    console.log(`    ${chalk.cyan("fixd config endpoints")}          ${chalk.dim("list configured endpoints")}`);
    console.log(`    ${chalk.cyan("fixd config routing")}           ${chalk.dim("show task → endpoint routing")}`);
    console.log(`    ${chalk.cyan("fixd config test <name>")}      ${chalk.dim("test an endpoint's connectivity")}`);
    console.log();
}

// ─── Status command ───────────────────────────────────────────────────────────

async function runStatus() {
    checkForUpdate().catch(() => {});
    printHeader("status");

    // Auto-migrate legacy config on first run
    const config = await loadConfig();
    const migrated = await migrateLegacyConfig(config);
    if (migrated) {
        info("Migrated legacy provider config to endpoint-based config.");
        info(`Config saved to ${path.join(os.homedir(), ".config", "fixd", "config.json")}`);
        console.log();
    }

    if (config.endpoints.length === 0) {
        console.log(`  ${chalk.yellow("⚠")} No endpoints configured.`);
        console.log(`  Run ${chalk.white("fixd config")} to set up LLM endpoints.`);
        console.log();
        return;
    }

    // Check each endpoint
    const results = await checkAllEndpoints();
    for (const r of results) {
        const s = spin(`checking ${r.name}...`);
        // Small delay for visual effect
        await new Promise(resolve => setTimeout(resolve, 300));
        s.stop();
        if (r.ok) {
            console.log(`  ${chalk.green("✔")} ${r.name} reachable`);
        } else {
            console.log(`  ${chalk.red("✖")} ${r.name}: ${r.error || "unreachable"}`);
        }
    }

    console.log();
    // Show routing table
    info("task routing:");
    for (const [task, route] of Object.entries(config.routing)) {
        if (route.endpoint) {
            console.log(`  ${chalk.dim(task.padEnd(12))} → ${chalk.white(route.endpoint)} / ${chalk.dim(route.model)}`);
        }
    }
    console.log();
    info(`project     : ${process.cwd()}`);
    info(`config dir  : ${path.join(os.homedir(), ".config", "fixd")}`);
    console.log();
}

// ─── Pre-flight check ─────────────────────────────────────────────────────────

async function preflight(): Promise<boolean> {
    const config = await loadConfig();

    // Auto-migrate legacy config
    await migrateLegacyConfig(config);

    // Reload config after migration
    const currentConfig = await loadConfig();

    if (currentConfig.endpoints.length === 0) {
        console.log();
        error("No LLM endpoints configured.");
        info(`Run ${chalk.white("fixd config")} to set up endpoints.`);
        info(`Config is stored in ${chalk.white("~/.config/fixd/config.json")}`);
        console.log();
        return false;
    }

    // Check that at least one endpoint is reachable
    const results = await checkAllEndpoints();
    const anyOk = results.some((r) => r.ok);
    if (!anyOk) {
        console.log();
        error("Cannot reach any configured endpoints.");
        info("Check your API keys and internet connection.");
        info(`Run ${chalk.white("fixd status")} for details.`);
        console.log();
        return false;
    }

    // Context7 is optional — warn but never block startup
    if (!process.env.CONTEXT7_API_KEY) {
        displayWarn("CONTEXT7_API_KEY not set — live library docs unavailable");
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
        runConfigList,
        runConfigRouting,
        runConfigTest,
    } = await import("./config.js");

    if (!subcommand) {
        await runConfigWizard();
    } else if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
        printConfigHelp();
    } else if (subcommand === "list" || subcommand === "endpoints") {
        await runConfigList();
    } else if (subcommand === "routing") {
        await runConfigRouting();
    } else if (subcommand === "test") {
        if (!value) { error("Usage: fixd config test <endpoint-name>"); process.exit(1); }
        await runConfigTest(value);
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
