/**
 * diagnostics.ts — Stack-aware project diagnostics
 *
 * Detects the project's tech stack from indicator files,
 * then runs the appropriate type checkers / linters and parses their output
 * into a unified ParsedError[] format.
 *
 * Supported stacks:
 *   TypeScript / JavaScript (Node, Bun, Deno)
 *   Python (mypy, flake8, pylint)
 *   Rust (cargo check)
 *   Go (go vet, go build)
 *   Java / Kotlin (mvn compile, gradle check)
 *   Ruby (rubocop)
 *   PHP (php -l, phpstan)
 */

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedError {
    file?: string;
    line?: number;
    col?: number;
    code?: string;
    severity: "error" | "warning" | "info";
    message: string;
    raw: string;
}

export interface CheckerResult {
    checker: string;           // e.g. "tsc --noEmit"
    stack: string;             // e.g. "TypeScript", "Rust"
    passed: boolean;
    errors: ParsedError[];
    warnings: ParsedError[];
    skipped: boolean;
    skipReason?: string;
    durationMs: number;
}

// ─── Stack definition ─────────────────────────────────────────────────────────

interface StackChecker {
    stack: string;
    /** Files whose existence confirms this stack */
    indicators: string[];
    /** Optional: file must contain this text to confirm */
    indicatorContent?: { file: string; contains: string };
    /** Command to run (bin will be auto-resolved if local) */
    command: string;
    /** Alternate commands tried in order if the primary fails with ENOENT */
    fallbacks?: string[];
    timeout?: number;
    parseOutput: (stdout: string, stderr: string, projectPath: string) => ParsedError[];
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function stripProjectPath(file: string, projectPath: string): string {
    return file.replace(projectPath + path.sep, "").replace(projectPath + "/", "");
}

/** tsc: src/foo.ts(12,5): error TS2345: message */
function parseTsc(stdout: string, stderr: string, projectPath: string): ParsedError[] {
    const out = stdout + "\n" + stderr;
    const errors: ParsedError[] = [];
    const re = /^([^(\n]+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
    let m;
    while ((m = re.exec(out)) !== null) {
        errors.push({
            file: stripProjectPath(m[1].trim(), projectPath),
            line: parseInt(m[2]),
            col: parseInt(m[3]),
            code: m[5],
            severity: m[4] === "error" ? "error" : "warning",
            message: m[6].trim(),
            raw: m[0],
        });
    }
    return errors;
}

/** eslint (compact format): file: line:col: severity [rule] message */
function parseEslint(stdout: string, _stderr: string, projectPath: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const re = /^([^:]+):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning|Info)\s+-\s+(.+?)(?:\s+\(([^)]+)\))?$/gm;
    let m;
    while ((m = re.exec(stdout)) !== null) {
        errors.push({
            file: stripProjectPath(m[1].trim(), projectPath),
            line: parseInt(m[2]),
            col: parseInt(m[3]),
            severity: m[4].toLowerCase() === "error" ? "error" : "warning",
            code: m[6],
            message: m[5].trim(),
            raw: m[0],
        });
    }
    return errors;
}

/** mypy: file:line: error/note: message */
function parseMypyFlake8(stdout: string, _stderr: string, projectPath: string): ParsedError[] {
    const errors: ParsedError[] = [];
    // flake8/mypy: file:line:col: Exxx message  OR  file:line: error: message
    const re = /^([^:\n]+):(\d+)(?::(\d+))?:\s+(error|warning|note|[A-Z]\d+)\s*:?\s+(.+)$/gm;
    let m;
    while ((m = re.exec(stdout)) !== null) {
        const sev = m[4].toLowerCase().startsWith("e") || m[4] === "error" ? "error" :
            m[4].toLowerCase().startsWith("w") || m[4] === "warning" ? "warning" : "info";
        errors.push({
            file: stripProjectPath(m[1].trim(), projectPath),
            line: parseInt(m[2]),
            col: m[3] ? parseInt(m[3]) : undefined,
            code: /^[A-Z]\d+/.test(m[4]) ? m[4] : undefined,
            severity: sev,
            message: m[5].trim(),
            raw: m[0],
        });
    }
    return errors;
}

/** cargo check:
 *  error[E0308]: message
 *    --> src/main.rs:12:5
 */
function parseCargo(stdout: string, stderr: string, projectPath: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const out = stdout + "\n" + stderr;
    // Match error/warning lines followed by --> location
    const blockRe = /(error|warning)(?:\[([^\]]+)\])?\s*:\s*([^\n]+)\n(?:.*\n)*?\s+-->\s+([^:]+):(\d+):(\d+)/gm;
    let m;
    while ((m = blockRe.exec(out)) !== null) {
        errors.push({
            severity: m[1] === "error" ? "error" : "warning",
            code: m[2],
            message: m[3].trim(),
            file: stripProjectPath(m[4].trim(), projectPath),
            line: parseInt(m[5]),
            col: parseInt(m[6]),
            raw: m[0].split("\n")[0],
        });
    }
    return errors;
}

