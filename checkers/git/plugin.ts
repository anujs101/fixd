// ─── Git Checker ─────────────────────────────────────────────────────────────
import type { CheckerPlugin, CheckerResult } from "../../cli/lib/checker-types.js";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";

const gitChecker: CheckerPlugin = {
  id: "git",
  name: "Git Status",
  category: "vcs",
  requires: [],
  priority: 90,
  canAutoFix: false,
  description: "Checks for uncommitted changes, detached HEAD, and git health",

  async check(projectPath: string): Promise<CheckerResult> {
    const start = Date.now();
    const errors: any[] = [];
    const warnings: any[] = [];

    if (!fs.existsSync(path.join(projectPath, ".git"))) {
      return {
        checker: "git", category: "vcs", passed: true,
        errors: [], warnings: [], skipped: true,
        skipReason: "Not a git repository", durationMs: Date.now() - start,
      };
    }

    try {
      // Check for uncommitted changes
      const { stdout: status } = await execa("git", ["status", "--porcelain"], {
        cwd: projectPath, reject: false, timeout: 10_000,
      });
      if (status.trim()) {
        const changedFiles = status.trim().split("\n").length;
        warnings.push({
          severity: "warning", code: "UNCOMMITTED_CHANGES",
          message: `${changedFiles} file(s) with uncommitted changes`, raw: status.slice(0, 200),
        });
      }

      // Check for detached HEAD
      const { stdout: branch } = await execa("git", ["branch", "--show-current"], {
        cwd: projectPath, reject: false, timeout: 5_000,
      });
      if (!branch.trim()) {
        warnings.push({
          severity: "warning", code: "DETACHED_HEAD",
          message: "Git is in detached HEAD state", raw: "DETACHED_HEAD",
        });
      }
    } catch { /* git not installed — skip */ }

    return {
      checker: "git", category: "vcs",
      passed: errors.length === 0,
      errors, warnings, skipped: false, durationMs: Date.now() - start,
    };
  },
};

export default gitChecker;
