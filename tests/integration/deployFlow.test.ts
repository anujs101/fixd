import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupDir, makeTmpDir, sampleProjectFiles, writeFixture } from "../helpers.js";

const deployState = vi.hoisted(() => ({
  confirms: [] as boolean[],
  prompts: [] as string[],
  execaCalls: [] as Array<{ command: string; args: string[] }>,
  dockerAvailable: true,
}));

vi.mock("../../cli/lib/display.js", () => ({
  printHeader: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  spin: vi.fn(() => ({ succeed: vi.fn(), fail: vi.fn(), stop: vi.fn() })),
  confirm: vi.fn(async () => deployState.confirms.shift() ?? true),
  prompt: vi.fn(async () => deployState.prompts.shift() ?? ""),
}));

vi.mock("../../cli/lib/llm.js", () => ({
  ask: vi.fn(async () => "FROM node:lts-alpine\nEXPOSE 3000\nCMD [\"npm\", \"start\"]"),
}));

vi.mock("../../cli/lib/sub-agents.js", () => ({
  exploreProject: vi.fn(async () => ({ framework: "Node.js", packageManager: "npm", runtime: "node", hasTypeScript: false, hasPrisma: false })),
}));

vi.mock("execa", () => ({
  execa: vi.fn(async (command: string, args: string[]) => {
    deployState.execaCalls.push({ command, args });
    if (command === "docker" && args[0] === "info" && !deployState.dockerAvailable) {
      throw new Error("docker missing");
    }
    return { stdout: "container-id-1234567890" };
  }),
}));

vi.mock("../../src/actions/executeCommand.js", () => ({
  executeCommand: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })),
}));

import { runDeploy } from "../../cli/deploy.js";
import { confirm, prompt } from "../../cli/lib/display.js";

function imageNameFor(projectRoot: string): string {
  return `${basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]/g, "-")}:latest`;
}

function containerNameFor(projectRoot: string): string {
  return `${basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-fixd`;
}

describe("deploy flow", () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = makeTmpDir();
    writeFixture(tmpDir, sampleProjectFiles());
    deployState.confirms.length = 0;
    deployState.prompts.length = 0;
    deployState.execaCalls.length = 0;
    deployState.dockerAvailable = true;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    cleanupDir(tmpDir);
  });

  test("fixd deploy generates a Dockerfile from LLM output", async () => {
    deployState.confirms.push(true, false, false, false);
    await runDeploy(tmpDir);
    expect(existsSync(`${tmpDir}/Dockerfile`)).toBe(true);
    expect(readFileSync(`${tmpDir}/Dockerfile`, "utf-8")).toBe("FROM node:lts-alpine\nEXPOSE 3000\nCMD [\"npm\", \"start\"]");
    expect(vi.mocked(confirm).mock.calls.map((call) => call[0])).toEqual([
      "Write this Dockerfile to project?",
      "Generate docker-compose.yml?",
      `Build Docker image "${imageNameFor(tmpDir)}"?`,
      "Run container locally on port 3000?",
      "Push image to a container registry?",
    ]);
  });

  test("fixd deploy generates docker-compose.yml", async () => {
    deployState.confirms.push(true, true, false, false, false);
    await runDeploy(tmpDir);
    expect(existsSync(`${tmpDir}/docker-compose.yml`)).toBe(true);
    expect(readFileSync(`${tmpDir}/docker-compose.yml`, "utf-8")).toContain('      - "3000:3000"');
    expect(vi.mocked(confirm).mock.calls.map((call) => call[0])).toEqual([
      "Write this Dockerfile to project?",
      "Generate docker-compose.yml?",
      `Build Docker image "${imageNameFor(tmpDir)}"?`,
      "Run container locally on port 3000?",
      "Push image to a container registry?",
    ]);
  });

  test("--build flag skips confirmation prompt for build step", async () => {
    deployState.confirms.push(true, false, false, false);
    await runDeploy(tmpDir, { build: true });
    expect(vi.mocked(confirm).mock.calls.map((call) => call[0])).not.toContain(`Build Docker image "${imageNameFor(tmpDir)}"?`);
    expect(deployState.execaCalls).toEqual([
      { command: "docker", args: ["info"] },
      { command: "docker", args: ["build", "-t", imageNameFor(tmpDir), "."] },
    ]);
  });

  test("--run flag skips confirmation for run step", async () => {
    deployState.confirms.push(true, false, false, false);
    await runDeploy(tmpDir, { run: true });
    expect(vi.mocked(confirm).mock.calls.map((call) => call[0])).not.toContain("Run container locally on port 3000?");
    expect(deployState.execaCalls).toEqual([
      { command: "docker", args: ["info"] },
      { command: "docker", args: ["run", "-d", "--rm", "-p", "3000:3000", "--name", containerNameFor(tmpDir), imageNameFor(tmpDir)] },
    ]);
  });

  test("--push flag skips confirmation for push step", async () => {
    deployState.confirms.push(true, false, false, false);
    deployState.prompts.push("docker.io/me");
    await runDeploy(tmpDir, { push: true });
    expect(vi.mocked(confirm).mock.calls.map((call) => call[0])).not.toContain("Push image to a container registry?");
    expect(vi.mocked(prompt).mock.calls).toEqual([
      ["Registry prefix (e.g. docker.io/username or ghcr.io/username, leave blank to skip):"],
    ]);
    expect(deployState.execaCalls).toEqual([
      { command: "docker", args: ["info"] },
      { command: "docker", args: ["tag", imageNameFor(tmpDir), `docker.io/me/${imageNameFor(tmpDir)}`] },
      { command: "docker", args: ["push", `docker.io/me/${imageNameFor(tmpDir)}`] },
    ]);
  });

  test("deploy without Docker installed exits gracefully", async () => {
    deployState.dockerAvailable = false;
    await expect(runDeploy(tmpDir)).rejects.toThrow("process.exit");
    expect(deployState.execaCalls[0]).toEqual({ command: "docker", args: ["info"] });
  });
});