/** go vet / go build: file:line:col: message */
function parseGo(stdout: string, stderr: string, projectPath: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const out = stdout + "\n" + stderr;
    const re = /^([^:#\n]+\.go):(\d+)(?::(\d+))?:\s+(.+)$/gm;
    let m;
    while ((m = re.exec(out)) !== null) {
        errors.push({
            file: stripProjectPath(m[1].trim(), projectPath),
            line: parseInt(m[2]),
            col: m[3] ? parseInt(m[3]) : undefined,
            severity: "error",
            message: m[4].trim(),
            raw: m[0],
        });
    }
    return errors;
}

/** rubocop compact: file:line:col: Severity: Code: message */
function parseRubocop(stdout: string, _stderr: string, projectPath: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const re = /^([^:]+):(\d+):(\d+):\s+(C|W|E|F|I):\s+(\w+\/\w+):\s+(.+)$/gm;
    let m;
    while ((m = re.exec(stdout)) !== null) {
        const sevMap: Record<string, "error" | "warning" | "info"> = { E: "error", F: "error", W: "warning", C: "warning", I: "info" };
        errors.push({
            file: stripProjectPath(m[1].trim(), projectPath),
            line: parseInt(m[2]),
            col: parseInt(m[3]),
            severity: sevMap[m[4]] ?? "warning",
            code: m[5],
            message: m[6].trim(),
            raw: m[0],
        });
    }
    return errors;
}

/** php -l and phpstan */
function parsePhp(stdout: string, stderr: string, projectPath: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const out = stdout + "\n" + stderr;
    const re = /(?:Parse|Fatal|Warning)\s+error:\s+(.+)\s+in\s+([^\s]+)\s+on\s+line\s+(\d+)/gm;
    let m;
    while ((m = re.exec(out)) !== null) {
        errors.push({ file: stripProjectPath(m[2], projectPath), line: parseInt(m[3]), severity: "error", message: m[1].trim(), raw: m[0] });
    }
    return errors;
}

/** Generic: any line containing "error:" or "Error:" */
function parseGeneric(stdout: string, stderr: string, _projectPath: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const out = stdout + "\n" + stderr;
    for (const line of out.split("\n")) {
        if (/\berror\b/i.test(line) && line.trim()) {
            errors.push({ severity: "error", message: line.trim(), raw: line });
        }
    }
    return errors;
}

// ─── Stack definitions ────────────────────────────────────────────────────────

const STACK_CHECKERS: StackChecker[] = [
    {
        stack: "TypeScript",
        indicators: ["tsconfig.json", "tsconfig.base.json"],
        command: "node_modules/.bin/tsc --noEmit",
        fallbacks: ["npx --no tsc --noEmit"],
        parseOutput: parseTsc,
    },
    {
        stack: "JavaScript (ESLint)",
        indicators: [".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yaml", "eslint.config.js", "eslint.config.mjs"],
        command: "node_modules/.bin/eslint . --ext .js,.jsx,.ts,.tsx --format compact --max-warnings 0",
        fallbacks: ["npx --no eslint . --ext .js,.jsx,.ts,.tsx --format compact --max-warnings 0"],
        parseOutput: parseEslint,
    },
    {
        stack: "Python (mypy)",
        indicators: ["mypy.ini", ".mypy.ini", "pyproject.toml"],
        indicatorContent: { file: "pyproject.toml", contains: "[tool.mypy]" },
        command: "mypy . --ignore-missing-imports",
        fallbacks: ["python -m mypy . --ignore-missing-imports", "python3 -m mypy . --ignore-missing-imports"],
        parseOutput: parseMypyFlake8,
    },
    {
        stack: "Python (flake8)",
        indicators: ["setup.cfg", ".flake8", "tox.ini", "requirements.txt", "pyproject.toml", "setup.py"],
        command: "flake8 .",
        fallbacks: ["python -m flake8 .", "python3 -m flake8 ."],
        parseOutput: parseMypyFlake8,
    },
    {
        stack: "Rust",
        indicators: ["Cargo.toml"],
        command: "cargo check 2>&1",
        parseOutput: parseCargo,
        timeout: 120_000,
    },
    {
        stack: "Go",
        indicators: ["go.mod"],
        command: "go vet ./...",
        fallbacks: ["go build ./..."],
        parseOutput: parseGo,
    },
    {
        stack: "Ruby",
        indicators: ["Gemfile", ".rubocop.yml"],
        command: "rubocop --format simple",
        parseOutput: parseRubocop,
    },
    {
        stack: "PHP",
        indicators: ["composer.json"],
        command: "php -l .",
        parseOutput: parsePhp,
    },
    {
        stack: "Java (Maven)",
        indicators: ["pom.xml"],
        command: "mvn compile -q 2>&1 | tail -50",
        parseOutput: parseGeneric,
        timeout: 120_000,
    },
    {
        stack: "Kotlin/Java (Gradle)",
        indicators: ["build.gradle", "build.gradle.kts", "settings.gradle"],
        command: "gradle check --quiet 2>&1 | tail -50",
        parseOutput: parseGeneric,
        timeout: 120_000,
    },
];

// ─── Stack detection ──────────────────────────────────────────────────────────

async function executeCommand(command: string, cwd: string, timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
        const { stdout, stderr } = await execAsync(command, { cwd, timeout, maxBuffer: 5 * 1024 * 1024 });
        return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
    } catch (err: any) {
        return {
            stdout: (err.stdout ?? "").trim(),
            stderr: (err.stderr ?? err.message ?? "").trim(),
            exitCode: typeof err.code === "number" ? err.code : 1,
        };
    }
}

function detectApplicableCheckers(projectPath: string): StackChecker[] {
    const applicable: StackChecker[] = [];
    for (const checker of STACK_CHECKERS) {
        const indicatorFound = checker.indicators.some((file) =>
            fs.existsSync(path.join(projectPath, file))
        );
        if (!indicatorFound) continue;

        // Optional content check
        if (checker.indicatorContent) {
            const { file, contains } = checker.indicatorContent;
            try {
                const content = fs.readFileSync(path.join(projectPath, file), "utf-8");
                if (!content.includes(contains)) continue;
            } catch { continue; }
        }

        // Note: ESLint and TypeScript both run — they check complementary things.
        // tsc = type correctness, ESLint = code quality / style rules (fix 7.2)

        applicable.push(checker);
    }
    return applicable;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runDiagnostics(projectPath: string): Promise<CheckerResult[]> {
    const checkers = detectApplicableCheckers(projectPath);
    const results: CheckerResult[] = [];

    if (checkers.length === 0) {
        // Fallback: nothing detected, return an empty "no stack found" result
        results.push({
            checker: "none",
            stack: "Unknown",
            passed: true,
            errors: [],
            warnings: [],
            skipped: true,
            skipReason: "No recognised stack indicators found (no tsconfig.json, Cargo.toml, go.mod, etc.)",
            durationMs: 0,
        });
        return results;
    }

    await Promise.all(
        checkers.map(async (checker) => {
            const start = Date.now();
            // B5: respect the same FIXD_COMMAND_TIMEOUT env var used by executor.ts
            const envTimeout = parseInt(process.env.FIXD_COMMAND_TIMEOUT ?? "120000", 10);
            const timeout = checker.timeout ?? envTimeout;
            const allCommands = [checker.command, ...(checker.fallbacks ?? [])];
            let lastResult = { stdout: "", stderr: "command not found", exitCode: 127 };

            for (const cmd of allCommands) {
                const result = await executeCommand(cmd, projectPath, timeout);
                lastResult = result;
                // If it ran (even with errors), stop trying fallbacks
                if (result.exitCode !== 127) break;
            }

            if (lastResult.exitCode === 127) {
                results.push({
                    checker: checker.command,
                    stack: checker.stack,
                    passed: true,
                    errors: [], warnings: [],
                    skipped: true,
                    skipReason: `Tool not installed (tried: ${allCommands.join(", ")})`,
                    durationMs: Date.now() - start,
                });
                return;
            }

            const allIssues = checker.parseOutput(lastResult.stdout, lastResult.stderr, projectPath);
            const errors = allIssues.filter((e) => e.severity === "error");
            const warnings = allIssues.filter((e) => e.severity !== "error");

            results.push({
                checker: checker.command,
                stack: checker.stack,
                passed: errors.length === 0,
                errors,
                warnings,
                skipped: false,
                durationMs: Date.now() - start,
            });
        })
    );

    return results;
}

// ─── Format results for agent context ────────────────────────────────────────

export function formatDiagnosticsForContext(results: CheckerResult[]): string {
    const lines: string[] = [];

    for (const r of results) {
        if (r.skipped) {
            lines.push(`${r.stack.toUpperCase()} CHECK: skipped — ${r.skipReason}`);
            continue;
        }
        if (r.passed && r.warnings.length === 0) {
            lines.push(`${r.stack.toUpperCase()} CHECK: PASSED — 0 errors`);
            lines.push(`  ✔ ${r.stack} is clean. Do NOT say it is misconfigured.`);
        } else {
            const total = r.errors.length + r.warnings.length;
            lines.push(`${r.stack.toUpperCase()} CHECK: ${r.errors.length > 0 ? "FAILED" : "WARNINGS"} — ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
            for (const e of [...r.errors, ...r.warnings].slice(0, 40)) {
                const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}${e.col ? `:${e.col}` : ""}` : "";
                const code = e.code ? `  ${e.code}` : "";
                lines.push(`  [${e.severity.toUpperCase()}]${loc ? " " + loc : ""}${code}  ${e.message}`);
            }
            if (total > 40) lines.push(`  ... and ${total - 40} more`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

// ─── Flat error list for issue detection ─────────────────────────────────────

export function getAllErrors(results: CheckerResult[]): Array<ParsedError & { stack: string }> {
    return results.flatMap((r) =>
        r.errors.map((e) => ({ ...e, stack: r.stack }))
    );
}
