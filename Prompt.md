Two things to fix:
1. Agent thinking out loud — that wall of "Okay, let's look at the problem..." is the model's <think> block leaking into output. Strip it in cli/lib/llm.ts before returning:
typescript// strip <think>...</think> blocks from qwen3 responses
response = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
2. bun add --dev scripts hallucination — model invented a fake command. Needs tighter prompt. In your diagnosis prompt add:
RULES:
- Never suggest `bun add` or `npm install` for fixing config issues
- For package.json script fixes, show ONLY the JSON diff, no commands
**Prompt:**

```
Fix the visual output of `fixd doctor` responses. The agent output is unstructured — 
thinking text leaks, random prose, inconsistent formatting. 

## Goal
Every agent response must follow a strict visual structure. The display layer 
(display.ts) already has all the primitives needed — use them.

## Problem 1: <think> blocks leaking
In `cli/lib/llm.ts`, strip before returning response:
```typescript
response = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
```

## Problem 2: Agent prompt not enforcing structure
The diagnosis prompt sent to LLM must enforce exact output format.
Replace the current diagPrompt in `cli/doctor.ts` with this structure:

```
You are fixd. Respond ONLY in this exact format. No prose. No thinking out loud.

ISSUES: {n} found

---
SEVERITY: HIGH | MEDIUM | LOW
TYPE: {ISSUE_TYPE}
PROBLEM: One sentence. What exactly is wrong.
FIX: One sentence. Exact action to take.
DIFF:
```diff
- old line
+ new line
```
---

(repeat block per issue)

If no issues: respond with exactly "NO ISSUES FOUND"

RULES:
- No filler text before or after the blocks
- No "I recommend", "Let me", "Okay", "First" or any conversational openers
- No fake commands (never suggest `bun add` for config fixes)
- For package.json fixes show JSON diff only
- Max 1 sentence per field
```

## Problem 3: Parse structured response in display layer
In `cli/doctor.ts`, after getting agent response, parse the structured blocks
and render using existing display.ts primitives instead of raw `agentSays()`:

```typescript
function renderDiagnosisResponse(raw: string) {
  // strip think blocks
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  
  if (clean === "NO ISSUES FOUND") {
    success("no issues found — project looks clean");
    return;
  }

  // parse issue blocks separated by ---
  const blocks = clean.split(/^---$/m).map(b => b.trim()).filter(Boolean);
  
  for (const block of blocks) {
    if (!block.includes("SEVERITY:")) continue;
    
    const get = (field: string) =>
      block.match(new RegExp(`${field}:\\s*(.+)`))?.[1]?.trim() ?? "";

    const severity = get("SEVERITY") as "HIGH" | "MEDIUM" | "LOW";
    const type     = get("TYPE");
    const problem  = get("PROBLEM");
    const fix      = get("FIX");

    // extract diff block
    const diffMatch = block.match(/```diff\n([\s\S]*?)```/);
    const diff      = diffMatch?.[1] ?? "";

    // render using display.ts primitives
    console.log();
    printIssue(severity, type);
    console.log(`     ${chalk.dim("problem:")} ${problem}`);
    console.log(`     ${chalk.dim("fix:")}     ${fix}`);
    
    if (diff) {
      printFix("suggested change:", diff);
    }
  }
  console.log();
}
```

Replace `agentSays(msg.text)` in the diagnosis phase with `renderDiagnosisResponse(msg.text)`.
Keep `agentSays()` for interactive chat phase only.

## Problem 4: Chat phase output still needs cleanup
In the interactive chat loop, before calling `agentSays()`, strip think blocks:

```typescript
const clean = msg.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
agentSays(clean);
```

## Problem 5: Chat prompt needs structure rule too
When sending chat messages in `agenticTurn()`, append to every message:

```
\n\nRESPOND FORMAT:
- Max 4 lines unless showing code
- If showing code: use fenced blocks with language tag
- No thinking out loud
- No "I will", "Let me", "Sure" openers
- Start answer directly
```

## Expected output after fix

```
  issues found
  ────────────────────────────────────────

  ●  MEDIUM   MISSING_SCRIPTS
     problem: package.json has no "dev" or "start" script defined
     fix:     add "start" script pointing to your entry point

     → suggested change:
     - (no start script)
     + "start": "tsx cli/index.ts"


  ℹ No auto-fixable issues.

  chat mode
  ────────────────────────────────────────

  ? you › why is strict mode important

  fixd › Strict mode enables additional TypeScript checks:
         - catches implicit any
         - enforces null checks  
         - prevents unsafe operations
         Recommended for all production TypeScript projects.
```

## Do not touch
- `cli/lib/display.ts` — only consume it, don't modify
- `cli/lib/diagnostics.ts`
- `cli/lib/executor.ts`
- `src/actions/`
```