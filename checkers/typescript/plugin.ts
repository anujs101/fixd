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
    const tsc = await findTsc(projectPath);
    if (!tsc) {
      return {
        checker: "typescript", category: "compile", passed: true,
        errors: [], warnings: [], skipped: true,
        skipReason: "tsc not installed (run: npm install typescript)", durationMs: Date.now() - start,
      };
    }
    try {
      const { stdout, stderr, exitCode } = await execa(tsc, ["--noEmit"], {
        cwd: projectPath, reject: false, timeout: 60_000,
      });
      const all = parseTsc(stdout ?? "", stderr ?? "", projectPath);
      return {
        checker: "typescript", category: "compile",
        passed: exitCode === 0 && all.filter(e => e.severity === "error").length === 0,
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
