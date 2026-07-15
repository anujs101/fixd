import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupDir, makeTmpDir, sampleProjectFiles, writeFixture } from "../helpers.js";

vi.mock("../../src/actions/executeCommand.js", () => ({
  executeCommand: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })),
  killPort: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })),
}));

import { scanProject } from "../../src/actions/scanFiles.js";
import { addMissingEnvKey, fixPrismaDirectUrl, fixTsconfigStrict } from "../../src/actions/fixEnv.js";

describe("auto fixers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => cleanupDir(tmpDir));

  test("fixPrismaDirectUrl adds DIRECT_URL to .env", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), ".env": "DATABASE_URL=postgresql://host:6543/db\n" });
    const result = await fixPrismaDirectUrl(tmpDir, await scanProject(tmpDir));
    expect(result).toMatchObject({ applied: true, filesChanged: [".env", "prisma/schema.prisma"] });
    expect(readFileSync(join(tmpDir, ".env"), "utf-8")).toBe(
      "DATABASE_URL=postgresql://host:6543/db\n\n# Direct (non-pooled) URL for Prisma migrations\nDIRECT_URL=postgresql://user:pass@host:5432/dbname?sslmode=require\n",
    );
  });

  test("fixPrismaDirectUrl adds directUrl line to schema", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), ".env": "DATABASE_URL=postgresql://host:6543/db\n" });
    const result = await fixPrismaDirectUrl(tmpDir, await scanProject(tmpDir));
    expect(result.diff).toContain('+   directUrl = env("DIRECT_URL")');
    expect(readFileSync(join(tmpDir, "prisma/schema.prisma"), "utf-8")).toBe('datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")\n}\n');
  });

  test("fixPrismaDirectUrl is idempotent", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), ".env": "DATABASE_URL=postgresql://host:6543/db\n" });
    await fixPrismaDirectUrl(tmpDir, await scanProject(tmpDir));
    await fixPrismaDirectUrl(tmpDir, await scanProject(tmpDir));
    const env = readFileSync(join(tmpDir, ".env"), "utf-8");
    const schema = readFileSync(join(tmpDir, "prisma/schema.prisma"), "utf-8");
    expect(env.match(/^DIRECT_URL=/gm)).toHaveLength(1);
    expect(schema.match(/directUrl/g)).toHaveLength(1);
  });

  test("addMissingEnvKey adds placeholder", async () => {
    writeFixture(tmpDir, { ".env": "" });
    const result = await addMissingEnvKey(tmpDir, "API_KEY", "TODO", "api key");
    expect(result).toEqual({
      applied: true,
      description: "Added API_KEY to .env",
      diff: "--- .env\n+ # api key\n+ API_KEY=TODO",
      filesChanged: [".env"],
    });
    expect(readFileSync(join(tmpDir, ".env"), "utf-8")).toBe("\n# api key\nAPI_KEY=TODO\n");
  });

  test("addMissingEnvKey does not overwrite existing key", async () => {
    writeFixture(tmpDir, { ".env": "API_KEY=real\n" });
    await addMissingEnvKey(tmpDir, "API_KEY", "TODO");
    expect(readFileSync(join(tmpDir, ".env"), "utf-8")).toBe("API_KEY=real\n");
  });

  test("fixTsconfigStrict sets strict true", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false } }) });
    await fixTsconfigStrict(tmpDir, await scanProject(tmpDir));
    expect(JSON.parse(readFileSync(join(tmpDir, "tsconfig.json"), "utf-8")).compilerOptions.strict).toBe(true);
  });

  test("fixTsconfigStrict adds strict when absent", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), "tsconfig.json": JSON.stringify({ compilerOptions: {} }) });
    await fixTsconfigStrict(tmpDir, await scanProject(tmpDir));
    expect(JSON.parse(readFileSync(join(tmpDir, "tsconfig.json"), "utf-8")).compilerOptions.strict).toBe(true);
  });

  test("fixers leave no .fixd.tmp files", async () => {
    writeFixture(tmpDir, { ...sampleProjectFiles(), "tsconfig.json": JSON.stringify({ compilerOptions: {} }) });
    await fixTsconfigStrict(tmpDir, await scanProject(tmpDir));
    expect(existsSync(join(tmpDir, "tsconfig.json.fixd.tmp"))).toBe(false);
  });
});
