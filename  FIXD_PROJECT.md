# fixd — AI Implementation Handoff Document
> This document gives a new AI assistant complete context to continue building fixd exactly where we left off. Read everything before writing a single line of code.

---
RULE: before writing any code refer to these docs https://docs.elizaos.ai/llms-full.txt and make sure you've written them according to the docs.
## What is fixd?

`fixd` is a multi-agent CLI developer tool built on **ElizaOS v2** for the **Nosana x ElizaOS Agent Challenge (Builders Challenge #4)**. It runs entirely from the user's terminal — no browser, no web UI. It handles everything *around* your code: broken environments, project scaffolding, and deployment to Nosana's GPU network.

**Three commands:**
```bash
fixd init      # scaffold a new project through conversation
fixd doctor    # diagnose, fix, and chat about a broken project
fixd deploy    # containerize and ship to Nosana GPU network
```

**Why it wins the hackathon:**
- Solves a real developer pain point (config hell, broken envs, boilerplate setup)
- Multi-agent architecture showcases ElizaOS v2 properly
- Terminal-native — developer never leaves their IDE
- OpenClaw aligned — code and credentials never leave the machine
- Nosana integration is natural (LLM on Nosana GPU, deploy to Nosana)
- 60-second demo arc is visceral and clear

---

## Hackathon Details

- **Challenge:** Nosana x ElizaOS Agent Challenge — Builders Challenge #4
- **Deadline:** April 14, 2026
- **Prize pool:** $3,000 USDC — top 10 submissions
  - 1st: $1,000 | 2nd: $750 | 3rd: $450 | 4th: $200 | 5th–10th: $100
- **Submission platform:** SuperTeam Builders Challenge Page
- **Required repos to star:** agent-challenge, nosana-programs, nosana-kit, nosana-cli
- **Framework:** ElizaOS v2
- **Model:** Qwen3.5-27B-AWQ-4bit (Nosana-hosted, switching from local Ollama when API key arrives), currentlly the project uses llama3:8b and nomic-embed-text:latest models running locally

**Judging criteria:**
| Criterion | Weight |
|---|---|
| Technical implementation | 25% |
| Nosana integration depth | 25% |
| Usefulness & UX | 25% |
| Creativity & originality | 15% |
| Documentation | 10% |

---

## Developer Context

- Solo participant
- Mac M2
- Backend dev, comfortable with frontend
- Comfortable with Docker and TypeScript
- Has Solana/Web3 experience
- Currently using local Ollama: `llama3:8b` + `nomic-embed-text:latest`
- Will switch to Nosana Qwen endpoint when API key arrives from team
- Package manager: bun
- Running: Node v24.6.0

---

## Current .env (local dev)

```env
OPENAI_API_KEY=ollama
OPENAI_API_URL=http://127.0.0.1:11434/v1
MODEL_NAME=llama3:8b
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_SMALL_MODEL=llama3:8b
OPENAI_LARGE_MODEL=llama3:8b
OPENAI_IMAGE_DESCRIPTION_MODEL=llama3:8b
SKIP_EMBEDDINGS=true
SERVER_PORT=3000
```

When Nosana API key arrives, switch to:
```env
OPENAI_API_KEY=nosana
OPENAI_API_URL=https://6vq2bcqphcansrs9b88ztxfs88oqy7etah2ugudytv2x.node.k8s.prd.nos.ci/v1
MODEL_NAME=Qwen3.5-27B-AWQ-4bit
OPENAI_EMBEDDING_URL=https://4yiccatpyxx773jtewo5ccwhw1s2hezq5pehndb6fcfq.node.k8s.prd.nos.ci/v1
OPENAI_EMBEDDING_API_KEY=nosana
OPENAI_EMBEDDING_MODEL=Qwen3-Embedding-0.6B
OPENAI_EMBEDDING_DIMENSIONS=1024
SERVER_PORT=3000
```

---

## Project Structure (current state)

```
agent-challenge/
├── characters/
│   └── agent.character.json        # fixd agent character — needs update (see below)
├── src/
│   ├── index.ts                    # ✅ DONE — ElizaOS plugin with SCAN_PROJECT + KILL_PORT actions
│   └── actions/
│       ├── executeCommand.ts       # ✅ DONE — safe shell exec wrapper
│       ├── scanFiles.ts            # ✅ DONE — project scanner
│       ├── diagnose.ts             # ❌ NOT WRITTEN
│       ├── fixEnv.ts               # ❌ NOT WRITTEN
│       └── nosanaDeploy.ts         # ❌ NOT WRITTEN
├── cli/
│   ├── index.ts                    # ✅ DONE — CLI entrypoint (fixd <command>)
│   ├── doctor.ts                   # ✅ DONE — fixd doctor command
│   ├── init.ts                     # ✅ DONE — fixd init command
│   ├── deploy.ts                   # ✅ DONE — fixd deploy command
│   └── lib/
│       ├── client.ts               # ⚠️ PARTIALLY DONE — needs Socket.IO rewrite (see below)
│       └── display.ts              # ✅ DONE — terminal formatting
├── nos_job_def/
│   └── nosana_eliza_job_definition.json  # needs image name updated before submission
├── Dockerfile                      # ✅ works — node:23-slim, pnpm
├── FIXD_PROJECT.md                 # full spec + checklist
├── .env                            # local dev config
└── package.json                    # needs socket.io-client added
```

---

## What's Working Right Now

1. `elizaos dev` runs successfully with the fixd agent
2. `bun fixd status` works — finds the agent, prints ID and URL
3. `bun fixd doctor` fails at the messaging step (Socket.IO rewrite needed — see below)
4. The ElizaOS plugin (`src/index.ts`) has SCAN_PROJECT and KILL_PORT actions registered

---

## Critical Issue: Socket.IO Messaging (the only blocker right now)

### What we discovered

ElizaOS v2 uses **Socket.IO** for real-time messaging, NOT the REST `POST /api/messaging/submit` endpoint. That REST endpoint is for agents posting to channels they're already in — not for external CLI clients.

The correct architecture:
1. Connect to `http://localhost:3000` via Socket.IO
2. Join a real existing room (emit `type: 1, ROOM_JOINING`)
3. Send messages via `socket.emit('message', { type: 2, payload: {...} })`
4. Receive responses via `socket.on('messageBroadcast', ...)`
5. Listen for `messageComplete` to know when agent is done

### Real room IDs (discovered via API)

The active Eliza agent (`54334a5c-cbd8-0f1f-a083-f5d48d8a7b82`) has these real socketio rooms:

```
channelId: 36240841-4728-4dde-a62a-5dcec982b014  (source: socketio, type: GROUP)
channelId: bc6f85f5-0b33-42be-83e0-008d67861360  (source: socketio, type: GROUP)
channelId: e9296cd6-5e39-420f-a04a-ce57ea7cf5e2  (source: socketio, type: GROUP)
... (several more)
```

These are real rows in `central_channels` table. The fake UUID `000...001` we were using doesn't exist, hence the DB foreign key error.

### The fixd agent issue

The fixd agent (`ddb6a79a-72ca-0c3e-9b5d-2e45385e453a`) shows `"status": "inactive"` in the API. This means it's not properly started. For now, the CLI uses the **active Eliza agent** (`54334a5c`) by finding the first active agent. The fixd character config needs fixing (see below).

---

## Complete Rewrite Required: `cli/lib/client.ts` (this is already done, dont waste token by re-pasting this, check first then implement changes)

Replace the entire file with this Socket.IO-based implementation:

```typescript
import { randomUUID } from "crypto";
import { io, Socket } from "socket.io-client";

const BASE_URL = process.env.FIXD_AGENT_URL ?? "http://localhost:3000";

const CLI_ENTITY_ID  = "00000000-0000-0000-0000-000000000099";
const CLI_SENDER_NAME = "fixd-cli";

let _agentId: string | null = null;
let _roomId:  string | null = null;
let _socket:  Socket | null = null;

export async function getAgentId(): Promise<string> {
  if (_agentId) return _agentId;

  const res  = await fetch(`${BASE_URL}/api/agents`);
  if (!res.ok) throw new Error(`Cannot reach fixd agent at ${BASE_URL}`);

  const data   = await res.json();
  const agents = data?.data?.agents ?? data?.agents ?? data ?? [];

  if (!agents.length) throw new Error("No agents found. Is `elizaos dev` running?");

  const agent =
    agents.find((a: any) => a.name?.toLowerCase() === "fixd"          && a.status === "active") ??
    agents.find((a: any) => a.characterName?.toLowerCase() === "fixd" && a.status === "active") ??
    agents.find((a: any) => a.status === "active") ??
    agents[0];

  _agentId = agent.id;
  return _agentId!;
}

async function getRoomId(agentId: string): Promise<string> {
  if (_roomId) return _roomId;

  const res = await fetch(`${BASE_URL}/api/agents/${agentId}/rooms`);
  if (!res.ok) throw new Error("Could not fetch agent rooms");

  const data  = await res.json();
  const rooms: any[] = data?.data?.rooms ?? data?.rooms ?? [];

  if (!rooms.length) {
    throw new Error(
      "Agent has no rooms yet.\n" +
      "  Fix: open http://localhost:3000 in your browser and send one message.\n" +
      "  This creates a real room. Then retry fixd."
    );
  }

  // prefer a socketio GROUP room (not the SELF room)
  const room =
    rooms.find((r: any) => r.source === "socketio" && r.type === "GROUP") ??
    rooms.find((r: any) => r.source === "socketio") ??
    rooms[0];

  _roomId = room.channelId ?? room.id;
  return _roomId!;
}

async function getSocket(): Promise<Socket> {
  if (_socket?.connected) return _socket;

  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    const connectTimeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket.IO connection timed out after 10s"));
    }, 10000);

    socket.on("connect", () => {
      clearTimeout(connectTimeout);
      _socket = socket;
      resolve(socket);
    });

    socket.on("connect_error", (err) => {
      clearTimeout(connectTimeout);
      reject(new Error(`Socket.IO connection failed: ${err.message}`));
    });
  });
}

export interface AgentResponse {
  text: string;
  actions?: string[];
}

export async function sendMessage(text: string): Promise<AgentResponse[]> {
  const agentId = await getAgentId();
  const roomId  = await getRoomId(agentId);
  const socket  = await getSocket();

  // join the room first — required to receive broadcasts
  socket.emit("message", {
    type: 1, // ROOM_JOINING
    payload: { roomId, entityId: CLI_ENTITY_ID },
  });

  await sleep(300); // let join propagate

  return new Promise((resolve, reject) => {
    const responses: AgentResponse[] = [];

    const timeout = setTimeout(() => {
      socket.off("messageBroadcast", onBroadcast);
      if (responses.length > 0) resolve(responses);
      else reject(new Error("Agent did not respond in time. Is the model loaded?"));
    }, 90_000);

    socket.once("messageComplete", () => {
      clearTimeout(timeout);
      socket.off("messageBroadcast", onBroadcast);
      resolve(responses.length > 0 ? responses : [{ text: "(agent sent no text response)" }]);
    });

    const onBroadcast = (data: any) => {
      const msgRoomId = data.roomId ?? data.channelId;
      if (msgRoomId !== roomId) return;
      if (data.senderId === CLI_ENTITY_ID) return; // skip own echo

      const text = data.text ?? data.content ?? "";
      if (text) responses.push({ text, actions: data.actions ?? [] });
    };

    socket.on("messageBroadcast", onBroadcast);

    socket.emit("message", {
      type: 2, // SEND_MESSAGE
      payload: {
        senderId:    CLI_ENTITY_ID,
        senderName:  CLI_SENDER_NAME,
        message:     text,
        roomId,
        messageId:   randomUUID(),
        source:      "cli",
        attachments: [],
        metadata:    { cwd: process.cwd() },
      },
    });
  });
}

export function disconnect() {
  _socket?.disconnect();
  _socket = null;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${BASE_URL}/api/agents`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
```

**Install socket.io-client:**
```bash
pnpm add socket.io-client
```

**Add `disconnect()` calls** at the end of `cli/doctor.ts`, `cli/init.ts`, `cli/deploy.ts`:
```typescript
import { disconnect } from "./lib/client.js";
// add at very end of each run function, after bye():
disconnect();
```

---


## ElizaOS API Reference (what we learned the hard way)
use https://docs.elizaos.ai/llms-full.txt docs for additional info.
### Agents endpoint
```
GET /api/agents
Response: { success: true, data: { agents: [{ id, name, characterName, status }] } }
```

### Agent rooms
```
GET /api/agents/:agentId/rooms
Response: { success: true, data: { rooms: [{ id, channelId, messageServerId, source, type }] } }
```

### Messaging — Socket.IO (correct approach)
```javascript
// Connect
const socket = io("http://localhost:3000", { transports: ["polling", "websocket"] });

// Join room (required before receiving)
socket.emit("message", { type: 1, payload: { roomId, entityId } });

// Send message
socket.emit("message", {
  type: 2,
  payload: { senderId, senderName, message, roomId, messageId, source, attachments, metadata }
});

// Receive
socket.on("messageBroadcast", (data) => { /* data.text, data.roomId */ });
socket.on("messageComplete", () => { /* agent done */ });
```

### REST messaging/submit (DO NOT USE for CLI)
The `POST /api/messaging/submit` endpoint requires the `channel_id` to already exist as a real row in `central_channels`. It's meant for agents posting back to channels they're already part of — not for external clients initiating conversations.

### Message types enum
```
1 = ROOM_JOINING
2 = SEND_MESSAGE
3 = MESSAGE (generic)
4 = ACK
5 = THINKING
6 = CONTROL
```

---

## Existing Code (complete, do not rewrite)

### `src/actions/executeCommand.ts` — safe shell execution
```typescript
import { execa, ExecaError } from "execa";

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

const BLOCKED_COMMANDS = [
  "rm -rf /", "dd if=", "mkfs", ":(){ :|:& };:", "> /dev/sda", "chmod -R 777 /",
];

function isSafeCommand(command: string): boolean {
  const lower = command.toLowerCase().trim();
  return !BLOCKED_COMMANDS.some((blocked) => lower.includes(blocked));
}

export async function executeCommand(
  command: string,
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<CommandResult> {
  const { cwd = process.cwd(), timeoutMs = 30_000, env = {} } = options;

  if (!isSafeCommand(command)) {
    return { success: false, stdout: "", stderr: `Blocked: "${command}" is not permitted.`, exitCode: 1, command };
  }

  try {
    const result = await execa("sh", ["-c", command], {
      cwd, timeout: timeoutMs, env: { ...process.env, ...env }, reject: false, all: true,
    });
    return { success: result.exitCode === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 1, command };
  } catch (err) {
    const e = err as ExecaError;
    return { success: false, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? e.message ?? "Unknown error", exitCode: e.exitCode ?? 1, command };
  }
}

export async function killPort(port: number): Promise<CommandResult> {
  const findPid = await executeCommand(`lsof -ti tcp:${port}`);
  if (!findPid.success || !findPid.stdout.trim()) {
    return { success: false, stdout: "", stderr: `No process found on port ${port}`, exitCode: 1, command: `killPort(${port})` };
  }
  return executeCommand(`kill -9 ${findPid.stdout.trim()}`);
}

export async function getRuntimeVersion(): Promise<{ node: string | null; bun: string | null }> {
  const [n, b] = await Promise.all([executeCommand("node --version"), executeCommand("bun --version")]);
  return { node: n.success ? n.stdout.trim() : null, bun: b.success ? b.stdout.trim() : null };
}
```

### `src/actions/scanFiles.ts` — project scanner
```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { executeCommand } from "./executeCommand.js";

export interface PortInfo { port: number; pid: number; process: string; }
export interface PrismaInfo { found: boolean; provider: string | null; connectionType: "pooled" | "direct" | "unknown" | null; hasDirectUrl: boolean; rawSchema: string | null; }
export interface EnvInfo { vars: Record<string, string>; missing: string[]; raw: string | null; }
export interface ProjectScan {
  projectPath: string; packageJson: Record<string, any> | null; tsconfig: Record<string, any> | null;
  env: EnvInfo; prisma: PrismaInfo; dockerCompose: Record<string, any> | null;
  runningPorts: PortInfo[]; nodeVersion: string | null; bunVersion: string | null;
  requiredNodeVersion: string | null; detectedPackageManager: "pnpm" | "bun" | "npm" | "yarn" | "unknown";
  errors: string[];
}

async function readJsonFile(p: string): Promise<Record<string, any> | null> {
  try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return null; }
}
async function readTextFile(p: string): Promise<string | null> {
  try { return await fs.readFile(p, "utf-8"); } catch { return null; }
}

function parseEnvFile(raw: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (k) r[k] = v;
  }
  return r;
}

