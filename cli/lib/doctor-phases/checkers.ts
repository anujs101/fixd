// ─── Phase 3: Checker Orchestration ─────────────────────────────────────────
// Discovery Engine → load plugins → run checkers → build issue graph → display.

import chalk from "chalk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spin, info, section, success } from "../display.js";
import { discoverStack } from "../discovery.js";
import { loadAllCheckers, filterByStack } from "../checker-loader.js";
import { buildIssueGraph, formatGraphForPrompt } from "../issue-graph.js";
import { saveMemory, updateFromScan, type ProjectMemory } from "../memory.js";
import type { CheckerPlugin, CheckerResult } from "../checker-types.js";
import type { ScanResult } from "./scan.js";

export interface CheckerPhaseResult {
  allPlugins: CheckerPlugin[];
  checkerResults: CheckerResult[];
  checkerGraph: ReturnType<typeof buildIssueGraph> | null;
  checkerContext: string;
  knownStack: ReturnType<typeof discoverStack>;
  currentMemory: ProjectMemory;
}

export async function runCheckerPhase(
  projectPath: string,
  scanResult: ScanResult,
): Promise<CheckerPhaseResult> {
  let { currentMemory } = scanResult;
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const checkerDir = path.resolve(srcDir, "..", "..", "..", "checkers");

  // Discovery
  const knownStack = discoverStack(projectPath, currentMemory.knownStack as any);
  currentMemory = { ...currentMemory, knownStack: knownStack as any };
  await saveMemory(currentMemory);

  let allPlugins: CheckerPlugin[] = [];
  let checkerResults: CheckerResult[] = [];
  let checkerGraph: ReturnType<typeof buildIssueGraph> | null = null;

  try {
    allPlugins = await loadAllCheckers(checkerDir);
    if (allPlugins.length === 0) {
      const altDir = path.resolve(srcDir, "..", "..", "checkers");
      allPlugins = await loadAllCheckers(altDir);
    }
    const activePlugins = filterByStack(allPlugins, knownStack);

    if (activePlugins.length > 0) {
      const checkerSpinner = spin(`running ${activePlugins.length} checker(s)...`);
      checkerResults = await Promise.all(
        activePlugins.map(p => p.check(projectPath).catch((err: Error) => ({
          checker: p.id, category: p.category, passed: false,
          errors: [{ file: undefined, line: undefined, col: undefined, code: "CHECKER_ERROR", severity: "error" as const, message: err.message, raw: err.message }],
          warnings: [], skipped: true, skipReason: err.message, durationMs: 0,
        })))
      );
      checkerSpinner.stop();

      checkerGraph = buildIssueGraph(checkerResults, activePlugins);
      displayCheckerResults(checkerResults, checkerGraph);
    }
  } catch (err: any) {
    // Checker system failure is non-fatal — LLM analysis still runs
  }

  const checkerContext = checkerGraph
    ? formatGraphForPrompt(checkerGraph, Object.keys(knownStack.signals).join(", "))
    : "";

  return { allPlugins, checkerResults, checkerGraph, checkerContext, knownStack, currentMemory };
}

function displayCheckerResults(
  results: CheckerResult[],
  graph: ReturnType<typeof buildIssueGraph>,
): void {
  const passed = results.filter(r => r.passed && !r.skipped).length;
  const failed = results.filter(r => !r.passed).length;
  const skipped = results.filter(r => r.skipped).length;
  section("checkers");
  info(`${passed} passed, ${failed} failed, ${skipped} skipped`);

  for (const r of results) {
    if (r.skipped) continue;
    const icon = r.passed ? chalk.green("✔") : chalk.red("✖");
    console.log(`  ${icon} ${r.checker}: ${r.errors.length} error(s), ${r.warnings.length} warning(s) (${r.durationMs}ms)`);
  }

  if (graph && graph.nodes.length > 0) {
    console.log();
    const errors = graph.nodes.filter(n => n.severity === "HIGH");
    const warnings = graph.nodes.filter(n => n.severity === "MEDIUM");
    const suggestions = graph.nodes.filter(n => n.severity === "LOW");

    if (errors.length > 0) {
      console.log(`  ${chalk.red("Errors")} (${errors.length})`);
      for (const e of errors.slice(0, 10)) {
        const loc = e.file ? ` ${chalk.dim(e.file + (e.line ? `:${e.line}` : ""))}` : "";
        console.log(`    ${chalk.red("✖")} [${e.category}] ${e.message.slice(0, 100)}${loc}`);
      }
    }
    if (warnings.length > 0) {
      console.log(`  ${chalk.yellow("Warnings")} (${warnings.length})`);
      for (const w of warnings.slice(0, 5)) {
        const loc = w.file ? ` ${chalk.dim(w.file + (w.line ? `:${w.line}` : ""))}` : "";
        console.log(`    ${chalk.yellow("⚠")} [${w.category}] ${w.message.slice(0, 100)}${loc}`);
      }
    }
    if (suggestions.length > 0) {
      console.log(`  ${chalk.dim("Suggestions")} (${suggestions.length})`);
    }

    if (graph.rootCauses.length > 0) {
      console.log();
      info(`${chalk.white(graph.rootCauses.length)} root cause(s) — fixing these resolves downstream issues`);
    }

    // Execution plan
    if (errors.length > 0 && graph.rootCauses.length > 0) {
      console.log();
      section("execution plan");
      const categories = [...new Set(graph.rootCauses.map(rc => rc.category))];
      for (let i = 0; i < categories.length; i++) {
        const catRoot = graph.rootCauses.find(rc => rc.category === categories[i]);
        console.log(`  ${chalk.cyan(`Phase ${i + 1}`)}  ${categories[i]}`);
        if (catRoot) console.log(`    ${chalk.dim("✓")} ${catRoot.message.slice(0, 80)}`);
      }
      console.log();
      console.log(`  ${chalk.dim("Estimated: ·")} ${graph.rootCauses.length} root cause(s) · ~${Math.min(graph.rootCauses.length * 2, 20)} edit(s) · ${categories.length} checker(s) re-run`);
      console.log();
    }
  }
  console.log();
}
