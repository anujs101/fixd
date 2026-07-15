import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupDir, makeTmpDir } from "../helpers.js";

const state = vi.hoisted(() => ({
  handlers: new Map<string, { stdout: string; stderr: string; code: number; delay: number }>(),
  calls: [] as string[],
}));

vi.mock("node:child_process", () => ({
  exec: (command: string, _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    state.calls.push(command);
    const handler = state.handlers.get(command) ?? { stdout: "", stderr: "", code: 0, delay: 0 };
    setTimeout(() => {
      if (handler.code === 0) {
        callback(null, handler.stdout, handler.stderr);
      } else {
        const error = new Error(`Command failed: ${command}`);
        Object.assign(error, { stdout: handler.stdout, stderr: handler.stderr, code: handler.code });
        callback(error, handler.stdout, handler.stderr);
      }
    }, handler.delay);
    return { pid: 1 };
  },
}));

import { runDiagnostics } from "../../cli/lib/diagnostics.js";

function setCommand(command: string, stdout: string, stderr = "", code = 0, delay = 0): void {
  state.handlers.set(command, { stdout, stderr, code, delay });
}

describe("diagnostics engine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    state.handlers.clear();
    state.calls.length = 0;
  });

  afterEach(() => cleanupDir(tmpDir));

  test("tsconfig.json includes TypeScript checker", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf-8");
    setCommand("node_modules/.bin/tsc --noEmit", "", "", 0);
    expect(await runDiagnostics(tmpDir)).toMatchObject([{ stack: "TypeScript", checker: "node_modules/.bin/tsc --noEmit", passed: true, errors: [] }]);
  });

  test(".eslintrc.json includes ESLint checker", async () => {
    writeFileSync(join(tmpDir, ".eslintrc.json"), "{}", "utf-8");
    setCommand("node_modules/.bin/eslint . --ext .js,.jsx,.ts,.tsx --format compact --max-warnings 0", "", "", 0);
    expect(await runDiagnostics(tmpDir)).toMatchObject([{ stack: "JavaScript (ESLint)", checker: "node_modules/.bin/eslint . --ext .js,.jsx,.ts,.tsx --format compact --max-warnings 0", passed: true, errors: [] }]);
  });

  test("Cargo.toml includes Rust checker", async () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), "[package]\n", "utf-8");
    setCommand("cargo check 2>&1", "", "", 0);
    expect(await runDiagnostics(tmpDir)).toMatchObject([{ stack: "Rust", checker: "cargo check 2>&1", passed: true, errors: [] }]);
  });

  test("go.mod includes Go checker", async () => {
    writeFileSync(join(tmpDir, "go.mod"), "module x\n", "utf-8");
    setCommand("go vet ./...", "", "", 0);
    expect(await runDiagnostics(tmpDir)).toMatchObject([{ stack: "Go", checker: "go vet ./...", passed: true, errors: [] }]);
  });

  test("no indicator files returns skipped unknown result", async () => {
    const result = await runDiagnostics(tmpDir);
    expect(result).toEqual([{
      checker: "none",
      stack: "Unknown",
      passed: true,
      errors: [],
      warnings: [],
      skipped: true,
      skipReason: "No recognised stack indicators found (no tsconfig.json, Cargo.toml, go.mod, etc.)",
      durationMs: expect.any(Number),
    }]);
  });

  test("multiple indicators run both checkers", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf-8");
    writeFileSync(join(tmpDir, "Cargo.toml"), "[package]\n", "utf-8");
    setCommand("node_modules/.bin/tsc --noEmit", "", "", 0);
    setCommand("cargo check 2>&1", "", "", 0);
    expect((await runDiagnostics(tmpDir)).map((r) => r.stack).sort()).toEqual(["Rust", "TypeScript"]);
  });

  test("parses TypeScript output", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf-8");
    setCommand("node_modules/.bin/tsc --noEmit", "src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.", "", 1);
    const error = (await runDiagnostics(tmpDir))[0].errors[0];
    expect(error).toMatchObject({ file: "src/index.ts", line: 10, col: 5, code: "TS2322", severity: "error" });
  });

  test("parses ESLint compact output", async () => {
    writeFileSync(join(tmpDir, ".eslintrc.json"), "{}", "utf-8");
    setCommand("node_modules/.bin/eslint . --ext .js,.jsx,.ts,.tsx --format compact --max-warnings 0", "src/foo.ts: line 5, col 3, Error - 'x' is not defined (no-undef)", "", 1);
    const error = (await runDiagnostics(tmpDir))[0].errors[0];
    expect(error).toMatchObject({ file: "src/foo.ts", line: 5, col: 3, severity: "error", code: "no-undef" });
  });

  test("parses Rust cargo check output", async () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), "[package]\n", "utf-8");
    setCommand("cargo check 2>&1", "", "error[E0308]: mismatched types\n --> src/main.rs:10:5", 1);
    const error = (await runDiagnostics(tmpDir))[0].errors[0];
    expect(error).toMatchObject({ file: "src/main.rs", line: 10, col: 5, code: "E0308" });
  });

  test("zero errors output returns empty errors", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf-8");
    setCommand("node_modules/.bin/tsc --noEmit", "", "", 0);
    expect((await runDiagnostics(tmpDir))[0].errors).toEqual([]);
  });

  test("all checkers run concurrently", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf-8");
    writeFileSync(join(tmpDir, "Cargo.toml"), "[package]\n", "utf-8");
    setCommand("node_modules/.bin/tsc --noEmit", "", "", 0, 50);
    setCommand("cargo check 2>&1", "", "", 0, 50);
    const start = Date.now();
    await runDiagnostics(tmpDir);
    expect(Date.now() - start).toBeLessThan(95);
  });

  test("one checker throwing does not stop others", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf-8");
    writeFileSync(join(tmpDir, ".eslintrc.json"), "{}", "utf-8");
    setCommand("node_modules/.bin/tsc --noEmit", "src/index.ts(1,1): error TS1005: ';' expected.", "", 1);
    setCommand("node_modules/.bin/eslint . --ext .js,.jsx,.ts,.tsx --format compact --max-warnings 0", "", "", 0);
    const results = await runDiagnostics(tmpDir);
    expect(results).toHaveLength(2);
    expect(results.map((r) => ({ stack: r.stack, passed: r.passed, errors: r.errors }))).toEqual([
      { stack: "TypeScript", passed: false, errors: [{ file: "src/index.ts", line: 1, col: 1, code: "TS1005", severity: "error", message: "';' expected.", raw: "src/index.ts(1,1): error TS1005: ';' expected." }] },
      { stack: "JavaScript (ESLint)", passed: true, errors: [] },
    ]);
  });

  test("prefers node_modules/.bin/tsc", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf-8");
    setCommand("node_modules/.bin/tsc --noEmit", "", "", 0);
    await runDiagnostics(tmpDir);
    expect(state.calls[0]).toBe("node_modules/.bin/tsc --noEmit");
  });

  test("falls back to npx tsc when local command not found", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}", "utf-8");
    setCommand("node_modules/.bin/tsc --noEmit", "", "not found", 127);
    setCommand("npx --no tsc --noEmit", "", "", 0);
    await runDiagnostics(tmpDir);
    expect(state.calls).toEqual(["node_modules/.bin/tsc --noEmit", "npx --no tsc --noEmit"]);
  });
});