function detectConnectionType(url: string): "pooled" | "direct" | "unknown" {
  if (!url) return "unknown";
  if (url.includes("pooler.") || url.includes("-pooler.")) return "pooled";
  if (url.includes(":6543")) return "pooled";
  return "direct";
}

function parsePrismaSchema(schema: string): PrismaInfo & { _urlEnvKey?: string } {
  return {
    found: true,
    provider: schema.match(/provider\s*=\s*["']([^"']+)["']/)?.[1] ?? null,
    connectionType: "unknown",
    hasDirectUrl: !!schema.match(/directUrl\s*=\s*env\(/),
    rawSchema: schema,
    _urlEnvKey: schema.match(/url\s*=\s*env\(["']([^"']+)["']\)/)?.[1],
  };
}

async function scanPorts(cwd: string): Promise<PortInfo[]> {
  const r = await executeCommand("lsof -iTCP -sTCP:LISTEN -n -P | tail -n +2", { cwd });
  if (!r.success || !r.stdout.trim()) return [];
  return r.stdout.split("\n").flatMap(line => {
    const p = line.trim().split(/\s+/);
    if (p.length < 9) return [];
    const m = p[8].match(/:(\d+)$/);
    const pid = parseInt(p[1], 10);
    if (!m || isNaN(pid)) return [];
    return [{ port: parseInt(m[1], 10), pid, process: p[0] }];
  });
}

function detectPM(files: string[]): "pnpm" | "bun" | "npm" | "yarn" | "unknown" {
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("package-lock.json")) return "npm";
  return "unknown";
}

