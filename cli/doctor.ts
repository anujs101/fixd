import chalk from "chalk";
import path from "node:path";
import { sendMessage, disconnect } from "./lib/agent.js";
import { askStream } from "./lib/llm.js";
import { scanProject } from "../src/actions/scanFiles.js";
import { detectIssues, type DetectedIssue } from "../src/actions/fixEnv.js";
import { runDiagnostics, formatDiagnosticsForContext, getAllErrors } from "./lib/diagnostics.js";
import { extractPendingCommands, runCommand, formatResultForAgent } from "./lib/executor.js";
import {
    printHeader,
    agentSays,
    agentWantsToRun,
    printCommandResult,
    spin,
    section,
    info,
    warn,
    success,
    error,
    printIssue,
    printFix,
    prompt,
    confirm,
    closePrompt,
    bye,
} from "./lib/display.js";



// ─── Format scan context for agent ───────────────────────────────────────────

function buildScanContext(
    projectPath: string,
    scan: Awaited<ReturnType<typeof scanProject>>,
    diagContext: string
): string {
    const lines: string[] = [
        `PROJECT DIRECTORY: ${projectPath}`,
        `PACKAGE MANAGER: ${scan.detectedPackageManager}`,
        `NODE: ${scan.nodeVersion ?? "not found"} | BUN: ${scan.bunVersion ?? "not found"} | REQUIRED: ${scan.requiredNodeVersion ?? "unspecified"}`,
        "",
    ];

    if (scan.packageJson) {
        lines.push("PACKAGE.JSON:");
        lines.push(`  name: ${scan.packageJson.name ?? "unknown"}`);
        lines.push(`  scripts: ${JSON.stringify(scan.packageJson.scripts ?? {})}`);
        lines.push(`  dependencies: ${Object.keys(scan.packageJson.dependencies ?? {}).join(", ") || "none"}`);
        lines.push(`  devDependencies: ${Object.keys(scan.packageJson.devDependencies ?? {}).join(", ") || "none"}`);
        lines.push("");
    }

    lines.push(`TSCONFIG: ${scan.tsconfig ? "found" : "not found"}`);
    if (scan.tsconfig?.compilerOptions) {
        lines.push(`  strict: ${scan.tsconfig.compilerOptions.strict ?? false}`);
        lines.push(`  module: ${scan.tsconfig.compilerOptions.module ?? "unset"}`);
        lines.push(`  target: ${scan.tsconfig.compilerOptions.target ?? "unset"}`);
    }
    lines.push("");

    // ── Diagnostics from the multi-stack engine ──────────────────────────────
    if (diagContext) {
        lines.push("DIAGNOSTICS:");
        lines.push(diagContext);
    }

    lines.push("ENV:");
    lines.push(`  vars present: ${Object.keys(scan.env.vars).join(", ") || "none"}`);
    lines.push(`  missing: ${scan.env.missing.join(", ") || "none"}`);
    lines.push("");

    if (scan.prisma.found) {
        lines.push("PRISMA:");
        lines.push(`  provider: ${scan.prisma.provider}`);
        lines.push(`  connection: ${scan.prisma.connectionType}`);
        lines.push(`  directUrl: ${scan.prisma.hasDirectUrl}`);
        lines.push("");
    }

    if (scan.runningPorts.length > 0) {
        lines.push("RUNNING PORTS:");
        for (const p of scan.runningPorts) {
            lines.push(`  ${p.port} → PID ${p.pid} (${p.process})`);
        }
        lines.push("");
    }

    if (scan.errors.length > 0) {
        lines.push("SCAN ERRORS:");
        for (const e of scan.errors) lines.push(`  - ${e}`);
        lines.push("");
    }

    return lines.join("\n");
}

function withCwd(text: string, cwd: string): string {
    return `[Working directory: ${cwd}]\n\n${text}`;
}

// ─── Print detected issues ────────────────────────────────────────────────────

function printDetectedIssues(issues: DetectedIssue[]) {
    if (issues.length === 0) {
        success("No issues detected.");
        return;
    }

    for (const issue of issues) {
        printIssue(issue.severity, `${issue.type}`);
        console.log(`     ${chalk.dim(issue.description)}`);
        console.log(`     ${chalk.dim("Auto-fixable:")} ${issue.autoFixable ? chalk.green("yes") : chalk.yellow("no — manual action required")}`);
        console.log();
    }
}

