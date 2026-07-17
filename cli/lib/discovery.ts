// ─── Centralized Stack Discovery Engine ──────────────────────────────────────
// Runs once per project. Uses multiple signal types to detect technologies.
// Caches results in .fixd/memory.json with mtime-based invalidation.
// Checkers never implement their own discovery — they only declare requires.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { KnownStack, StackSignal } from "./checker-types.js";

// ─── Signal detectors ────────────────────────────────────────────────────────

type SignalDetector = (projectPath: string) => StackSignal[];

/** Detect from config files: tsconfig.json, vite.config.ts, Cargo.toml, etc. */
function detectConfigFiles(projectPath: string): StackSignal[] {
  const signals: StackSignal[] = [];
  const configMap: Record<string, string> = {
    "tsconfig.json": "TypeScript",
    "vite.config.ts": "Vite",
    "vite.config.js": "Vite",
    "next.config.js": "Next.js",
    "next.config.ts": "Next.js",
    "Cargo.toml": "Rust",
    "go.mod": "Go",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "pom.xml": "Java",
    "build.gradle": "Java",
    "build.gradle.kts": "Kotlin",
    "Dockerfile": "Docker",
    "docker-compose.yml": "Docker",
    "docker-compose.yaml": "Docker",
    ".eslintrc.js": "ESLint",
    ".eslintrc.json": "ESLint",
    "eslint.config.js": "ESLint",
    "eslint.config.mjs": "ESLint",
    ".flake8": "Python",
    "setup.cfg": "Python",
    "mypy.ini": "Python",
    ".mypy.ini": "Python",
    ".rubocop.yml": "Ruby",
    "pnpm-workspace.yaml": "pnpm",
    "lerna.json": "Lerna",
    "turbo.json": "Turborepo",
  };

  for (const [file, tech] of Object.entries(configMap)) {
    if (fs.existsSync(path.join(projectPath, file))) {
      signals.push({ technology: tech, confidence: 1.0, evidence: [`${file} exists`] });
    }
  }
  return signals;
}

/** Detect from package.json: dependencies, scripts, devDependencies. */
function detectPackageJson(projectPath: string): StackSignal[] {
  const signals: StackSignal[] = [];
  const pkgPath = path.join(projectPath, "package.json");
  if (!fs.existsSync(pkgPath)) return signals;

  let pkg: any;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")); }
  catch { return signals; }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = Object.keys(pkg.scripts ?? {});

  const depMap: Record<string, string> = {
    "typescript": "TypeScript",
    "react": "React",
    "react-dom": "React",
    "vue": "Vue",
    "svelte": "Svelte",
    "angular": "Angular",
    "express": "Express",
    "fastify": "Fastify",
    "hono": "Hono",
    "next": "Next.js",
    "prisma": "Prisma",
    "@prisma/client": "Prisma",
    "drizzle-orm": "Drizzle",
    "vite": "Vite",
    "webpack": "Webpack",
    "esbuild": "esbuild",
    "jest": "Jest",
    "vitest": "Vitest",
    "mocha": "Mocha",
    "tailwindcss": "Tailwind",
    "django": "Django",
    "flask": "Flask",
    "fastapi": "FastAPI",
    "spring-boot": "Spring",
    "laravel": "Laravel",
    "rails": "Rails",
    "jsonwebtoken": "JWT",
    "bcrypt": "Auth",
    "better-auth": "Auth",
    "next-auth": "Auth",
    "passport": "Auth",
  };

  for (const [dep, tech] of Object.entries(depMap)) {
    if (allDeps[dep]) {
      signals.push({ technology: tech, confidence: 0.9, evidence: [`"${dep}" in package.json`] });
    }
  }

  // Script-based detection
  for (const script of scripts) {
    if (script.includes("prisma")) {
      signals.push({ technology: "Prisma", confidence: 0.7, evidence: [`"${script}" script uses prisma`] });
    }
    if (script.includes("vite")) {
      signals.push({ technology: "Vite", confidence: 0.7, evidence: [`"${script}" script uses vite`] });
    }
  }

  return signals;
}

