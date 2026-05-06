// ─── fixd project reader ──────────────────────────────────────────────────────
// Reads actual file contents from disk and injects them into agent context.
// Prevents the agent from hallucinating or guessing about file contents.

import fs from "node:fs/promises";
import path from "node:path";

const MAX_FILE_SIZE = 50_000;   // 50 KB per file — skip larger files
const MAX_TOTAL_TOKENS = 20_000; // rough token budget (increased from 8k)
const CHAR_LIMIT = MAX_TOTAL_TOKENS * 4; // ~4 chars/token

// ─── Files always included regardless of query ────────────────────────────────

const ALWAYS_READ = [
    "package.json",
    "tsconfig.json",
    ".env.example",
    "README.md",
];

// ─── Code file extensions to scan when query is broad ────────────────────────

const CODE_EXTENSIONS = [
    ".ts", ".tsx", ".js", ".jsx", ".mjs",
    ".json", ".yaml", ".yml", ".py", ".ipynb",
    ".prisma", ".env.example",
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read files relevant to the given user query and return them as a formatted
 * string block ready for injection into the agent context.
 *
 * Returns an empty string if nothing could be read.
 */
export async function readRelevantFiles(
    query: string,
    projectRoot: string,
): Promise<string> {
    const sections: string[] = [];
    let totalChars = 0;

    // ── Always-read core config files ─────────────────────────────────────────
    for (const f of ALWAYS_READ) {
        if (totalChars >= CHAR_LIMIT) break;
        const content = await safeRead(path.join(projectRoot, f));
        if (!content) continue;
        const snippet = formatSnippet(f, content);
        sections.push(snippet);
        totalChars += snippet.length;
    }

    // ── Query-driven file selection ────────────────────────────────────────────
    const q = query.toLowerCase();
    const targets: string[] = [];

    // Broad project analysis → read src + cli
    if (/\b(src|source|analyse|analyze|summary|project|overview|codebase)\b/.test(q)) {
        targets.push(...await listFiles(path.join(projectRoot, "src"), CODE_EXTENSIONS));
        targets.push(...await listFiles(path.join(projectRoot, "cli"), CODE_EXTENSIONS));
    }

    // Action/scan/fix → read action files
    if (/\b(action|scan|fix)\b/.test(q)) {
        targets.push(...await listFiles(path.join(projectRoot, "src/actions"), CODE_EXTENSIONS));
    }

    // Prisma / database / schema
    if (/\b(prisma|schema|database|db)\b/.test(q)) {
        targets.push(...await listFiles(path.join(projectRoot, "prisma"), CODE_EXTENSIONS));
    }

    // CLI-specific queries
    if (/\b(cli|command|doctor|init|deploy)\b/.test(q)) {
        targets.push(...await listFiles(path.join(projectRoot, "cli"), CODE_EXTENSIONS));
    }

    // LLM / model / groq / clarifai queries
    if (/\b(llm|model|groq|clarifai|ai|inference)\b/.test(q)) {
        targets.push(...await listFiles(path.join(projectRoot, "cli/lib"), CODE_EXTENSIONS));
    }

    // ── Dedupe and read up to the char budget ─────────────────────────────────
    const seen = new Set(ALWAYS_READ);
    const unique = [...new Set(targets)];

    for (const filePath of unique) {
        if (totalChars >= CHAR_LIMIT) break;
        const rel = path.relative(projectRoot, filePath);
        if (seen.has(rel)) continue;
        seen.add(rel);

        const content = await safeRead(filePath);
        if (!content) continue;

        const snippet = formatSnippet(rel, content.slice(0, MAX_FILE_SIZE));
        sections.push(snippet);
        totalChars += snippet.length;
    }

    if (sections.length === 0) return "";

    return [
        "--- PROJECT FILES (read from disk, authoritative) ---",
        ...sections,
        "--- END PROJECT FILES ---",
    ].join("\n\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSnippet(rel: string, content: string): string {
    return `FILE: ${rel}\n\`\`\`\n${content}\n\`\`\``;
}

async function safeRead(filePath: string): Promise<string | null> {
    try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) return null;
        return await fs.readFile(filePath, "utf-8");
    } catch {
        return null;
    }
}

async function listFiles(dir: string, exts: string[]): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                // Recurse, but skip heavy dirs that won't help the agent
                if (!["node_modules", ".git", "dist", ".fixd"].includes(e.name)) {
                    files.push(...await listFiles(full, exts));
                }
            } else if (exts.some((ext) => e.name.endsWith(ext))) {
                files.push(full);
            }
        }
        return files;
    } catch {
        return [];
    }
}