// ─── Print diagnostics immediately (no LLM wait) ─────────────────────────────
// Shows tsc / eslint / etc. errors directly from the local runner so the
// developer sees them instantly, regardless of LLM response speed.

function printDiagnosticsImmediate(diagResults: Awaited<ReturnType<typeof runDiagnostics>>) {
    const errors = getAllErrors(diagResults);
    if (errors.length === 0) return;

    section("diagnostics");
    for (const e of errors) {
        const loc = [e.file, e.line, e.col].filter(Boolean).join(":");
        const code = e.code ? chalk.dim(`[${e.code}]`) : "";
        const prefix = chalk.red(`  ✖ [${e.stack.toUpperCase()}]`);
        const location = loc ? chalk.yellow(` ${loc}`) : "";
        console.log(`${prefix}${location} ${code} ${e.message}`);
    }
    console.log();
}

// ─── Main doctor flow ─────────────────────────────────────────────────────────

export async function runDoctor() {
    const projectPath = process.cwd();

    printHeader("doctor");
    info(`scanning project at ${chalk.white(projectPath)}`);
    console.log();

    // ── Phase 1: local scan + real diagnostics (deterministic, no LLM) ───────────
    const scanSpinner = spin("scanning project files...");
    let scan: Awaited<ReturnType<typeof scanProject>>;
    try {
        scan = await scanProject(projectPath);
    } catch (err: any) {
        scanSpinner.stop();
        warn(`Scan failed: ${err.message}`);
        process.exit(1);
    }
    scanSpinner.stop();

    // Run stack-aware diagnostics in parallel (tsc, eslint, mypy, cargo, go vet...)
    const diagSpinner2 = spin("running diagnostics...");
    const diagResults = await runDiagnostics(projectPath);
    diagSpinner2.stop();

    // ── Show diagnostic errors immediately — before sending to LLM ──────────
    printDiagnosticsImmediate(diagResults);

    const diagContext = formatDiagnosticsForContext(diagResults);
    const diagErrors = getAllErrors(diagResults);

    // ── Phase 2: detect issues locally ──────────────────────────────────────────
    const issues = detectIssues(scan, projectPath);

    // Add real errors from diagnostics as HIGH issues
    for (const e of diagErrors) {
        const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}${e.col ? `:${e.col}` : ""}` : "";
        issues.push({
            severity: "HIGH",
            type: `${e.stack.toUpperCase().replace(/\s+/g, "_")}_ERROR${e.code ? `_${e.code}` : ""}`,
            description: `${loc ? loc + " — " : ""}${e.message}`,
            autoFixable: false,
        });
    }

    const autoFixable = issues.filter((i) => i.autoFixable);
    const manual = issues.filter((i) => !i.autoFixable);

    section("issues found");
    printDetectedIssues(issues);

    // ── Phase 3: agent explains with REAL scan data ─────────────────────────────
    const scanContext = buildScanContext(projectPath, scan, diagContext);
    const issueList = issues.length > 0
        ? issues.map((i) => `- [${i.severity}] ${i.type}: ${i.description}`).join("\n")
        : "No issues detected.";

    const diagSpinner = spin("agent analysing...");

    const diagPrompt = [
        `You are fixd. The CLI has already scanned this project and ran real diagnostics.`,
        `The data below is AUTHORITATIVE — do not guess or invent issues not listed here.`,
        ``,
        `SCAN DATA:`,
        "```",
        scanContext,
        "```",
        ``,
        `DETECTED ISSUES (${issues.length} total):`,
        issueList,
        ``,
        `RULES:`,
        `- If TYPESCRIPT CHECK says PASSED, TypeScript is FINE. Do NOT say tsconfig is wrong.`,
        `- Only mention issues that appear in the DETECTED ISSUES list above.`,
        `- For each issue: state the exact file, line, error code, and what it means.`,
        `- If no issues: say "No issues found" clearly.`,
        `- No pleasantries. No filler. Be direct and specific.`,
    ].join("\n");

    const diagResponse = await sendMessage(diagPrompt, "diagnose").catch((err: any) => {
        diagSpinner.stop();
        warn(err.message);
        return [];
    });

    diagSpinner.stop();

    for (const msg of diagResponse) {
        agentSays(msg.text);
    }

    // ── Phase 4: apply fixes locally (no agent, real fs writes) ──────────
    if (autoFixable.length === 0) {
        info("No auto-fixable issues. Fix manual issues as described above.");
    } else {
        const shouldFix = await confirm(`apply ${autoFixable.length} auto-fix${autoFixable.length > 1 ? "es" : ""}?`);

        if (shouldFix) {
            section("applying fixes");

            const fixedDescriptions: string[] = [];

            for (const issue of autoFixable) {
                const fixSpinner = spin(`fixing ${issue.type}...`);
                try {
                    const result = await issue.fix!();
                    fixSpinner.stop();
                    if (result.applied) {
                        printFix(result.description, result.diff);
                        fixedDescriptions.push(`✔ ${result.description}`);
                        if (result.filesChanged.length > 0) {
                            info(`changed: ${result.filesChanged.join(", ")}`);
                        }
                    } else {
                        info(`skipped: ${result.description}`);
                    }
                } catch (err: any) {
                    fixSpinner.stop();
                    warn(`Failed to fix ${issue.type}: ${err.message}`);
                }
                console.log();
            }

            if (manual.length > 0) {
                section("manual fixes required");
                for (const issue of manual) {
                    printIssue(issue.severity, issue.type);
                    console.log(`     ${chalk.dim(issue.description)}`);
                    console.log();
                }
            }

            // Tell agent what was fixed so chat has accurate context
            const fixSummarySpinner = spin("updating agent context...");
            const fixSummary = await sendMessage(
                withCwd(
                    `The CLI just applied these fixes automatically:\n${fixedDescriptions.join("\n")}\n\n` +
                    `${manual.length > 0 ? `Still needs manual action:\n${manual.map((i) => `- ${i.type}: ${i.description}`).join("\n")}` : "All detected issues are now fixed."}\n\n` +
                    `Provide a brief summary of what was fixed and what the developer should do next.`,
                    projectPath
                ),
                "explain"
            ).catch(() => []);
            fixSummarySpinner.stop();

            for (const msg of fixSummary) {
                agentSays(msg.text);
            }
        }
    }

    // ── Phase 5: interactive chat with agentic execution loop ──────────────────────
    section("chat mode");
    info("ask anything about your project — fixd can run commands with your approval.");
    info(`type ${chalk.white("exit")} or ${chalk.white("quit")} to leave.`);
    console.log();

    while (true) {
        const input = await prompt("you");
        if (!input) continue;
        if (["exit", "quit", "q", ":q"].includes(input.toLowerCase())) break;

        await agenticTurn(input, projectPath, 0, new Set());
    }

    closePrompt();
    bye();
    disconnect();
}

