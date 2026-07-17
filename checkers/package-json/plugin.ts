// ─── package.json Validator ──────────────────────────────────────────────────
import type { CheckerPlugin, CheckerResult, ParsedError } from "../../cli/lib/checker-types.js";
import fs from "node:fs";
import path from "node:path";

const pkgJsonChecker: CheckerPlugin = {
  id: "package-json",
  name: "package.json Validator",
  category: "structure",
  requires: [],
  priority: 8,
  canAutoFix: false,
  description: "Validates package.json structure and required fields",

  async check(projectPath: string): Promise<CheckerResult> {
    const start = Date.now();
    const errors: ParsedError[] = [];
    const warnings: ParsedError[] = [];

    const pkgPath = path.join(projectPath, "package.json");
    if (!fs.existsSync(pkgPath)) {
      errors.push({
        file: "package.json", severity: "error", code: "MISSING_PACKAGE_JSON",
        message: "No package.json found in project root", raw: "MISSING_PACKAGE_JSON",
      });
      return {
        checker: "package-json", category: "structure", passed: false,
        errors, warnings, skipped: false, durationMs: Date.now() - start,
      };
    }

    let pkg: any;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")); }
    catch {
      errors.push({ file: "package.json", severity: "error", code: "INVALID_JSON", message: "package.json is not valid JSON", raw: "INVALID_JSON" });
      return { checker: "package-json", category: "structure", passed: false, errors, warnings, skipped: false, durationMs: Date.now() - start };
    }

    if (!pkg.name) errors.push({ file: "package.json", severity: "error", code: "MISSING_NAME", message: "package.json is missing 'name' field", raw: "MISSING_NAME" });
    if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) {
      warnings.push({ file: "package.json", severity: "warning", code: "NO_SCRIPTS", message: "package.json has no scripts defined", raw: "NO_SCRIPTS" });
    }

    return {
      checker: "package-json", category: "structure",
      passed: errors.length === 0,
      errors, warnings, skipped: false, durationMs: Date.now() - start,
    };
  },
};

export default pkgJsonChecker;
