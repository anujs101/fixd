import { execa, ExecaError } from "execa";

export interface CommandResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    command: string;
}

const BLOCKED_COMMANDS = [
    "rm -rf /",
    "dd if=",
    "mkfs",
    ":(){ :|:& };:",
    "> /dev/sda",
    "chmod -R 777 /",
];

function isSafeCommand(command: string): boolean {
    const lower = command.toLowerCase().trim();
    return !BLOCKED_COMMANDS.some((blocked) => lower.includes(blocked));
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
 * Kill a process occupying a specific port.
 */
export async function killPort(port: number): Promise<CommandResult> {
    // works on macOS and Linux
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

    const pid = findPid.stdout.trim();
    return executeCommand(`kill -9 ${pid}`);
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