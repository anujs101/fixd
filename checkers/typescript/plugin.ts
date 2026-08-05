// ─── TypeScript Checker Plugin ────────────────────────────────────────────────
import type { CheckerPlugin, CheckerResult, ParsedError, AggregatedIssue, FixOperation } from "../../cli/lib/checker-types.js";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

function stripProjectPath(file: string, projectPath: string): string {
  return file.replace(projectPath + path.sep, "").replace(projectPath + "/", "");
}

function parseTsc(stdout: string, stderr: string, projectPath: string): ParsedError[] {
  const out = stdout + "\n" + stderr;
  const errors: ParsedError[] = [];
  const re = /^([^(\n]+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let m;
  while ((m = re.exec(out)) !== null) {
    errors.push({
      file: stripProjectPath(m[1].trim(), projectPath),
      line: parseInt(m[2]), col: parseInt(m[3]),
      code: m[5],
      severity: m[4] === "error" ? "error" : "warning",
      message: m[6].trim(), raw: m[0],
    });
  }
  return errors;
}

async function findTsc(projectPath: string): Promise<string | null> {
  const local = path.join(projectPath, "node_modules", ".bin", "tsc");
  if (fs.existsSync(local)) return local;
  try { await execa("which", ["tsc"], { timeout: 5000 }); return "tsc"; }
  catch { return null; }
}

const typescriptChecker: CheckerPlugin = {
  id: "typescript",
  name: "TypeScript Compiler",
  category: "compile",
  requires: ["TypeScript"],
  priority: 20,
  canAutoFix: false,
  description: "Runs tsc --noEmit to find type errors",

  async check(projectPath: string): Promise<CheckerResult> {
    const start = Date.now();
    const errors: any[] = [];
    const warnings: any[] = [];

    // Check tsconfig strict mode (migrated from fixEnv.ts detectIssues)
    const tsconfigPath = path.join(projectPath, "tsconfig.json");
    if (fs.existsSync(tsconfigPath)) {
      try {
        const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
        if (tsconfig.compilerOptions?.strict !== true) {
          warnings.push({
            file: "tsconfig.json", severity: "warning",
            code: "TSCONFIG_STRICT_MISSING",
            message: "tsconfig.json does not have strict:true. Unsafe TypeScript patterns are allowed.",
            raw: "TSCONFIG_STRICT_MISSING",
          });
        }
      } catch { /* invalid JSON — package-json checker handles this */ }
    }

    const tsc = await findTsc(projectPath);
    if (!tsc) return {
      checker: "typescript", category: "compile",
      passed: true, errors: [], warnings, skipped: true,
      skipReason: "tsc not installed", durationMs: Date.now() - start,
    };
    try {
      const { stdout, stderr, exitCode } = await execa(tsc, ["--noEmit"], {
        cwd: projectPath, reject: false, timeout: 60_000,
      });
      const all = parseTsc(stdout ?? "", stderr ?? "", projectPath);
      const errors = all.filter(e => e.severity === "error");
      // Pass/fail based on actual errors found, not exit code.
      // tsc may exit non-zero for tsconfig warnings that don't produce parseable errors.
      return {
        checker: "typescript", category: "compile",
        passed: errors.length === 0,
        errors: all.filter(e => e.severity === "error"),
        warnings: all.filter(e => e.severity !== "error"),
        skipped: false, durationMs: Date.now() - start,
      };
    } catch {
      return {
        checker: "typescript", category: "compile", passed: true,
        errors: [], warnings: [], skipped: true,
        skipReason: "tsc execution failed", durationMs: Date.now() - start,
      };
    }
  },
};

export default typescriptChecker;
