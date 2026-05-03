```
Build Context7 integration for fixd CLI. Context7 provides up-to-date library 
documentation via API — fixes the problem of LLMs generating stale/outdated code.

## Context
fixd is a terminal-native dev environment agent. Stack:
- `cli/lib/llm.ts` — Groq LLM client
- `cli/lib/agent.ts` — conversation management, system prompt
- `cli/lib/display.ts` — terminal UI primitives
- `cli/doctor.ts` — main doctor flow with agenticTurn()
- `cli/init.ts` — project scaffolding

CONTEXT7_API_KEY is already in .env.

## What to build: `cli/lib/context7.ts`

```typescript
const BASE_URL = "https://context7.com/api/v1";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LibraryDoc {
  libraryId: string;      // e.g. "/honojs/hono"
  topic: string;          // e.g. "routing" — what we asked for
  content: string;        // markdown doc content
  version: string | null; // library version if returned
  tokens: number;         // content token count
}

export interface Context7Result {
  docs: LibraryDoc[];
  totalTokens: number;
  skipped: string[];      // libraries that failed or returned nothing
}

// ─── Library ID map ───────────────────────────────────────────────────────────
// Maps common names from fixd init interview → Context7 library IDs
// If not found in map, use search API to resolve dynamically

const KNOWN_LIBRARIES: Record<string, string> = {
  // frameworks
  "hono":          "/honojs/hono",
  "express":       "/expressjs/express",
  "fastify":       "/fastify/fastify",
  "nextjs":        "/vercel/next.js",
  "next":          "/vercel/next.js",
  "vite":          "/vitejs/vite",

  // ORMs / DB
  "prisma":        "/prisma/prisma",
  "drizzle":       "/drizzle-team/drizzle-orm",

  // auth
  "better-auth":   "/better-auth/better-auth",
  "clerk":         "/clerkinc/clerk-docs",

  // runtime
  "bun":           "/oven-sh/bun",

  // nosana
  "nosana":        "/nosana-ci/nosana-node",
};
```

### Functions to implement

**`resolveLibraryId(name: string): Promise<string | null>`**

Resolve library name to Context7 ID.
1. Check `KNOWN_LIBRARIES` map first (instant)
2. If not found, call `GET /api/v1/search?q={name}&limit=3`
3. Parse response, pick first result with `code_snippet_count > 0`
4. Return `libraryId` or null if nothing found
5. Cache resolved IDs in memory (Map) for session duration

**`fetchDocs(libraryId: string, topic: string, maxTokens = 4000): Promise<LibraryDoc | null>`**

Fetch docs for a specific library + topic.
```
GET https://context7.com/api/v1{libraryId}?topic={topic}&tokens={maxTokens}
Headers:
  X-Context7-Source: fixd
  Authorization: Bearer {process.env.CONTEXT7_API_KEY}
```
- Return null on 404 or empty content
- Return null on error (never throw — log with `warn()`)
- Strip excessive whitespace from content before returning

**`fetchDocsForStack(stack: StackChoices): Promise<Context7Result>`**

Called during `fixd init` after interview. Fetches docs for all chosen libraries.

```typescript
interface StackChoices {
  framework?: string;   // "hono", "express", etc.
  orm?: string;         // "prisma", "drizzle"
  auth?: string;        // "better-auth", "clerk"
  runtime?: string;     // "bun", "node"
  database?: string;    // used to pick relevant prisma topics
}
```

Topic selection logic per library:
- `hono` → topic: "getting started routing middleware"
- `express` → topic: "routing middleware setup"
- `prisma` + postgres → topic: "postgresql connection schema migrations"
- `prisma` + neon → topic: "neon serverless connection pooling directUrl"
- `drizzle` → topic: "schema migrations postgresql"
- `better-auth` → topic: "setup nextjs configuration"
- `bun` → topic: "http server file runtime"

Fetch all in parallel with `Promise.allSettled`.
Cap total tokens at 12000 — if over, trim least important libs first (auth < runtime < orm < framework).

**`detectLibrariesInProject(projectPath: string): Promise<string[]>`**

Called during `fixd doctor` chat to auto-detect what docs to fetch.
Read `package.json` dependencies + devDependencies, map to library IDs using `KNOWN_LIBRARIES`.
Return list of resolved library IDs found.

**`fetchDocsForQuery(query: string, projectLibraries: string[]): Promise<LibraryDoc[]>`**

Called in `agenticTurn()` when user asks about a library.
1. Extract library name from query (simple keyword match against KNOWN_LIBRARIES keys)
2. If match found and in projectLibraries: fetch with query as topic
3. Cap at 3000 tokens per doc, max 2 docs per query
4. Return empty array if nothing relevant (never block the response)

**`formatDocsForPrompt(docs: LibraryDoc[]): string`**

Convert docs to injection string for LLM prompt:
```
--- CURRENT LIBRARY DOCUMENTATION ---
The following is up-to-date documentation fetched in real time.
Prefer this over your training data for these libraries.

