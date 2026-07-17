// ─── Docker Checker ──────────────────────────────────────────────────────────
import type { CheckerPlugin, CheckerResult, ParsedError } from "../../cli/lib/checker-types.js";
import fs from "node:fs";
import path from "node:path";

const dockerChecker: CheckerPlugin = {
  id: "docker",
  name: "Dockerfile Validator",
  category: "container",
  requires: ["Docker"],
  priority: 80,
  canAutoFix: false,
  description: "Validates Dockerfile structure",

  async check(projectPath: string): Promise<CheckerResult> {
    const start = Date.now();
    const errors: ParsedError[] = [];
    const warnings: ParsedError[] = [];

    const dockerfilePath = path.join(projectPath, "Dockerfile");
    if (!fs.existsSync(dockerfilePath)) {
      return {
        checker: "docker", category: "container", passed: true,
        errors: [], warnings: [], skipped: true,
        skipReason: "No Dockerfile found", durationMs: Date.now() - start,
      };
    }

    const content = fs.readFileSync(dockerfilePath, "utf-8");

    if (!/^FROM\s+\S+/im.test(content)) {
      errors.push({ file: "Dockerfile", severity: "error", code: "MISSING_FROM", message: "Dockerfile missing FROM instruction", raw: "MISSING_FROM" });
    }
    if (!/COPY|ADD/i.test(content)) {
      warnings.push({ file: "Dockerfile", severity: "warning", code: "NO_COPY", message: "Dockerfile has no COPY or ADD instruction", raw: "NO_COPY" });
    }
    if (!/EXPOSE|CMD|ENTRYPOINT/i.test(content)) {
      warnings.push({ file: "Dockerfile", severity: "warning", code: "NO_RUNTIME", message: "Dockerfile missing EXPOSE, CMD, or ENTRYPOINT", raw: "NO_RUNTIME" });
    }
    if (/\/Users\//.test(content)) {
      errors.push({ file: "Dockerfile", severity: "error", code: "HARDCODED_PATH", message: "Dockerfile contains hardcoded user paths", raw: "HARDCODED_PATH" });
    }

    return {
      checker: "docker", category: "container",
      passed: errors.length === 0,
      errors, warnings, skipped: false, durationMs: Date.now() - start,
    };
  },
};

export default dockerChecker;
