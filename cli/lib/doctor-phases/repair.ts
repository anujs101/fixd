// ─── Phase 5: Repository-Driven Repair Loop ─────────────────────────────────
// Iterative fix+verify. Every iteration starts from current filesystem state.
// Stops when checkers pass or max iterations reached.

import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { spin, info, success, warn, section } from "../display.js";
import { discoverStack } from "../discovery.js";
import { filterByStack } from "../checker-loader.js";
import { buildIssueGraph, formatGraphForPrompt } from "../issue-graph.js";
import { sendMessage, setActiveProject } from "../agent.js";
import { proposeAndApply } from "../patcher.js";
import { scanProject } from "../../../src/actions/scanFiles.js";
import { updateFromScan, type ProjectMemory } from "../memory.js";
import type { CheckerPlugin, CheckerResult } from "../checker-types.js";
import type { CheckerPhaseResult } from "./checkers.js";
import type { ScanResult } from "./scan.js";

export async function runRepairLoop(
  projectPath: string,
  checkerPhase: CheckerPhaseResult,
  scanResult: ScanResult,
): Promise<void> {
  const { allPlugins, checkerResults: initialResults, checkerGraph: initialGraph } = checkerPhase;
  let { currentMemory } = checkerPhase;
  let checkerResults = initialResults;
  let checkerGraph = initialGraph;
  let scan = scanResult.scan;

  if (checkerResults.length === 0 || !checkerGraph || checkerGraph.rootCauses.length === 0) return;

  section("repair loop");
  const MAX_ITERATIONS = 3;
  const appliedPatchHashes = new Set<string>();
  let prevGraphHash = "";
  let stallCount = 0;

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const verifySpinner = spin(`repair iteration ${iter}/${MAX_ITERATIONS}...`);

    // Refresh state from filesystem
    try {
      const freshScan = await scanProject(projectPath).catch(() => null);
      if (freshScan) { scan = freshScan; currentMemory = updateFromScan(currentMemory, scan); }
    } catch { /* non-fatal */ }
    try {
      const freshStack = discoverStack(projectPath, currentMemory.knownStack as any);
      currentMemory = { ...currentMemory, knownStack: freshStack as any };
    } catch { /* non-fatal */ }

    // Capture repo files
    const repoFiles = new Set<string>();
    (function collect(dir: string, base: string = dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collect(full, base);
        else repoFiles.add(path.relative(base, full));
      }
    })(projectPath);

    // Re-run checkers
    const activePlugins = filterByStack(allPlugins, currentMemory.knownStack as any);
    const freshResults = await Promise.all(
      activePlugins.map(p => p.check(projectPath).catch((err: Error) => ({
        checker: p.id, category: p.category, passed: false,
        errors: [{ file: undefined, line: undefined, col: undefined, code: "CHECKER_ERROR", severity: "error" as const, message: err.message, raw: err.message }],
        warnings: [], skipped: true, skipReason: err.message, durationMs: 0,
      })))
    );
    const freshGraph = buildIssueGraph(freshResults, activePlugins);
    verifySpinner.stop();

    const remainingErrors = freshGraph.rootCauses.filter(n => n.severity === "HIGH").length;
    const remainingTotal = freshGraph.rootCauses.length;

    if (remainingTotal === 0) {
      success(`repair iteration ${iter}: all checkers pass — project is clean`);
      checkerResults = freshResults;
      checkerGraph = freshGraph;
      break;
    }

    // Loop detection
    const graphHash = JSON.stringify(freshGraph.rootCauses.map(n => n.id).sort());
    if (graphHash === prevGraphHash) {
      stallCount++;
      if (stallCount >= 2) {
        warn("Doctor is no longer making progress.");
        info(`${remainingTotal} issue(s) persist after ${iter} repair attempts.`);
        for (const rc of freshGraph.rootCauses.slice(0, 5)) {
          console.log(`  ${chalk.yellow("●")} [${rc.category}] ${rc.message.slice(0, 100)}`);
        }
        info("Continue in interactive mode to resolve manually.");
        break;
      }
    } else { stallCount = 0; }
    prevGraphHash = graphHash;

    info(`${remainingErrors} error(s), ${remainingTotal - remainingErrors} warning(s) remain`);

    // LLM fix round. Auto-fixable issues are included in the checker report
    // so the LLM can generate patches (which go through proposeAndApply →
    // backupFile → atomicWrite). Direct fix!() calls bypass the backup
    // mechanism and break `fixd undo`.
    if (iter < MAX_ITERATIONS && remainingTotal > 0) {
      const freshReport = formatGraphForPrompt(freshGraph, Object.keys((currentMemory.knownStack as any)?.signals ?? {}).join(", "));
      const fileList = [...repoFiles].sort().slice(0, 30).join("\n");

      // Show current content of error files
      const errorFiles = [...new Set(freshGraph.rootCauses.filter(rc => rc.file).map(rc => rc.file!))].slice(0, 8);
      const fileContents: string[] = [];
      for (const f of errorFiles) {
        const fp = path.join(projectPath, f);
        if (fs.existsSync(fp)) {
          let content = fs.readFileSync(fp, "utf-8");
          if (f.endsWith(".json") && content.trim().startsWith("{")) {
            try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* leave as-is */ }
          }
          fileContents.push(`--- CURRENT CONTENT OF ${f} ---\n${content}\n--- END ${f} ---`);
        }
      }

      const fixPrompt = [
        `FRESH DIAGNOSTIC PASS — ignore any previous conversation.`,
        `The filesystem is authoritative. Trust only this data.`,
        `CURRENT REPOSITORY FILES:`, fileList || "(empty)",
        fileContents.length > 0 ? fileContents.join("\n\n") : "",
        freshReport,
      ].filter(Boolean).join("\n");

      const { resetSession } = await import("../agent.js");
      resetSession();
      setActiveProject(projectPath);

      const responses = await sendMessage(fixPrompt, "diagnose").catch(() => [] as any[]);
      for (const msg of responses) {
        const clean = (msg.text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (!clean.includes("<<<WRITE:") && !clean.includes("<<<EDIT:")) continue;

        // Duplicate detection
        for (const [, wp] of [...clean.matchAll(/<<<WRITE:\s*([^\n>]+)>>>/g)]) {
          const target = wp.trim();
          if (repoFiles.has(target)) {
            const existing = (() => { try { return fs.readFileSync(path.join(projectPath, target), "utf-8"); } catch { return ""; } })();
            const m = clean.match(new RegExp(`<<<WRITE:\\s*${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>>>\\s*([\\s\\S]*?)<<<END>>>`, 'i'));
            if (m?.[1]?.trim() === existing.trim()) { warn(`Skipping duplicate: ${target}`); continue; }
          }
        }
        for (const [, ep] of [...clean.matchAll(/<<<EDIT:\s*([^\n>]+)>>>/g)]) {
          const hash = `${ep.trim()}::${clean.slice(0, 100)}`;
          if (appliedPatchHashes.has(hash)) { warn(`Skipping duplicate edit: ${ep.trim()}`); continue; }
          appliedPatchHashes.add(hash);
        }

        await proposeAndApply(clean, projectPath, { confirmEach: false });
      }
    }

    checkerResults = freshResults;
    checkerGraph = freshGraph;
  }
}
