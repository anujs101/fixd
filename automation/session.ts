import { randomBytes } from "node:crypto";
import { mkdir, cp, rm, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

export type Session = {
  id: string;
  workspacePath: string;
};

export type SessionSummary = {
  id: string;
  createdAt: Date;
};

function generateSessionId(): string {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[T:]/g, "-")
    .replace(/\..+/, "")
    .slice(0, 19);
  const rand = randomBytes(2).toString("hex");
  return `sess-${stamp}-${rand}`;
}

export async function createSession(
  sessionsRoot: string,
  options?: { fixturePath?: string; envPath?: string },
): Promise<Session> {
  const id = generateSessionId();
  const sessionDir = path.join(sessionsRoot, id);
  const workspacePath = path.join(sessionDir, "workspace");

  await mkdir(workspacePath, { recursive: true });

  if (options?.fixturePath) {
    await cp(options.fixturePath, workspacePath, { recursive: true });
  }

  if (options?.envPath) {
    await cp(options.envPath, path.join(workspacePath, ".env"));
  }

  return { id, workspacePath };
}

export async function cleanSession(session: Session): Promise<void> {
  const sessionDir = path.dirname(session.workspacePath);
  await rm(sessionDir, { recursive: true, force: true });
}

export async function listSessions(
  sessionsRoot: string,
): Promise<SessionSummary[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const results: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const entryStat = await stat(path.join(sessionsRoot, entry.name));
    results.push({
      id: entry.name,
      createdAt: entryStat.birthtime,
    });
  }

  results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return results;
}