export async function scanProject(projectPath: string): Promise<ProjectScan> {
  const errors: string[] = [];
  let topLevel: string[] = [];
  try { topLevel = await fs.readdir(projectPath); } catch (e) { errors.push(`Cannot read dir: ${(e as Error).message}`); }

  const [pkg, tsconfig, envRaw, prismaRaw, dcYml, dcYaml] = await Promise.all([
    readJsonFile(path.join(projectPath, "package.json")),
    readJsonFile(path.join(projectPath, "tsconfig.json")),
    readTextFile(path.join(projectPath, ".env")),
    readTextFile(path.join(projectPath, "prisma", "schema.prisma")),
    readTextFile(path.join(projectPath, "docker-compose.yml")),
    readTextFile(path.join(projectPath, "docker-compose.yaml")),
  ]);

  const envVars = envRaw ? parseEnvFile(envRaw) : {};
  const missingEnvKeys = prismaRaw ? ["DATABASE_URL"].filter(k => !envVars[k]) : [];

  let prisma: PrismaInfo = { found: false, provider: null, connectionType: null, hasDirectUrl: false, rawSchema: null };
  if (prismaRaw) {
    const parsed = parsePrismaSchema(prismaRaw);
    if (parsed._urlEnvKey && envVars[parsed._urlEnvKey]) parsed.connectionType = detectConnectionType(envVars[parsed._urlEnvKey]);
    const { _urlEnvKey: _, ...clean } = parsed;
    prisma = clean;
  }

  let runningPorts: PortInfo[] = [];
  try { runningPorts = await scanPorts(projectPath); } catch (e) { errors.push(`Port scan failed: ${(e as Error).message}`); }

  const [nv, bv] = await Promise.all([executeCommand("node --version", { cwd: projectPath }), executeCommand("bun --version", { cwd: projectPath })]);

  return {
    projectPath, packageJson: pkg, tsconfig,
    env: { vars: envVars, missing: missingEnvKeys, raw: envRaw },
    prisma,
    dockerCompose: (dcYml ?? dcYaml) ? { raw: dcYml ?? dcYaml } : null,
    runningPorts,
    nodeVersion: nv.success ? nv.stdout.trim() : null,
    bunVersion: bv.success ? bv.stdout.trim() : null,
    requiredNodeVersion: pkg?.engines?.node ?? null,
    detectedPackageManager: detectPM(topLevel),
    errors,
  };
}
```

### `src/index.ts` — ElizaOS plugin
```typescript
import { type Plugin, type Action, type IAgentRuntime, type Memory, type State, type HandlerCallback } from "@elizaos/core";
import { scanProject, type ProjectScan } from "./actions/scanFiles.js";
import { killPort } from "./actions/executeCommand.js";
import path from "node:path";

