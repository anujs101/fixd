import chalk from "chalk";
import path from "node:path";
import { sendMessage, disconnect, setActiveProject, primeContext } from "./lib/agent.js";
import { proposeAndApply, resetBackupSession } from "./lib/patcher.js";
import { readRelevantFiles } from "./lib/projectReader.js";
import {
    loadMemory,
    saveMemory,
    updateFromScan,
    recordFix,
    summarizeSession,
    addCausalEntry,
    recordStackPattern,
    type AppliedFix,
    type CausalEntry,
} from "./lib/memory.js";
import {
    detectLibrariesInProject,
    fetchDocsForQuery,
    formatDocsForPrompt,
    scoreDocRelevance,
    type LibraryDoc,
} from "./lib/context7.js";
import { exploreProject, diagnoseWithAgent, synthesizeDiagnosis } from "./lib/sub-agents.js";
import { classifyCommand } from "./lib/command-classifier.js";
import { scanProject } from "../src/actions/scanFiles.js";
import { fixTypescriptNodeTypes, detectIssues, type DetectedIssue } from "../src/actions/fixEnv.js";
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

    // Docker-compose port bindings (now parsed from YAML — INCOMPLETE 2 fix)
    if (scan.dockerPorts && scan.dockerPorts.length > 0) {
        lines.push("DOCKER COMPOSE PORTS:");
        for (const dp of scan.dockerPorts) {
            lines.push(`  ${dp.service}: host ${dp.hostPort} → container ${dp.containerPort}`);
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

// ─── Render structured diagnosis response ────────────────────────────────────
// Parses the LLM's structured block format and renders each issue using
// display.ts primitives. Falls back to raw agentSays() if parsing fails.

function renderDiagnosisResponse(raw: string, knownTypes: Set<string> = new Set()) {
    // Strip any residual think blocks (defensive — llm.ts already does this)
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    if (!clean || clean.toUpperCase() === "NO ISSUES FOUND") {
        success("no issues found — project looks clean");
        return;
    }

    // Parse issue blocks separated by ---
    // First line may be "ISSUES: n found" — skip it
    const blocks = clean.split(/^---$/m).map((b) => b.trim()).filter(Boolean);

    let rendered = 0;
    for (const block of blocks) {
        if (!block.includes("SEVERITY:")) continue;

        const get = (field: string) =>
            block.match(new RegExp(`${field}:\\s*(.+)`))?.[1]?.trim() ?? "";

        const severity = get("SEVERITY") as "HIGH" | "MEDIUM" | "LOW";
        const type     = get("TYPE");
        const problem  = get("PROBLEM");
        const fix      = get("FIX");

        if (!type && !problem) continue; // malformed block — skip

        // Skip if this issue type was already rendered by the local detector
        if (type && knownTypes.has(type)) continue;

        // Extract ```diff ... ``` block and normalise indentation.
        // printFix already adds 5-space indent per line, so strip leading
        // whitespace from the raw diff to avoid double-indentation.
        const diffMatch = block.match(/```diff\n([\s\S]*?)```/);
        const diff = diffMatch
            ? diffMatch[1]
                .split("\n")
                .map((l) => l.trimStart())
                .join("\n")
            : "";

        console.log();
        printIssue(severity || "MEDIUM", type || "UNKNOWN");
        if (problem) console.log(`     ${chalk.dim("problem:")} ${problem}`);
        if (fix)     console.log(`     ${chalk.dim("fix:    ")} ${fix}`);
        if (diff)    printFix("suggested change:", diff);

        rendered++;
    }

    // If the structured parse found nothing (model ignored format), fall back
    if (rendered === 0 && blocks.every((b) => !b.includes("SEVERITY:"))) {
        agentSays(clean);
    }

    console.log();
}

// ─── Main doctor flow ─────────────────────────────────────────────────────────

export async function runDoctor(cwd?: string, fast = false, plan = false) {
    // Default to cwd; init.ts passes the new project dir explicitly
    // so we never need process.chdir() (which is a global side-effect)
    const projectPath = cwd ?? process.cwd();

    // Each command invocation gets a fresh backup session
    resetBackupSession();

    // B3: anchor the agent's memory reads to the correct project directory
    setActiveProject(projectPath);

    printHeader("doctor");
    info(`scanning project at ${chalk.white(projectPath)}`);
    console.log();

    // Load persistent memory for this project
    let currentMemory = await loadMemory(projectPath);
    const sessionLog: string[] = [];
    const sessionChangedFiles: string[] = [];

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

    // Update memory with scan result
    currentMemory = updateFromScan(currentMemory, scan);
    await saveMemory(currentMemory);

    // ── Detect project libraries for Context7 doc injection ──────────────────
    const projectLibraries = await detectLibrariesInProject(projectPath).catch(() => [] as string[]);

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

    // ── Promote TS2591 errors to a single auto-fixable issue ─────────────────
    // TS2591 = "Cannot find name 'process'" — always fixed by adding @types/node
    const ts2591Errors = diagErrors.filter((e) => e.code === "TS2591");
    const otherDiagErrors = diagErrors.filter((e) => e.code !== "TS2591");

    if (ts2591Errors.length > 0) {
        issues.push({
            severity: "HIGH",
            type: "MISSING_NODE_TYPES",
            description: `${ts2591Errors.length} TS2591 error(s) — @types/node not configured in tsconfig.json. Run: bun add -d @types/node`,
            autoFixable: true,
            fix: () => fixTypescriptNodeTypes(projectPath),
        });
    }

    // Add remaining diagnostic errors (non-TS2591) as non-fixable issues
    for (const e of otherDiagErrors) {
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

    // Build a set of locally-detected issue types so renderDiagnosisResponse
    // can skip agent blocks that duplicate what's already shown locally.
    const knownTypes = new Set(issues.map((i) => i.type));

    section("issues found");
    printDetectedIssues(issues);

    // ── Phase 3: parallel sub-agents analyse with REAL scan data ────────────────
    const scanContext = buildScanContext(projectPath, scan, diagContext);
    const issueList = issues.length > 0
        ? issues.map((i) => `- [${i.severity}] ${i.type}: ${i.description}`).join("\n")
        : "No issues detected.";

    const diagSpinner = spin(fast ? "agent analysing..." : "running parallel analysis...");

    let diagResponseText: string;

    if (fast) {
        // ── FAST MODE: single sequential LLM call (old behaviour) ────────────
        const diagPrompt = [
            `You are fixd. Respond ONLY in the exact format below. No prose. No thinking out loud.`,
            ``,
            `SCAN DATA:`,
            "```",
            scanContext,
            "```",
            ``,
            `DETECTED ISSUES (${issues.length} total):`,
            issueList,
            ``,
            `OUTPUT FORMAT — follow exactly, no deviations:`,
            ``,
            `ISSUES: {n} found`,
            ``,
            `---`,
            `SEVERITY: HIGH | MEDIUM | LOW`,
            `TYPE: {ISSUE_TYPE}`,
            `PROBLEM: One sentence. What exactly is wrong.`,
            `FIX: One sentence. Exact action to take.`,
            `DIFF:`,
            "\`\`\`diff",
            `- old line`,
            `+ new line`,
            "\`\`\`",
            `---`,
            ``,
            `(repeat block per issue)`,
            ``,
            `If no issues: respond with exactly "NO ISSUES FOUND"`,
            ``,
            `RULES:`,
            `- No filler text before or after the blocks`,
            `- No "I recommend", "Let me", "Okay", "First" or any conversational openers`,
            `- Never suggest \`bun add\` or \`npm install\` for config fixes`,
            `- For package.json fixes show JSON diff only, no install commands`,
            `- If TYPESCRIPT CHECK says PASSED, TypeScript is FINE — do NOT mention tsconfig issues`,
            `- Only mention issues that appear in the DETECTED ISSUES list above`,
            `- Max 1 sentence per PROBLEM and FIX field`,
        ].join("\n");

        const diagResponse = await sendMessage(diagPrompt, "diagnose").catch((err: any) => {
            diagSpinner.stop();
            warn(err.message);
            return [];
        });

        diagSpinner.stop();
        for (const msg of diagResponse) {
            renderDiagnosisResponse(msg.text, knownTypes);
        }
    } else {
        // ── SEQUENTIAL: explore → diagnose → synthesize ───────────────────────
        // BUG 6 fix: stop diagSpinner BEFORE starting exploreSpinner so ora
        // doesn't leave a ghost spinner line in the terminal.
        diagSpinner.stop();

        const exploreSpinner = spin("exploring project...");
        const exploreResult = await exploreProject(projectPath).catch(() => null);
        exploreSpinner.stop();

        if (exploreResult) {
            const extras: string[] = [];
            if (exploreResult.missingEnvVars?.length > 0) {
                extras.push(`  ${chalk.dim("explorer noted missing env vars:")} ${exploreResult.missingEnvVars.join(", ")}`);
            }
            if (exploreResult.notes) {
                extras.push(`  ${chalk.dim("explorer:")} ${exploreResult.notes}`);
            }
            if (extras.length > 0) {
                console.log(chalk.dim("── explore ─────────────────────────"));
                for (const e of extras) console.log(e);
                console.log();
            }
        }

        // diagnoseWithAgent now requires exploreResult — use empty fallback if explore failed
        const fallbackExplore = exploreResult ?? {
            framework: null, language: "unknown", runtime: "unknown",
            packageManager: "unknown", hasTypeScript: false, hasPrisma: false,
            hasDocker: false, hasTests: false, testFramework: null,
            entryPoint: null, apiFramework: null, dbProvider: null,
            missingEnvVars: [], notes: null,
        };

        const diagnoseSpinner = spin("diagnosing with agent...");
        const rawDiagnosis = await diagnoseWithAgent(scanContext, issueList, fallbackExplore).catch((err: any) => {
            warn(`Diagnose sub-agent failed: ${err.message}`);
            return "";
        });
        diagnoseSpinner.stop();

        if (rawDiagnosis) {
            renderDiagnosisResponse(rawDiagnosis, knownTypes);
        }

        // synthesize — merge explore + diagnose into a unified summary
        if (exploreResult && (rawDiagnosis || issues.length > 0)) {
            const synthSpinner = spin("synthesizing diagnosis...");
            const synthSummary = await synthesizeDiagnosis(exploreResult, rawDiagnosis, issues).catch(() => "");
            synthSpinner.stop();
            if (synthSummary.trim()) {
                console.log(chalk.dim("── diagnosis summary ───────────────────"));
                for (const line of synthSummary.split("\n")) {
                    if (line.trim()) console.log(`  ${chalk.dim("│")} ${line}`);
                }
                console.log();
                // INCOMPLETE 5 fix: inject synthesis into agent history so the
                // agent is context-aware in chat mode without an extra LLM call.
                primeContext(`[Diagnosis summary for this session]\n${synthSummary}`);
            }
        }
    }

    // ── PLAN MODE gate (INCOMPLETE 1 fix) ────────────────────────────────────
    // If --plan was passed, show a clear summary of what would happen and ask
    // the user to explicitly approve before any fixes are applied or chat starts.
    if (plan) {
        section("plan mode — review before applying");
        console.log();
        info(chalk.white("Diagnosis complete. No changes have been applied yet."));
        console.log();

        if (autoFixable.length > 0) {
            info(chalk.bold("Auto-fixable issues:"));
            for (const issue of autoFixable) {
                console.log(`  ${chalk.green("✔")} ${chalk.white(issue.type)}: ${chalk.dim(issue.description)}`);
            }
            console.log();
        }

        if (manual.length > 0) {
            info(chalk.bold("Requires manual action:"));
            for (const issue of manual) {
                console.log(`  ${chalk.yellow("⚠")} ${chalk.white(issue.type)}: ${chalk.dim(issue.description)}`);
            }
            console.log();
        }

        if (autoFixable.length === 0 && manual.length === 0) {
            success("No issues found — project looks clean.");
            closePrompt();
            bye();
            disconnect();
            return;
        }

        const proceed = await confirm("proceed? (apply fixes and enter interactive chat mode)");
        if (!proceed) {
            info("Exiting plan mode. Run `fixd doctor` (without --plan) to apply fixes.");
            closePrompt();
            const finalMem = await summarizeSession(currentMemory, sessionLog.join("\n"), sessionChangedFiles);
            await saveMemory(finalMem);
            bye();
            disconnect();
            return;
        }
        // User approved — fall through to Phase 4 and Phase 5
    }

    // ── Phase 4: apply fixes locally (no agent, real fs writes) ──────────
    if (autoFixable.length === 0) {
        info("No auto-fixable issues. Fix manual issues as described above.");
    } else {
        const shouldFix = await confirm(`apply ${autoFixable.length} auto-fix${autoFixable.length > 1 ? "es" : ""}?`);

        if (shouldFix) {
            section("applying fixes");

            const fixedDescriptions: string[] = [];
            const appliedFixes: AppliedFix[] = [];

            for (const issue of autoFixable) {
                const fixSpinner = spin(`fixing ${issue.type}...`);
                try {
                    const result = await issue.fix!();
                    fixSpinner.stop();
                    if (result.applied) {
                        printFix(result.description, result.diff);
                        fixedDescriptions.push(`✔ ${result.description}`);
                        appliedFixes.push({
                            type:         issue.type,
                            description:  result.description,
                            filesChanged: result.filesChanged,
                        });
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

            // Record applied fixes in memory
            currentMemory = recordFix(currentMemory, appliedFixes);
            await saveMemory(currentMemory);

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
                // strip think blocks from fix summary too
                const clean = msg.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
                agentSays(clean);
                sessionLog.push(`agent: ${clean}`);
            }

            // ── Fix 3: Verify fixes actually resolved issues ─────────────────────
            if (appliedFixes.length > 0) {
                const verifySpinner = spin("verifying fixes...");

                const [scanAfter, diagAfter] = await Promise.all([
                    scanProject(projectPath).catch(() => null),
                    runDiagnostics(projectPath).catch(() => []),
                ]);

                verifySpinner.stop();
                section("verification");

                if (!scanAfter) {
                    warn("could not re-scan project — verify manually");
                } else {
                    const issuesAfter    = detectIssues(scanAfter, projectPath);
                    const diagErrorsAfter = getAllErrors(diagAfter);

                    const resolvedCount = issues.length - issuesAfter.length;
                    const newIssueCount = issuesAfter.filter(
                        (a) => !issues.some((b) => b.type === a.type)
                    ).length;

                    if (resolvedCount > 0) {
                        success(`${resolvedCount} issue${resolvedCount > 1 ? "s" : ""} resolved`);
                    }

                    if (newIssueCount > 0) {
                        warn(`${newIssueCount} new issue${newIssueCount > 1 ? "s" : ""} detected after fix`);
                        for (const i of issuesAfter.filter((a) => !issues.some((b) => b.type === a.type))) {
                            printIssue(i.severity, i.type);
                            console.log(`     ${chalk.dim(i.description)}`);
                        }
                    }

                    if (diagErrorsAfter.length === 0 && issuesAfter.length === 0) {
                        success("project is clean");
                    } else if (diagErrorsAfter.length > 0) {
                        warn(`${diagErrorsAfter.length} diagnostic error${diagErrorsAfter.length > 1 ? "s" : ""} remain`);
                        for (const e of diagErrorsAfter.slice(0, 5)) {
                            const loc = e.file ? `${e.file}:${e.line ?? ""}` : "";
                            console.log(`     ${chalk.dim(loc)} ${chalk.red(e.code ?? "")} ${e.message}`);
                        }
                    }

                    // Update memory with post-fix scan
                    currentMemory = updateFromScan(currentMemory, scanAfter);
                    await saveMemory(currentMemory);
                }
            }
        }
    }

    // ── Phase 5: interactive chat with agentic execution loop ──────────────────────
    section("chat mode");
    info("ask anything about your project — fixd can run commands with your approval.");
    if (!fast) info(chalk.dim("(tip: safe commands like git status, ls, tsc run automatically)"));
    info(`type ${chalk.white("exit")} or ${chalk.white("quit")} to leave.`);
    console.log();


    // BUG 1 fix: SessionState lives for the ENTIRE chat session, not per-turn.
    // triedFixes and hypotheses persist so the agent never retries an identical
    // patch across consecutive user messages.
    // alreadyRan resets per turn — intentional: the user may legitimately ask
    // to re-run the same command in a new message.
    const chatState = makeSessionState();

    while (true) {
        const input = await prompt("you");
        if (!input) continue;
        if (["exit", "quit", "q", ":q"].includes(input.toLowerCase())) break;

        sessionLog.push(`you: ${input}`);
        await agenticTurn(input, projectPath, 0, chatState, new Set(), projectLibraries, sessionLog, sessionChangedFiles, issues);
    }
    closePrompt();

    // Summarize and persist this session before exiting (8.1: pass changedFiles)
    const finalMemory = await summarizeSession(currentMemory, sessionLog.join("\n"), sessionChangedFiles);
    await saveMemory(finalMemory);

    bye();
    disconnect();
}

// ─── SessionState ──────────────────────────────────────────────────────────────────────────────

interface Hypothesis {
    claim: string;           // first line of agent response
    fix: string;             // file path patched or command run
    outcome: "resolved" | "no_change" | "regression" | "pending";
    issuesBefore: number;
    issuesAfter: number;
    timestamp: string;
}

interface SessionState {
    hypotheses: Hypothesis[];
    triedFixes: Set<string>;  // "filepath::searchString" keys
    currentDepth: number;
    totalFixAttempts: number;
    startTime: string;
}

function makeSessionState(): SessionState {
    return {
        hypotheses: [],
        triedFixes: new Set(),
        currentDepth: 0,
        totalFixAttempts: 0,
        startTime: new Date().toISOString(),
    };
}

function formatHypothesesBlock(hypotheses: Hypothesis[]): string {
    if (hypotheses.length === 0) return "";
    const lines = [
        "--- SESSION HYPOTHESES ---",
        ...hypotheses.map((h, i) =>
            `${i + 1}. ${h.claim} → fixed: ${h.fix} → ${h.outcome}`
        ),
        "--- END SESSION HYPOTHESES ---",
    ];
    return lines.join("\n");
}

function getErrorTypeFormatInstruction(userMessage: string, detectedIssues: DetectedIssue[]): string {
    const issueTypes = detectedIssues.map((i) => i.type);

    if (issueTypes.includes("MISSING_DATABASE_URL") || issueTypes.includes("PRISMA_POOLED_WITHOUT_DIRECT_URL")) {
        return "FORMAT: Output ONLY <<<WRITE: .env>>> or <<<EDIT: prisma/schema.prisma>>> patch markers. Zero prose. Zero explanation.";
    }
    if (issueTypes.includes("PORT_CONFLICT")) {
        return "FORMAT: Output ONLY a ```bash block with the kill command. Zero prose.";
    }
    if (issueTypes.includes("MISSING_NODE_TYPES") || issueTypes.includes("TSCONFIG_STRICT_MISSING")) {
        return "FORMAT: Output ONLY <<<EDIT: tsconfig.json>>> patch marker. Zero prose.";
    }
    if (/typescript|ts error|type error/i.test(userMessage)) {
        return "FORMAT: Output ONLY <<<EDIT: filepath>>> patch markers with exact SEARCH/REPLACE blocks. One block per error location. Zero prose.";
    }
    if (/fix|apply|implement|create|add|remove|update|change|patch|edit/i.test(userMessage)) {
        return "EXECUTE DON'T EXPLAIN: output patch markers or bash blocks immediately. No preamble. No explanation. No summary.";
    }
    return "RESPOND FORMAT: max 4 lines. Answer directly. No preamble.";
}

function generateStuckReport(state: SessionState, remainingIssues: DetectedIssue[]): string {
    const elapsed = Math.round((Date.now() - new Date(state.startTime).getTime()) / 1000);
    const lines: string[] = [
        "## Auto-fix limit reached\n",
        `**Attempts made:** ${state.totalFixAttempts}`,
        `**Session duration:** ${elapsed}s`,
        "",
        "### What was tried:",
    ];
    state.hypotheses.forEach((h, i) => {
        lines.push(`${i + 1}. ${h.claim}`);
        lines.push(`   → fix: \`${h.fix}\` → **${h.outcome}**`);
    });
    lines.push("", "### Remaining issues:");
    remainingIssues.forEach((issue) => {
        const msg = "description" in issue ? (issue as any).description : (issue as any).message ?? "";
        lines.push(`- **${issue.type}** (${issue.severity}): ${msg}`);
    });
    lines.push("", "### Recommended manual steps:");
    lines.push("Review the issues above and the fix attempts. The agent was unable to resolve these automatically.");
    lines.push("Consider: checking environment variable configuration, reviewing schema files manually, or running `fixd doctor --fast` for a fresh analysis.");
    return lines.join("\n");
}

// ─── Agentic execution loop ───────────────────────────────────────────────────
//
// One "turn" = send message → agent responds → patches/commands → recurse.
// Now driven by SessionState for hypothesis tracking, duplicate detection,
// and outcome-based routing. Max depth 6.

async function computeFixOutcome(
    projectRoot: string,
    issuesBefore: DetectedIssue[]
): Promise<{ outcome: "resolved" | "no_change" | "regression"; delta: number; newIssues: DetectedIssue[] }> {
    const newScan = await scanProject(projectRoot).catch(() => null);
    const newIssues = newScan ? detectIssues(newScan, projectRoot) : issuesBefore;
    // BUG 2 fix: compare DetectedIssue[] counts on both sides only.
    // Previously newDiag errors were added to `after` but NOT to `before`, which
    // made every partially-resolved fix read as a regression.
    const before = issuesBefore.length;
    const after  = newIssues.length;
    const delta  = before - after;
    const outcome: "resolved" | "no_change" | "regression" =
        delta > 0 ? "resolved" : delta < 0 ? "regression" : "no_change";
    return { outcome, delta, newIssues };
}

async function agenticTurn(
    userMessage: string,
    projectRoot: string,
    depth: number,
    state: SessionState,
    alreadyRan: Set<string>,
    projectLibraries: string[],
    sessionLog: string[],
    sessionChangedFiles: string[],
    detectedIssues: DetectedIssue[] = []
): Promise<void> {
    state.currentDepth = depth;

    // Change 4b: at depth >= 6, generate stuck report instead of silently stopping
    if (depth >= 6) {
        const stuckReport = generateStuckReport(state, detectedIssues);
        section("FIXD Could Not Fully Resolve");
        agentSays(stuckReport);
        return;
    }

    // Change 4a: depth 4 pressure message
    if (depth === 4) {
        const pressure = `[SESSION PRESSURE: 2 attempts remaining. You have tried ${state.totalFixAttempts} fixes. Prioritize the highest-confidence fix for the most impactful remaining issue. Make ONE surgical, targeted fix only.]`;
        userMessage = pressure + "\n" + userMessage;
    }

    // ── Hypothesis block prepend on depth > 0 ────────────────────────────────
    if (depth > 0 && state.hypotheses.length > 0) {
        userMessage = formatHypothesesBlock(state.hypotheses) + "\n\n" + userMessage;
    }


    // ── READ FILES (depth 0 only) — Change 7: pass issueTypes ────────────────
    let fileContext = "";
    if (depth === 0) {
        const readSpinner = spin("reading project files...");
        const issueTypes = detectedIssues.map((i) => i.type);
        fileContext = await readRelevantFiles(userMessage, projectRoot, issueTypes).catch(() => "");
        readSpinner.stop();
    }

    // ── Per-error-type format instructions (Change 3) ─────────────────────────
    const formatInstruction = getErrorTypeFormatInstruction(userMessage, detectedIssues);
    const isFixRequest = /fix|apply|implement|create|add|remove|update|change|patch|edit/i.test(userMessage);

    // ── Build enriched message ────────────────────────────────────────────────
    const parts: string[] = [];
    if (fileContext) parts.push(fileContext);
    parts.push(`[Working directory: ${projectRoot}]`);
    parts.push("");
    parts.push(userMessage);
    parts.push("");
    parts.push(formatInstruction);
    let enrichedMessage = parts.filter(Boolean).join("\n");

    // ── Relevance-gated Context7 (depth 0, INCOMPLETE 4 fix) ─────────────────
    // Guard behind CONTEXT7_API_KEY: scoreDocRelevance makes an LLM call.
    // Without the key fetchDocs always returns null, so the call is wasteful.
    if (depth === 0 && process.env.CONTEXT7_API_KEY && projectLibraries.length > 0) {
        const relevantLibIds = await scoreDocRelevance(userMessage, projectLibraries).catch(() => projectLibraries);
        if (relevantLibIds.length > 0) {
            const docs: LibraryDoc[] = await fetchDocsForQuery(userMessage, relevantLibIds).catch(() => []);
            if (docs.length > 0) {
                enrichedMessage = `${formatDocsForPrompt(docs)}\n\n${enrichedMessage}`;
            }
        }
    }

    const thinkSpinner = spin(depth === 0 ? "thinking..." : "agent analysing output...");

    const responses = await sendMessage(enrichedMessage, isFixRequest ? "diagnose" : "chat").catch((err: any) => {
        thinkSpinner.stop();
        warn(err.message);
        return [];
    });
    thinkSpinner.stop();

    for (const msg of responses) {
        const clean = msg.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        agentSays(clean);
        if (depth === 0) sessionLog.push(`agent: ${clean}`);

        // ── Duplicate patch detection (Change 1e) ─────────────────────────────
        const editBlocks = [...clean.matchAll(/<<<EDIT:\s*([^>]+)>>>([\s\S]*?)<<<END>>>/g)];
        const skipKeys = new Set<string>();
        for (const [, filePath, body] of editBlocks) {
            const searchMatch = body.match(/<<<SEARCH>>>([\s\S]*?)<<<REPLACE>>>/);
            if (searchMatch) {
                const key = `${filePath.trim()}::${searchMatch[1].trim().slice(0, 100)}`;
                if (state.triedFixes.has(key)) {
                    skipKeys.add(key);
                }
            }
        }
        if (skipKeys.size > 0) {
            await agenticTurn(
                "[Skipped: identical fix already attempted for this location. Try a different approach.]",
                projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, detectedIssues
            );
            return;
        }

        // ── Capture before-state for outcome tracking ─────────────────────────
        const issuesBefore = [...detectedIssues];

        // ── Propose and apply patches ─────────────────────────────────────────
        const patches = await proposeAndApply(clean, projectRoot, { confirmEach: true });
        const applied = patches.filter((p) => p.applied);

        if (applied.length > 0) {
            state.totalFixAttempts++;
            for (const p of applied) sessionChangedFiles.push(p.path);

            // Register triedFixes keys for duplicate detection
            for (const [, filePath, body] of editBlocks) {
                const searchMatch = body.match(/<<<SEARCH>>>([\s\S]*?)<<<REPLACE>>>/);
                if (searchMatch) {
                    state.triedFixes.add(`${filePath.trim()}::${searchMatch[1].trim().slice(0, 100)}`);
                }
            }

            // Compute fix outcome (Change 2a/b)
            const { outcome, delta, newIssues } = await computeFixOutcome(projectRoot, issuesBefore);

            // Extract hypothesis from first non-empty line of agent response
            const claim = clean.split("\n").find((l) => l.trim()) ?? "(no hypothesis)";
            const fixPath = applied.map((p) => p.path).join(", ");

            // Update hypothesis entry (Change 1c/2d)
            const hypo: Hypothesis = {
                claim:        claim.slice(0, 100),
                fix:          fixPath,
                outcome,
                issuesBefore: issuesBefore.length,
                issuesAfter:  newIssues.length,
                timestamp:    new Date().toISOString(),
            };
            state.hypotheses.push(hypo);

            // Write causal entry + stack pattern to memory
            const followupIssues = newIssues
                .filter((a) => !issuesBefore.some((b) => b.type === a.type))
                .map((i) => i.type);

            // IMPROVEMENT 6 fix: load memory ONCE, accumulate all causal entries
            // and stack pattern updates, then save ONCE after the loop.
            // Previously each patch triggered a full loadMemory→saveMemory cycle
            // (N reads + N writes for N patches). Now it's always 1 read + 1 write.
            const mem = await loadMemory(projectRoot).catch(() => null);
            if (mem) {
                const allIssueTypes  = [...new Set(issuesBefore.map((i) => i.type))];
                const primaryIssue   = allIssueTypes[0] ?? "UNKNOWN";
                const issueTypeLabel = allIssueTypes.join("|") || "UNKNOWN";
                const outcomeLabel   = outcome === "resolved" ? "resolved"
                                     : outcome === "regression" ? "regression" : "no_change";

                let current = mem;
                for (const p of applied) {
                    const causalEntry: CausalEntry = {
                        timestamp:     new Date().toISOString(),
                        file:          p.path,
                        issueType:     issueTypeLabel,
                        action:        claim.slice(0, 120),
                        outcome:       outcomeLabel,
                        followupIssues,
                    };
                    current = addCausalEntry(current, causalEntry);
                }
                // Record stack pattern once (represents the whole batch)
                current = recordStackPattern(
                    current,
                    mem.knownStack,
                    primaryIssue,
                    claim.slice(0, 120),
                    outcome === "resolved" ? "success" : "failure"
                );
                await saveMemory(current).catch(() => {});
            }

            // Change 2c: outcome-based routing
            if (outcome === "resolved") {
                const msg = `[Fix Outcome: FIXED — ${Math.abs(delta)} issue(s) resolved]\nApplied ${applied.length} change(s), verify remaining issues.`;
                await agenticTurn(msg, projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, newIssues);
            } else if (outcome === "no_change") {
                const hypoLog = formatHypothesesBlock(state.hypotheses);
                const msg = `[Fix Outcome: NO CHANGE — fix had no effect]\n${hypoLog}\nThe previous fix had no effect. Review the hypothesis log above. Form a completely different hypothesis and try again, or explain why this cannot be fixed automatically.`;
                await agenticTurn(msg, projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, newIssues);
            } else {
                const newIssueList = newIssues
                    .filter((a) => !issuesBefore.some((b) => b.type === a.type))
                    .map((i) => `  - ${i.type}: ${"description" in i ? (i as any).description : ""}`)
                    .join("\n");
                const hypoLog = formatHypothesesBlock(state.hypotheses);
                const msg = `[Fix Outcome: REGRESSION — ${Math.abs(delta)} new issue(s) introduced]\nNew issues:\n${newIssueList}\n${hypoLog}\nThe fix made things worse. Reassess completely.`;
                await agenticTurn(msg, projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, newIssues);
            }
            return;
        }

        // ── Shell commands ────────────────────────────────────────────────────
        const textWithoutPatches = clean
            .replace(/<<<WRITE:.*?<<<END>>>/gs, "")
            .replace(/<<<EDIT:.*?<<<END>>>/gs, "")
            .replace(/<<<DELETE:[^\n>]+>>>/g, "")
            .replace(/<<<RENAME:[^\n>]+>>>/g, "");
        const pending = extractPendingCommands(textWithoutPatches, alreadyRan);

        // BUG 3 fix: only ONE command is dispatched per recursion level, then
        // we return immediately. Previously `continue` let the for-loop dispatch
        // a second agenticTurn at the same depth, creating two parallel recursive
        // subtrees. Now each command fires one recursive call and returns so the
        // depth counter stays accurate and the agent handles follow-up naturally.
        for (const cmd of pending) {
            alreadyRan.add(cmd.command);

            const classifySpinner = depth === 0 ? spin("classifying command...") : null;
            const classification = await classifyCommand(cmd.command).catch(() => ({ classification: "confirm" as const, reason: "llm-error" as const }));
            classifySpinner?.stop();

            if (classification.classification === "auto-run") {
                console.log(`  ${chalk.dim("●")} ${chalk.dim("auto-running:")} ${chalk.white(cmd.command)}`);
                const runSpinner = spin(`running: ${chalk.bold(cmd.command)}`);
                const result = await runCommand(cmd.command, projectRoot);
                runSpinner.stop();
                if (result.exitCode !== 0) printCommandResult(result);
                await agenticTurn(formatResultForAgent(result), projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, detectedIssues);
                return; // ← was: continue
            }

            agentWantsToRun(cmd.command, cmd.reason, projectRoot);
            const approved = await confirm("run this command?");

            if (!approved) {
                await agenticTurn(
                    `[User declined to run: \`${cmd.command}\`]. Propose alternative or explain manual steps.`,
                    projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, detectedIssues
                );
                return; // ← was: continue
            }

            const runSpinner = spin(`running: ${chalk.bold(cmd.command)}`);
            const result = await runCommand(cmd.command, projectRoot);
            runSpinner.stop();
            printCommandResult(result);
            await agenticTurn(formatResultForAgent(result), projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, detectedIssues);
            return; // stop after first command; recursion handles all follow-up
        }
    }
}
