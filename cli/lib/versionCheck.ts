import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";

const CACHE_DIR = path.join(os.homedir(), ".config", "fixd");
const CACHE_FILE = path.join(CACHE_DIR, "version-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface VersionCache {
    checkedAt: string;
    latestVersion: string;
}

// Bun compile injects this at build time via --define
declare var FIXD_BUILD_VERSION: string | undefined;

function readPackageVersion(): string {
    // Bun compiled binary: use injected version constant
    if (typeof FIXD_BUILD_VERSION === "string" && FIXD_BUILD_VERSION.length > 0) {
        return FIXD_BUILD_VERSION;
    }

    const candidates = [
        new URL("../../package.json", import.meta.url),
        new URL("../../../package.json", import.meta.url),
    ];

    for (const pkgPath of candidates) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
            return pkg.version;
        } catch {
            // Try the next location; source and dist have different depths.
        }
    }
    return "0.0.0";
}

function readCache(): VersionCache | null {
    try {
        if (!fs.existsSync(CACHE_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as VersionCache;
        const age = Date.now() - new Date(raw.checkedAt).getTime();
        if (age > CACHE_TTL_MS) return null;
        return raw;
    } catch {
        return null;
    }
}

function writeCache(version: string): void {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const cache: VersionCache = {
            checkedAt: new Date().toISOString(),
            latestVersion: version,
        };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
    } catch {
        // Version checks are best-effort.
    }
}

async function fetchLatestVersion(): Promise<string | null> {
    try {
        const res = await fetch("https://registry.npmjs.org/fixd/latest", {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = await res.json() as { version: string };
        return data.version;
    } catch {
        return null;
    }
}

function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

export async function checkForUpdate(): Promise<void> {
    const current = readPackageVersion();
    let latest: string | null = null;

    const cached = readCache();
    if (cached) {
        latest = cached.latestVersion;
    } else {
        latest = await fetchLatestVersion();
        if (latest) writeCache(latest);
    }

    if (!latest) return;

    if (compareVersions(latest, current) > 0) {
        console.log(chalk.yellow(`\n  ⚡ Update available: ${chalk.dim(current)} → ${chalk.cyan(latest)}`));
        console.log(chalk.dim(`  Run ${chalk.white("fixd update")} to upgrade\n`));
    }
}

export function getCurrentVersion(): string {
    return readPackageVersion();
}