function formatScanForLLM(scan: ProjectScan): string {
  return [
    "PROJECT SCAN RESULTS", "====================",
    `Path: ${scan.projectPath}`,
    `Package manager: ${scan.detectedPackageManager}`,
    `Node: ${scan.nodeVersion ?? "not found"} | Bun: ${scan.bunVersion ?? "not found"} | Required: ${scan.requiredNodeVersion ?? "unspecified"}`,
    "",
    "PACKAGE.JSON:",
    scan.packageJson
      ? `  name: ${scan.packageJson.name}\n  scripts: ${JSON.stringify(scan.packageJson.scripts ?? {})}\n  deps: ${Object.keys(scan.packageJson.dependencies ?? {}).join(", ")}`
      : "  not found",
    "",
    `TSCONFIG: ${scan.tsconfig ? "found" : "not found"}`,
    "",
    "ENV:", `  keys: ${Object.keys(scan.env.vars).join(", ") || "none"}`, `  missing: ${scan.env.missing.join(", ") || "none"}`,
    "",
    "PRISMA:", scan.prisma.found
      ? `  provider: ${scan.prisma.provider} | connection: ${scan.prisma.connectionType} | directUrl: ${scan.prisma.hasDirectUrl}`
      : "  not found",
    "",
    "RUNNING PORTS:",
    scan.runningPorts.length > 0 ? scan.runningPorts.map(p => `  ${p.port} → PID ${p.pid} (${p.process})`).join("\n") : "  none",
    "",
    "ERRORS:", scan.errors.length > 0 ? scan.errors.map(e => `  - ${e}`).join("\n") : "  none",
  ].join("\n");
}

