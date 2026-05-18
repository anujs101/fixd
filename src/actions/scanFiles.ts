import fs from "node:fs/promises";
import path from "node:path";
import { executeCommand } from "./executeCommand.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortInfo {
    port: number;
    pid: number;
    process: string;
}

export interface DockerPort {
    service: string;
    hostPort: number;
    containerPort: number;
}

export interface PrismaInfo {
    found: boolean;
    provider: string | null;
    connectionType: "pooled" | "direct" | "unknown" | null;
    hasDirectUrl: boolean;
    rawSchema: string | null;
}

export interface EnvInfo {
    vars: Record<string, string>;
    missing: string[];
    raw: string | null;
}

export interface ProjectScan {
    projectPath: string;
    packageJson: Record<string, any> | null;
    tsconfig: Record<string, any> | null;
    env: EnvInfo;
    prisma: PrismaInfo;
    dockerCompose: Record<string, any> | null;
    dockerPorts: DockerPort[];      // parsed host→container port mappings
    runningPorts: PortInfo[];
    nodeVersion: string | null;
    bunVersion: string | null;
    requiredNodeVersion: string | null;
    detectedPackageManager: "pnpm" | "bun" | "npm" | "yarn" | "unknown";
    errors: string[]; // non-fatal scan errors
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readJsonFile(filePath: string): Promise<Record<string, any> | null> {
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function readTextFile(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, "utf-8");
    } catch {
        return null;
    }
}

function parseEnvFile(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key) result[key] = value;
    }
    return result;
}

function detectConnectionType(url: string): "pooled" | "direct" | "unknown" {
    if (!url) return "unknown";
    // Neon pooled connections go through pooler subdomain
    if (url.includes("pooler.") || url.includes("-pooler.")) return "pooled";
    // Supabase transaction pooler uses port 6543
    if (url.includes(":6543")) return "pooled";
    return "direct";
}

function parsePrismaSchema(schema: string): PrismaInfo {
    const providerMatch = schema.match(/provider\s*=\s*["']([^"']+)["']/);
    const urlMatch = schema.match(/url\s*=\s*env\(["']([^"']+)["']\)/);
    const directUrlMatch = schema.match(/directUrl\s*=\s*env\(["']([^"']+)["']\)/);

    const provider = providerMatch?.[1] ?? null;
    const urlEnvKey = urlMatch?.[1] ?? null;
    const hasDirectUrl = !!directUrlMatch;

    // We can only determine connection type at runtime when env is available
    // Return unknown here; scanFiles will resolve it using the actual env vars
    return {
        found: true,
        provider,
        connectionType: urlEnvKey ? "unknown" : null,
        hasDirectUrl,
        rawSchema: schema,
        // Store the env key name so scanFiles can resolve the actual URL
        ...(urlEnvKey ? { _urlEnvKey: urlEnvKey } : {}),
    } as PrismaInfo & { _urlEnvKey?: string };
}

async function scanPorts(projectPath: string): Promise<PortInfo[]> {
    // Extract ports from package.json scripts and docker-compose for context
    const result = await executeCommand(
        "lsof -iTCP -sTCP:LISTEN -n -P | tail -n +2",
        { cwd: projectPath }
    );

    if (!result.success || !result.stdout.trim()) return [];

    const ports: PortInfo[] = [];
    for (const line of result.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;

        const processName = parts[0];
        const pid = parseInt(parts[1], 10);
        const addressPart = parts[8]; // e.g. *:3000 or 127.0.0.1:5432

        const portMatch = addressPart.match(/:(\d+)$/);
        if (!portMatch || isNaN(pid)) continue;

        const port = parseInt(portMatch[1], 10);
        ports.push({ port, pid, process: processName });
    }

    return ports;
}

function detectPackageManager(
    projectPath: string,
    files: string[]
): "pnpm" | "bun" | "npm" | "yarn" | "unknown" {
    if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
    if (files.includes("pnpm-lock.yaml")) return "pnpm";
    if (files.includes("yarn.lock")) return "yarn";
    if (files.includes("package-lock.json")) return "npm";
    return "unknown";
}

/**
 * Extracts host→container port bindings from a raw docker-compose YAML string.
 * Uses regex (no js-yaml dep) to find:
 *   - "HOST:CONTAINER" or 'HOST:CONTAINER'
 *   - - "HOST:CONTAINER"  (list form)
 * Returns an array of { service, hostPort, containerPort }.
 */
