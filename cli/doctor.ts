// ─── fixd doctor — Diagnostic Orchestrator ──────────────────────────────────
// Phase 1+2 → scan.ts       (project scan + issue detection)
// Phase 3   → checkers.ts   (discovery engine + checker plugins)
// Phase 4   → inline below  (LLM analysis prompt)
// Phase 5   → repair.ts     (repository-driven repair loop)
// Phase 6   → inline below  (interactive chat with agenticTurn)

import chalk from "chalk";
import path from "node:path";
import fs from "node:fs";
import { execa } from "execa";
import { sendMessage, disconnect, setActiveProject, primeContext } from "./lib/agent.js";
import { proposeAndApply, resetBackupSession, clearNormalizedPatchHistory } from "./lib/patcher.js";
import { readRelevantFiles } from "./lib/projectReader.js";
import {
    loadMemory, saveMemory, summarizeSession,
    addCausalEntry, recordStackPattern,
    type ProjectMemory,
} from "./lib/memory.js";
import {
    fetchDocsForQuery,
    formatDocsForPrompt, scoreDocRelevance, type LibraryDoc,
} from "./lib/context7.js";
import { exploreProject, diagnoseWithAgent, synthesizeDiagnosis } from "./lib/sub-agents.js";
import { classifyCommand } from "./lib/command-classifier.js";
import { scanProject } from "../src/actions/scanFiles.js";
import { detectIssues, type DetectedIssue } from "../src/actions/fixEnv.js";
import { extractPendingCommands, runCommand, formatResultForAgent } from "./lib/executor.js";
import { runCheckerPhase } from "./lib/doctor-phases/checkers.js";
import { runRepairLoop } from "./lib/doctor-phases/repair.js";
import { verifyAfterFix } from "./lib/doctor-phases/verify.js";
import {
    printHeader, agentSays, agentWantsToRun, printCommandResult,
    spin, section, info, warn, success, printIssue, printFix,
    prompt, confirm, closePrompt, bye,
} from "./lib/display.js";

import { buildScanContext, runScanPhase as _runScanPhase } from "./lib/doctor-phases/scan.js";
// Re-export for external callers that import buildScanContext from doctor
export { buildScanContext } from "./lib/doctor-phases/scan.js";

// ─── Phase 4: LLM analysis ─────────────────────────────────────────────────

function renderDiagnosisResponse(raw: string, knownTypes: Set<string> = new Set()) {
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!clean || clean.toUpperCase() === "NO ISSUES FOUND") { success("no issues found — project looks clean"); return; }
    const blocks = clean.split(/^---$/m).map((b) => b.trim()).filter(Boolean);
    let rendered = 0;
    for (const block of blocks) {
        if (!block.includes("SEVERITY:")) continue;
        const get = (field: string) => block.match(new RegExp(`${field}:\\s*(.+)`))?.[1]?.trim() ?? "";
        const sev = get("SEVERITY") as "HIGH" | "MEDIUM" | "LOW";
        const type = get("TYPE"), problem = get("PROBLEM"), fix = get("FIX");
        if (!type && !problem) continue;
        if (type && knownTypes.has(type)) continue;
        const diffMatch = block.match(/```diff\n([\s\S]*?)```/);
        const diff = diffMatch ? diffMatch[1].split("\n").map((l: string) => l.trimStart()).join("\n") : "";
        console.log();
        printIssue(sev || "MEDIUM", type || "UNKNOWN");
        if (problem) console.log(`     ${chalk.dim("problem:")} ${problem}`);
        if (fix)     console.log(`     ${chalk.dim("fix:    ")} ${fix}`);
        if (diff)    printFix("suggested change:", diff);
        rendered++;
    }
    if (rendered === 0 && blocks.every((b) => !b.includes("SEVERITY:"))) agentSays(clean);
    console.log();
}