const scanProjectAction: Action = {
  name: "SCAN_PROJECT",
  description: "Scans a project directory and returns a structured snapshot of configs, env vars, ports, and runtime info. Use before diagnosing or fixing any issues.",
  similes: ["SCAN", "ANALYSE_PROJECT", "ANALYZE_PROJECT", "CHECK_PROJECT", "INSPECT_PROJECT", "DOCTOR", "DIAGNOSE"],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message?.content?.text ?? "";
    return ["scan", "analyse", "analyze", "check", "inspect", "doctor", "diagnose", "fix", "broken", "won't start", "not working", "error"].some(t => text.toLowerCase().includes(t));
  },
  handler: async (_runtime: IAgentRuntime, message: Memory, _state: State, _options: unknown, callback: HandlerCallback) => {
    const text = message?.content?.text ?? "";
    const pathMatch = text.match(/(?:path|directory|folder|at|in)\s+([^\s]+)/i);
    const projectPath = pathMatch?.[1] ? path.resolve(pathMatch[1]) : process.env.PROJECT_PATH ?? "/project";

    await callback({ text: `Scanning project at \`${projectPath}\`...`, actions: ["SCAN_PROJECT"] });
    const scan = await scanProject(projectPath);
    await _runtime.setCache("last_project_scan", JSON.stringify(scan));
    await callback({ text: `Scan complete:\n\n\`\`\`\n${formatScanForLLM(scan)}\n\`\`\`\n\nWant me to diagnose and fix these issues?`, actions: ["SCAN_PROJECT"] });
    return true;
  },
  examples: [
    [{ user: "user", content: { text: "scan my project" } }, { user: "fixd", content: { text: "Scanning...", actions: ["SCAN_PROJECT"] } }],
    [{ user: "user", content: { text: "my app won't start" } }, { user: "fixd", content: { text: "Scanning project...", actions: ["SCAN_PROJECT"] } }],
  ],
};