[LIBRARY: honojs/hono — routing]
{content}

[LIBRARY: prisma/prisma — neon connection]
{content}
--- END DOCUMENTATION ---
```

### Integration: `cli/init.ts`

After stack interview, before sending scaffold prompt to LLM:

```typescript
import { fetchDocsForStack, formatDocsForPrompt } from "./lib/context7.js";

// after confirm("scaffold this project?"):
const docsSpinner = spin("fetching latest docs...");
const docsResult = await fetchDocsForStack({
  framework: framework || "hono",
  orm: orm !== "none" ? orm : undefined,
  auth: auth !== "none" ? auth : undefined,
  runtime: pkgManager === "bun" ? "bun" : "node",
  database: database !== "none" ? database : undefined,
}).catch(() => ({ docs: [], totalTokens: 0, skipped: [] }));
docsSpinner.stop();

if (docsResult.docs.length > 0) {
  info(`fetched docs for: ${docsResult.docs.map(d => d.libraryId.split("/")[2]).join(", ")}`);
}
if (docsResult.skipped.length > 0) {
  info(`skipped (no docs found): ${docsResult.skipped.join(", ")}`);
}

const docsContext = formatDocsForPrompt(docsResult.docs);

// inject into scaffold prompt:
const scaffoldPrompt = `
${docsContext}

Scaffold a new project with these specs:
- Project name: ${projectName}
...rest of existing prompt
`.trim();
```

### Integration: `cli/doctor.ts` — chat mode

In `agenticTurn()`, detect if user query references a known library and inject docs:

```typescript
import { detectLibrariesInProject, fetchDocsForQuery, formatDocsForPrompt } from "./lib/context7.js";

// at top of runDoctor(), after scan:
const projectLibraries = await detectLibrariesInProject(projectPath)
  .catch(() => [] as string[]);

// in agenticTurn(), before sendMessage():
async function buildMessageWithDocs(userMessage: string): Promise<string> {
  const docs = await fetchDocsForQuery(userMessage, projectLibraries)
    .catch(() => [] as LibraryDoc[]);
  
  if (docs.length === 0) return userMessage;
  
  const docsContext = formatDocsForPrompt(docs);
  return `${docsContext}\n\n${userMessage}`;
}

// replace: sendMessage(withCwd(injectCommandInstruction(userMessage), projectPath))
// with:
const enrichedMessage = await buildMessageWithDocs(
  withCwd(injectCommandInstruction(userMessage), projectPath)
);
const responses = await sendMessage(enrichedMessage, "chat").catch(...);
```

### Environment

Add to `.env.example`:
```env
# Context7
CONTEXT7_API_KEY=your_key_here
```

Add to `.env` validation in `cli/index.ts` startup:
```typescript
// warn but don't exit — context7 is optional enhancement
if (!process.env.CONTEXT7_API_KEY) {
  warn("CONTEXT7_API_KEY not set — library docs unavailable");
}
```

## Do not touch
- `cli/lib/display.ts`
- `cli/lib/diagnostics.ts`
- `cli/lib/executor.ts`
- `cli/lib/patcher.ts`
- `src/actions/`

## Verification

```
fixd init

  ? backend framework (hono / express / fastify) › hono
  ? orm (prisma / drizzle / none) › prisma
  ? postgres hosting (neon / supabase / railway / local) › neon
  ...

  ⠋ fetching latest docs...
  ℹ fetched docs for: hono, prisma
  ℹ skipped (no docs found): (none)

  ⠋ generating project...
  [streams files with current hono v4 syntax + correct neon+prisma config]
```

And in doctor chat:
```
  ? you › how do i add middleware in hono

  [auto-fetches hono middleware docs, injects, responds with current v4 syntax]
```
```