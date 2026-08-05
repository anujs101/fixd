// ─── Shared Verification ────────────────────────────────────────────────────
// Used by both the repair loop (Phase 5) and chat mode (Phase 6) to re-run
// checkers after a fix and report outcome.

import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { spin, info, success, warn } from "../display.js";
import { discoverStack } from "../discovery.js";
import { filterByStack } from "../checker-loader.js";
import { buildIssueGraph } from "../issue-graph.js";
import { updateFromScan, type ProjectMemory } from "../memory.js";
import { scanProject } from "../../../src/actions/scanFiles.js";
import type { CheckerPlugin, CheckerResult } from "../checker-types.js";

export interface VerifyResult {
  outcome: "resolved" | "no_change" | "regression";
  graph: ReturnType<typeof buildIssueGraph>;
  results: CheckerResult[];
  remainingErrors: number;
  remainingTotal: number;
  currentMemory: ProjectMemory;
}

/**
 * After a fix is applied, re-scan the project, re-run checkers, and report
 * whether the fix resolved, worsened, or had no effect on the issue graph.
 */
export async function verifyAfterFix(
  projectPath: string,
  allPlugins: CheckerPlugin[],
  currentMemory: ProjectMemory,
  previousRootCauseCount: number,
): Promise<VerifyResult> {
  const verifySpinner = spin("verifying...");

  // Refresh project state
  let scan: Awaited<ReturnType<typeof scanProject>> | null = null;
  try {
    scan = await scanProject(projectPath).catch(() => null);
    if (scan) currentMemory = updateFromScan(currentMemory, scan);
  } catch { /* non-fatal */ }

  try {
    const freshStack = discoverStack(projectPath, currentMemory.knownStack as any);
    currentMemory = { ...currentMemory, knownStack: freshStack as any };
  } catch { /* non-fatal */ }

  // Re-run applicable checkers
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
  const delta = previousRootCauseCount - remainingTotal;

  const outcome: "resolved" | "no_change" | "regression" =
    delta > 0 ? "resolved" : delta < 0 ? "regression" : "no_change";

  // Display verification result
  if (outcome === "resolved") {
    success(`verification: ${Math.abs(delta)} issue(s) resolved — ${remainingTotal} remaining`);
  } else if (outcome === "regression") {
    warn(`verification: ${Math.abs(delta)} new issue(s) introduced — ${remainingTotal} total`);
  } else if (remainingTotal === 0) {
    success("verification: all checkers pass — project is clean");
  } else {
    info(`verification: no change — ${remainingTotal} issue(s) remain`);
  }

  return { outcome, graph: freshGraph, results: freshResults, remainingErrors, remainingTotal, currentMemory };
}
