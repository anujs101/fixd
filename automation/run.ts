import { execa } from "execa";
import type { Session } from "./session.js";
import type { BuildArtifact } from "./build.js";

export type RunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
  signal: string | null;
};

export type RunOptions = {
  input?: string;
  timeout?: number;
  env?: Record<string, string>;
};

export async function run(
  session: Session,
  artifact: BuildArtifact,
  args: string[],
  options?: RunOptions,
): Promise<RunResult> {
  const start = Date.now();

  const command = artifact.type === "node" ? "node" : artifact.path;
  const commandArgs =
    artifact.type === "node" ? [artifact.path, ...args] : args;

  try {
    const result = await execa(command, commandArgs, {
      cwd: session.workspacePath,
      input: options?.input ?? "",
      timeout: options?.timeout ?? 300_000,
      reject: false,
      all: true,
      env: options?.env,
    });

    return {
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      duration: Date.now() - start,
      signal: null,
    };
  } catch (error: any) {
    if (error.isCanceled || error.timedOut) {
      return {
        exitCode: error.exitCode ?? null,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        duration: Date.now() - start,
        signal: error.signal ?? "SIGTERM",
      };
    }
    throw error;
  }
}
