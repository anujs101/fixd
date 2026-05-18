import { execa } from "execa";
import { section, info, success, error } from "./lib/display.js";
import { getCurrentVersion } from "./lib/versionCheck.js";

export async function runUpdate(): Promise<void> {
    section("fixd update");
    const current = getCurrentVersion();
    info(`Current version: ${current}`);
    info("Fetching latest version from npm...");

    try {
        const res = await fetch("https://registry.npmjs.org/fixd/latest", {
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error("npm registry unreachable");
        const data = await res.json() as { version: string };
        const latest = data.version;

        if (latest === current) {
            success(`Already on latest version (${current})`);
            return;
        }

        info(`Installing fixd@${latest}...`);
        console.log();

        await execa("npm", ["install", "-g", `fixd@${latest}`], {
            stdio: "inherit",
        });

        console.log();
        success(`Updated ${current} → ${latest}`);
        info("Restart your terminal if the command is not updated immediately.");
    } catch (err) {
        error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
        info("Try manually: npm install -g fixd@latest");
        process.exit(1);
    }
}
