// ─── fixd × Context7 ──────────────────────────────────────────────────────────
// Fetches up-to-date library docs from context7.com and injects them into
// LLM prompts, preventing stale/outdated code generation.

import { warn } from "./display.js";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://context7.com/api/v1";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LibraryDoc {
    libraryId: string;      // e.g. "/honojs/hono"
    topic: string;          // e.g. "routing" — what was requested
    content: string;        // markdown doc content
    version: string | null; // library version if returned
    tokens: number;         // content token count
}

export interface Context7Result {
    docs: LibraryDoc[];
    totalTokens: number;
    skipped: string[];      // libraries that failed or returned nothing
}

export interface StackChoices {
    framework?: string;   // "hono", "express", etc.
    orm?: string;         // "prisma", "drizzle"
    auth?: string;        // "better-auth", "clerk"
    runtime?: string;     // "bun", "node"
    database?: string;    // used to pick relevant prisma topics
}

// ─── Library ID map ───────────────────────────────────────────────────────────

const KNOWN_LIBRARIES: Record<string, string> = {
    // frameworks
    "hono":        "/honojs/hono",
    "express":     "/expressjs/express",
    "fastify":     "/fastify/fastify",
    "nextjs":      "/vercel/next.js",
    "next":        "/vercel/next.js",
    "vite":        "/vitejs/vite",

    // ORMs / DB
    "prisma":      "/prisma/prisma",
    "drizzle":     "/drizzle-team/drizzle-orm",

    // auth
    "better-auth": "/better-auth/better-auth",
    "clerk":       "/clerkinc/clerk-docs",

    // runtime
    "bun":         "/oven-sh/bun",

    // nosana
    "nosana":      "/nosana-ci/nosana-node",
};

// ─── In-memory search cache ───────────────────────────────────────────────────

const resolveCache = new Map<string, string | null>();

// ─── Shared fetch helper ──────────────────────────────────────────────────────

function c7Headers(): Record<string, string> {
    const headers: Record<string, string> = {
        "X-Context7-Source": "fixd",
        "Accept": "application/json, text/plain",
    };
    const key = process.env.CONTEXT7_API_KEY;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    return headers;
}

// ─── resolveLibraryId ─────────────────────────────────────────────────────────

export async function resolveLibraryId(name: string): Promise<string | null> {
    const normalized = name.toLowerCase().trim();

    // 1. Known map
    if (KNOWN_LIBRARIES[normalized]) return KNOWN_LIBRARIES[normalized];

    // 2. Memory cache
    if (resolveCache.has(normalized)) return resolveCache.get(normalized)!;

    // 3. Search API
    try {
        const url = `${BASE_URL}/search?q=${encodeURIComponent(normalized)}&limit=3`;
        const res = await fetch(url, { headers: c7Headers() });
        if (!res.ok) { resolveCache.set(normalized, null); return null; }

        const data = await res.json() as any;
        const results: any[] = data.results ?? data.data ?? [];
        const match = results.find((r: any) => (r.code_snippet_count ?? r.codeSnippetCount ?? 0) > 0);
        const id: string | null = match?.id ?? match?.library_id ?? null;

        resolveCache.set(normalized, id);
        return id;
    } catch {
        resolveCache.set(normalized, null);
        return null;
    }
}

// ─── fetchDocs ────────────────────────────────────────────────────────────────

export async function fetchDocs(
    libraryId: string,
    topic: string,
    maxTokens = 4000
): Promise<LibraryDoc | null> {
    if (!process.env.CONTEXT7_API_KEY) return null;

    try {
        const url = `${BASE_URL}${libraryId}?topic=${encodeURIComponent(topic)}&tokens=${maxTokens}`;
        const res = await fetch(url, { headers: c7Headers() });

        if (res.status === 404) return null;
        if (!res.ok) {
            warn(`context7: ${libraryId} returned ${res.status}`);
            return null;
        }

        const text = await res.text();
        let data: any;
        try { data = JSON.parse(text); } catch { data = { content: text }; }

        const content: string = (data.content ?? data.text ?? text ?? "").trim()
            // collapse runs of 3+ blank lines to 2
            .replace(/\n{3,}/g, "\n\n");

        if (!content) return null;

        return {
            libraryId,
            topic,
            content,
            version: data.version ?? null,
            tokens: data.tokens ?? Math.ceil(content.length / 4),
        };
    } catch (err: any) {
        warn(`context7: failed to fetch ${libraryId} — ${err.message}`);
        return null;
    }
}

// ─── Topic selection ──────────────────────────────────────────────────────────

function pickTopic(lib: string, stack: StackChoices): string {
    const db = (stack.database ?? "").toLowerCase();
    switch (lib) {
        case "hono":        return "getting started routing middleware";
        case "express":     return "routing middleware setup";
        case "fastify":     return "routing plugins setup";
        case "nextjs":
        case "next":        return "app router server components api routes";
        case "prisma":
            if (db.includes("neon"))      return "neon serverless connection pooling directUrl";
            if (db.includes("supabase")) return "supabase connection pooling ssl";
            return "postgresql connection schema migrations";
        case "drizzle":     return "schema migrations postgresql";
        case "better-auth": return "setup configuration";
        case "clerk":       return "setup nextjs middleware";
        case "bun":         return "http server file runtime";
        default:            return "getting started";
    }
}