/** Detect from directory structure: prisma/, src/, frontend/, etc. */
function detectDirectories(projectPath: string): StackSignal[] {
  const signals: StackSignal[] = [];
  const dirMap: Record<string, string> = {
    "prisma": "Prisma",
    "src": "TypeScript",
    "frontend": "React",
    "pages": "Next.js",
    "app": "Next.js",
    "components": "React",
    "migrations": "Prisma",
    "tests": "Testing",
    ".github": "GitHub Actions",
  };

  for (const [dir, tech] of Object.entries(dirMap)) {
    if (fs.existsSync(path.join(projectPath, dir))) {
      signals.push({ technology: tech, confidence: 0.6, evidence: [`${dir}/ directory exists`] });
    }
  }
  return signals;
}

/** Detect from file extensions in the project. */
function detectFilePatterns(projectPath: string): StackSignal[] {
  const signals: StackSignal[] = [];
  let hasTsx = false, hasJsx = false, hasTs = false, hasPy = false, hasRs = false, hasGo = false;

  function scan(dir: string, depth: number = 0) {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (e.isDirectory()) { scan(path.join(dir, e.name), depth + 1); continue; }
      if (e.name.endsWith(".tsx")) hasTsx = true;
      if (e.name.endsWith(".jsx")) hasJsx = true;
      if (e.name.endsWith(".ts")) hasTs = true;
      if (e.name.endsWith(".py")) hasPy = true;
      if (e.name.endsWith(".rs")) hasRs = true;
      if (e.name.endsWith(".go")) hasGo = true;
    }
  }
  scan(projectPath);

  if (hasTsx || hasJsx) signals.push({ technology: "React", confidence: 0.8, evidence: ["found .tsx/.jsx files"] });
  if (hasTs) signals.push({ technology: "TypeScript", confidence: 0.8, evidence: ["found .ts files"] });
  if (hasPy) signals.push({ technology: "Python", confidence: 0.9, evidence: ["found .py files"] });
  if (hasRs) signals.push({ technology: "Rust", confidence: 0.9, evidence: ["found .rs files"] });
  if (hasGo) signals.push({ technology: "Go", confidence: 0.9, evidence: ["found .go files"] });

  return signals;
}

/** Detect from lockfiles. */
function detectLockfiles(projectPath: string): StackSignal[] {
  const signals: StackSignal[] = [];
  const lockfileMap: Record<string, string> = {
    "package-lock.json": "npm",
    "yarn.lock": "Yarn",
    "pnpm-lock.yaml": "pnpm",
    "bun.lock": "Bun",
    "bun.lockb": "Bun",
    "Cargo.lock": "Rust",
    "go.sum": "Go",
    "Gemfile.lock": "Ruby",
    "composer.lock": "PHP",
  };

  for (const [file, tech] of Object.entries(lockfileMap)) {
    if (fs.existsSync(path.join(projectPath, file))) {
      signals.push({ technology: tech, confidence: 0.95, evidence: [`${file} exists`] });
    }
  }
  return signals;
}

// ─── Project hash for invalidation ───────────────────────────────────────────

function computeProjectHash(projectPath: string): string {
  const hash = createHash("sha256");
  const keyFiles = ["package.json", "tsconfig.json", "Cargo.toml", "go.mod", "Gemfile", "composer.json"];
  for (const f of keyFiles) {
    const fp = path.join(projectPath, f);
    if (fs.existsSync(fp)) hash.update(fs.readFileSync(fp));
  }
  return hash.digest("hex").slice(0, 16);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/** All signal detectors, run in order. */
const DETECTORS: SignalDetector[] = [
  detectConfigFiles,
  detectPackageJson,
  detectDirectories,
  detectFilePatterns,
  detectLockfiles,
];

/**
 * Discover the project's technology stack. Runs all detectors, merges signals
 * by technology name (taking the max confidence), and caches the result.
 */
export function discoverStack(projectPath: string, previous?: KnownStack): KnownStack {
  const projectHash = computeProjectHash(projectPath);

  // Cache hit: same project, no file changes
  if (previous && previous.projectHash === projectHash) {
    return previous;
  }

  // Run all detectors
  const signalMap = new Map<string, StackSignal>();
  for (const detector of DETECTORS) {
    for (const signal of detector(projectPath)) {
      const existing = signalMap.get(signal.technology);
      if (!existing || signal.confidence > existing.confidence) {
        signalMap.set(signal.technology, signal);
      } else if (signal.confidence === existing.confidence) {
        // Merge evidence
        existing.evidence.push(...signal.evidence);
      }
    }
  }

  const signals: Record<string, StackSignal> = {};
  for (const [tech, signal] of signalMap) {
    signals[tech] = signal;
  }

  return {
    signals,
    detectedAt: new Date().toISOString(),
    projectHash,
  };
}
