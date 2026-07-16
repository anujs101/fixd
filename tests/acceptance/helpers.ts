// ─── Strong acceptance test helpers ──────────────────────────────────────────
// Every helper exists to verify observable user behavior, not log output.

import { build, createSession, run, cleanSession } from "../../automation/index.js";
import type { BuildArtifact, Session, RunResult } from "../../automation/index.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { execa } from "execa";
import { expect } from "vitest";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TESTING_ROOT = path.join(PROJECT_ROOT, "..", "testing");
const SESSIONS_ROOT = path.join(TESTING_ROOT, "sessions");
const FIXTURES_ROOT = path.join(TESTING_ROOT, "fixtures");
const ENV_FILE = path.join(TESTING_ROOT, ".env");

let _artifact: BuildArtifact | null = null;

export async function getArtifact(): Promise<BuildArtifact> {
  if (!_artifact) _artifact = await build(PROJECT_ROOT);
  return _artifact;
}

export async function newSession(fixtureName?: string): Promise<Session> {
  const options: { fixturePath?: string; envPath?: string } = {};
  if (fixtureName) options.fixturePath = path.join(FIXTURES_ROOT, fixtureName);
  if (existsSync(ENV_FILE)) options.envPath = ENV_FILE;
  return createSession(SESSIONS_ROOT, options);
}

export async function fixdRun(
  session: Session, args: string[],
  opts?: { input?: string; timeout?: number; env?: Record<string, string> },
): Promise<RunResult> {
  const artifact = await getArtifact();
  return run(session, artifact, args, {
    input: opts?.input ?? "",
    timeout: opts?.timeout,
    env: opts?.env,
  });
}

export async function cleanup(session: Session): Promise<void> {
  await cleanSession(session);
}

// ─── Filesystem verification ─────────────────────────────────────────────────

/** Hash a file for exact content comparison. */
export function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 16);
}

/** Hash all files in a directory (relative paths → hash). */
export function hashDirectory(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const result: Record<string, string> = {};
  function walk(d: string) {
    for (const entry of require("node:fs").readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else { result[path.relative(dir, full)] = hashFile(full); }
    }
  }
  walk(dir);
  return result;
}

/** Count issues of a specific type detected in doctor output. */
export function countIssueType(stdout: string, type: string): number {
  return (stdout.match(new RegExp(type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "g")) ?? []).length;
}

/** Parse detected issue types from doctor output. */
export function parseIssueTypes(stdout: string): string[] {
  const matches = stdout.match(/\b(HIGH|MEDIUM|LOW)\s+(\w+(?:_\w+)*)/g);
  return (matches ?? []).map(m => m.replace(/^(HIGH|MEDIUM|LOW)\s+/, ""));
}
