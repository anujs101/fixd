/**
 * fixEnv.ts — CLI-side atomic fixers
 *
 * Each fixer:
 *   1. Reads the current file (never destroys data if the file is missing)
 *   2. Applies ONE targeted change
 *   3. Writes atomically (write to .tmp → rename)
 *   4. Returns a FixResult with a diff string for display
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectScan } from "./scanFiles.js";

export interface FixResult {
  applied: boolean;
  description: string;
  diff: string;        // simple +/- diff for display
  filesChanged: string[];
}

// ─── Helper: atomic write ─────────────────────────────────────────────────────

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.fixd.tmp`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, filePath);
}

// ─── Helper: simple +/- diff ──────────────────────────────────────────────────

function simpleDiff(label: string, added: string[]): string {
  return [
    `--- ${label}`,
    ...added.map((l) => `+ ${l}`),
  ].join("\n");
}

// ─── Fixer 1: Prisma directUrl ────────────────────────────────────────────────
//
// Adds DIRECT_URL placeholder to .env and adds directUrl to schema.prisma.
// Only fires when: prisma found + connection is pooled + no directUrl yet.

export async function fixPrismaDirectUrl(
  projectPath: string,
  scan: ProjectScan
): Promise<FixResult> {
  if (!scan.prisma.found || scan.prisma.hasDirectUrl || scan.prisma.connectionType !== "pooled") {
    return { applied: false, description: "Prisma directUrl not needed", diff: "", filesChanged: [] };
  }

  const filesChanged: string[] = [];
  const diffs: string[] = [];

  // 1. Add DIRECT_URL to .env
  const envPath = path.join(projectPath, ".env");
  let envContent = "";
  try { envContent = await fs.readFile(envPath, "utf-8"); } catch { /* new file */ }

  if (!envContent.includes("DIRECT_URL=")) {
    const addition = "\n# Direct (non-pooled) URL for Prisma migrations\nDIRECT_URL=postgresql://user:pass@host:5432/dbname?sslmode=require\n";
    await atomicWrite(envPath, envContent + addition);
    filesChanged.push(".env");
    diffs.push(simpleDiff(".env", [
      "# Direct (non-pooled) URL for Prisma migrations",
      "DIRECT_URL=postgresql://user:pass@host:5432/dbname?sslmode=require",
    ]));
  }

  // 2. Add directUrl to prisma/schema.prisma
  const schemaPath = path.join(projectPath, "prisma", "schema.prisma");
  let schemaContent = "";
  try { schemaContent = await fs.readFile(schemaPath, "utf-8"); } catch { /* no prisma */ }

  if (schemaContent && !schemaContent.includes("directUrl")) {
    // Insert directUrl line after the url = env(...) line
    const updated = schemaContent.replace(
      /(\s+url\s*=\s*env\([^)]+\))/,
      '$1\n  directUrl = env("DIRECT_URL")'
    );
    if (updated !== schemaContent) {
      await atomicWrite(schemaPath, updated);
      filesChanged.push("prisma/schema.prisma");
      diffs.push(simpleDiff("prisma/schema.prisma", ['  directUrl = env("DIRECT_URL")']));
    }
  }

  return {
    applied: filesChanged.length > 0,
    description: "Added DIRECT_URL to .env and directUrl to prisma/schema.prisma",
    diff: diffs.join("\n\n"),
    filesChanged,
  };
}

// ─── Fixer 2: tsconfig strict ─────────────────────────────────────────────────

export async function fixTsconfigStrict(
  projectPath: string,
  scan: ProjectScan
): Promise<FixResult> {
  if (!scan.tsconfig) {
    return { applied: false, description: "No tsconfig.json found", diff: "", filesChanged: [] };
  }
  if (scan.tsconfig.compilerOptions?.strict === true) {
    return { applied: false, description: "tsconfig strict already enabled", diff: "", filesChanged: [] };
  }

  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  const content = await fs.readFile(tsconfigPath, "utf-8");
  const parsed = JSON.parse(content) as Record<string, any>;

  parsed.compilerOptions = parsed.compilerOptions ?? {};
  parsed.compilerOptions.strict = true;

  await atomicWrite(tsconfigPath, JSON.stringify(parsed, null, 2) + "\n");

  return {
    applied: true,
    description: 'Added "strict": true to tsconfig.json',
    diff: simpleDiff("tsconfig.json", ['"strict": true']),
    filesChanged: ["tsconfig.json"],
  };
}

// ─── Fixer 3: missing env key ─────────────────────────────────────────────────

export async function addMissingEnvKey(
  projectPath: string,
  key: string,
  placeholder: string,
  comment?: string
): Promise<FixResult> {
  const envPath = path.join(projectPath, ".env");
  let content = "";
  try { content = await fs.readFile(envPath, "utf-8"); } catch { /* new */ }

  if (content.includes(`${key}=`)) {
    return { applied: false, description: `${key} already set`, diff: "", filesChanged: [] };
  }

  const addition = `\n${comment ? `# ${comment}\n` : ""}${key}=${placeholder}\n`;
  await atomicWrite(envPath, content + addition);

  return {
    applied: true,
    description: `Added ${key} to .env`,
    diff: simpleDiff(".env", [
      ...(comment ? [`# ${comment}`] : []),
      `${key}=${placeholder}`,
    ]),
    filesChanged: [".env"],
  };
}