async function runLLMAnalysis(
    projectPath: string, fast: boolean,
    scanContext: string, issueList: string, knownTypes: Set<string>,
    checkerContext: string,
): Promise<void> {
    if (fast) {
        const diagPrompt = [
            `You are fixd. Respond ONLY in the exact format below. No prose.`,
            ``, `SCAN DATA:`, "```", scanContext, "```", ``,
            `DETECTED ISSUES:`, issueList, ``,
            checkerContext ? `${checkerContext}\n` : "",
            `OUTPUT FORMAT — follow exactly:`,
            ``, `ISSUES: {n} found`, ``, `---`,
            `SEVERITY: HIGH | MEDIUM | LOW`, `TYPE: {ISSUE_TYPE}`,
            `PROBLEM: One sentence. What exactly is wrong.`,
            `FIX: One sentence. Exact action to take.`,
            `DIFF:`, "\`\`\`diff", `- old line`, `+ new line`, "\`\`\`", `---`,
            ``, `(repeat block per issue)`, ``,
            `If no issues: respond with exactly "NO ISSUES FOUND"`, ``,
            `RULES:`,
            `- No filler text before or after the blocks`,
            `- Never suggest \`bun add\` or \`npm install\` for config fixes`,
            `- If TYPESCRIPT CHECK says PASSED, TypeScript is FINE`,
            `- Only mention issues that appear in DETECTED ISSUES above`,
            `- Make the SMALLEST possible change that resolves each issue`,
            `- For compiler errors: fix ONLY the reported line/token, never rewrite file`,
            `- Preserve all existing code that checkers did not flag`,
        ].join("\n");

        const diagSpinner = spin("agent analysing...");
        const diagResponse = await sendMessage(diagPrompt, "diagnose").catch((err: any) => { diagSpinner.stop(); warn(err.message); return []; });
        diagSpinner.stop();
        for (const msg of diagResponse) renderDiagnosisResponse(msg.text, knownTypes);
    } else {
        if (checkerContext) {
            primeContext(`[Checker results for this session]\n${checkerContext}`);
        } else {
            const exploreSpinner = spin("exploring project...");
            const exploreResult = await exploreProject(projectPath).catch(() => null);
            exploreSpinner.stop();
            if (exploreResult) {
                if (exploreResult.missingEnvVars?.length || exploreResult.notes) {
                    console.log(chalk.dim("── explore ─────────────────────────"));
                    if (exploreResult.missingEnvVars?.length) console.log(`  ${chalk.dim("missing env vars:")} ${exploreResult.missingEnvVars.join(", ")}`);
                    if (exploreResult.notes) console.log(`  ${chalk.dim("explorer:")} ${exploreResult.notes}`);
                    console.log();
                }
            }
            const fallbackExplore = exploreResult ?? { framework: null, language: "unknown", runtime: "unknown", packageManager: "unknown", hasTypeScript: false, hasPrisma: false, hasDocker: false, hasTests: false, testFramework: null, entryPoint: null, apiFramework: null, dbProvider: null, missingEnvVars: [], notes: null };
            const diagnoseSpinner = spin("diagnosing with agent...");
            const rawDiagnosis = await diagnoseWithAgent(scanContext, issueList, fallbackExplore).catch((err: any) => { warn(`Diagnose failed: ${err.message}`); return ""; });
            diagnoseSpinner.stop();
            if (rawDiagnosis) renderDiagnosisResponse(rawDiagnosis, knownTypes);
            if (exploreResult && (rawDiagnosis || issueList.length > 0)) {
                const synthSpinner = spin("synthesizing diagnosis...");
                const synthSummary = await synthesizeDiagnosis(exploreResult, rawDiagnosis, [{ severity: "HIGH", type: "SCAN", description: issueList, autoFixable: false }]).catch(() => "");
                synthSpinner.stop();
                if (synthSummary.trim()) {
                    console.log(chalk.dim("── diagnosis summary ───────────────────"));
                    for (const line of synthSummary.split("\n")) { if (line.trim()) console.log(`  ${chalk.dim("│")} ${line}`); }
                    console.log();
                    primeContext(`[Diagnosis summary for this session]\n${synthSummary}`);
                }
            }
        }
    }
}

