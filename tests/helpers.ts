import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir(prefix = "fixd-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeFixture(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const filePath = join(root, rel);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content, "utf-8");
  }
}

export function sampleProjectFiles(): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "sample-project", version: "1.0.0", scripts: { dev: "tsx src/index.ts" } }, null, 2),
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", strict: true } }, null, 2),
    ".env": "DATABASE_URL=postgresql://user:pass@localhost:5432/app\n",
    "src/index.ts": "export const answer = 42;\n",
    "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
  };
}

export function brokenProjectFiles(): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "broken-project", version: "1.0.0" }, null, 2),
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext" } }, null, 2),
    ".env": "OTHER_KEY=value\n",
    "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
  };
}