// Priority order: auth < runtime < orm < framework (higher = more important)
const PRIORITY: Record<string, number> = {
    auth: 1, runtime: 2, orm: 3, framework: 4,
};

// ─── fetchDocsForStack ────────────────────────────────────────────────────────

export async function fetchDocsForStack(stack: StackChoices): Promise<Context7Result> {
    type Entry = { name: string; category: string };
    const entries: Entry[] = [];

    if (stack.framework) entries.push({ name: stack.framework, category: "framework" });
    if (stack.orm)       entries.push({ name: stack.orm,       category: "orm" });
    if (stack.auth)      entries.push({ name: stack.auth,      category: "auth" });
    if (stack.runtime)   entries.push({ name: stack.runtime,   category: "runtime" });

    // Fetch all in parallel
    const settled = await Promise.allSettled(
        entries.map(async (e) => {
            const libId = await resolveLibraryId(e.name);
            if (!libId) return { entry: e, doc: null };
            const topic = pickTopic(e.name, stack);
            const doc = await fetchDocs(libId, topic, 3000);
            return { entry: e, doc };
        })
    );

    const docs: LibraryDoc[] = [];
    const skipped: string[] = [];

    for (const r of settled) {
        if (r.status === "rejected" || !r.value.doc) {
            const name = r.status === "fulfilled" ? r.value.entry.name : "unknown";
            skipped.push(name);
        } else {
            docs.push(r.value.doc);
        }
    }

    // Cap total at 12000 tokens — trim least important first
    const byPriority = [...docs].sort((a, b) => {
        const catA = entries.find((e) => a.libraryId.includes(e.name))?.category ?? "orm";
        const catB = entries.find((e) => b.libraryId.includes(e.name))?.category ?? "orm";
        return (PRIORITY[catA] ?? 0) - (PRIORITY[catB] ?? 0); // ascending = least first
    });

    const TOKEN_CAP = 12000;
    let total = 0;
    const trimmed: LibraryDoc[] = [];

    // Add highest priority first (reverse of byPriority)
    for (const doc of byPriority.reverse()) {
        if (total + doc.tokens <= TOKEN_CAP) {
            trimmed.push(doc);
            total += doc.tokens;
        } else {
            skipped.push(doc.libraryId);
        }
    }

    return { docs: trimmed, totalTokens: total, skipped };
}

// ─── detectLibrariesInProject ─────────────────────────────────────────────────

export async function detectLibrariesInProject(projectPath: string): Promise<string[]> {
    try {
        const pkgPath = path.join(projectPath, "package.json");
        const raw = await fs.readFile(pkgPath, "utf-8");
        const pkg = JSON.parse(raw);
        const allDeps = {
            ...(pkg.dependencies ?? {}),
            ...(pkg.devDependencies ?? {}),
        };

        const found: string[] = [];
        for (const [name, libId] of Object.entries(KNOWN_LIBRARIES)) {
            if (allDeps[name] !== undefined) {
                found.push(libId as string);
            }
        }
        return [...new Set(found)]; // deduplicate
    } catch {
        return [];
    }
}

// ─── fetchDocsForQuery ────────────────────────────────────────────────────────

export async function fetchDocsForQuery(
    query: string,
    projectLibraries: string[]
): Promise<LibraryDoc[]> {
    if (!process.env.CONTEXT7_API_KEY) return [];

    const lower = query.toLowerCase();
    const matched: string[] = [];

    // Simple keyword match against KNOWN_LIBRARIES keys
    for (const [name, libId] of Object.entries(KNOWN_LIBRARIES)) {
        if (lower.includes(name) && projectLibraries.includes(libId)) {
            matched.push(libId);
        }
    }

    if (matched.length === 0) return [];

    // Fetch max 2 docs, 3000 tokens each
    const toFetch = matched.slice(0, 2);
    const results = await Promise.allSettled(
        toFetch.map((libId) => fetchDocs(libId, query, 3000))
    );

    return results
        .filter((r): r is PromiseFulfilledResult<LibraryDoc> =>
            r.status === "fulfilled" && r.value !== null)
        .map((r) => r.value);
}

// ─── formatDocsForPrompt ──────────────────────────────────────────────────────

export function formatDocsForPrompt(docs: LibraryDoc[]): string {
    if (docs.length === 0) return "";

    const parts: string[] = [
        "--- CURRENT LIBRARY DOCUMENTATION ---",
        "The following is up-to-date documentation fetched in real time.",
        "Prefer this over your training data for these libraries.",
        "",
    ];

    for (const doc of docs) {
        const label = `${doc.libraryId.replace(/^\//, "")} — ${doc.topic}`;
        parts.push(`[LIBRARY: ${label}]`);
        parts.push(doc.content);
        parts.push("");
    }

    parts.push("--- END DOCUMENTATION ---");
    return parts.join("\n");
}
