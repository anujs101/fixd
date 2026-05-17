// ─── fixd project reader ──────────────────────────────────────────────────────
// Reads actual file contents from disk and injects them into agent context.
// Prevents the agent from hallucinating or guessing about file contents.

import fs from "node:fs/promises";
import path from "node:path";
import { ask } from "./llm.js";

const MAX_FILE_SIZE = 50_000;    // 50 KB per file — skip larger files
const MAX_TOTAL_TOKENS = 20_000; // rough token budget
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

// ─── scoreFileRelevance (Change 7) ───────────────────────────────────────────
//
// Uses small model to filter which candidate files are actually relevant to
// the current query + detected issue types. Gracefully falls back to all
// candidates on any error — never throws, never blocks.

async function scoreFileRelevance(
    query: string,
    candidateFiles: string[],
    detectedIssueTypes: string[]
): Promise<string[]> {
    if (candidateFiles.length <= 5) return candidateFiles; // not worth a model call

    const prompt = `Given this developer error context:
"${query}"

Issue types: ${detectedIssueTypes.join(", ") || "unknown"}

Which of these files are directly relevant to diagnosing or fixing this specific error?
Files: ${candidateFiles.join(", ")}

Reply with ONLY a JSON array of relevant file paths. Maximum 8 files. If none are relevant, return [].
Example: ["src/index.ts", "prisma/schema.prisma"]`;

    try {
        const response = await ask(prompt, "classify");
        const cleaned = response.replace(/```json|```/g, "").trim();
        const match = cleaned.match(/\[[\s\S]*?\]/);
        if (!match) return candidateFiles;
        const parsed: string[] = JSON.parse(match[0]);
        if (!Array.isArray(parsed)) return candidateFiles;
        const filtered = parsed.filter((f) => candidateFiles.includes(f));
        return filtered.length > 0 ? filtered : candidateFiles;
    } catch {
        // Always fall back to all candidates on any error
        return candidateFiles;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read files relevant to the given user query and return them as a formatted
 * string block ready for injection into the agent context.
 *
 * issueTypes — optional list of detected issue type strings (e.g. "MISSING_DATABASE_URL")
 * used to focus the file relevance scoring step.
 *
 * Returns an empty string if nothing could be read.
 */
export async function readRelevantFiles(
    query: string,
    projectRoot: string,
    issueTypes: string[] = [],
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
    const candidatePaths: string[] = [];

    // Broad project analysis → read src + cli
    if (/\b(src|source|analyse|analyze|summary|project|overview|codebase)\b/.test(q)) {
        candidatePaths.push(...await listFiles(path.join(projectRoot, "src"), CODE_EXTENSIONS));
        candidatePaths.push(...await listFiles(path.join(projectRoot, "cli"), CODE_EXTENSIONS));
    }

    // Action/scan/fix → read action files
    if (/\b(action|scan|fix)\b/.test(q)) {
        candidatePaths.push(...await listFiles(path.join(projectRoot, "src/actions"), CODE_EXTENSIONS));
    }

    // Prisma / database / schema
    if (/\b(prisma|schema|database|db)\b/.test(q)) {
        candidatePaths.push(...await listFiles(path.join(projectRoot, "prisma"), CODE_EXTENSIONS));
    }

    // CLI-specific queries
    if (/\b(cli|command|doctor|init|deploy)\b/.test(q)) {
        candidatePaths.push(...await listFiles(path.join(projectRoot, "cli"), CODE_EXTENSIONS));
    }

    // LLM / model / groq / clarifai queries
    if (/\b(llm|model|groq|clarifai|ai|inference)\b/.test(q)) {
        candidatePaths.push(...await listFiles(path.join(projectRoot, "cli/lib"), CODE_EXTENSIONS));
    }

    // ── Dedupe candidate paths (relative), then relevance-score ───────────────
    const seen = new Set(ALWAYS_READ);
    const uniquePaths = [...new Set(candidatePaths)];
    const relCandidates = uniquePaths.map((p) => path.relative(projectRoot, p));

    // Change 7: score file relevance — skip model call if too few candidates
    const relevantRel = await scoreFileRelevance(query, relCandidates, issueTypes);
    const relevantSet = new Set(relevantRel);

    for (const filePath of uniquePaths) {
        if (totalChars >= CHAR_LIMIT) break;
        const rel = path.relative(projectRoot, filePath);
        if (seen.has(rel)) continue;
        if (relCandidates.length > 5 && !relevantSet.has(rel)) continue; // filtered out
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