// ─── Phase 6: Chat mode + agenticTurn ──────────────────────────────────────

interface Hypothesis { claim: string; fix: string; outcome: "resolved" | "no_change" | "regression" | "pending"; issuesBefore: number; issuesAfter: number; timestamp: string; }
interface SessionState { hypotheses: Hypothesis[]; currentDepth: number; totalFixAttempts: number; startTime: string; }

function makeSessionState(): SessionState { return { hypotheses: [], currentDepth: 0, totalFixAttempts: 0, startTime: new Date().toISOString() }; }

function formatHypothesesBlock(hypotheses: Hypothesis[]): string {
    if (hypotheses.length === 0) return "";
    return ["--- SESSION HYPOTHESES ---", ...hypotheses.map((h, i) => `${i + 1}. ${h.claim} → fixed: ${h.fix} → ${h.outcome}`), "--- END SESSION HYPOTHESES ---"].join("\n");
}

/**
 * Detect when 2+ consecutive no_change outcomes target the same file/error.
 * Returns an escalation prompt if detected, empty string otherwise.
 */
function detectEscalation(hypotheses: Hypothesis[], detectedIssues: DetectedIssue[]): string {
    const noChanges = hypotheses.filter(h => h.outcome === "no_change");
    if (noChanges.length < 2) return "";

    const lastTwo = noChanges.slice(-2);
    // Extract file paths from fix descriptions (comma-separated)
    const filesA = new Set(lastTwo[0].fix.split(", ").map(f => f.trim()).filter(Boolean));
    const filesB = new Set(lastTwo[1].fix.split(", ").map(f => f.trim()).filter(Boolean));
    // Check overlap — same file targeted in both attempts
    const overlap = [...filesA].filter(f => filesB.has(f));
    if (overlap.length === 0) return "";

    // Check if remaining issues include TS errors on the overlapping files
    const tsIssues = detectedIssues.filter(i =>
        i.type.includes("TYPESCRIPT") || i.type.includes("TS7016") ||
        i.type.includes("MISSING_TYPES_PACKAGE") || i.type.includes("DECLARATION_NOT_INCLUDED")
    );
    const relevantIssues = tsIssues.length > 0 ? tsIssues : detectedIssues;

    const errorCodes = [...new Set(relevantIssues.map(i => i.type))].join(", ");
    const overlapList = overlap.join(", ");

    return [
        `[ESCALATION: 2 fix attempts to ${overlapList} produced NO CHANGE for ${errorCodes}.`,
        `The file content may be correct but not discoverable.`,
        `DIAGNOSE TSCONFIG: check tsconfig.json's "include", "files", and "typeRoots" —`,
        `the file may exist with correct content but be outside tsc's compilation scope.`,
        `DO NOT rewrite the same file again. DO NOT delete it.]`,
    ].join("\n");
}

function getErrorTypeFormatInstruction(userMessage: string, detectedIssues: DetectedIssue[]): string {
    const types = detectedIssues.map(i => i.type);
    if (types.includes("MISSING_DATABASE_URL") || types.includes("PRISMA_POOLED_WITHOUT_DIRECT_URL")) return "FORMAT: Output ONLY <<<WRITE: .env>>> or <<<EDIT: prisma/schema.prisma>>> patch markers. Zero prose.";
    if (types.includes("PORT_CONFLICT")) return "FORMAT: Output ONLY ```bash kill command. Zero prose.";
    if (types.includes("MISSING_NODE_TYPES") || types.includes("TSCONFIG_STRICT_MISSING")) return "FORMAT: Output ONLY <<<EDIT: tsconfig.json>>>. Zero prose.";
    if (/fix|apply|implement|create|add|remove|update|change|patch|edit/i.test(userMessage)) return "EXECUTE DON'T EXPLAIN: output patch markers or bash blocks immediately.";
    return "RESPOND FORMAT: max 4 lines. Answer directly.";
}

