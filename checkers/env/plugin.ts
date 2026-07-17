// ─── Environment Variables Checker ───────────────────────────────────────────
import type { CheckerPlugin, CheckerResult, ParsedError, AggregatedIssue, FixOperation } from "../../cli/lib/checker-types.js";
import fs from "node:fs";
import path from "node:path";

const COMMON_REQUIRED_VARS: Record<string, string[]> = {
  "DATABASE_URL": ["prisma/schema.prisma"],
  "JWT_SECRET": ["jsonwebtoken", "better-auth", "next-auth"],
  "NEXTAUTH_SECRET": ["next-auth"],
  "API_KEY": [],
  "PORT": [],
  "NODE_ENV": [],
};

const envChecker: CheckerPlugin = {
  id: "env",
  name: "Environment Validator",
  category: "env",
  requires: [],  // always runs
  priority: 5,    // runs FIRST — other checkers depend on env
  canAutoFix: true,
  description: "Checks for missing required environment variables",

  async check(projectPath: string): Promise<CheckerResult> {
    const start = Date.now();
    const errors: ParsedError[] = [];
    const warnings: ParsedError[] = [];

    const envPath = path.join(projectPath, ".env");
    const envExamplePath = path.join(projectPath, ".env.example");
    const envVars: Record<string, string> = {};

    // Parse .env if it exists
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) envVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
    }

    // Check .env.example for expected vars
    const expectedVars: string[] = [];
    if (fs.existsSync(envExamplePath)) {
      const exampleRaw = fs.readFileSync(envExamplePath, "utf-8");
      for (const line of exampleRaw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) {
          const key = trimmed.slice(0, eq).trim();
          if (key && !key.includes("your_") && !key.includes("_here")) {
            expectedVars.push(key);
          }
        }
      }
    }

    // Check schema files for env() references
    const schemaPath = path.join(projectPath, "prisma", "schema.prisma");
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, "utf-8");
      const envRefs = schema.match(/env\(["']([^"']+)["']\)/g);
      if (envRefs) {
        for (const ref of envRefs) {
          const key = ref.match(/env\(["']([^"']+)["']\)/)?.[1];
          if (key && !envVars[key] && !expectedVars.includes(key)) {
            expectedVars.push(key);
          }
        }
      }
    }

    // Check for commonly required vars based on project content
    for (const [varName, indicators] of Object.entries(COMMON_REQUIRED_VARS)) {
      if (envVars[varName]) continue; // already set
      if (expectedVars.includes(varName)) continue; // already expected
      for (const indicator of indicators) {
        if (indicator === "" || fs.existsSync(path.join(projectPath, indicator))) {
          expectedVars.push(varName);
          break;
        }
      }
    }

    for (const key of expectedVars) {
      if (!envVars[key]) {
        errors.push({
          file: ".env",
          severity: "error",
          code: "MISSING_ENV_VAR",
          message: `Missing required environment variable: ${key}`,
          raw: `MISSING_ENV_VAR: ${key}`,
        });
      }
    }

    return {
      checker: "env", category: "env",
      passed: errors.length === 0,
      errors, warnings, skipped: false, durationMs: Date.now() - start,
    };
  },

  async fix(issues: AggregatedIssue[], projectPath: string): Promise<FixOperation[]> {
    const ops: FixOperation[] = [];
    const envPath = path.join(projectPath, ".env");
    let existing = "";
    if (fs.existsSync(envPath)) existing = fs.readFileSync(envPath, "utf-8");

    for (const issue of issues) {
      if (issue.code === "MISSING_ENV_VAR") {
        const varName = issue.message.replace("Missing required environment variable: ", "");
        if (!existing.includes(`${varName}=`)) {
          ops.push({
            op: "edit", path: ".env",
            search: existing.slice(-1) === "\n" ? existing : existing + "\n",
            replace: (existing.slice(-1) === "\n" ? existing : existing + "\n") + `${varName}=your_${varName.toLowerCase()}_here\n`,
          });
        }
      }
    }
    return ops;
  },
};

export default envChecker;
