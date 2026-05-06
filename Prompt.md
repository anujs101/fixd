Two problems. Agent doesn't read actual files before answering, and it recommends instead of executes.

```
Fix `fixd doctor` chat mode. Two critical issues:

## Problem 1: Agent never reads actual project files
When user asks "analyse this project", agent guesses from scan metadata.
It should read actual file contents before responding.

## Fix: Add file reading to agenticTurn context pipeline

In `cli/lib/` create `projectReader.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";

const MAX_FILE_SIZE = 50_000; // 50kb per file
const MAX_TOTAL_TOKENS = 8_000;

const ALWAYS_READ = [
  "package.json",
  "tsconfig.json",
  ".env.example",
  "README.md",
];

const CODE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".mjs",
  ".json", ".yaml", ".yml",
  ".prisma", ".env.example",
];

// Read files relevant to a user query
export async function readRelevantFiles(
  query: string,
  projectRoot: string,
): Promise<string> {
  const sections: string[] = [];
  let totalChars = 0;
  const charLimit = MAX_TOTAL_TOKENS * 4; // ~4 chars per token

  // Always read core config files first
  for (const f of ALWAYS_READ) {
    const content = await safeRead(path.join(projectRoot, f));
    if (!content) continue;
    const snippet = `FILE: ${f}\n\`\`\`\n${content}\n\`\`\``;
    sections.push(snippet);
    totalChars += snippet.length;
    if (totalChars > charLimit) break;
  }

  // Query-driven file reading
  const queryLower = query.toLowerCase();
  
  // detect which src files to read based on query keywords
  const targets: string[] = [];
  
  if (queryLower.includes("src") || queryLower.includes("source") || queryLower.includes("analyse") || queryLower.includes("analyze") || queryLower.includes("summary") || queryLower.includes("project")) {
    // read all src files up to limit
    targets.push(...await listFiles(path.join(projectRoot, "src"), CODE_EXTENSIONS));
    targets.push(...await listFiles(path.join(projectRoot, "cli"), CODE_EXTENSIONS));
  }
  
  if (queryLower.includes("action") || queryLower.includes("scan") || queryLower.includes("fix")) {
    targets.push(...await listFiles(path.join(projectRoot, "src/actions"), CODE_EXTENSIONS));
  }

  if (queryLower.includes("prisma") || queryLower.includes("schema") || queryLower.includes("database")) {
    targets.push(...await listFiles(path.join(projectRoot, "prisma"), CODE_EXTENSIONS));
  }

  if (queryLower.includes("cli") || queryLower.includes("command") || queryLower.includes("doctor") || queryLower.includes("init")) {
    targets.push(...await listFiles(path.join(projectRoot, "cli"), CODE_EXTENSIONS));
  }

  // dedupe
  const unique = [...new Set(targets)];

  for (const filePath of unique) {
    if (totalChars > charLimit) break;
    const rel = path.relative(projectRoot, filePath);
    // skip already-read files
    if (ALWAYS_READ.includes(rel)) continue;
    const content = await safeRead(filePath);
    if (!content) continue;
    const snippet = `FILE: ${rel}\n\`\`\`\n${content.slice(0, MAX_FILE_SIZE)}\n\`\`\``;
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
        files.push(...await listFiles(full, exts));
      } else if (exts.some(ext => e.name.endsWith(ext))) {
        files.push(full);
      }
    }
    return files;
  } catch {
    return [];
  }
}
```

## Problem 2: Agent recommends instead of executes

When user says "fix them" agent should immediately output patch markers
and/or bash blocks — not describe what to do.

### Fix: Update `agenticTurn` in `cli/doctor.ts`

```typescript
import { readRelevantFiles } from "./lib/projectReader.js";

