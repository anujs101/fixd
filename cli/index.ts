#!/usr/bin/env node
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load .env from the fixd package root (cli/../.env),
// NOT from process.cwd() which changes depending on where the user runs fixd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "../.env") });
dotenvConfig({ path: path.resolve(__dirname, "../.env.local"), override: false }); // allow local overrides
import chalk from "chalk";
import { checkHealth } from "./lib/agent.js";
import {
    printHeader,
    error,
    info,
    spin,
    bye,
} from "./lib/display.js";
import { SMALL_MODEL, LARGE_MODEL } from "./lib/llm.js";

const VERSION = "0.1.0";

// ─── Help text ────────────────────────────────────────────────────────────────

function printHelp() {
    console.log();
    console.log(`  ${chalk.bold.white("fixd")} ${chalk.dim(`v${VERSION}`)}`);
    console.log(`  ${chalk.dim("dev environment agent · powered by groq + nosana")}`);
    console.log();
    console.log(`  ${chalk.bold("Usage:")}`);
    console.log(
        `    ${chalk.cyan("fixd doctor")}   ${chalk.dim("diagnose + fix your broken project")}`
    );
    console.log(
        `    ${chalk.cyan("fixd init")}     ${chalk.dim("scaffold a new project from scratch")}`
    );
    console.log(
        `    ${chalk.cyan("fixd deploy")}   ${chalk.dim("containerize + ship to nosana GPU")}`
    );
    console.log(
        `    ${chalk.cyan("fixd status")}   ${chalk.dim("check groq API connectivity")}`
    );
    console.log();
    console.log(`  ${chalk.bold("Options:")}`);
    console.log(
        `    ${chalk.cyan("--help, -h")}    ${chalk.dim("show this help message")}`
    );
    console.log(
        `    ${chalk.cyan("--version, -v")} ${chalk.dim("show version")}`
    );
    console.log();
    console.log(
        `  ${chalk.dim("Requires: ")}${chalk.white("GROQ_API_KEY")} ${chalk.dim("in your .env")}`
    );
    console.log();
}

// ─── Status command ───────────────────────────────────────────────────────────

async function runStatus() {
    printHeader("status");
    const s = spin("checking groq API...");

    const healthy = await checkHealth();
    s.stop();

    if (!healthy) {
        error("Groq API is not reachable.");
        info("Make sure GROQ_API_KEY is set in your .env file.");
        info("Get a key at: https://console.groq.com/keys");
        process.exit(1);
    }

    console.log(`  ${chalk.green("✔")} Groq API reachable`);
    info(`small model : ${SMALL_MODEL}`);
    info(`large model : ${LARGE_MODEL}`);
    info(`project     : ${process.cwd()}`);
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

    return true;
}

// ─── Lazy load commands ───────────────────────────────────────────────────────

async function runDoctor() {
    const { runDoctor } = await import("./doctor.js");
    await runDoctor();
}

async function runInit() {
    const { runInit } = await import("./init.js");
    await runInit();
}

async function runDeploy() {
    const { runDeploy } = await import("./deploy.js");
    await runDeploy();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const flags = args.slice(1);

    if (!command || flags.includes("--help") || flags.includes("-h") || command === "help") {
        printHelp();
        return;
    }

    if (flags.includes("--version") || flags.includes("-v") || command === "version") {
        console.log(`fixd v${VERSION}`);
        return;
    }

    switch (command) {
        case "doctor": {
            if (!(await preflight())) break;
            await runDoctor();
            break;
        }
        case "init": {
            if (!(await preflight())) break;
            await runInit();
            break;
        }
        case "deploy": {
            if (!(await preflight())) break;
            await runDeploy();
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