// ─── Phase 1+2: Project Scan + Issue Detection ──────────────────────────────
// Deterministic, no LLM. Produces the project state snapshot used by all
// downstream phases.

import chalk from "chalk";
import { spin, info, warn, success, section, printIssue } from "../display.js";
import { scanProject } from "../../../src/actions/scanFiles.js";
import { detectIssues, fixTypescriptNodeTypes, type DetectedIssue } from "../../../src/actions/fixEnv.js";
import { runDiagnostics, formatDiagnosticsForContext, getAllErrors } from "../diagnostics.js";
import { loadMemory, saveMemory, updateFromScan, type ProjectMemory } from "../memory.js";
import { detectLibrariesInProject } from "../context7.js";

export interface ScanResult {
  scan: Awaited<ReturnType<typeof scanProject>>;
  currentMemory: ProjectMemory;
  projectLibraries: string[];
  issues: DetectedIssue[];
  autoFixable: DetectedIssue[];
  manual: DetectedIssue[];
  knownTypes: Set<string>;
  diagContext: string;
}

export async function runScanPhase(
  projectPath: string,
  currentMemory: ProjectMemory,
): Promise<ScanResult> {
  // ── Phase 1: Local scan + diagnostics ─────────────────────────────────
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

  currentMemory = updateFromScan(currentMemory, scan);
  await saveMemory(currentMemory);

  const projectLibraries = await detectLibrariesInProject(projectPath).catch(() => [] as string[]);

  const diagSpinner2 = spin("running diagnostics...");
  const diagResults = await runDiagnostics(projectPath);
  diagSpinner2.stop();

  printDiagnosticsImmediate(diagResults);

  const diagContext = formatDiagnosticsForContext(diagResults);
  const diagErrors = getAllErrors(diagResults);

  // ── Phase 2: Issue detection ─────────────────────────────────────────
  const issues = detectIssues(scan, projectPath);

  const ts2591Errors = diagErrors.filter((e) => e.code === "TS2591");
  const otherDiagErrors = diagErrors.filter((e) => e.code !== "TS2591");

  if (ts2591Errors.length > 0) {
    issues.push({
      severity: "HIGH", type: "MISSING_NODE_TYPES",
      description: `${ts2591Errors.length} TS2591 error(s) — @types/node not configured. Run: bun add -d @types/node`,
      autoFixable: true,
      fix: () => fixTypescriptNodeTypes(projectPath),
    });
  }

  for (const e of otherDiagErrors) {
    const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}${e.col ? `:${e.col}` : ""}` : "";
    issues.push({
      severity: "HIGH", type: `${e.stack.toUpperCase().replace(/\s+/g, "_")}_ERROR${e.code ? `_${e.code}` : ""}`,
      description: `${loc ? loc + " — " : ""}${e.message}`,
      autoFixable: false, file: e.file,
    });
  }

  const autoFixable = issues.filter((i) => i.autoFixable);
  const manual = issues.filter((i) => !i.autoFixable);
  const knownTypes = new Set(issues.map((i) => i.type));

  section("issues found");
  printDetectedIssues(issues);

  return { scan, currentMemory, projectLibraries, issues, autoFixable, manual, knownTypes, diagContext };
}

// ─── Build scan context for LLM prompt ─────────────────────────────────────

export function buildScanContext(
  projectPath: string,
  scan: Awaited<ReturnType<typeof scanProject>>,
  diagContext: string,
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
  if (diagContext) { lines.push("DIAGNOSTICS:"); lines.push(diagContext); }
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
    for (const p of scan.runningPorts) lines.push(`  ${p.port} → PID ${p.pid} (${p.process})`);
    lines.push("");
  }
  if (scan.dockerPorts && scan.dockerPorts.length > 0) {
    lines.push("DOCKER COMPOSE PORTS:");
    for (const dp of scan.dockerPorts) lines.push(`  ${dp.service}: host ${dp.hostPort} → container ${dp.containerPort}`);
    lines.push("");
  }
  if (scan.errors.length > 0) {
    lines.push("SCAN ERRORS:");
    for (const e of scan.errors) lines.push(`  - ${e}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Helpers (moved from doctor.ts) ───────────────────────────────────────

function printDetectedIssues(issues: DetectedIssue[]) {
  if (issues.length === 0) { success("No issues detected."); return; }
  for (const issue of issues) {
    printIssue(issue.severity, `${issue.type}`);
    console.log(`     ${chalk.dim(issue.description)}`);
    console.log(`     ${chalk.dim("Auto-fixable:")} ${issue.autoFixable ? chalk.green("yes") : chalk.yellow("no — manual action required")}`);
    console.log();
  }
}

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