// ─── Fixer 4: kill zombie port ────────────────────────────────────────────────

import { killPort } from "./executeCommand.js";

export async function fixPortConflict(port: number): Promise<FixResult> {
  const result = await killPort(port);
  return {
    applied: result.success,
    description: result.success
      ? `Killed process on port ${port}`
      : `Could not kill port ${port}: ${result.stderr}`,
    diff: "",
    filesChanged: [],
  };
}

// ─── Fixer 5: add @types/node to tsconfig + install package ─────────────────────
//
// Fixes TS2591 "Cannot find name 'process'" / "node:fs" errors.
// 1. Adds "node" to tsconfig.json compilerOptions.types
// 2. Adds @types/node to package.json devDependencies (deferred install via npm/bun)

export async function fixTypescriptNodeTypes(
  projectPath: string
): Promise<FixResult> {
  const filesChanged: string[] = [];
  const diffs: string[] = [];

  // 1. Patch tsconfig.json
  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  try {
    const raw = await fs.readFile(tsconfigPath, "utf-8");
    const tsconfig = JSON.parse(raw) as Record<string, any>;
    tsconfig.compilerOptions = tsconfig.compilerOptions ?? {};

    const types: string[] = tsconfig.compilerOptions.types ?? [];
    if (!types.includes("node")) {
      tsconfig.compilerOptions.types = [...types, "node"];
      await atomicWrite(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
      filesChanged.push("tsconfig.json");
      diffs.push(simpleDiff("tsconfig.json", [`"types": [${tsconfig.compilerOptions.types.map((t: string) => `"${t}"`).join(", ")}]`]));
    }
  } catch {
    return { applied: false, description: "tsconfig.json not found or not valid JSON", diff: "", filesChanged: [] };
  }

  // 2. Check if @types/node is already installed
  const typesNodePath = path.join(projectPath, "node_modules", "@types", "node");
  let alreadyInstalled = false;
  try {
    await fs.stat(typesNodePath);
    alreadyInstalled = true;
  } catch { /* not installed */ }

  if (!alreadyInstalled) {
    // Detect package manager
    let installCmd = "npm install --save-dev @types/node";
    try {
      await fs.stat(path.join(projectPath, "bun.lock"));
      installCmd = "bun add -d @types/node";
    } catch { /* not bun */ }
    try {
      await fs.stat(path.join(projectPath, "pnpm-lock.yaml"));
      installCmd = "pnpm add -D @types/node";
    } catch { /* not pnpm */ }
    try {
      await fs.stat(path.join(projectPath, "yarn.lock"));
      installCmd = "yarn add -D @types/node";
    } catch { /* not yarn */ }

    // Run the install synchronously as part of the fix
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    try {
      await execAsync(installCmd, { cwd: projectPath, timeout: 60_000 });
      filesChanged.push("package.json", "node_modules/@types/node");
      diffs.push(simpleDiff("devDependencies", [`"@types/node": "latest"`]));
    } catch (installErr: any) {
      // tsconfig was patched, warn about manual install
      diffs.push(simpleDiff("ACTION REQUIRED", [`Run: ${installCmd}`]));
    }
  }

  return {
    applied: filesChanged.length > 0,
    description: `Added "node" to tsconfig types${alreadyInstalled ? "" : " and installed @types/node"}`,
    diff: diffs.join("\n\n"),
    filesChanged,
  };
}

// ─── Issue detection (CLI-side, no LLM needed) ───────────────────────────────

export interface DetectedIssue {
  severity: "HIGH" | "MEDIUM" | "LOW";
  type: string;
  description: string;
  autoFixable: boolean;
  fix?: () => Promise<FixResult>;
  file?: string;
}

export function detectIssues(scan: ProjectScan, projectPath: string): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // NOTE: PRISMA_POOLED_WITHOUT_DIRECT_URL → checkers/prisma/
  // NOTE: MISSING_DATABASE_URL → checkers/env/

  // Port conflicts on common dev ports
  const devPorts = [3000, 5173, 8080, 4000];
  for (const portInfo of scan.runningPorts) {
    if (devPorts.includes(portInfo.port)) {
      issues.push({
        severity: "MEDIUM",
        type: "PORT_CONFLICT",
        description: `Port ${portInfo.port} is occupied by PID ${portInfo.pid} (${portInfo.process}).`,
        autoFixable: true,
        fix: () => fixPortConflict(portInfo.port),
      });
    }
  }

  // NOTE: TSCONFIG_STRICT_MISSING → checkers/typescript/
  // NOTE: MISSING_PACKAGE_JSON   → checkers/package-json/
  // NOTE: MISSING_SCRIPTS        → checkers/package-json/


  // Node version mismatch
  if (scan.nodeVersion && scan.requiredNodeVersion) {
    const running = scan.nodeVersion.replace(/^v/, "").split(".")[0];
    const required = scan.requiredNodeVersion.replace(/[^0-9.]/g, "").split(".")[0];
    if (required && running && parseInt(running) < parseInt(required)) {
      issues.push({
        severity: "HIGH",
        type: "NODE_VERSION_MISMATCH",
        description: `Running Node ${scan.nodeVersion} but package.json requires ${scan.requiredNodeVersion}.`,
        autoFixable: false,
      });
    }
  }

  return issues;
}

