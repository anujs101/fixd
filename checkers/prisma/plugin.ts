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

    // Check for pooled connection without directUrl (migrated from fixEnv.ts)
    const schema = fs.readFileSync(schemaPath, "utf-8");
    if (schema.includes("url") && !schema.includes("directUrl")) {
      const urlMatch = schema.match(/url\s*=\s*env\(["']([^"']+)["']\)/);
      if (urlMatch) {
        const envKey = urlMatch[1];
        const envPath = path.join(projectPath, ".env");
        let urlValue = "";
        if (fs.existsSync(envPath)) {
          const envRaw = fs.readFileSync(envPath, "utf-8");
          const match = envRaw.match(new RegExp(`^${envKey}=(.+)$`, "m"));
          if (match) urlValue = match[1].trim();
        }
        // Neon/Supabase pooled URLs have pooler subdomain or port 6543
        if (urlValue.includes("pooler.") || urlValue.includes("-pooler.") || urlValue.includes(":6543")) {
          warnings.push({
            file: "prisma/schema.prisma", severity: "warning",
            code: "PRISMA_POOLED_WITHOUT_DIRECT_URL",
            message: "DATABASE_URL uses a pooled connection but no directUrl is set. Migrations will fail.",
            raw: "PRISMA_POOLED_WITHOUT_DIRECT_URL",
          });
        }
      }
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
