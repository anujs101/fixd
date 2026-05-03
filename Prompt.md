Here's the prompt:

---

**Prompt for your coding agent:**

```
You are refactoring the `fixd` CLI project to remove all ElizaOS dependencies and replace them with direct Groq API calls.

## Context
fixd is a terminal-native developer environment agent. It has three commands:
- `fixd doctor` — scans project, detects issues, fixes them, interactive chat
- `fixd init` — scaffolds new project via conversation
- `fixd deploy` — deploys to Nosana GPU network

Currently the CLI talks to an ElizaOS server via Socket.IO. We are ripping that out entirely and talking to Groq directly.

## What to remove
- `cli/lib/client.ts` — delete entirely (Socket.IO + ElizaOS messaging)
- All `socket.io-client` usage
- All `elizaos dev` server dependency
- `src/index.ts` plugin — delete (ElizaOS action system no longer needed)
- `src/actions/` folder — keep the logic but detach from ElizaOS types
- Any `@elizaos/core` imports anywhere in `cli/`

## What to keep
- `characters/agent.character.json` — keep as-is, convert to system prompt
- `cli/lib/display.ts` — keep entirely, no changes
- `cli/lib/diagnostics.ts` — keep entirely, no changes
- `cli/lib/executor.ts` — keep entirely, no changes
- `src/actions/scanFiles.ts` — keep, remove any ElizaOS imports
- `src/actions/executeCommand.ts` — keep, remove any ElizaOS imports
- `src/actions/fixEnv.ts` — keep, remove any ElizaOS imports
- `cli/doctor.ts` — keep structure, replace `sendMessage()` calls
- `cli/init.ts` — keep structure, replace `sendMessage()` calls
- `cli/deploy.ts` — keep structure, replace `sendMessage()` calls
- `cli/index.ts` — keep, remove preflight Socket.IO check

## What to build: `cli/lib/llm.ts`

Create a new LLM client that talks directly to Groq. Requirements:

```typescript
// Two models — route by task
const SMALL_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"; // classify, explain, short answers
const LARGE_MODEL = "qwen/qwen3-32b"; // codegen, scaffold, complex diagnosis

type Task = "classify" | "explain" | "generate" | "diagnose" | "chat";

// Core function — streaming for generate tasks, regular for others
async function ask(
  prompt: string,
  task: Task,
  systemPrompt?: string
): Promise<string>

// Streaming variant — yields chunks for real-time display
async function* askStream(
  prompt: string,
  task: Task,
  systemPrompt?: string
): AsyncGenerator<string>

// Multi-turn conversation support
interface Message { role: "user" | "assistant" | "system"; content: string; }
async function chat(messages: Message[], task: Task): Promise<string>
```

Model routing logic:
- `generate` → LARGE_MODEL
- `diagnose` → LARGE_MODEL  
- `classify` → SMALL_MODEL
- `explain` → SMALL_MODEL
- `chat` → SMALL_MODEL, upgrade to LARGE if message contains code generation intent

Groq endpoint: `https://api.groq.com/openai/v1` (OpenAI-compatible)
Auth: `process.env.GROQ_API_KEY`
Error handling: retry once on 429, throw with clean message on others.

## What to build: `cli/lib/agent.ts`

Replaces `client.ts`. Wraps `llm.ts` with fixd-specific context management.

```typescript
// Load system prompt from character JSON
function loadSystemPrompt(): string
// Takes characters/agent.character.json, extracts:
// - system field
// - bio array (join as paragraph)
// - style.all + style.chat rules
// Combines into one system prompt string

// Session-level conversation history
const history: Message[] = [];

// Send a message, get response — drop-in replacement for old sendMessage()
async function sendMessage(text: string): Promise<AgentResponse[]>

// Same interface as old client.ts AgentResponse
interface AgentResponse {
  text: string;
  actions?: string[];
}

// Reset conversation (new doctor/init session)
function resetSession(): void

// Health check — just verify GROQ_API_KEY exists and API responds
async function checkHealth(): Promise<boolean>
```

Conversation history rules:
- Keep last 20 messages max (sliding window)
- Always include system prompt as first message
- On `resetSession()`, clear history but keep system prompt

## Update `cli/index.ts`

Replace the `preflight()` function:
- Old: checks if ElizaOS Socket.IO server is reachable
- New: checks if `GROQ_API_KEY` is set in env, calls `checkHealth()` from `agent.ts`
- If key missing: print clear error "set GROQ_API_KEY in your .env" and exit

Remove:
- `getAgentId()` import
- Any Socket.IO or ElizaOS server references in status command

Update `fixd status` to show:
- Groq API reachable: yes/no
- Active model (small + large)
- Current project path

## Update `cli/doctor.ts`

Replace all `sendMessage()` calls — import from `./lib/agent.js` instead of `./lib/client.js`. Pass task type:

```typescript
// diagnosis explanation → task: "diagnose"
const diagResponse = await sendMessage(diagPrompt, "diagnose");

// fix summary → task: "explain"  
const fixSummary = await sendMessage(fixSummaryPrompt, "explain");

// interactive chat → task: "chat"
const responses = await sendMessage(userMessage, "chat");
```

Add direct diagnostics display BEFORE sending to agent (this is important — show tsc errors
immediately from local runner, don't wait for LLM):

After `runDiagnostics()` resolves, iterate `diagResults` and print directly to terminal using
existing display functions (`success`, `warn`, `info`). Show file:line:col:code for each error.
This gives instant feedback regardless of LLM speed.

## Update `cli/init.ts`

Replace `sendMessage()` import. Add streaming for scaffold generation:

```typescript
// use askStream for file generation — show output as it arrives
for await (const chunk of askStream(scaffoldPrompt, "generate")) {
  process.stdout.write(chunk);
}
```

After streaming completes, parse the response for file blocks and write them to disk:
- Detect ```filename.ext ... ``` blocks in response
- Write each to `process.cwd()/${projectName}/filename.ext`
- Create directories as needed
- Run `git init && git add . && git commit -m "init: fixd scaffold"` after all files written

## Update `cli/deploy.ts`

Keep the Nosana deploy flow but replace agent call with direct structured prompt.
Do not add @nosana/kit yet — that's a separate task.

## Environment variables

Add to `.env.example`:
```env
# LLM
GROQ_API_KEY=your_key_here
SMALL_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
LARGE_MODEL=qwen/qwen3-32b

# Agent server (no longer needed after ElizaOS removal)
# FIXD_AGENT_URL=http://localhost:3000
```

## Package.json changes

Remove:
- `socket.io-client`
- `@elizaos/core`
- `@elizaos/plugin-bootstrap`
- `@elizaos/plugin-openai`
- `@elizaos/cli` (devDep)

Keep everything else. Add:
- No new deps needed — Groq uses native fetch (Node 18+)

## Do not touch
- `cli/lib/display.ts`
- `cli/lib/diagnostics.ts`
- `cli/lib/executor.ts`
- `src/actions/scanFiles.ts`
- `src/actions/executeCommand.ts`
- `src/actions/fixEnv.ts`
- `characters/agent.character.json`
- `Dockerfile`
- `nos_job_def/`

## Verification

After refactor, this should work with zero background processes:
```bash
# no elizaos dev needed
bun fixd status   # shows groq connected
bun fixd doctor   # full flow, direct groq calls
```

The old flow was: CLI → Socket.IO → ElizaOS server → Ollama
The new flow is:  CLI → Groq API (direct)
```