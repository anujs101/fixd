import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupDir, makeTmpDir, sampleProjectFiles, writeFixture } from "../helpers.js";

vi.mock("../../src/actions/executeCommand.js", () => ({
  executeCommand: vi.fn(async (command: string) => {
    if (command.includes("node --version")) return { success: true, stdout: "v24.0.0\n", stderr: "", exitCode: 0 };
    if (command.includes("bun --version")) return { success: true, stdout: "1.2.0\n", stderr: "", exitCode: 0 };
    return { success: true, stdout: "", stderr: "", exitCode: 0 };
  }),
}));

import { scanProject } from "../../src/actions/scanFiles.js";

describe("scanProject", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => cleanupDir(tmpDir));

  test("reads package.json name and version", async () => {
    writeFixture(tmpDir, sampleProjectFiles());
    const scan = await scanProject(tmpDir);
    expect(scan.packageJson?.name).toBe("sample-project");
    expect(scan.packageJson?.version).toBe("1.0.0");
  });

  test("detects missing DATABASE_URL", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), ".env": "OTHER=value\n" });
    const scan = await scanProject(tmpDir);
    expect(scan.env.missing).toContain("DATABASE_URL");
  });

  test("detects pooled Prisma URL containing pooler", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), ".env": "DATABASE_URL=postgresql://x.pooler.supabase.com/db\n" });
    expect((await scanProject(tmpDir)).prisma.connectionType).toBe("pooled");
  });

  test("detects pooled Prisma URL on port 6543", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), ".env": "DATABASE_URL=postgresql://host:6543/db\n" });
    expect((await scanProject(tmpDir)).prisma.connectionType).toBe("pooled");
  });

  test("detects direct Prisma URL", async () => {
    writeFixture(tmpDir, sampleProjectFiles());
    expect((await scanProject(tmpDir)).prisma.connectionType).toBe("direct");
  });

  test("detects missing directUrl", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), ".env": "DATABASE_URL=postgresql://host:6543/db\n" });
    expect((await scanProject(tmpDir)).prisma.hasDirectUrl).toBe(false);
  });

  test("detects bun lockfile", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), "bun.lock": "" });
    expect((await scanProject(tmpDir)).detectedPackageManager).toBe("bun");
  });

  test("detects pnpm lockfile", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), "pnpm-lock.yaml": "" });
    expect((await scanProject(tmpDir)).detectedPackageManager).toBe("pnpm");
  });

  test("detects yarn lockfile", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), "yarn.lock": "" });
    expect((await scanProject(tmpDir)).detectedPackageManager).toBe("yarn");
  });

  test("parses docker-compose ports", async () => {
    writeFixture(tmpDir, {
      ...sampleProjectFiles(),
      "docker-compose.yml": 'services:\n  app:\n    ports:\n      - "3000:3000"\n  db:\n    ports:\n      - "5432:5432"\n',
    });
    expect((await scanProject(tmpDir)).dockerPorts).toEqual([
      { service: "app", hostPort: 3000, containerPort: 3000 },
      { service: "db", hostPort: 5432, containerPort: 5432 },
    ]);
  });

  test("returns empty prisma when no schema file", async () => {
    writeFixture(tmpDir, {
      "package.json": "{\"name\":\"x\"}",
      ".env": "",
      "tsconfig.json": "{}",
    });
    expect((await scanProject(tmpDir)).prisma.found).toBe(false);
  });
});