const killPortAction: Action = {
  name: "KILL_PORT",
  description: "Kills the process occupying a specific port.",
  similes: ["FREE_PORT", "CLEAR_PORT", "RELEASE_PORT"],
  validate: async (_runtime: IAgentRuntime, message: Memory) => /port\s+\d+|kill\s+\d+|free\s+port/i.test(message?.content?.text ?? ""),
  handler: async (_runtime: IAgentRuntime, message: Memory, _state: State, _options: unknown, callback: HandlerCallback) => {
    const text = message?.content?.text ?? "";
    const portMatch = text.match(/\b(\d{2,5})\b/);
    if (!portMatch) { await callback({ text: "Which port should I kill?" }); return false; }
    const port = parseInt(portMatch[1], 10);
    await callback({ text: `Killing process on port ${port}...` });
    const result = await killPort(port);
    await callback({ text: result.success ? `Done. Port ${port} is free.` : `Couldn't kill port ${port}: ${result.stderr}` });
    return result.success;
  },
  examples: [[{ user: "user", content: { text: "kill port 3000" } }, { user: "fixd", content: { text: "Killing process on port 3000..." } }]],
};

export const customPlugin: Plugin = {
  name: "fixd-plugin",
  description: "fixd — dev environment agent. Scan, diagnose, fix, scaffold, and deploy.",
  actions: [scanProjectAction, killPortAction],
  providers: [],
  evaluators: [],
};

