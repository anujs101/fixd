// ─── Dependencies Checker ────────────────────────────────────────────────────
import type { CheckerPlugin, CheckerResult, ParsedError } from "../../cli/lib/checker-types.js";
import fs from "node:fs";
import path from "node:path";

const depsChecker: CheckerPlugin = {
  id: "dependencies",
  name: "Dependency Validator",
  category: "deps",
  requires: [],   // always runs if package.json exists
  priority: 10,
  canAutoFix: false,
  description: "Checks lockfile consistency and missing dependencies",

  async check(projectPath: string): Promise<CheckerResult> {
    const start = Date.now();
    const errors: ParsedError[] = [];
    const warnings: ParsedError[] = [];

    const pkgPath = path.join(projectPath, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return {
        checker: "dependencies", category: "deps", passed: true,
        errors: [], warnings: [], skipped: true,
        skipReason: "No package.json found", durationMs: Date.now() - start,
      };
    }

    let pkg: any;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")); }
    catch {
      errors.push({ file: "package.json", severity: "error", code: "INVALID_JSON", message: "package.json is not valid JSON", raw: "INVALID_JSON" });
      return { checker: "dependencies", category: "deps", passed: false, errors, warnings, skipped: false, durationMs: Date.now() - start };
    }

    // Check lockfile exists
    const lockfiles = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
    const hasLockfile = lockfiles.some(f => fs.existsSync(path.join(projectPath, f)));
    if (!hasLockfile) {
      warnings.push({
        file: "package.json", severity: "warning", code: "NO_LOCKFILE",
        message: "No lockfile found. Run install to generate one.", raw: "NO_LOCKFILE",
      });
    }

    // Check scripts reference available tools
    const scripts = pkg.scripts ?? {};
    for (const [name, script] of Object.entries(scripts) as [string, string][]) {
      if (script.includes("prisma") && !pkg.dependencies?.prisma && !pkg.devDependencies?.prisma) {
        errors.push({
          file: "package.json", severity: "error", code: "MISSING_DEP",
          message: `Script "${name}" uses prisma but it's not in dependencies`, raw: `MISSING_DEP: prisma`,
        });
      }
      if (script.includes("vite") && !pkg.dependencies?.vite && !pkg.devDependencies?.vite) {
        errors.push({
          file: "package.json", severity: "error", code: "MISSING_DEP",
          message: `Script "${name}" uses vite but it's not in dependencies`, raw: `MISSING_DEP: vite`,
        });
      }
    }

    return {
      checker: "dependencies", category: "deps",
      passed: errors.length === 0,
      errors, warnings, skipped: false, durationMs: Date.now() - start,
    };
  },
};

export default depsChecker;