async function agenticTurn(
  userMessage: string,
  projectPath: string,
  depth = 0,
  alreadyRan: Set<string> = new Set()
): Promise<void> {
  const MAX_DEPTH = 6;
  if (depth > MAX_DEPTH) {
    info("(max tool calls reached for this turn)");
    return;
  }

  // READ FILES BEFORE EVERY TOP-LEVEL TURN
  let fileContext = "";
  if (depth === 0) {
    const readSpinner = spin("reading project files...");
    fileContext = await readRelevantFiles(userMessage, projectPath)
      .catch(() => "");
    readSpinner.stop();
  }

  const isFixRequest = /fix|apply|implement|create|add|remove|update|change/i.test(userMessage);

  const fixInstruction = isFixRequest ? `
EXECUTE DON'T EXPLAIN:
- If fixing a file: output patch markers immediately, no preamble
- If running a command: output bash block immediately
- Do not describe what you will do — just do it
- After patch markers: one sentence max explaining what changed
` : `
RESPOND FORMAT:
- Answer directly from file contents above
- Max 4 lines unless showing code
- No "I will", "Let me", "Sure" openers
- Start answer immediately
`;

  const fullMessage = [
    fileContext,
    `[Working directory: ${projectPath}]`,
    "",
    userMessage,
    "",
    fixInstruction,
  ].filter(Boolean).join("\n");

  const thinkSpinner = spin(
    depth === 0
      ? "thinking..."
      : "agent analysing output..."
  );

  const responses = await sendMessage(fullMessage, "chat").catch((err: any) => {
    thinkSpinner.stop();
    warn(err.message);
    return [];
  });

  thinkSpinner.stop();

  for (const msg of responses) {
    const clean = msg.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    agentSays(clean);

    // patches
    const patches = await proposeAndApply(clean, projectPath, { confirmEach: true })
      .catch(() => [] as PatchResult[]);
    const applied = patches.filter(p => p.applied);

    if (applied.length > 0) {
      await agenticTurn(
        `Applied ${applied.length} change(s):\n${applied.map(p => `- ${p.op} ${p.path}`).join("\n")}\nVerify the changes are correct and continue.`,
        projectPath,
        depth + 1,
        alreadyRan
      );
      return;
    }

    // commands
    const pending = extractPendingCommands(clean, alreadyRan);
    for (const cmd of pending) {
      alreadyRan.add(cmd.command);
      agentWantsToRun(cmd.command, cmd.reason);
      const approved = await confirm("run this command?");

      if (!approved) {
        await agenticTurn(
          `User declined: \`${cmd.command}\`. Propose alternative or explain manual steps.`,
          projectPath,
          depth + 1,
          alreadyRan
        );
        continue;
      }

      const runSpinner = spin(`running: ${cmd.command}`);
      const result = await runCommand(cmd.command, projectPath);
      runSpinner.stop();
      printCommandResult(result);

      await agenticTurn(
        formatResultForAgent(result),
        projectPath,
        depth + 1,
        alreadyRan
      );
    }
  }
}
```

## Problem 3: JSON patch search/replace fails

In `cli/lib/patcher.ts`, add JSON-aware patching:

```typescript
// at top of applyPatch(), before generic edit logic:
if (op.op === "edit" && op.path.endsWith(".json")) {
  return applyJsonPatch(op, projectRoot);
}

async function applyJsonPatch(
  op: Extract<PatchOperation, { op: "edit" }>,
  projectRoot: string
): Promise<PatchResult> {
  const absPath = path.join(projectRoot, op.path);
  
  try {
    const raw = await fs.readFile(absPath, "utf-8");
    const current = JSON.parse(raw);
    
    // parse the replace block as JSON fragment and deep merge
    // agent outputs full JSON object in replace — parse and merge at top level
    let replacement: Record<string, any>;
    try {
      replacement = JSON.parse(op.replace);
    } catch {
      // replace block isn't valid JSON — fall back to string search
      return applyStringPatch(op, projectRoot);
    }

    const merged = deepMerge(current, replacement);
    const newContent = JSON.stringify(merged, null, 2) + "\n";
    
    // generate diff
    const diff = generateJsonDiff(current, merged);
    
    await atomicWrite(absPath, newContent);
    
    return {
      op: "edit",
      path: op.path,
      applied: true,
      diff,
    };
  } catch (err: any) {
    return {
      op: "edit",
      path: op.path,
      applied: false,
      diff: "",
      error: err.message,
    };
  }
}

function deepMerge(base: any, override: any): any {
  if (typeof base !== "object" || typeof override !== "object") return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      key in base &&
      typeof base[key] === "object" &&
      typeof override[key] === "object" &&
      !Array.isArray(base[key])
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
  const afterStr  = JSON.stringify(after, null, 2).split("\n");
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
```

## Expected flow after fix

```
? you › analyse the project dir and give me a summary

  ⠋ reading project files...
  ⠋ thinking...

  fixd › TypeScript CLI tool — terminal-native dev environment agent.
         Three commands: doctor (diagnose/fix), init (scaffold), deploy (Nosana).
         Stack: Bun + TypeScript + Groq LLM + Context7 docs.
         Core modules: scanner, diagnostics, patcher, executor, memory.
         6 open TS2591 errors — @types/node missing from tsconfig types field.

? you › fix the typescript errors

  ⠋ reading project files...
  ⠋ thinking...

  → edit: tsconfig.json
    - "types": []
    + "types": ["node"]

  ? apply this change? (y/n) › y
  ✔ applied: tsconfig.json

  ⠋ agent analysing output...
  fixd › tsconfig updated. Run bun tsc --noEmit to verify.

  ╭─ agent wants to run
  │  $ bun tsc --noEmit
  ╰─
  ? run this command? (y/n) › y
  ✔ OK  0 errors
```

## Do not touch
- `cli/lib/display.ts`


- `cli/lib/context7.ts`
- `cli/lib/memory.ts`

```