export default customPlugin;
```

---

## What Needs to Be Built Next (in order)

### Step 1: Fix Socket.IO client (IMMEDIATE — unblocks everything)
- Replace `cli/lib/client.ts` with the Socket.IO implementation above
- Run `pnpm add socket.io-client`
- Add `disconnect()` calls to end of doctor/init/deploy commands
- Test: `bun fixd doctor` — should now connect and get a response

### Step 2: Fix agent character
- Update `characters/agent.character.json` with the JSON above
- Restart `elizaos dev`
- Verify fixd agent shows `active` in API response

### Step 3: Write `src/actions/diagnose.ts`

This action reads the cached scan from ElizaOS runtime memory and produces structured issues:

```typescript
// Interface
interface Issue {
  severity: "HIGH" | "MEDIUM" | "LOW";
  type: string;           // e.g. "PRISMA_POOLED_CONNECTION"
  description: string;    // plain English
  fixable: boolean;
  fixHint: string;        // what fix agent should do
}

// The action:
// 1. Read _runtime.getCache("last_project_scan") → parse as ProjectScan
// 2. Build a structured diagnosis prompt with the scan data
// 3. Call LLM to identify issues and return typed Issue[]
// 4. Store result in _runtime.setCache("last_diagnosis", JSON.stringify(issues))
// 5. Return formatted issue list to user

// Known issues to detect (hardcode detection logic + let LLM explain):
// - PRISMA_POOLED_CONNECTION: DATABASE_URL uses pooler endpoint without directUrl
// - PORT_CONFLICT: a common dev port (3000, 5432, 5173) is occupied
// - MISSING_ENV_KEY: required env key not present
// - NODE_VERSION_MISMATCH: running node X, package.json requires Y
// - TSCONFIG_STRICT_MISSING: no strict mode in tsconfig
// - MISSING_SCRIPTS: no dev/build/start scripts in package.json
```

### Step 4: Write `src/actions/fixEnv.ts`

Hardcoded fixers for common issues. Each fixer:
1. Reads the current file
2. Applies the specific change
3. Writes atomically
4. Returns a diff string showing what changed

```typescript
// Fixers to implement:
// fixPrismaPooledConnection(envPath, envVars) → adds directUrl to .env
// killZombiePort(port) → calls executeCommand killPort
// addMissingEnvKey(envPath, key, value) → appends to .env
// fixTsconfigStrict(tsconfigPath) → adds "strict": true
```

### Step 5: Write `src/actions/nosanaDeploy.ts`

```typescript
import { createNosanaClient } from '@nosana/kit';

// Flow:
// 1. Read ~/.nosana/ for API key OR prompt user once
// 2. Detect project type (Next.js, Hono, Express, etc.)
// 3. Generate appropriate Dockerfile
// 4. client.api.markets.list() → filter by VRAM, sort by price_per_hour_usd
// 5. client.ipfs.add(jobDefinition) → get IPFS hash
// 6. client.api.jobs.list({ ipfsHash, market }) → post job
// 7. Poll client.api.jobs.get(jobAddress) every 5s → stream status
// 8. Return deployment URL when state === "running"

// Nosana API (already confirmed working):
// GET /api/agents → { success, data: { agents: [...] } }
// markets: name, address, gpu, vram, price_per_hour_usd
// job states: pending | running | completed | failed | stopped
```

### Step 6: Wire up diagnose + fix actions to ElizaOS plugin

Add `DIAGNOSE_PROJECT` and `FIX_ISSUES` actions to `src/index.ts`:

```typescript
// DIAGNOSE_PROJECT action:
// - similes: ["DIAGNOSE", "FIND_ISSUES", "WHAT'S_WRONG"]
// - reads cached scan, calls diagnose.ts, returns issue list

