// ─── fixd patcher ─────────────────────────────────────────────────────────────
// Parses agent-proposed file operations from structured markers, previews them
// as colored diffs, and applies them atomically with user approval.

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
        const search   = m[2].trimEnd();  // preserve leading indent, strip trailing newline
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
        // Fallback — show raw search/replace
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

/**
 * Generate a plain-text colored diff string for user preview.
 * Used by printFix() in display.ts which already handles coloring +/- lines.
 */
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

// ─── Apply single operation ───────────────────────────────────────────────────

export async function applyPatch(op: PatchOperation, projectRoot: string): Promise<PatchResult> {
    const abs = path.resolve(projectRoot, op.path);

    try {
        switch (op.op) {
            case "create": {
                const exists = await fs.stat(abs).then(() => true).catch(() => false);
                if (exists) {
                    return {
                        op: "create", path: op.path, applied: false, diff: "",
                        error: "file already exists — use edit instead",
                    };
                }
                await fs.mkdir(path.dirname(abs), { recursive: true });
                await atomicWrite(abs, op.content);
                const diff = prefixLines(op.content.split("\n"), "+ ");
                return { op: "create", path: op.path, applied: true, diff };
            }

            case "edit": {
                let original: string;
                try { original = await fs.readFile(abs, "utf-8"); }
                catch { return { op: "edit", path: op.path, applied: false, diff: "", error: "file not found" }; }

                // Exact match first
                if (original.includes(op.search)) {
                    const updated = original.replace(op.search, op.replace);
                    await atomicWrite(abs, updated);
                    const diff = contextDiff(original, op.search, op.replace);
                    return { op: "edit", path: op.path, applied: true, diff };
                }

                // Whitespace-normalized retry
                const normOrig   = normalizeWs(original);
                const normSearch = normalizeWs(op.search);
                if (normOrig.includes(normSearch)) {
                    const updated = normOrig.replace(normSearch, normalizeWs(op.replace));
                    await atomicWrite(abs, updated);
                    const diff = contextDiff(original, op.search, op.replace);
                    return { op: "edit", path: op.path, applied: true, diff };
                }

                return {
                    op: "edit", path: op.path, applied: false, diff: "",
                    error: "search string not found in file",
                };
            }

            case "delete": {
                let content = "";
                try { content = await fs.readFile(abs, "utf-8"); } catch { /* gone already */ }
                await fs.unlink(abs);
                const diff = prefixLines(content.split("\n"), "- ");
                return { op: "delete", path: op.path, applied: true, diff };
            }

            case "rename": {
                const dest = path.resolve(projectRoot, op.to);
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
                await atomicWrite(abs, updated);
                const diff = prefixLines(op.content.split("\n"), "+ ");
                return { op: "append", path: op.path, applied: true, diff };
            }

            case "prepend": {
                let existing = "";
                try { existing = await fs.readFile(abs, "utf-8"); } catch { /* new file */ }
                const updated = op.content + "\n" + existing;
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
    // Default: confirmEach = true unless overridden
    const confirmEach = options.confirmEach ?? (!autoApprove && !confirmAll);

    // ── confirmAll: show all diffs, ask once ──────────────────────────────────
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

    // ── autoApprove or confirmEach ────────────────────────────────────────────
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

/**
 * Parse agent text, resolve paths, validate existence for edit/delete/rename.
 * Never throws.
 */
export async function extractPatchesFromResponse(
    agentText: string,
    projectRoot: string
): Promise<PatchOperation[]> {
    const { operations, parseErrors } = parsePatchOperations(agentText);

    if (parseErrors.length > 0) {
        for (const e of parseErrors) warn(`patcher parse error: ${e}`);
    }

    // Filter out edit/delete/rename ops where the file doesn't exist
    const valid: PatchOperation[] = [];
    for (const op of operations) {
        if (op.op === "edit" || op.op === "delete" || op.op === "rename" || op.op === "append" || op.op === "prepend") {
            const abs = path.resolve(projectRoot, op.path);
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

/**
 * Full pipeline: parse agent text → validate paths → show diffs → apply with approval.
 * Used by doctor.ts (chat) and init.ts (scaffold).
 */
export async function proposeAndApply(
    agentText: string,
    projectRoot: string,
    options: ApplyOptions = { confirmEach: true }
): Promise<PatchResult[]> {
    const ops = await extractPatchesFromResponse(agentText, projectRoot);
    if (ops.length === 0) return [];
    return applyPatchSet(ops, projectRoot, options);
}
