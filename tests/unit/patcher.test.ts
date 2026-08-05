import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { cleanupDir, makeTmpDir } from "../helpers.js";

vi.mock("../../cli/lib/display.js", () => ({
  printFix: vi.fn(),
  confirm: vi.fn(async () => true),
  success: vi.fn(),
  warn: vi.fn(),
  printHeader: vi.fn(),
  section: vi.fn(),
  info: vi.fn(),
  closePrompt: vi.fn(),
  bye: vi.fn(),
}));

import { applyPatch, parsePatchOperations, proposeAndApply, resetBackupSession, clearNormalizedPatchHistory } from "../../cli/lib/patcher.js";
import { runUndo } from "../../cli/undo.js";

describe("parsePatchOperations", () => {
  test("parses a single WRITE block", () => {
    const result = parsePatchOperations("<<<WRITE: src/foo.ts>>>\ncontent\n<<<END>>>");
    expect(result.operations).toEqual([{ op: "create", path: "src/foo.ts", content: "content" }]);
  });

  test("parses a single EDIT block", () => {
    const text = "<<<EDIT: src/foo.ts>>>\n<<<SEARCH>>>\nold()\n<<<REPLACE>>>\nnew()\n<<<END>>>";
    expect(parsePatchOperations(text).operations).toEqual([{ op: "edit", path: "src/foo.ts", search: "old()", replace: "new()" }]);
  });

  test("parses a DELETE block", () => {
    expect(parsePatchOperations("<<<DELETE: src/old.ts>>>").operations).toEqual([{ op: "delete", path: "src/old.ts" }]);
  });

  test("parses a RENAME block", () => {
    expect(parsePatchOperations("<<<RENAME: old.ts -> new.ts>>>").operations).toEqual([{ op: "rename", path: "old.ts", to: "new.ts" }]);
  });

  test("parses multiple operations in one response", () => {
    const text = [
      "<<<WRITE: a.ts>>>\na\n<<<END>>>",
      "<<<EDIT: b.ts>>>\n<<<SEARCH>>>\nb\n<<<REPLACE>>>\nc\n<<<END>>>",
      "<<<DELETE: d.ts>>>",
    ].join("\n");
    expect(parsePatchOperations(text).operations.map((op) => op.op)).toEqual(["create", "edit", "delete"]);
  });

  test("returns empty array for plain text with no markers", () => {
    expect(parsePatchOperations("Here is my analysis of your code.").operations).toEqual([]);
  });

  test("handles WRITE block with empty content", () => {
    expect(parsePatchOperations("<<<WRITE: empty.ts>>>\n<<<END>>>").operations).toEqual([{ op: "create", path: "empty.ts", content: "" }]);
  });

  test("handles nested code blocks inside WRITE content", () => {
    const content = "```typescript\nconst x = 1;\n```";
    const result = parsePatchOperations(`<<<WRITE: code.md>>>\n${content}\n<<<END>>>`);
    expect(result.operations[0]).toEqual({ op: "create", path: "code.md", content });
  });

  test("ignores malformed block with no END marker", () => {
    expect(parsePatchOperations("<<<WRITE: foo.ts>>>\ncontent with no end").operations).toEqual([]);
  });

  test("parses EDIT SEARCH that contains special regex chars literally", () => {
    const search = "const r = foo($bar[0]);";
    const text = `<<<EDIT: src/re.ts>>>\n<<<SEARCH>>>\n${search}\n<<<REPLACE>>>\nchanged\n<<<END>>>`;
    expect(parsePatchOperations(text).operations[0]).toEqual({ op: "edit", path: "src/re.ts", search, replace: "changed" });
  });
});

