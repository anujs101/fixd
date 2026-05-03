```
Fix three issues in the fixd CLI project.

## Fix 1: Conversation memory across sessions

### Problem
Every `fixd doctor` run starts cold. Agent has no memory of previous sessions,
previously fixed issues, or project history.

### Solution
Build a simple persistent memory layer using a local JSON file at
`{projectRoot}/.fixd/memory.json`. Not a database. Not embeddings. Just structured
JSON that gets injected into every LLM system prompt.

### Build `cli/lib/memory.ts`

```typescript
export interface ProjectMemory {
  projectRoot: string;
  lastScanned: string | null;          // ISO timestamp
  fixedIssues: FixedIssue[];
  knownStack: Partial<StackSnapshot>;
  chatSummaries: ChatSummary[];        // rolling summaries of past sessions
  userPreferences: Record<string, string>; // e.g. { "preferred_pkg_manager": "bun" }
}

interface FixedIssue {
  type: string;
  description: string;
  fixedAt: string;        // ISO timestamp
  filesChanged: string[];
}

interface StackSnapshot {
  packageManager: string;
  nodeVersion: string;
  frameworks: string[];
  orms: string[];
  databases: string[];
}

interface ChatSummary {
  sessionDate: string;    // ISO timestamp
  summary: string;        // 2-3 sentence summary of what happened
  filesChanged: string[];
}
```

Functions:

**`loadMemory(projectRoot: string): Promise<ProjectMemory>`**
- Read `.fixd/memory.json`
- Return empty ProjectMemory if file doesn't exist
- Never throw

**`saveMemory(memory: ProjectMemory): Promise<void>`**
- Create `.fixd/` dir if needed
- Write atomically (tmp → rename)
- Never throw

**`updateFromScan(memory: ProjectMemory, scan: ProjectScan): ProjectMemory`**
- Update `lastScanned`, `knownStack` from scan result
- Return updated memory (don't save — caller saves)

**`recordFix(memory: ProjectMemory, results: PatchResult[]): ProjectMemory`**
- Append each applied fix to `fixedIssues`
- Cap `fixedIssues` at 50 entries (drop oldest)
- Return updated memory

**`summarizeSession(memory: ProjectMemory, sessionLog: string): Promise<ProjectMemory>`**
- Call LLM with `task: "classify"` (small model, cheap):
  ```
  Summarize this fixd session in 2 sentences max. What was broken, what was fixed.
  Session log: {sessionLog}
  ```
- Append result to `chatSummaries`
- Cap `chatSummaries` at 10 entries
- Return updated memory

**`formatMemoryForPrompt(memory: ProjectMemory): string`**
- Returns empty string if memory is essentially empty
- Otherwise returns:
  ```
  --- PROJECT MEMORY ---
  Last scanned: {lastScanned}
  Stack: {frameworks}, {orms}, {packageManager}
  
  Previously fixed:
  - {type}: {description} (fixed {date})
  
  Past sessions:
  - {date}: {summary}
  --- END MEMORY ---
  ```
- Keep under 500 tokens total — truncate old fixes if needed

### Integration: `cli/lib/agent.ts`

```typescript
import { loadMemory, formatMemoryForPrompt } from "./memory.js";

// in sendMessage() or buildSystemPrompt():
const memory = await loadMemory(process.cwd());
const memoryContext = formatMemoryForPrompt(memory);

// prepend to system prompt:
const fullSystemPrompt = memoryContext
  ? `${memoryContext}\n\n${baseSystemPrompt}`
  : baseSystemPrompt;
```

### Integration: `cli/doctor.ts`

```typescript
import { loadMemory, saveMemory, updateFromScan, recordFix, summarizeSession } from "./lib/memory.js";

// at start of runDoctor():
const memory = await loadMemory(projectPath);

// after scan:
const updatedMemory = updateFromScan(memory, scan);
await saveMemory(updatedMemory);

// after fixes applied (in the fix loop):
const memoryAfterFix = recordFix(updatedMemory, allPatchResults);
await saveMemory(memoryAfterFix);

// at end of session (before bye()):
// collect sessionLog = all agent responses + user inputs concatenated
const finalMemory = await summarizeSession(memoryAfterFix, sessionLog);
await saveMemory(finalMemory);
```

Add `.fixd/` to `.gitignore` — project memory is local, not committed.

---

## Fix 2: Groq 429 rate limit handling

### Problem
Groq free tier hits rate limits. Currently unhandled — crashes with unreadable error.

### Solution
In `cli/lib/llm.ts`, wrap every API call with retry + backoff + clear user messaging.

```typescript
// Replace current fetch call with this wrapper:

interface GroqError {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

async function groqFetch(
  body: object,
  retries = 3
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res;

    if (res.status === 429) {
      // parse retry-after header if present
      const retryAfter = res.headers.get("retry-after");
      const waitSeconds = retryAfter ? parseInt(retryAfter) : attempt * 15;

      if (attempt < retries) {
        // show spinner with countdown
        const s = spin(`rate limited — waiting ${waitSeconds}s (attempt ${attempt}/${retries})...`);
        await sleep(waitSeconds * 1000);
        s.stop();
        continue;
      }

      // final attempt failed
      throw new Error(
        `Groq rate limit exceeded. Wait ${waitSeconds}s and retry.\n` +
        `Tip: reduce usage or upgrade at console.groq.com`
      );
    }

    if (res.status === 401) {
      throw new Error("Invalid GROQ_API_KEY. Check your .env file.");
    }

    if (res.status === 503 || res.status === 502) {
      if (attempt < retries) {
        const wait = attempt * 5;
        const s = spin(`Groq unavailable — retrying in ${wait}s...`);
        await sleep(wait * 1000);
        s.stop();
        continue;
      }
      throw new Error("Groq API is currently unavailable. Try again in a moment.");
    }

    // other errors — parse and throw clean message
    const errBody = await res.json().catch(() => null) as GroqError | null;
    throw new Error(
      errBody?.error?.message ?? `Groq API error ${res.status}`
    );
  }

  throw new Error("Groq request failed after all retries.");
}
```

Also add startup validation in `cli/index.ts`:

```typescript
// in preflight() after checkHealth():
async function validateGroqKey(): Promise<boolean> {
  if (!process.env.GROQ_API_KEY) {
    error("GROQ_API_KEY not set — add it to your .env file");
    info("get a free key at console.groq.com");
    return false;
  }

  // lightweight test call — 1 token, cheapest model
  try {
    await ask("hi", "classify");
    return true;
  } catch (err: any) {
    error(`Groq API error: ${err.message}`);
    return false;
  }
}
```

Add model fallback — if large model (qwen3-32b) fails, retry with small model:

```typescript
// in ask() for task === "generate" or "diagnose":
try {
  return await groqFetch({ model: LARGE_MODEL, ...body });
} catch (err: any) {
  if (err.message.includes("rate limit") || err.message.includes("unavailable")) {
    warn(`${LARGE_MODEL} unavailable — falling back to ${SMALL_MODEL}`);
    return await groqFetch({ model: SMALL_MODEL, ...body });
  }
  throw err;
}
```

---

## Fix 3: Verify step after auto-fix

### Problem
After fixes are applied, fixd never confirms the project is actually clean.
User has no way to know if the fixes worked without manually re-running.

### Solution
After fix loop in `cli/doctor.ts`, re-run scan + diagnostics and compare.

```typescript
// after fix loop, before dropping into chat mode:

if (autoFixable.length > 0 && shouldFix) {
  const verifySpinner = spin("verifying fixes...");

  // re-run full scan + diagnostics
  const [scanAfter, diagAfter] = await Promise.all([
    scanProject(projectPath).catch(() => null),
    runDiagnostics(projectPath).catch(() => []),
  ]);

  verifySpinner.stop();
  section("verification");

  if (!scanAfter) {
    warn("could not re-scan project — verify manually");
  } else {
    const issuesAfter = detectIssues(scanAfter, projectPath);
    const diagErrorsAfter = getAllErrors(diagAfter);

    // compare before vs after
    const resolvedCount = issues.length - issuesAfter.length;
    const newIssueCount = issuesAfter.filter(
      a => !issues.some(b => b.type === a.type)
    ).length;

    if (resolvedCount > 0) {
      success(`${resolvedCount} issue${resolvedCount > 1 ? "s" : ""} resolved`);
    }

    if (newIssueCount > 0) {
      warn(`${newIssueCount} new issue${newIssueCount > 1 ? "s" : ""} detected after fix`);
      for (const i of issuesAfter.filter(a => !issues.some(b => b.type === a.type))) {
        printIssue(i.severity, i.type);
        console.log(`     ${chalk.dim(i.description)}`);
      }
    }

    if (diagErrorsAfter.length === 0 && issuesAfter.length === 0) {
      success("project is clean");
    } else if (diagErrorsAfter.length > 0) {
      warn(`${diagErrorsAfter.length} diagnostic error${diagErrorsAfter.length > 1 ? "s" : ""} remain`);
      for (const e of diagErrorsAfter.slice(0, 5)) {
        const loc = e.file ? `${e.file}:${e.line ?? ""}` : "";
        console.log(`     ${chalk.dim(loc)} ${chalk.red(e.code ?? "")} ${e.message}`);
      }
    }

    // update memory with verify result
    if (scanAfter) {
      const verifiedMemory = updateFromScan(memory, scanAfter);
      await saveMemory(verifiedMemory);
    }
  }
}
```

## Do not touch
- `cli/lib/display.ts`
- `cli/lib/diagnostics.ts`
- `cli/lib/executor.ts`
- `cli/lib/patcher.ts`
- `cli/lib/context7.ts`
- `src/actions/`
```