// ─── Agentic execution loop ────────────────────────────────────────────────────────────────────
//
// One "turn" = send message → agent responds → if agent proposed commands,
// show approval prompts → run approved ones → feed output back into a new turn.
// Loops until the agent stops proposing commands (max 6 tool calls to prevent runaway).

async function agenticTurn(
    userMessage: string,
    projectPath: string,
    depth = 0,
    alreadyRan: Set<string> = new Set()
): Promise<void> {
    const MAX_DEPTH = 6;
    if (depth > MAX_DEPTH) {
        info("(max tool calls reached for this turn)");
        return;
    }

    const thinkSpinner = spin(depth === 0 ? "thinking..." : "agent analysing output...");

    const responses = await sendMessage(withCwd(userMessage, projectPath), "chat").catch((err: any) => {
        thinkSpinner.stop();
        warn(err.message);
        return [];
    });

    thinkSpinner.stop();

    for (const msg of responses) {
        agentSays(msg.text);

        // ── Detect commands the agent wants to run ──────────────────────────────────
        const pending = extractPendingCommands(msg.text, alreadyRan);

        for (const cmd of pending) {
            alreadyRan.add(cmd.command); // mark before approval so declined cmds are also deduped
            agentWantsToRun(cmd.command, cmd.reason);

            const approved = await confirm(`run this command?`);

            if (!approved) {
                await agenticTurn(
                    `[User declined to run: \`${cmd.command}\`]. Suggest an alternative or explain what to do manually.`,
                    projectPath,
                    depth + 1,
                    alreadyRan
                );
                continue;
            }

            const runSpinner = spin(`running: ${chalk.bold(cmd.command)}`);
            const result = await runCommand(cmd.command, projectPath);
            runSpinner.stop();

            printCommandResult(result);

            // Feed output back to agent — the core of the agentic loop
            await agenticTurn(formatResultForAgent(result), projectPath, depth + 1, alreadyRan);
        }
    }
}