describe("proposeAndApply and applyPatch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    resetBackupSession();
    clearNormalizedPatchHistory();
  });

  afterEach(() => cleanupDir(tmpDir));

  test("WRITE creates a new file", async () => {
    const result = await proposeAndApply("<<<WRITE: src/foo.ts>>>\nhello\n<<<END>>>", tmpDir, { autoApprove: true });
    expect(result[0].applied).toBe(true);
    expect(readFileSync(join(tmpDir, "src/foo.ts"), "utf-8")).toBe("hello");
  });

  test("WRITE overwrites existing file", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/foo.ts"), "old", "utf-8");
    await proposeAndApply("<<<WRITE: src/foo.ts>>>\nnew\n<<<END>>>", tmpDir, { autoApprove: true });
    expect(readFileSync(join(tmpDir, "src/foo.ts"), "utf-8")).toBe("new");
  });

  test("EDIT replaces matching text", async () => {
    writeFileSync(join(tmpDir, "file.ts"), "before\nconst x = 1;\nafter\n", "utf-8");
    const result = await proposeAndApply("<<<EDIT: file.ts>>>\n<<<SEARCH>>>\nconst x = 1;\n<<<REPLACE>>>\nconst x = 2;\n<<<END>>>", tmpDir, { autoApprove: true });
    expect(result[0].applied).toBe(true);
    expect(readFileSync(join(tmpDir, "file.ts"), "utf-8")).toBe("before\nconst x = 2;\nafter\n");
  });

  test("EDIT with whitespace-normalized match", async () => {
    writeFileSync(join(tmpDir, "file.ts"), "const x = 1;   \n", "utf-8");
    const result = await applyPatch({ op: "edit", path: "file.ts", search: "const x = 1;", replace: "const x = 2;" }, tmpDir);
    expect(result.applied).toBe(true);
    expect(readFileSync(join(tmpDir, "file.ts"), "utf-8")).toBe("const x = 2;   \n");
  });

  test("EDIT fails when SEARCH string is not found", async () => {
    writeFileSync(join(tmpDir, "file.ts"), "original", "utf-8");
    const result = await applyPatch({ op: "edit", path: "file.ts", search: "missing", replace: "new" }, tmpDir);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("search string not found");
    expect(readFileSync(join(tmpDir, "file.ts"), "utf-8")).toBe("original");
  });

  test("DELETE removes file", async () => {
    writeFileSync(join(tmpDir, "old.ts"), "old", "utf-8");
    const result = await proposeAndApply("<<<DELETE: old.ts>>>", tmpDir, { autoApprove: true });
    expect(result[0].applied).toBe(true);
    expect(existsSync(join(tmpDir, "old.ts"))).toBe(false);
  });

  test("DELETE on non-existent file is skipped before apply", async () => {
    const result = await proposeAndApply("<<<DELETE: old.ts>>>", tmpDir, { autoApprove: true });
    expect(result).toEqual([]);
  });

  test("RENAME moves file", async () => {
    writeFileSync(join(tmpDir, "old.ts"), "old", "utf-8");
    const result = await proposeAndApply("<<<RENAME: old.ts -> new.ts>>>", tmpDir, { autoApprove: true });
    expect(result[0].applied).toBe(true);
    expect(readFileSync(join(tmpDir, "new.ts"), "utf-8")).toBe("old");
    expect(existsSync(join(tmpDir, "old.ts"))).toBe(false);
  });

  test("path traversal is rejected", async () => {
    const result = await applyPatch({ op: "create", path: "../../evil.ts", content: "evil" }, tmpDir);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("path traversal rejected");
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("absolute path traversal is rejected", async () => {
    const result = await applyPatch({ op: "create", path: "/tmp/evil.ts", content: "evil" }, tmpDir);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("path traversal rejected");
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("backup is created before every overwrite", async () => {
    writeFileSync(join(tmpDir, "file.ts"), "old", "utf-8");
    await applyPatch({ op: "create", path: "file.ts", content: "new" }, tmpDir);
    const lastBackup = readFileSync(join(tmpDir, ".fixd/last-backup"), "utf-8").trim();
    expect(readFileSync(join(lastBackup, "file.ts"), "utf-8")).toBe("old");
  });

  test("backup session contains all files from one apply call", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "a1", "utf-8");
    writeFileSync(join(tmpDir, "b.ts"), "b1", "utf-8");
    await proposeAndApply("<<<WRITE: a.ts>>>\na2\n<<<END>>>\n<<<WRITE: b.ts>>>\nb2\n<<<END>>>", tmpDir, { autoApprove: true });
    const lastBackup = readFileSync(join(tmpDir, ".fixd/last-backup"), "utf-8").trim();
    expect(readFileSync(join(lastBackup, "a.ts"), "utf-8")).toBe("a1");
    expect(readFileSync(join(lastBackup, "b.ts"), "utf-8")).toBe("b1");
  });

  test("JSON EDIT uses deepMerge", async () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "foo" }, null, 2), "utf-8");
    await applyPatch({ op: "edit", path: "package.json", search: "{}", replace: JSON.stringify({ version: "1.0.0" }) }, tmpDir);
    expect(JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"))).toEqual({ name: "foo", version: "1.0.0" });
  });

  test("JSON deepMerge replaces arrays", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: ["node"] } }, null, 2), "utf-8");
    await applyPatch({ op: "edit", path: "tsconfig.json", search: "{}", replace: JSON.stringify({ compilerOptions: { types: ["jest"] } }) }, tmpDir);
    expect(JSON.parse(readFileSync(join(tmpDir, "tsconfig.json"), "utf-8")).compilerOptions.types).toEqual(["jest"]);
  });

  test("atomic write tmp file is cleaned up on success", async () => {
    await applyPatch({ op: "create", path: "file.ts", content: "ok" }, tmpDir);
    expect(existsSync(join(tmpDir, "file.ts.fixd.tmp"))).toBe(false);
  });

  test("atomic write preserves original when rename fails", async () => {
    writeFileSync(join(tmpDir, "file.ts"), "old", "utf-8");
    mkdirSync(join(tmpDir, "file.ts.fixd.tmp"), { recursive: true });
    const result = await applyPatch({ op: "create", path: "file.ts", content: "new" }, tmpDir);
    expect(result.applied).toBe(false);
    expect(readFileSync(join(tmpDir, "file.ts"), "utf-8")).toBe("old");
  });

  test("undo restores all files from last backup", async () => {
    writeFileSync(join(tmpDir, "file.ts"), "old", "utf-8");
    await applyPatch({ op: "create", path: "file.ts", content: "new" }, tmpDir);
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await runUndo();
    } finally {
      process.chdir(cwd);
    }
    expect(readFileSync(join(tmpDir, "file.ts"), "utf-8")).toBe("old");
  });

  test("undo rejects tampered backup path by restoring nothing outside root", async () => {
    mkdirSync(join(tmpDir, ".fixd"), { recursive: true });
    writeFileSync(join(tmpDir, ".fixd/last-backup"), "../../etc", "utf-8");
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await runUndo();
    } finally {
      process.chdir(cwd);
    }
    expect(statSync(tmpDir).isDirectory()).toBe(true);
  });

  test("undo with no backup session exits gracefully", async () => {
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await runUndo();
    } finally {
      process.chdir(cwd);
    }
    expect(existsSync(join(tmpDir, ".fixd"))).toBe(false);
  });

  test("backup directory has exactly the files changed in session", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "a1", "utf-8");
    await applyPatch({ op: "create", path: "a.ts", content: "a2" }, tmpDir);
    const lastBackup = readFileSync(join(tmpDir, ".fixd/last-backup"), "utf-8").trim();
    expect(readdirSync(lastBackup)).toEqual(["a.ts"]);
  });
});
