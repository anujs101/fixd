import { execa, ExecaError } from "execa";

export interface CommandResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    command: string;
}

// S1: A command blocklist is NOT a security boundary — it's trivially bypassable
// (double spaces, eval wrapping, character variation, etc.).
// Real protection is the human-in-the-loop confirm() gate in doctor.ts:
// the user reads and approves every command before it runs.
// This function is kept as a last-resort sanity check for the most catastrophic
// accidental invocations only (e.g. a test that somehow generates fork bombs).
const CATASTROPHIC_PATTERNS = [
    /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}/, // fork bomb
    />\s*\/dev\/(sda|hda|nvme)/,      // raw disk overwrite
];

function isSafeCommand(command: string): boolean {
    return !CATASTROPHIC_PATTERNS.some((re) => re.test(command));
}

/**
 * Safely executes a shell command with timeout and output capture.
 * Never throws — always returns a structured result.
 */
export async function executeCommand(
    command: string,
    options: {
        cwd?: string;
        timeoutMs?: number;
        env?: Record<string, string>;
    } = {}
): Promise<CommandResult> {
    const { cwd = process.cwd(), timeoutMs = 30_000, env = {} } = options;

    if (!isSafeCommand(command)) {
        return {
            success: false,
            stdout: "",
            stderr: `Blocked: command "${command}" is not permitted.`,
            exitCode: 1,
            command,
        };
    }

    try {
        const result = await execa("sh", ["-c", command], {
            cwd,
            timeout: timeoutMs,
            env: { ...process.env, ...env },
            reject: false, // never throw on non-zero exit
            all: true,
        });

        return {
            success: result.exitCode === 0,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: result.exitCode ?? 1,
            command,
        };
    } catch (err) {
        const execaErr = err as ExecaError;
        return {
            success: false,
            stdout: execaErr.stdout?.toString() ?? "",
            stderr: execaErr.stderr?.toString() ?? execaErr.message ?? "Unknown error",
            exitCode: execaErr.exitCode ?? 1,
            command,
        };
    }
}

/**
 * Kill all processes occupying a specific port.
 * lsof can return multiple PIDs; we kill each one and then verify the port is free.
 */
export async function killPort(port: number): Promise<CommandResult> {
    const findPid = await executeCommand(`lsof -ti tcp:${port}`);
    if (!findPid.success || !findPid.stdout.trim()) {
        return {
            success: false,
            stdout: "",
            stderr: `No process found on port ${port}`,
            exitCode: 1,
            command: `killPort(${port})`,
        };
    }

    // lsof can return multiple PIDs (one per line)
    const pids = findPid.stdout.trim().split("\n").map((p) => p.trim()).filter(Boolean);
    const killed: string[] = [];
    const failed: string[] = [];

    for (const pid of pids) {
        const result = await executeCommand(`kill -9 ${pid}`);
        if (result.success || result.exitCode === 0) {
            killed.push(pid);
        } else {
            failed.push(pid);
        }
    }

    // Short pause, then verify the port is actually free
    await new Promise((r) => setTimeout(r, 300));
    const verify = await executeCommand(`lsof -ti tcp:${port}`);
    const portFree = !verify.success || !verify.stdout.trim();

    return {
        success: portFree && failed.length === 0,
        stdout: killed.length > 0 ? `Killed PID(s): ${killed.join(", ")}` : "",
        stderr: failed.length > 0 ? `Failed to kill PID(s): ${failed.join(", ")}` : "",
        exitCode: portFree ? 0 : 1,
        command: `killPort(${port})`,
    };
}

/**
 * Get the currently active Node.js / Bun version.
 */
export async function getRuntimeVersion(): Promise<{
    node: string | null;
    bun: string | null;
}> {
    const [nodeResult, bunResult] = await Promise.all([
        executeCommand("node --version"),
        executeCommand("bun --version"),
    ]);

    return {
        node: nodeResult.success ? nodeResult.stdout.trim() : null,
        bun: bunResult.success ? bunResult.stdout.trim() : null,
    };
}