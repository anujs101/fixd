// ─── fixd patcher ─────────────────────────────────────────────────────────────
// Parses agent-proposed file operations from structured markers, previews them
// as colored diffs, and applies them atomically with user approval.
//
// Security: all resolved paths are validated to be within projectRoot.
// Safety:   original files are backed up to .fixd/backups/<session>/ before
//           every write, enabling `fixd undo` to restore them.

import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { printFix, confirm, success, warn } from "./display.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PatchOperation =
    | { op: "edit";    path: string; search: string; replace: string }
    | { op: "create";  path: string; content: string }
    | { op: "delete";  path: string }
    | { op: "rename";  path: string; to: string }
    | { op: "append";  path: string; content: string }
    | { op: "prepend"; path: string; content: string };

export interface PatchResult {
    op: PatchOperation["op"];
    path: string;
    applied: boolean;
    diff: string;
    error?: string;
}

export interface ApplyOptions {
    autoApprove?: boolean;
    confirmEach?: boolean;
    confirmAll?: boolean;
    onPreview?: (diff: string, op: PatchOperation) => Promise<boolean>;
}

export interface ParseResult {
    operations: PatchOperation[];
    parseErrors: string[];
}

// ─── Path traversal guard ─────────────────────────────────────────────────────

/**
 * Ensures a resolved absolute path is strictly inside projectRoot.
 * Rejects `..`-escape attempts from LLM-generated paths.
 */
function assertWithinRoot(abs: string, projectRoot: string, opPath: string): string | null {
    const root = path.resolve(projectRoot);
    const resolved = path.resolve(abs);
    // Allow exact match (projectRoot itself) or any child
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return `path traversal rejected: "${opPath}" resolves outside project root`;
    }
    return null; // OK
}

// ─── Backup system ────────────────────────────────────────────────────────────
//
// One backup session per patcher module lifetime (= one fixd command invocation).
// Files are copied to .fixd/backups/<ISO-timestamp>/ before their first overwrite.
// The path of the latest backup dir is written to .fixd/last-backup for `fixd undo`.

let _sessionBackupDir: string | null = null;

function getSessionBackupDir(projectRoot: string): string {
    if (!_sessionBackupDir) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        _sessionBackupDir = path.join(projectRoot, ".fixd", "backups", ts);
    }
    return _sessionBackupDir;
}

/**
 * Copy `abs` into the session backup dir (mirroring relative structure).
 * Records the backup dir path in .fixd/last-backup for undo.
 * Never throws.
 */
