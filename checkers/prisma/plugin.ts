// ─── Prisma Checker ──────────────────────────────────────────────────────────
import type { CheckerPlugin, CheckerResult } from "../../cli/lib/checker-types.js";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";

const prismaChecker: CheckerPlugin = {
  id: "prisma",
  name: "Prisma Validator",
  category: "schema",
  requires: ["Prisma"],
  priority: 15,
  canAutoFix: false,
  description: "Runs prisma validate and prisma generate",

  async check(projectPath: string): Promise<CheckerResult> {
    const start = Date.now();
    const errors: any[] = [];
    const warnings: any[] = [];
    let skipped = false;
    let skipReason = "";

    const schemaPath = path.join(projectPath, "prisma", "schema.prisma");
    if (!fs.existsSync(schemaPath)) {
      return {
        checker: "prisma", category: "schema", passed: true,
        errors: [], warnings: [], skipped: true,
        skipReason: "No prisma/schema.prisma found", durationMs: Date.now() - start,
      };
    }

    // Find prisma CLI
    const localPrisma = path.join(projectPath, "node_modules", ".bin", "prisma");
    const prismaBin = fs.existsSync(localPrisma) ? localPrisma : "npx prisma";

    // prisma validate
    try {
      const { stderr, exitCode } = await execa(prismaBin, ["validate"], {
        cwd: projectPath, reject: false, timeout: 30_000,
      });
      if (exitCode !== 0 && stderr) {
        errors.push({
          file: "prisma/schema.prisma", severity: "error",
          code: "PRISMA_VALIDATE_FAILED",
          message: stderr.slice(0, 200).trim() || "prisma validate failed",
          raw: stderr,
        });
      }
    } catch (err: any) {
      skipped = true;
      skipReason = `prisma CLI not found (run: npm install prisma)`;
    }

    // prisma generate (warns if client is out of date)
    if (!skipped) {
      try {
        const { stderr: genErr } = await execa(prismaBin, ["generate"], {
          cwd: projectPath, reject: false, timeout: 30_000,
        });
        if (genErr && !genErr.includes("Generated")) {
          warnings.push({
            file: "prisma/schema.prisma", severity: "warning",
            code: "PRISMA_GENERATE_WARNING",
            message: genErr.slice(0, 200).trim(), raw: genErr,
          });
        }
      } catch { /* generate failed — not blocking */ }
    }

    return {
      checker: "prisma", category: "schema",
      passed: errors.length === 0,
      errors, warnings, skipped, skipReason, durationMs: Date.now() - start,
    };
  },
};

export default prismaChecker;
