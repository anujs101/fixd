// ─── TypeScript Checker Plugin ────────────────────────────────────────────────
import type { CheckerPlugin, CheckerResult, ParsedError, AggregatedIssue, FixOperation } from "../../cli/lib/checker-types.js";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

// ─── @types registry cache ────────────────────────────────────────────────────
// Avoids repeated network calls within a single fixd invocation.
const _typesRegistryCache = new Map<string, boolean>();

// Hardcoded allowlist of popular packages known to have @types on DefinitelyTyped.
// Seeded at startup to skip network calls for the most common TS7016 triggers.
// Sourced from DefinitelyTyped top packages (npm download rankings).
const KNOWN_TYPES_PACKAGES = new Set([
  "bcryptjs", "lodash", "express", "react", "react-dom", "node",
  "uuid", "cors", "morgan", "helmet", "body-parser", "cookie-parser",
  "dotenv", "jsonwebtoken", "multer", "passport", "axios", "cheerio",
  "debug", "fs-extra", "glob", "jest", "mocha", "chai", "sinon",
  "ws", "redis", "pg", "mysql", "sqlite3", "nodemailer", "sharp",
  "yargs", "minimist", "semver", "compression", "cookies", "ioredis",
  "jquery", "leaflet", "lodash.debounce", "lodash.merge", "mime",
  "moment", "node-fetch", "nprogress", "pino", "pluralize",
  "prompt-sync", "qrcode", "redux", "sanitize-html", "serve-favicon",
  "styled-components", "supertest", "swagger-ui-express", "tar",
  "three", "tmp", "validator", "webpack", "xml2js", "winston",
]);

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

// ─── TS7016 enrichment helpers ────────────────────────────────────────────────

/** Extract the bare module name from a TS7016 error message. */
function extractModuleName(message: string): string | null {
  // "Could not find a declaration file for module 'bcryptjs'."
  // "Could not find a declaration file for module 'lodash/debounce'."
  const m = message.match(/module\s+['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

/**
 * Check whether @types/<module> exists on the npm registry.
 * Uses a module-level cache + hardcoded allowlist to avoid repeated network calls.
 */
async function checkTypesPackageExists(moduleName: string): Promise<boolean> {
  // Scoped packages: @scope/foo → check @types/scope__foo
  // (DefinitelyTyped convention for scoped packages)
  const typesName = moduleName.startsWith("@")
    ? `@types/${moduleName.slice(1).replace("/", "__")}`
    : `@types/${moduleName}`;

  // Cache hit
  if (_typesRegistryCache.has(typesName)) {
    return _typesRegistryCache.get(typesName)!;
  }

  // Hardcoded allowlist (covers ~60 most common packages)
  if (!moduleName.startsWith("@") && KNOWN_TYPES_PACKAGES.has(moduleName)) {
    _typesRegistryCache.set(typesName, true);
    return true;
  }

  // Network check — npm view with short timeout
  try {
    const { stdout, exitCode } = await execa("npm", ["view", typesName, "version", "--json"], {
      timeout: 5_000,
      reject: false,
    });
    if (exitCode === 0 && stdout) {
      try {
        const parsed = JSON.parse(stdout.trim());
        // Valid response: either a string version or object with version field
        if (typeof parsed === "string" || (parsed && typeof parsed === "object")) {
          _typesRegistryCache.set(typesName, true);
          return true;
        }
      } catch {
        // Non-JSON output → package doesn't exist
      }
    }
    _typesRegistryCache.set(typesName, false);
    return false;
  } catch {
    // Network error / timeout → don't cache, caller falls through
    return false;
  }
}

/**
 * Search the project for an existing .d.ts file that declares the given module.
 * Returns the relative path if found, null otherwise.
 */
function findExistingDeclaration(projectPath: string, moduleName: string): string | null {
  // Search common declaration directories
  const searchDirs = [
    path.join(projectPath, "src", "types"),
    path.join(projectPath, "types"),
    path.join(projectPath, "src"),
    projectPath,
  ];

  // Also glob *.d.ts in the whole project (excluding node_modules)
  const candidates: string[] = [];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".d.ts")) {
          candidates.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Permission error — skip
    }
  }

  // Deep search for *.d.ts files (guarded — only src + project root, skip node_modules)
  function collectDts(dir: string, depth: number) {
    if (depth > 3) return; // max 3 levels deep
    if (!fs.existsSync(dir)) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".d.ts")) {
          if (!candidates.includes(full)) candidates.push(full);
        } else if (entry.isDirectory() && depth < 3) {
          collectDts(full, depth + 1);
        }
      }
    } catch { /* permission error */ }
  }
  collectDts(path.join(projectPath, "src"), 0);

  // Check each candidate for the declare module statement
  const escapedName = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declPattern = new RegExp(`declare\\s+module\\s+['"\`]${escapedName}['"\`]`);
  for (const abs of candidates) {
    try {
      const content = fs.readFileSync(abs, "utf-8");
      if (declPattern.test(content)) {
        return path.relative(projectPath, abs);
      }
    } catch { /* skip unreadable files */ }
  }

  return null;
}