async function backupFile(abs: string, projectRoot: string): Promise<void> {
    try {
        const backupDir = getSessionBackupDir(projectRoot);
        const rel = path.relative(projectRoot, abs);
        const dest = path.join(backupDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(abs, dest);
        // Record the session backup dir so `fixd undo` can find it
        const lastBackupFile = path.join(projectRoot, ".fixd", "last-backup");
        await fs.mkdir(path.dirname(lastBackupFile), { recursive: true });
        await fs.writeFile(lastBackupFile, backupDir, "utf-8");
    } catch {
        // Backup failure is non-fatal — warn only
    }
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse agent response text for patch operations.
 * Supports <<<WRITE>>>, <<<EDIT>>>, <<<DELETE>>>, <<<RENAME>>> markers.
 * Never throws — errors go into parseErrors[].
 */
export function parsePatchOperations(agentText: string): ParseResult {
    const operations: PatchOperation[] = [];
    const parseErrors: string[] = [];

    // ── <<<WRITE: path>>> ... <<<END>>> ──────────────────────────────────────
    const writeRe = /<<<WRITE:\s*([^\n>]+)>>>\n([\s\S]*?)<<<END>>>/g;
    let m: RegExpExecArray | null;
    while ((m = writeRe.exec(agentText)) !== null) {
        const filePath = m[1].trim();
        const content  = m[2].trim();
        if (!filePath) { parseErrors.push("WRITE: empty path"); continue; }
        operations.push({ op: "create", path: filePath, content });
    }

    // ── <<<EDIT: path>>> <<<SEARCH>>> ... <<<REPLACE>>> ... <<<END>>> ────────
    const editRe = /<<<EDIT:\s*([^\n>]+)>>>\n<<<SEARCH>>>\n([\s\S]*?)<<<REPLACE>>>\n([\s\S]*?)<<<END>>>/g;
    while ((m = editRe.exec(agentText)) !== null) {
        const filePath = m[1].trim();
        const search   = m[2].trimEnd();
        const replace  = m[3].trimEnd();
        if (!filePath) { parseErrors.push("EDIT: empty path"); continue; }
        if (!search)   { parseErrors.push(`EDIT ${filePath}: empty search block`); continue; }
        operations.push({ op: "edit", path: filePath, search, replace });
    }

    // ── <<<DELETE: path>>> ───────────────────────────────────────────────────
    const deleteRe = /<<<DELETE:\s*([^\n>]+)>>>/g;
    while ((m = deleteRe.exec(agentText)) !== null) {
        const filePath = m[1].trim();
        if (!filePath) { parseErrors.push("DELETE: empty path"); continue; }
        operations.push({ op: "delete", path: filePath });
    }

    // ── <<<RENAME: old -> new>>> ─────────────────────────────────────────────
    const renameRe = /<<<RENAME:\s*([^\n>]+?)\s*->\s*([^\n>]+)>>>/g;
    while ((m = renameRe.exec(agentText)) !== null) {
        const from = m[1].trim();
        const to   = m[2].trim();
        if (!from || !to) { parseErrors.push("RENAME: empty path"); continue; }
        operations.push({ op: "rename", path: from, to });
    }

    return { operations, parseErrors };
}

// ─── Atomic write helper ──────────────────────────────────────────────────────

async function atomicWrite(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.fixd.tmp`;
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, filePath);
}

// ─── Diff helpers ─────────────────────────────────────────────────────────────

function prefixLines(lines: string[], prefix: string): string {
    return lines.map((l) => `${prefix}${l}`).join("\n");
}

function contextDiff(original: string, search: string, replace: string): string {
    const origLines  = original.split("\n");
    const searchIdx  = findSearchIndex(origLines, search.split("\n"));

    if (searchIdx === -1) {
        const rem = prefixLines(search.split("\n"),   "- ");
        const add = prefixLines(replace.split("\n"), "+ ");
        return `${rem}\n${add}`;
    }

    const searchLines  = search.split("\n");
    const replaceLines = replace.split("\n");
    const ctxBefore    = origLines.slice(Math.max(0, searchIdx - 3), searchIdx);
    const ctxAfter     = origLines.slice(searchIdx + searchLines.length, searchIdx + searchLines.length + 3);

    const parts: string[] = [];
    if (ctxBefore.length) parts.push(prefixLines(ctxBefore, "  "));
    parts.push(prefixLines(searchLines,  "- "));
    parts.push(prefixLines(replaceLines, "+ "));
    if (ctxAfter.length)  parts.push(prefixLines(ctxAfter,  "  "));

    return parts.join("\n");
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export async function previewPatch(op: PatchOperation, projectRoot: string): Promise<string> {
    const abs = path.resolve(projectRoot, op.path);

    try {
        switch (op.op) {
            case "create": {
                return prefixLines(op.content.split("\n"), "+ ");
            }
            case "edit": {
                const original = await fs.readFile(abs, "utf-8").catch(() => "");
                return contextDiff(original, op.search, op.replace);
            }
            case "delete": {
                const content = await fs.readFile(abs, "utf-8").catch(() => "");
                return prefixLines(content.split("\n"), "- ");
            }
            case "rename": {
                return `  ${op.path} → ${op.to}`;
            }
            case "append": {
                return prefixLines(op.content.split("\n"), "+ ");
            }
            case "prepend": {
                return prefixLines(op.content.split("\n"), "+ ");
            }
        }
    } catch {
        return "  (preview unavailable)";
    }
}

// ─── Search helpers ───────────────────────────────────────────────────────────

function findSearchIndex(fileLines: string[], searchLines: string[]): number {
    outer: for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
        for (let j = 0; j < searchLines.length; j++) {
            if (fileLines[i + j] !== searchLines[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function normalizeWs(s: string): string {
    return s.replace(/\r\n/g, "\n").replace(/\t/g, "    ").trimEnd();
}

// ─── JSON-aware patch helpers ────────────────────────────────────────────────

function deepMerge(base: any, override: any): any {
    if (
        typeof base !== "object" || base === null ||
        typeof override !== "object" || override === null ||
        Array.isArray(override)
    ) {
        return override;
    }
    const result = { ...base };
    for (const key of Object.keys(override)) {
        if (
            key in base &&
            typeof base[key] === "object" && base[key] !== null &&
            typeof override[key] === "object" && override[key] !== null &&
            !Array.isArray(base[key]) && !Array.isArray(override[key])
        ) {
            result[key] = deepMerge(base[key], override[key]);
        } else {
            result[key] = override[key];
        }
    }
    return result;
}

function generateJsonDiff(before: any, after: any): string {
    const beforeStr = JSON.stringify(before, null, 2).split("\n");
    const afterStr  = JSON.stringify(after,  null, 2).split("\n");
    const lines: string[] = [];

    const maxLen = Math.max(beforeStr.length, afterStr.length);
    for (let i = 0; i < maxLen; i++) {
        const b = beforeStr[i];
        const a = afterStr[i];
        if (b === a) {
            lines.push(`  ${a ?? ""}`);
        } else {
            if (b !== undefined) lines.push(`- ${b}`);
            if (a !== undefined) lines.push(`+ ${a}`);
        }
    }
    return lines.join("\n");
}

async function applyJsonPatch(
    op: Extract<PatchOperation, { op: "edit" }>,
    projectRoot: string,
    abs: string
): Promise<PatchResult> {
    try {
        const raw = await fs.readFile(abs, "utf-8");
        const current = JSON.parse(raw);

        let replacement: Record<string, any>;
        try {
            replacement = JSON.parse(op.replace);
        } catch {
            return applyStringPatch(op, projectRoot, abs, raw);
        }

        const merged = deepMerge(current, replacement);
        const newContent = JSON.stringify(merged, null, 2) + "\n";
        const diff = generateJsonDiff(current, merged);

        await backupFile(abs, projectRoot);
        await atomicWrite(abs, newContent);

        return { op: "edit", path: op.path, applied: true, diff };
    } catch (err: any) {
        return { op: "edit", path: op.path, applied: false, diff: "", error: err.message };
    }
}

/**
 * String-based edit using positional splice — fixes the String.replace()
 * first-match-only bug. Uses findSearchIndex to locate the exact occurrence,
 * then splices with slice() for a deterministic, position-correct replacement.
 */
async function applyStringPatch(
    op: Extract<PatchOperation, { op: "edit" }>,
    projectRoot: string,
    abs: string,
    original?: string
): Promise<PatchResult> {
    const content = original ?? await fs.readFile(abs, "utf-8").catch(() => null);
    if (content === null) {
        return { op: "edit", path: op.path, applied: false, diff: "", error: "file not found" };
    }

    // ── Exact match — use positional splice (not String.replace) ─────────────
    const idx = content.indexOf(op.search);
    if (idx !== -1) {
        const updated = content.slice(0, idx) + op.replace + content.slice(idx + op.search.length);
        await backupFile(abs, projectRoot);
        await atomicWrite(abs, updated);
        const diff = contextDiff(content, op.search, op.replace);
        return { op: "edit", path: op.path, applied: true, diff };
    }

    // ── Whitespace-normalised retry ───────────────────────────────────────────
    const normOrig   = normalizeWs(content);
    const normSearch = normalizeWs(op.search);
    const normIdx    = normOrig.indexOf(normSearch);
    if (normIdx !== -1) {
        const normReplace = normalizeWs(op.replace);
        const updated = normOrig.slice(0, normIdx) + normReplace + normOrig.slice(normIdx + normSearch.length);
        await backupFile(abs, projectRoot);
        await atomicWrite(abs, updated);
        const diff = contextDiff(content, op.search, op.replace);
        return { op: "edit", path: op.path, applied: true, diff };
    }

    return { op: "edit", path: op.path, applied: false, diff: "", error: "search string not found in file" };
}


export async function applyPatch(op: PatchOperation, projectRoot: string): Promise<PatchResult> {
    const abs = path.resolve(projectRoot, op.path);

    // ── Path traversal guard (5.2) ────────────────────────────────────────────
    const traversalErr = assertWithinRoot(abs, projectRoot, op.path);
    if (traversalErr) {
        return { op: op.op, path: op.path, applied: false, diff: "", error: traversalErr };
    }

    try {
        switch (op.op) {
            case "create": {
                const exists = await fs.stat(abs).then(() => true).catch(() => false);
                if (exists) {
                    // Auto-promote WRITE on existing file to a full-file EDIT
                    // instead of silently failing — this handles agent retries
                    await backupFile(abs, projectRoot);
                    await fs.mkdir(path.dirname(abs), { recursive: true });
                    await atomicWrite(abs, op.content);
                    const diff = prefixLines(op.content.split("\n"), "+ ");
                    return { op: "create", path: op.path, applied: true, diff };
                }
                await fs.mkdir(path.dirname(abs), { recursive: true });
                await atomicWrite(abs, op.content);
                const diff = prefixLines(op.content.split("\n"), "+ ");
                return { op: "create", path: op.path, applied: true, diff };
            }

            case "edit": {
                if (op.path.endsWith(".json")) {
                    return applyJsonPatch(op, projectRoot, abs);
                }
                return applyStringPatch(op, projectRoot, abs);
            }

            case "delete": {
                let content = "";
                try { content = await fs.readFile(abs, "utf-8"); } catch { /* gone already */ }
                await backupFile(abs, projectRoot);
                await fs.unlink(abs);
                const diff = prefixLines(content.split("\n"), "- ");
                return { op: "delete", path: op.path, applied: true, diff };
            }

            case "rename": {
                const dest = path.resolve(projectRoot, op.to);
                // Guard destination too
                const destErr = assertWithinRoot(dest, projectRoot, op.to);
                if (destErr) return { op: op.op, path: op.path, applied: false, diff: "", error: destErr };
                await backupFile(abs, projectRoot);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.rename(abs, dest);
                return { op: "rename", path: op.path, applied: true, diff: `  ${op.path} → ${op.to}` };
            }

            case "append": {
                let existing = "";
                try { existing = await fs.readFile(abs, "utf-8"); } catch { /* new file */ }
                const updated = existing.endsWith("\n")
                    ? existing + op.content
                    : existing + "\n" + op.content;
                await backupFile(abs, projectRoot);
                await atomicWrite(abs, updated);
                const diff = prefixLines(op.content.split("\n"), "+ ");
                return { op: "append", path: op.path, applied: true, diff };
            }

            case "prepend": {
                let existing = "";
                try { existing = await fs.readFile(abs, "utf-8"); } catch { /* new file */ }
                const updated = op.content + "\n" + existing;
                await backupFile(abs, projectRoot);
                await atomicWrite(abs, updated);
                const diff = prefixLines(op.content.split("\n"), "+ ");
                return { op: "prepend", path: op.path, applied: true, diff };
            }
        }
    } catch (err: any) {
        return {
            op: op.op, path: op.path, applied: false, diff: "",
            error: err.message ?? "unknown error",
        };
    }
}

// ─── Apply patch set ──────────────────────────────────────────────────────────

export async function applyPatchSet(
    ops: PatchOperation[],
    projectRoot: string,
    options: ApplyOptions = {}
): Promise<PatchResult[]> {
    const results: PatchResult[] = [];
    if (ops.length === 0) return results;

    const { autoApprove, confirmAll, onPreview } = options;
    const confirmEach = options.confirmEach ?? (!autoApprove && !confirmAll);

    if (confirmAll) {
        console.log();
        for (const op of ops) {
            const diff = await previewPatch(op, projectRoot);
            printFix(`${op.op}: ${op.path}`, diff);
        }
        const go = await confirm(`apply all ${ops.length} change(s)?`);
        if (!go) {
            for (const op of ops) {
                results.push({ op: op.op, path: op.path, applied: false, diff: "", error: "declined" });
            }
            return results;
        }
        for (const op of ops) {
            const r = await applyPatch(op, projectRoot);
            results.push(r);
        }
        return results;
    }

    for (const op of ops) {
        const diff = await previewPatch(op, projectRoot);

        let approved = autoApprove ?? false;

        if (!approved && onPreview) {
            approved = await onPreview(diff, op);
        } else if (!approved && confirmEach) {
            printFix(`${op.op}: ${op.path}`, diff);
            approved = await confirm("apply this change?");
        }

        if (!approved) {
            results.push({ op: op.op, path: op.path, applied: false, diff, error: "declined" });
            continue;
        }

        const r = await applyPatch(op, projectRoot);
        if (r.applied) {
            success(`applied: ${op.path}`);
        } else if (r.error) {
            warn(`skipped ${op.path}: ${r.error}`);
        }
        results.push(r);
    }

    return results;
}

// ─── extractPatchesFromResponse ───────────────────────────────────────────────

export async function extractPatchesFromResponse(
    agentText: string,
    projectRoot: string
): Promise<PatchOperation[]> {
    const { operations, parseErrors } = parsePatchOperations(agentText);

    if (parseErrors.length > 0) {
        for (const e of parseErrors) warn(`patcher parse error: ${e}`);
    }

    const valid: PatchOperation[] = [];
    for (const op of operations) {
        // Path traversal pre-filter
        const abs = path.resolve(projectRoot, op.path);
        const traversalErr = assertWithinRoot(abs, projectRoot, op.path);
        if (traversalErr) {
            warn(`patcher: ${traversalErr}`);
            continue;
        }

        if (op.op === "edit" || op.op === "delete" || op.op === "rename" || op.op === "append" || op.op === "prepend") {
            const exists = await fs.stat(abs).then(() => true).catch(() => false);
            if (!exists) {
                warn(`patcher: ${op.path} not found — skipping ${op.op}`);
                continue;
            }
        }
        valid.push(op);
    }

    return valid;
}

// ─── proposeAndApply — top-level convenience ──────────────────────────────────

export async function proposeAndApply(
    agentText: string,
    projectRoot: string,
    options: ApplyOptions = { confirmEach: true }
): Promise<PatchResult[]> {
    const ops = await extractPatchesFromResponse(agentText, projectRoot);
    if (ops.length === 0) return [];
    return applyPatchSet(ops, projectRoot, options);
}

// ─── resetBackupSession — call at the start of each command ──────────────────
// Clears the module-level session backup dir so each command gets its own
// backup session rather than accumulating into a single one.

export function resetBackupSession(): void {
    _sessionBackupDir = null;
}