// FIX_ISSUES action:
// - similes: ["FIX", "REPAIR", "APPLY_FIX"]
// - reads cached diagnosis, calls fixers, returns diffs
// - IMPORTANT: always show changes before executing, ask confirmation
```

### Step 7: `fixd init` scaffolding agent

The init command is mostly done in `cli/init.ts` — it collects stack info and sends it to the agent. What's missing is the **agent-side handling** — an `INIT_PROJECT` ElizaOS action that:

1. Parses the stack from the message
2. Generates all files based on the choices
3. Knows the cross-config rules:
   - Neon + Prisma: needs `?sslmode=require` in DATABASE_URL + separate `directUrl` for migrations
   - Hono on Bun: entry point is `Bun.serve()` not `app.listen()`
   - better-auth + Next.js: needs `auth.ts` config + middleware.ts
4. Writes files to the specified directory
5. Runs `git init && git add . && git commit -m "init: fixd scaffold"`

### Step 8: Docker + Nosana deployment

The agent itself needs to be deployed to Nosana:

1. Update `nos_job_def/nosana_eliza_job_definition.json`:
```json
{
  "ops": [{
    "id": "fixd-agent",
    "type": "container/run",
    "args": {
      "image": "YOUR_DOCKERHUB_USERNAME/fixd:latest",
      "expose": 3000,
      "env": {
        "OPENAI_API_KEY": "nosana",
        "OPENAI_API_URL": "https://6vq2bcqphcansrs9b88ztxfs88oqy7etah2ugudytv2x.node.k8s.prd.nos.ci/v1",
        "MODEL_NAME": "Qwen3.5-27B-AWQ-4bit",
        "SERVER_PORT": "3000",
        "NODE_ENV": "production"
      }
    }
  }],
  "version": "0.1"
}
```

2. Build and push Docker image:
```bash
docker build -t YOUR_USERNAME/fixd:latest .
docker push YOUR_USERNAME/fixd:latest
```

3. Deploy via Nosana dashboard at `deploy.nosana.com`

### Step 9: README + submission

Write `README.md` covering:
- What fixd is (1 paragraph)
- Prerequisites (Docker, Nosana account, Ollama or Nosana API key)
- Setup (`git clone`, `.env` config, `elizaos dev`)
- Usage (all three commands with examples)
- How credentials work (never leave machine)
- Architecture overview

### Step 10: Demo video (60 seconds)

Script:
- **0:00** — show broken project: wrong DATABASE_URL, zombie port 3000, run `npm start` → it fails
- **0:10** — `bun fixd doctor` in terminal
- **0:18** — triage runs, shows 3 issues with severity badges
- **0:30** — fix executes: .env rewritten, port killed, diffs shown
- **0:42** — verify confirms boot
- **0:48** — `bun fixd deploy` → Nosana URL returned
- **0:58** — done

---

## Submission Checklist

- [ ] ElizaOS agent built with v2
- [ ] Custom CLI UI (terminal — counts as frontend)
- [ ] Deployed on Nosana GPU network (not traditional cloud)
- [ ] Docker container properly set up
- [ ] Public GitHub fork (must be public)
- [ ] Video demo under 1 minute
- [ ] Agent description ≤300 words
- [ ] Social media post with `#NosanaAgentChallenge` and `@nosana_ai`
- [ ] All 4 repos starred: agent-challenge, nosana-programs, nosana-kit, nosana-cli

---

## Package.json (current dependencies needed)

```json
{
  "name": "nosana-eliza-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "elizaos start --character ./characters/agent.character.json",
    "dev": "elizaos dev --character ./characters/agent.character.json",
    "fixd": "tsx cli/index.ts"
  },
  "bin": {
    "fixd": "./cli/index.ts"
  },
  "dependencies": {
    "@elizaos/core": "^1.0.0",
    "@elizaos/plugin-anthropic": "^1.5.12",
    "@elizaos/plugin-bootstrap": "^1.0.0",
    "@elizaos/plugin-openai": "^1.0.0",
    "@nosana/kit": "^1.0.0",
    "chalk": "^5.0.0",
    "chokidar": "^3.6.0",
    "dotenv": "^16.0.0",
    "execa": "^9.0.0",
    "inquirer": "^9.0.0",
    "ora": "^8.0.0",
    "socket.io-client": "^4.5.0"
  },
  "devDependencies": {
    "@elizaos/cli": "^1.0.0",
    "@types/inquirer": "^9.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

---

## Known Risks

| Risk | Mitigation |
|---|---|
| Socket.IO room ID changes between sessions | Fetch fresh room ID on every CLI startup — never cache across sessions |
| Fix agent writes wrong content | Show diff before executing, ask for confirmation |
| LLM diagnosis is hallucinated | Display diagnosis to user before running any fixes |
| Nosana deploy fails | Graceful fallback: show generated Dockerfile + manual CLI instructions |
| Agent stays inactive | Make sure character.json name is exactly "fixd" and restart elizaos dev |
| llama3:8b too slow for complex diagnosis | Keep prompts tight, chunk large scan output |

---