/**
 * Check whether a file path is covered by tsconfig.json's compilation scope.
 * Reads tsconfig.json and checks include, files, and typeRoots/types.
 */
function isCoveredByTsconfig(projectPath: string, relPath: string): boolean {
  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return true; // no tsconfig → assume covered

  let tsconfig: any;
  try {
    tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
  } catch {
    return true; // invalid JSON → can't determine, assume covered
  }

  const include: string[] = tsconfig.include ?? [];
  const files: string[] = tsconfig.files ?? [];
  const typeRoots: string[] = tsconfig.compilerOptions?.typeRoots ?? [];

  // Check files (exact match)
  for (const f of files) {
    if (f === relPath || path.resolve(projectPath, f) === path.resolve(projectPath, relPath)) {
      return true;
    }
  }

  // Check include globs
  for (const pattern of include) {
    // Simple glob matching: dir/**/* or dir/*
    const globDir = pattern.replace(/\/?\*\*\/?\*$/, "").replace(/\/?\*$/, "");
    const absGlobDir = path.resolve(projectPath, globDir);
    const absFile = path.resolve(projectPath, relPath);
    if (absFile.startsWith(absGlobDir + path.sep) || absFile === absGlobDir) {
      return true;
    }
    // Also match exact patterns like "src/**/*.d.ts" or "types/*.d.ts"
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*") + "$"
      );
      if (regex.test(relPath)) return true;
    }
  }

  // Check typeRoots — type declaration directories
  for (const tr of typeRoots) {
    const absTypeRoot = path.resolve(projectPath, tr);
    const absFile = path.resolve(projectPath, relPath);
    if (absFile.startsWith(absTypeRoot + path.sep)) return true;
  }

  return false;
}

/**
 * Post-process TS7016 errors to provide better diagnosis.
 * Priority chain: @types exists → install it. .d.ts exists but not covered → fix tsconfig.
 * Only leaves plain TS7016 when neither applies (genuinely untyped package).
 */
async function enrichTs7016Errors(
  errors: ParsedError[],
  projectPath: string,
): Promise<ParsedError[]> {
  const enriched: ParsedError[] = [];

  for (const err of errors) {
    if (err.code !== "TS7016" || err.severity !== "error") {
      enriched.push(err);
      continue;
    }

    const moduleName = extractModuleName(err.message);
    if (!moduleName) {
      enriched.push(err);
      continue;
    }

    // ── Fix 0: Check @types/<module> on npm ───────────────────────────────
    const hasTypesPackage = await checkTypesPackageExists(moduleName);
    if (hasTypesPackage) {
      enriched.push({
        ...err,
        code: "MISSING_TYPES_PACKAGE",
        severity: "error",
        message: `@types/${moduleName} exists on npm — install it with your package manager (e.g. npm install -D @types/${moduleName})`,
        raw: err.raw,
      });
      continue;
    }

    // ── Fix 3: Check for existing .d.ts file (tsconfig discovery) ──────────
    const declPath = findExistingDeclaration(projectPath, moduleName);
    if (declPath) {
      const covered = isCoveredByTsconfig(projectPath, declPath);
      if (!covered) {
        const declDir = path.dirname(declPath);
        enriched.push({
          ...err,
          code: "TS7016_DECLARATION_NOT_INCLUDED",
          severity: "error",
          message: `Declaration file for '${moduleName}' exists at ${declPath} but is not covered by tsconfig.json include — add "${declDir}" to tsconfig.json "include" array`,
          raw: err.raw,
        });
        continue;
      }
      // .d.ts exists and IS covered but tsc still can't find it —
      // could be tsc incremental cache or typeRoots misconfiguration
      enriched.push({
        ...err,
        code: "TS7016_DECLARATION_NOT_PICKED_UP",
        severity: "error",
        message: `Declaration file for '${moduleName}' exists at ${declPath} and appears to be covered by tsconfig, but tsc is not picking it up — try clearing tsc build cache (rm -rf tsconfig.tsbuildinfo) or checking typeRoots`,
        raw: err.raw,
      });
      continue;
    }

    // ── Fallback: genuinely untyped package — LLM must handle ──────────────
    enriched.push(err);
  }

  return enriched;
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
      const parsed = parseTsc(stdout ?? "", stderr ?? "", projectPath);
      const enriched = await enrichTs7016Errors(parsed, projectPath);
      const errors = enriched.filter(e => e.severity === "error");
      // Pass/fail based on actual errors found, not exit code.
      // tsc may exit non-zero for tsconfig warnings that don't produce parseable errors.
      return {
        checker: "typescript", category: "compile",
        passed: errors.length === 0,
        errors: enriched.filter(e => e.severity === "error"),
        warnings: enriched.filter(e => e.severity !== "error"),
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