function parseDockerComposePorts(raw: string): DockerPort[] {
    const ports: DockerPort[] = [];
    const lines = raw.split("\n");

    let currentService = "unknown";

    for (const line of lines) {
        // Detect service name: top-level 2-space or 4-space indented key under `services:`
        const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+)\s*:/);
        if (serviceMatch) {
            currentService = serviceMatch[1];
        }

        // Match port bindings: - "HOST:CONTAINER" or - HOST:CONTAINER
        const portMatch = line.match(/[-\s]+["']?(\d+):(\d+)["']?/);
        if (portMatch) {
            const hostPort      = parseInt(portMatch[1], 10);
            const containerPort = parseInt(portMatch[2], 10);
            if (!isNaN(hostPort) && !isNaN(containerPort)) {
                ports.push({ service: currentService, hostPort, containerPort });
            }
        }
    }

    return ports;
}

// ─── Main scanner ─────────────────────────────────────────────────────────────

/**
 * Scans a project directory and returns a structured snapshot of its state.
 * Never throws — errors are collected in the `errors` array.
 */
export async function scanProject(projectPath: string): Promise<ProjectScan> {
    const errors: string[] = [];

    // List top-level files for package manager detection
    let topLevelFiles: string[] = [];
    try {
        topLevelFiles = await fs.readdir(projectPath);
    } catch (err) {
        errors.push(`Cannot read project directory: ${(err as Error).message}`);
    }

    // ── Read all config files in parallel ──────────────────────────────────────
    const [
        packageJson,
        tsconfig,
        envRaw,
        prismaSchemaRaw,
        dockerComposeYml,
        dockerComposeYaml,
    ] = await Promise.all([
        readJsonFile(path.join(projectPath, "package.json")),
        readJsonFile(path.join(projectPath, "tsconfig.json")),
        readTextFile(path.join(projectPath, ".env")),
        readTextFile(path.join(projectPath, "prisma", "schema.prisma")),
        readTextFile(path.join(projectPath, "docker-compose.yml")),
        readTextFile(path.join(projectPath, "docker-compose.yaml")),
    ]);

    // ── Parse .env ─────────────────────────────────────────────────────────────
    const envVars = envRaw ? parseEnvFile(envRaw) : {};

    // Check for commonly required env keys based on detected stack
    const commonRequiredKeys: string[] = [];
    if (prismaSchemaRaw) {
        commonRequiredKeys.push("DATABASE_URL");
    }
    const missingEnvKeys = commonRequiredKeys.filter((k) => !envVars[k]);

    // ── Parse prisma schema ────────────────────────────────────────────────────
    let prismaInfo: PrismaInfo = {
        found: false,
        provider: null,
        connectionType: null,
        hasDirectUrl: false,
        rawSchema: null,
    };

    if (prismaSchemaRaw) {
        const parsed = parsePrismaSchema(prismaSchemaRaw) as PrismaInfo & {
            _urlEnvKey?: string;
        };

        // Resolve connection type using actual env var
        if (parsed._urlEnvKey && envVars[parsed._urlEnvKey]) {
            parsed.connectionType = detectConnectionType(envVars[parsed._urlEnvKey]);
        }

        const { _urlEnvKey: _, ...cleanPrisma } = parsed;
        prismaInfo = cleanPrisma;
    }

    // ── Parse docker-compose ───────────────────────────────────────────────────
    let dockerCompose: Record<string, any> | null = null;
    let dockerPorts: DockerPort[] = [];
    const dockerComposeRaw = dockerComposeYml ?? dockerComposeYaml;
    if (dockerComposeRaw) {
        dockerCompose = { raw: dockerComposeRaw };
        dockerPorts   = parseDockerComposePorts(dockerComposeRaw);
    }

    // ── Scan running ports ─────────────────────────────────────────────────────
    let runningPorts: PortInfo[] = [];
    try {
        runningPorts = await scanPorts(projectPath);
    } catch (err) {
        errors.push(`Port scan failed: ${(err as Error).message}`);
    }

    // ── Runtime versions ───────────────────────────────────────────────────────
    const nodeResult = await executeCommand("node --version", { cwd: projectPath });
    const bunResult = await executeCommand("bun --version", { cwd: projectPath });

    const nodeVersion = nodeResult.success ? nodeResult.stdout.trim() : null;
    const bunVersion = bunResult.success ? bunResult.stdout.trim() : null;

    // Required node version from package.json engines field
    const requiredNodeVersion =
        packageJson?.engines?.node ?? null;

    return {
        projectPath,
        packageJson,
        tsconfig,
        env: {
            vars: envVars,
            missing: missingEnvKeys,
            raw: envRaw,
        },
        prisma: prismaInfo,
        dockerCompose,
        dockerPorts,
        runningPorts,
        nodeVersion,
        bunVersion,
        requiredNodeVersion,
        detectedPackageManager: detectPackageManager(projectPath, topLevelFiles),
        errors,
    };
}