function generateStuckReport(state: SessionState, remaining: DetectedIssue[]): string {
    return [
        "## Auto-fix limit reached", `**Attempts:** ${state.totalFixAttempts}`, `**Duration:** ${Math.round((Date.now() - new Date(state.startTime).getTime()) / 1000)}s`,
        "", "### Tried:", ...state.hypotheses.map((h, i) => `${i + 1}. ${h.claim}\n   → ${h.fix} → **${h.outcome}**`),
        "", "### Remaining:", ...remaining.map(i => `- **${i.type}** (${i.severity}): ${"description" in i ? (i as any).description : ""}`),
    ].join("\n");
}

async function computeFixOutcome(projectRoot: string, issuesBefore: DetectedIssue[]): Promise<{ outcome: "resolved" | "no_change" | "regression"; delta: number; newIssues: DetectedIssue[] }> {
    const newScan = await scanProject(projectRoot).catch(() => null);
    const baseIssues = newScan ? detectIssues(newScan, projectRoot) : issuesBefore;

    // Also count TS errors from tsc --noEmit so TS fix outcomes are visible.
    // detectIssues() only covers PORT_CONFLICT and NODE_VERSION_MISMATCH —
    // without this, every TS fix reports "NO CHANGE" in the agenticTurn loop.
    let tsErrorCount = 0;
    try {
        const tscBin = path.join(projectRoot, "node_modules", ".bin", "tsc");
        const tsc = fs.existsSync(tscBin) ? tscBin : "tsc";
        const { stdout, stderr } = await execa(tsc, ["--noEmit"], {
            cwd: projectRoot, reject: false, timeout: 30_000,
        });
        const out = (stdout ?? "") + "\n" + (stderr ?? "");
        const tsRe = /^[^(\n]+\(\d+,\d+\):\s+error\s+TS\d+:/gm;
        const matches = out.match(tsRe);
        tsErrorCount = matches ? matches.length : 0;
    } catch {
        // tsc unavailable — don't affect outcome
    }

    // Merge: base issues + TS errors counted as synthetic DetectedIssue entries
    const totalBefore = issuesBefore.length + (issuesBefore.some(i => i.type.includes("TYPESCRIPT") || i.type.includes("TS")) ? 0 : 0);
    // We can't easily know the before-count of TS errors, so use a simpler heuristic:
    // If tsErrorCount is 0 and the fix touched a .d.ts or tsconfig file, count it as progress.
    const newIssues = [...baseIssues];
    const delta = issuesBefore.length - baseIssues.length + (tsErrorCount === 0 && issuesBefore.length === baseIssues.length ? 0 : 0);
    // Simplified: use total before/after by injecting TS error count
    const effectiveBefore = issuesBefore.length;
    const effectiveAfter = baseIssues.length + tsErrorCount;
    const effectiveDelta = effectiveBefore - effectiveAfter;

    return {
        outcome: effectiveDelta > 0 ? "resolved" : effectiveDelta < 0 ? "regression" : "no_change",
        delta: effectiveDelta,
        newIssues,
    };
}

async function agenticTurn(
    userMessage: string, projectRoot: string, depth: number, state: SessionState,
    alreadyRan: Set<string>, projectLibraries: string[], sessionLog: string[],
    sessionChangedFiles: string[], detectedIssues: DetectedIssue[] = [],
    currentMemory?: ProjectMemory,
): Promise<void> {
    state.currentDepth = depth;
    if (depth >= 6) { section("FIXD Could Not Fully Resolve"); agentSays(generateStuckReport(state, detectedIssues)); return; }
    if (depth === 4) userMessage = `[SESSION PRESSURE: 2 attempts remaining. ${state.totalFixAttempts} fixes tried. Make ONE surgical fix.]\n${userMessage}`;
    if (depth > 0 && state.hypotheses.length > 0) userMessage = `${formatHypothesesBlock(state.hypotheses)}\n\n${userMessage}`;

    let fileContext = "";
    if (depth === 0) {
        fileContext = await readRelevantFiles(userMessage, projectRoot, detectedIssues.map(i => i.type), detectedIssues).catch(() => "");
    }
    const errorFiles = detectedIssues.map(i => i.file).filter((f): f is string => typeof f === "string").filter((f, idx, arr) => arr.indexOf(f) === idx);
    let errorFileContents = "";
    for (const relPath of errorFiles) {
        const abs = path.join(projectRoot, relPath);
        if (fs.existsSync(abs)) errorFileContents += `\n--- FILE: ${relPath} ---\n${fs.readFileSync(abs, "utf-8")}\n--- END FILE ---\n`;
    }

    const isFixRequest = /fix|apply|implement|create|add|remove|update|change|patch|edit/i.test(userMessage);
    const formatInstruction = getErrorTypeFormatInstruction(userMessage, detectedIssues);
    const parts: string[] = [];
    if (fileContext) parts.push(fileContext);
    if (errorFileContents) parts.push(errorFileContents);
    parts.push(`[Working directory: ${projectRoot}]`, "", userMessage, "", formatInstruction);
    let enrichedMessage = parts.filter(Boolean).join("\n");

    if (depth === 0 && process.env.CONTEXT7_API_KEY && projectLibraries.length > 0) {
        const libs = await scoreDocRelevance(userMessage, projectLibraries).catch(() => projectLibraries);
        if (libs.length > 0) {
            const docs: LibraryDoc[] = await fetchDocsForQuery(userMessage, libs).catch(() => []);
            if (docs.length > 0) enrichedMessage = `${formatDocsForPrompt(docs)}\n\n${enrichedMessage}`;
        }
    }

    const thinkSpinner = spin(depth === 0 ? "thinking..." : "agent analysing output...");
    const responses = await sendMessage(enrichedMessage, isFixRequest ? "diagnose" : "chat").catch((err: any) => { thinkSpinner.stop(); warn(err.message); return []; });
    thinkSpinner.stop();

    for (const msg of responses) {
        const clean = msg.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        agentSays(clean);
        if (depth === 0) sessionLog.push(`agent: ${clean}`);

        const issuesBefore = [...detectedIssues];
        const patches = await proposeAndApply(clean, projectRoot, { confirmEach: true });
        const applied = patches.filter(p => p.applied);
        const rejected = patches.filter(p => !p.applied);

        // Step 3: Feed dedup rejections back to the agent so it can try a
        // different approach. The patcher's isNormalizedDuplicate now handles
        // all dedup — SessionState.triedFixes has been removed.
        if (applied.length === 0 && rejected.length > 0) {
            const rejectionReasons = [...new Set(rejected.map(p => p.error).filter(Boolean))].join("; ");
            // Pass the exact rejection reason to the agent — especially prisma validation
            // errors that tell the agent what env var to set before retrying the edit.
            const isDedup = rejectionReasons.includes("Skipped") || rejectionReasons.includes("identical");
            const instruction = isDedup
              ? "Form a different hypothesis."
              : "Fix the reported problem and re-propose the same edit.";
            await agenticTurn(`[Patch rejected: ${rejectionReasons}]. ${instruction}`, projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, detectedIssues, currentMemory);
            return;
        }

        if (applied.length > 0) {
            state.totalFixAttempts++;
            for (const p of applied) sessionChangedFiles.push(p.path);
            const { outcome, delta, newIssues } = await computeFixOutcome(projectRoot, issuesBefore);
            const claim = clean.split("\n").find((l: string) => l.trim()) ?? "(no hypothesis)";
            state.hypotheses.push({ claim: claim.slice(0, 100), fix: applied.map(p => p.path).join(", "), outcome, issuesBefore: issuesBefore.length, issuesAfter: newIssues.length, timestamp: new Date().toISOString() });

            if (currentMemory) {
                const fu = newIssues.filter((a: DetectedIssue) => !issuesBefore.some((b: DetectedIssue) => b.type === a.type)).map((i: DetectedIssue) => i.type);
                const ai = [...new Set(issuesBefore.map(i => i.type))];
                for (const p of applied) currentMemory = addCausalEntry(currentMemory, { timestamp: new Date().toISOString(), file: p.path, issueType: ai.join("|") || "UNKNOWN", action: claim.slice(0, 120), outcome: outcome === "resolved" ? "resolved" : outcome === "regression" ? "regression" : "no_change", followupIssues: fu });
                currentMemory = recordStackPattern(currentMemory, currentMemory.knownStack, ai[0] ?? "UNKNOWN", claim.slice(0, 120), outcome === "resolved" ? "success" : "failure");
            }

            const escalation = outcome === "no_change" ? detectEscalation(state.hypotheses, newIssues) : "";
            const msg = outcome === "resolved" ? `[Fix Outcome: FIXED — ${Math.abs(delta)} resolved]` :
                outcome === "no_change" ? `[Fix Outcome: NO CHANGE]\n${formatHypothesesBlock(state.hypotheses)}\n${escalation || "Try different approach."}` :
                    `[Fix Outcome: REGRESSION — ${Math.abs(delta)} new issues]\nReassess.`;
            await agenticTurn(msg, projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, newIssues, currentMemory);
            return;
        }

        const textNoPatches = clean.replace(/<<<WRITE:.*?<<<END>>>/gs, "").replace(/<<<EDIT:.*?<<<END>>>/gs, "").replace(/<<<DELETE:[^\n>]+>>>/g, "").replace(/<<<RENAME:[^\n>]+>>>/g, "");
        const pending = extractPendingCommands(textNoPatches, alreadyRan);
        for (const cmd of pending) {
            alreadyRan.add(cmd.command);
            const classification = await classifyCommand(cmd.command).catch(() => ({ classification: "confirm" as const, reason: "llm-error" as const }));
            if (classification.classification === "auto-run") {
                console.log(`  ${chalk.dim("●")} ${chalk.dim("auto-running:")} ${chalk.white(cmd.command)}`);
                const r = await runCommand(cmd.command, projectRoot);
                if (r.exitCode !== 0) printCommandResult(r);
                await agenticTurn(formatResultForAgent(r), projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, detectedIssues, currentMemory);
                return;
            }
            agentWantsToRun(cmd.command, cmd.reason, projectRoot);
            if (!(await confirm("run this command?"))) { await agenticTurn(`[User declined: \`${cmd.command}\`]`, projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, detectedIssues, currentMemory); return; }
            const r2 = await runCommand(cmd.command, projectRoot);
            printCommandResult(r2);
            await agenticTurn(formatResultForAgent(r2), projectRoot, depth + 1, state, alreadyRan, projectLibraries, sessionLog, sessionChangedFiles, detectedIssues, currentMemory);
            return;
        }
    }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export async function runDoctor(cwd?: string, fast = false, plan = false) {
    const projectPath = cwd ?? process.cwd();
    resetBackupSession();
    clearNormalizedPatchHistory();
    setActiveProject(projectPath);
    printHeader("doctor");
    info(`scanning project at ${chalk.white(projectPath)}`);
    console.log();

    let currentMemory = await loadMemory(projectPath);
    const sessionLog: string[] = [];
    const sessionChangedFiles: string[] = [];

    // ── Phase 1+2: Scan + detect issues ────────────────────────────────
    const scanResult = await _runScanPhase(projectPath, currentMemory);
    currentMemory = scanResult.currentMemory;
    const { scan, projectLibraries, issues, autoFixable, manual, knownTypes, diagContext } = scanResult;

    // ── Phase 3: Checker orchestration ──────────────────────────────────
    const checkerPhase = await runCheckerPhase(projectPath, scanResult);
    currentMemory = checkerPhase.currentMemory;

    const scanContext = buildScanContext(projectPath, scan, diagContext);
    const issueList = issues.length > 0
        ? issues.map(i => `- [${i.severity}] ${i.type}: ${i.description}`).join("\n")
        : "No issues detected.";

    // ── Phase 4: LLM analysis ──────────────────────────────────────────
    await runLLMAnalysis(projectPath, fast, scanContext, issueList, knownTypes, checkerPhase.checkerContext);

    // ── Plan mode gate ──────────────────────────────────────────────────
    if (plan) {
        section("plan mode — review before applying");
        console.log(); info("Diagnosis complete. No changes have been applied yet."); console.log();
        if (autoFixable.length > 0) { info(chalk.bold("Auto-fixable:")); for (const i of autoFixable) console.log(`  ${chalk.green("✔")} ${i.type}: ${chalk.dim(i.description)}`); console.log(); }
        if (manual.length > 0) { info(chalk.bold("Manual:")); for (const i of manual) console.log(`  ${chalk.yellow("⚠")} ${i.type}: ${chalk.dim(i.description)}`); console.log(); }
        if (autoFixable.length === 0 && manual.length === 0) { success("No issues found."); closePrompt(); bye(); disconnect(); return; }
        if (!(await confirm("proceed? (apply fixes and enter chat mode)"))) { info("Exiting."); closePrompt(); await saveMemory(currentMemory); bye(); disconnect(); return; }
    }

    // ── Phase 5: Repair loop ───────────────────────────────────────────
    await runRepairLoop(projectPath, checkerPhase, scanResult);

    // ── Phase 6: Interactive chat ───────────────────────────────────────
    section("chat mode");
    info("ask anything about your project — fixd can run commands with your approval.");
    info(`type ${chalk.white("exit")} or ${chalk.white("quit")} to leave.`);
    console.log();

    const chatState = makeSessionState();
    let prevRootCauseCount = checkerPhase.checkerGraph?.rootCauses.length ?? 0;
    let chatStallCount = 0;

    while (true) {
        const input = await prompt("you");
        if (!input) continue;
        if (["exit", "quit", "q", ":q"].includes(input.toLowerCase())) break;
        sessionLog.push(`you: ${input}`);

        // Step 4: Inject hypothesis history + verification state
        let message = input;
        const parts: string[] = [];
        if (chatState.hypotheses.length > 0 && chatState.hypotheses.some(h => h.outcome !== "resolved")) {
            parts.push(formatHypothesesBlock(chatState.hypotheses));
        }
        // If agenticTurn applied patches in the previous turn, inject verification outcome
        const lastHypo = chatState.hypotheses.at(-1);
        if (lastHypo && lastHypo.outcome !== "pending") {
            parts.push(`[Previous fix outcome: ${lastHypo.outcome.toUpperCase()} — ${lastHypo.claim.slice(0, 80)}]`);
        }
        if (parts.length > 0) {
            message = `${parts.join("\n")}\n\n${input}`;
        }

        await agenticTurn(message, projectPath, 0, chatState, new Set(), projectLibraries, sessionLog, sessionChangedFiles, issues, currentMemory);

        // Step 4: Re-run checkers after each turn where patches may have been applied
        if (checkerPhase.allPlugins.length > 0 && chatState.hypotheses.length > 0) {
            const verifyResult = await verifyAfterFix(projectPath, checkerPhase.allPlugins, currentMemory, prevRootCauseCount);
            currentMemory = verifyResult.currentMemory;
            const newCount = verifyResult.remainingTotal;

            // Stall detection: no progress after 3 turns
            if (newCount > 0 && newCount >= prevRootCauseCount) {
                chatStallCount++;
                if (chatStallCount >= 3) {
                    warn("Chat mode: no progress after 3 turns. The same issues persist.");
                    info("Consider running `fixd doctor --fast` for a fresh analysis, or check the issues manually.");
                    chatStallCount = 0; // reset — let user continue if they want
                }
            } else if (newCount < prevRootCauseCount) {
                chatStallCount = 0; // progress made
            }

            prevRootCauseCount = newCount;
        }
    }
    closePrompt();

    currentMemory = await summarizeSession(currentMemory, sessionLog.join("\n"), sessionChangedFiles);
    await saveMemory(currentMemory);
    bye();
    disconnect();
}

export const __doctorTest = { makeSessionState, formatHypothesesBlock, generateStuckReport, computeFixOutcome, agenticTurn };
