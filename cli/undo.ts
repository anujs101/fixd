// ─── fixd undo ────────────────────────────────────────────────────────────────
// Restores files from the most recent patcher backup session.
// Backup sessions are written to .fixd/backups/<timestamp>/ by patcher.ts
// before every atomic write. The latest session path is recorded in
// .fixd/last-backup so this command can find it without scanning.

import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import {
    printHeader,
    section,
    info,
    warn,
    success,
    confirm,
    closePrompt,
    bye,
} from "./lib/display.js";

export async function runUndo() {
    const projectPath = process.cwd();
    printHeader("undo");

    // ── Find the latest backup session ────────────────────────────────────────
    const lastBackupFile = path.join(projectPath, ".fixd", "last-backup");
    let backupDir: string;
    try {
        backupDir = (await fs.readFile(lastBackupFile, "utf-8")).trim();
    } catch {
        warn("No backup found in this project. Nothing to undo.");
        info("Backups are created automatically when fixd applies patches.");
        bye();
        return;
    }

    // Verify the backup dir actually exists
    try {
        await fs.stat(backupDir);
    } catch {
        warn(`Backup directory not found: ${backupDir}`);
        warn("It may have been manually deleted.");
        bye();
        return;
    }

    // ── List files in the backup ───────────────────────────────────────────────
    const backedUpFiles = await listAllFiles(backupDir);
    if (backedUpFiles.length === 0) {
        info("Backup session is empty — no files to restore.");
        bye();
        return;
    }

    const sessionName = path.basename(backupDir);
    section(`restoring from session ${chalk.white(sessionName)}`);

    for (const abs of backedUpFiles) {
        const rel = path.relative(backupDir, abs);
        console.log(`  ${chalk.dim("•")} ${chalk.white(rel)}`);
    }
    console.log();

    const go = await confirm(`restore ${backedUpFiles.length} file(s) to their previous state?`);
    if (!go) {
        info("Cancelled.");
        closePrompt();
        bye();
        return;
    }

    // ── Restore each file ─────────────────────────────────────────────────────
    section("restoring files");
    let restored = 0;
    let failed   = 0;

    for (const backupAbs of backedUpFiles) {
        const rel    = path.relative(backupDir, backupAbs);
        const target = path.join(projectPath, rel);
        try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(backupAbs, target);
            success(`restored: ${rel}`);
            restored++;
        } catch (err: any) {
            warn(`failed to restore ${rel}: ${err.message}`);
            failed++;
        }
    }

    console.log();
    if (restored > 0) {
        success(`${restored} file(s) restored successfully`);
    }
    if (failed > 0) {
        warn(`${failed} file(s) could not be restored — check permissions`);
    }

    // ── Clear last-backup pointer ONLY if all files restored (B6) ────────────
    // If any file failed, keep the pointer so the user can retry `fixd undo`.
    if (failed === 0) {
        try { await fs.unlink(lastBackupFile); } catch { /* ok if already gone */ }
    } else {
        warn("backup pointer kept — run `fixd undo` again after fixing permissions");
    }

    closePrompt();
    bye();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function listAllFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                files.push(...await listAllFiles(full));
            } else {
                files.push(full);
            }
        }
    } catch { /* dir vanished */ }
    return files;
}
