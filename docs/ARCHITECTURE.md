# FIXD — Architecture

This document describes the internal architecture of FIXD. It is written
for developers who want to understand how the system works, contribute
code, or build tooling on top of FIXD's automation SDK.

For the design philosophy and tradeoffs, see [DESIGN.md](DESIGN.md).

## High-Level Architecture

```
┌──────────────────────────────────────────────────────┐
│                    fixd CLI                          │
│                 cli/index.ts                         │
│        (entry point · preflight · routing)           │
└──────────┬───────────────────┬──────────────────────┘
           │                   │
  ┌────────▼──────┐   ┌────────▼──────┐
  │  fixd doctor  │   │   fixd init   │
  │ cli/doctor.ts │   │  cli/init.ts  │
  └────────┬──────┘   └────────┬──────┘
           │                   │
  ┌────────▼───────────────────▼──────────────────────┐
  │                  cli/lib/                          │
  │  llm.ts          ← multi-provider LLM routing      │
  │  agent.ts        ← session state + system prompt   │
  │  sub-agents.ts   ← explore/diagnose/synthesize     │
  │  diagnostics.ts  ← stack detection + linting       │
  │  memory.ts       ← causal chain + stack patterns   │
  │  context7.ts     ← relevance-gated doc fetcher     │
  │  patcher.ts      ← atomic file patch + backup      │
  │  executor.ts     ← shell command extraction        │
  │  projectReader.ts← scored file relevance reader    │
  │  command-classifier.ts ← 3-stage safety check      │
  │  display.ts      ← terminal UI primitives          │
  │  versionCheck.ts ← cached npm update checks        │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌──────────────────────▼────────────────────────────┐
  │               src/actions/                         │
  │  scanFiles.ts  ← project scanner                   │
  │  fixEnv.ts     ← deterministic issue detector      │
  │  executeCommand.ts ← safe command execution        │
  └───────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────┐
  │               automation/                          │
  │  Internal SDK for programmatic FIXD execution      │
  │  build.ts · session.ts · run.ts · fixture.ts       │
  └───────────────────────────────────────────────────┘
```

## Layer Responsibilities

### CLI Layer (`cli/`)

Entry point and command implementations. Each command is lazy-loaded via
dynamic `import()` to minimize startup time.

| File | Responsibility |
|---|---|
| `index.ts` | Argument parsing, preflight checks, command routing, help text |
| `doctor.ts` | Diagnostic pipeline: scan → detect → explore → diagnose → synthesize → fix → verify → chat. Contains `agenticTurn()` recursive loop |
| `init.ts` | Interactive scaffolding: interview → plan → doc fetch → streaming generation → file write → git init → install → FIXD.md → memory warm-up |
| `config.ts` | XDG-compliant API key management (`~/.config/fixd/.env`) |
| `deploy.ts` | Dockerfile + docker-compose generation via LLM |
| `undo.ts` | Restore files from `.fixd/backups/` |
| `update.ts` | Self-update from npm registry |

### Library Layer (`cli/lib/`)

Stateless or session-scoped modules. Most functions are pure or have
clearly documented side effects.

| Module | Purpose |
|---|---|
| `llm.ts` | Endpoint-based LLM client. Routes requests through configurable endpoints (OpenAI-compatible, Anthropic, Gemini, Ollama) via compatibility adapters. Task-aware temperature/max_tokens. Network error retry with backoff. |
| `agent.ts` | Session context manager. Maintains conversation history, loads system prompt from `characters/agent.character.json`, injects memory + FIXD.md context, trims history by token budget (60k tokens). |
| `sub-agents.ts` | Stateless single-turn LLM workers. `exploreProject()` (2-pass iterative), `diagnoseWithAgent()`, `synthesizeDiagnosis()`, `planScaffold()`, `generateFixdMd()`. |
| `diagnostics.ts` | Stack-aware parallel linter runner. TypeScript, ESLint, Python (mypy/flake8), Rust, Go, Ruby, PHP, Java, Kotlin. Detects applicable checkers, runs in parallel, parses output into unified format. |
| `memory.ts` | Persistent project memory in `.fixd/memory.json`. Causal chain (30 entries), stack patterns (50 entries, confidence-scored), session summaries (10 entries), fixed issues (50 entries). Auto-gitignored. |
| `context7.ts` | Context7 API client with 24-hour disk cache. Relevance-gated: small-model classifier decides which libraries to fetch docs for. |
| `patcher.ts` | Parses agent responses for structured markers (`<<>>`, `<<>>`, `<<>>`, `<<>>`). Path traversal guard, atomic writes, backup-before-write, JSON-aware deep merge. |
| `executor.ts` | Extracts shell commands from agent responses. Executes with timeout, resolves local `node_modules/.bin/` paths, formats results for agent feedback. |
| `projectReader.ts` | Reads project files for agent context. Relevance scoring via small-model filter, always-read core files, keyword-driven candidate selection. |
| `command-classifier.ts` | 3-stage safety pipeline: always-confirm regex → hardcoded safe prefix sets → LLM classifier for ambiguous commands. |
| `display.ts` | Terminal UI: spinners (ora), color palette, markdown rendering, prompts, command approval UI. |
| `versionCheck.ts` | Cached 24-hour npm version check with semver comparison. |

### Actions Layer (`src/actions/`)

Deterministic, no-LLM operations. These run locally and are fast, free,
and reproducible.

| Module | Purpose |
|---|---|
| `scanFiles.ts` | Project scanner. Reads package.json, tsconfig.json, .env, Prisma schema, docker-compose. Detects package manager, scans ports via lsof. Never throws — errors collected in `errors[]`. |
| `fixEnv.ts` | Deterministic issue detector (7 issue types) and auto-fixers. Prisma directUrl fixer, tsconfig strict fixer, missing env key fixer, port conflict fixer, @types/node installer. |
| `executeCommand.ts` | Safe command execution via execa. Catastrophic pattern blocklist, timeout, output capture. Never throws — always returns structured `CommandResult`. |

### Automation SDK (`automation/`)

Internal SDK for programmatic FIXD execution. Used by Claude Code,
regression tests, CI, manual development, and future tooling.

| Module | Purpose |
|---|---|
| `build.ts` | Compile FIXD via `tsc`, return `BuildArtifact` |
| `session.ts` | Create/clean/list isolated test sessions with fixture-based workspaces |
| `run.ts` | Spawn FIXD in a session workspace, capture stdout/stderr/exitCode |
| `fixture.ts` | Enumerate available test fixture directories |
| `cli.ts` | `fixd-dev` CLI — thin wrapper around SDK functions |

Full documentation: [DEVELOPMENT.md](DEVELOPMENT.md) and
`.claude/adr/ADR-0001-internal-automation-layer.md`.

## End-to-End Request Lifecycle

### `fixd doctor`

```
1. ENV LOADING
   cli/index.ts loads .env from:
   ~/.config/fixd/.env → ~/.fixd/.env → <pkg>/../.env → <pkg>/../.env.local

2. PREFLIGHT
   Loads endpoint config from ~/.config/fixd/config.json.
   Auto-migrates legacy env vars if present.
   Validates at least one endpoint is configured and reachable.

3. PHASE 1 — LOCAL SCAN (deterministic, no LLM)
   scanProject() → ProjectScan (package.json, tsconfig, .env, prisma, ports)
   runDiagnostics() → parallel tsc/eslint/mypy/cargo/go vet execution
   Memory: updateFromScan() → saveMemory() (crash-safe checkpoint)

4. PHASE 2 — ISSUE DETECTION (deterministic, no LLM)
   detectIssues() → DetectedIssue[] (7 hardcoded issue types)
   TS2591 errors auto-promoted to MISSING_NODE_TYPES issue
   All issues displayed immediately (no LLM wait)

5. PHASE 3 — LLM ANALYSIS
   FAST MODE (--fast):
     Single sendMessage("diagnose") → renderDiagnosisResponse()

   FULL MODE:
     exploreProject() → ExploreResult (small model, 2-pass if low confidence)
     diagnoseWithAgent() → structured SEVERITY/TYPE/PROBLEM/FIX blocks
     synthesizeDiagnosis() → unified summary (dedup + severity escalation)
     primeContext() → injects synthesis into agent history

6. PHASE 4 — AUTO-FIX (deterministic, no LLM)
   Apply auto-fixable issues with user approval
   verify: re-scan + re-detect → confirm issues resolved
   sendMessage("explain") → brief summary of what was fixed

7. PHASE 5 — AGENTIC CHAT (LLM loop)
   Interactive loop with agenticTurn() recursion:
   ┌─ sendMessage(enrichedMessage, task)
   ├─ proposeAndApply() → parse patches, apply, backup
   ├─ computeFixOutcome() → before/after scan → FIXED/NO CHANGE/REGRESSION
   ├─ recordFix + recordStackPattern → in-memory mutation (saved at end)
   └─ recurse with outcome-routed message
      Depth 0-3: normal operation
      Depth 4: pressure message (2 attempts remaining)
      Depth 6: stuck report generated

8. CLEANUP
   summarizeSession() → saveMemory() (final save)
   disconnect()
```

### `fixd init`

```
1. INTERVIEW
   Interactive prompts: framework, database, host, ORM, auth, frontend, package manager
   Typo normalization (e.g., "hono" vs "Hono")

2. PLAN
   planScaffold() → file manifest, env vars, gotchas, post-install steps

3. DOC FETCH
   fetchDocsForStack() → Context7 live docs for chosen stack
   relevance-gated: only fetches docs for libraries used in the scaffold

4. GENERATE (streaming)
   askStream("generate") → tokens streamed to terminal in real time

5. WRITE
   proposeAndApply(autoApprove: true) → write all scaffolded files

6. SETUP
   git init + commit
   npm/bun install
   prisma generate (if Prisma selected)

7. MEMORY
   generateFixdMd() → writes FIXD.md for future doctor sessions
   Memory warm-up → initializes .fixd/memory.json with detected stack
```

## Agent Architecture

### System Prompt

Loaded from `characters/agent.character.json` at module init. Contains:
- System role definition
- Bio (concatenated into system prompt)
- Style rules (all + chat)
- Patch format instructions (`<<>>`, `<<>>` markers)

The system prompt is augmented at runtime with:
- `FIXD.md` content (project-specific context)
- Memory context (causal chain + stack patterns from `.fixd/memory.json`)
- Hypothesis rule (don't repeat failed fixes)

### Conversation State

Managed by `agent.ts`:
- `history: Message[]` — full conversation (system + user + assistant)
- Token budget: 60k tokens (240k chars at 4 chars/token)
- Trimmed from the oldest end — recent context is preserved
- Memory cache: loaded once per session, invalidated on project switch

### Agentic Turn Loop

The `agenticTurn()` function in `doctor.ts` is the core execution loop:

```
agenticTurn(message, projectRoot, depth, sessionState, ...)
  │
  ├─ depth >= 6? → generate stuck report, return
  ├─ depth === 4? → prepend pressure message
  ├─ depth > 0? → prepend hypothesis block
  │
  ├─ depth === 0? → readRelevantFiles() + Context7 doc fetch
  │
  ├─ sendMessage(enrichedMessage, task)
  │   │
  │   ├─ detect duplicate patches → skip if tried before
  │   ├─ proposeAndApply() → apply patches
  │   │
  │   ├─ patches applied?
  │   │   ├─ computeFixOutcome() → FIXED/NO CHANGE/REGRESSION
  │   │   ├─ mutate memory (causal entry + stack pattern)
  │   │   └─ recursive agenticTurn() with outcome-routed message
  │   │
  │   └─ no patches? → extract commands
  │       ├─ classifyCommand() → auto-run or confirm?
  │       ├─ runCommand() → capture result
  │       └─ recursive agenticTurn() with command result
  │
  └─ return (control back to chat loop)
```

### Session State

`SessionState` persists across recursive calls within a single chat session:

| Field | Purpose |
|---|---|
| `hypotheses: Hypothesis[]` | Every fix attempt: claim, file, outcome, issue counts |
| `triedFixes: Set<string>` | "filepath::searchString" keys — duplicate prevention |
| `currentDepth: number` | Current recursion depth (0-6) |
| `totalFixAttempts: number` | Cumulative fix count across all depths |
| `startTime: string` | Session start (for stuck report elapsed time) |

## Memory System

### Schema (`memory.ts`)

```typescript
interface ProjectMemory {
    projectRoot: string;
    lastScanned: string | null;
    fixedIssues: FixedIssue[];          // last 50
    knownStack: Partial<StackSnapshot>;
    chatSummaries: ChatSummary[];       // last 10
    userPreferences: Record<string, string>;
    causalChain: CausalEntry[];         // last 30
    stackPatterns: StackPattern[];      // up to 50
}
```

### Lifecycle

```
doctor session start
  → loadMemory() from .fixd/memory.json
  → formatMemoryForPrompt() injects causal chain + stack patterns into system prompt

Phase 1: scan → updateFromScan() → saveMemory() [checkpoint]

Phase 4: auto-fix → recordFix() [in-memory mutation]

Phase 5: each agenticTurn() patch batch
  → addCausalEntry() [in-memory mutation]
  → recordStackPattern() [in-memory mutation, confidence update]

Session end → summarizeSession() → saveMemory() [final persist]
```

### Confidence Dynamics

Stack patterns accumulate confidence with repeated success and decay with
failure:
- `confidence` starts at 0.5 on first occurrence
- Each success: confidence = min(1.0, confidence + 0.15)
- Each failure: confidence = max(0.1, confidence - 0.2)
- Patterns below 0.2 confidence are pruned after 10 failures

## LLM Routing

### Model Selection (`pickModel()`)

| Task | Model | Rationale |
|---|---|---|
| `classify` | Per config | Deterministic output, 512 token max |
| `explain` | Per config | Short summaries, 2048 token max |
| `generate` | Per config | Creative code generation, 8192 token max |
| `diagnose` | Per config | Precise technical analysis, 8192 token max |
| `chat` (first message) | Per config | Heuristic routing based on content |
| `chat` (follow-up) | Per config | Always uses configured chat endpoint when `userTurns > 1` |

### Task Parameters (`taskParams()`)

Each task type gets tuned temperature and max_tokens:

| Task | Temperature | Max Tokens |
|---|---|---|
| classify | 0.1 | 512 |
| explain | 0.5 | 2048 |
| generate | 0.7 | 8192 |
| diagnose | 0.3 | 8192 |
| chat | 0.7 | 4096 |

### Provider Fallback Chain

Each task routes to a specific endpoint + model pair configured by the
user in `~/.config/fixd/config.json`. If the endpoint fails, requests
are retried with backoff (3 retries for 429/5xx/network errors). Auth
errors throw immediately.

There is no automatic provider cascade. Users who want redundancy should
configure multiple endpoints and route tasks accordingly.

The `pickModel()` function remains as a hint for model size selection
but the actual endpoint + model is determined by the user's routing
config.

### Retry Behavior

- HTTP 429: exponential backoff (15s × attempt) or `retry-after` header
- HTTP 500/502/503/504: linear backoff (5s × attempt)
- Network errors (ECONNRESET, ETIMEDOUT, etc.): linear backoff (5s × attempt)
- Auth errors (401/403): throw immediately — won't self-resolve
- Max 3 retries per provider per call
- `sendMessage()` adds 1 additional top-level retry after 2s delay

## File Patch Pipeline

### Patch Markers

Agents communicate file operations via text markers in LLM responses:

| Marker | Operation |
|---|---|
| `<<>>` | Create or fully rewrite a file |
| `<<>>` | Targeted edit (preferred for small changes) |
| `<<>>` | Delete a file |
| `<<>>` | Rename/move a file |

### Processing Pipeline (`patcher.ts`)

```
1. PARSE: extract markers from agent response text via regex
2. VALIDATE: path traversal guard — reject paths escaping projectRoot
3. SEARCH: for EDIT operations, find exact SEARCH string in file
   → whitespace-normalized retry if exact match fails
4. REPLACE: construct new file content
5. BACKUP: copy original to .fixd/backups/<timestamp>/
6. WRITE: atomic write via .fixd.tmp → rename
7. RESULT: return PatchResult with { op, path, applied, diff }
```

### Safety Guarantees

- **Path traversal protection**: all paths validated to stay within `projectRoot`
- **Atomic writes**: `.fixd.tmp` → `rename` — partial writes never corrupt files
- **Backup-before-patch**: every modified file backed up to `.fixd/backups/`
- **Duplicate detection**: identical SEARCH strings blocked within same session
- **Whitespace retry**: if exact SEARCH fails, retry with whitespace normalization

## Safety Model

### Command Classification (3-stage)

```
Stage 1: ALWAYS-CONFIRM REGEX
  Matches: rm -rf, sudo, git reset --hard, eval, base64 decode,
           piped shell execution, chmod/chown, db drop/truncate
  → Always requires explicit user approval, regardless of auto-run level

Stage 2: SAFE PREFIX SETS
  conservative: ls, cat, grep, git status, tsc --noEmit, npm ls, ...
  moderate:    conservative + npm install, npx, bun, cargo build, ...
  aggressive:  moderate + git push, docker build, db migrate, ...
  → Auto-run if command starts with a known-safe prefix

Stage 3: LLM CLASSIFIER
  For commands not matching Stages 1-2
  → Small model classifies as "auto-run" or "confirm"
```

### File Operation Safety

- Path traversal guard: all patch paths validated against `projectRoot`
- Atomic writes: `.fixd.tmp` → `rename` prevents partial writes
- Backup-before-write: `.fixd/backups/<timestamp>/` for every modified file
- `fixd undo`: restores all files from most recent backup session atomically

### Memory Isolation

- `.fixd/memory.json` auto-gitignored (`.fixd/.gitignore` contains `*`)
- API keys stored in `~/.config/fixd/.env`, never in project directories
- No telemetry, no cloud sync, no external service dependencies

## Project Layout

```
fixd/
├── cli/                       # CLI commands (lazy-loaded)
│   ├── index.ts               # Entry point, arg parsing, preflight
│   ├── doctor.ts              # Doctor pipeline + agenticTurn loop
│   ├── init.ts                # Scaffolding interview + generation
│   ├── config.ts              # API key management
│   ├── deploy.ts              # Docker generation
│   ├── undo.ts                # Backup restoration
│   ├── update.ts              # Self-update
│   └── lib/                   # Shared library modules
│       ├── llm.ts             # Multi-provider LLM client
│       ├── agent.ts           # Session state + system prompt
│       ├── sub-agents.ts      # Stateless LLM workers
│       ├── diagnostics.ts     # Stack detection + linting
│       ├── memory.ts          # Persistent project memory
│       ├── context7.ts        # Live doc fetcher
│       ├── patcher.ts         # Patch marker parser + applier
│       ├── executor.ts        # Shell command extraction
│       ├── projectReader.ts   # File relevance reader
│       ├── command-classifier.ts  # 3-stage safety check
│       ├── display.ts         # Terminal UI
│       └── versionCheck.ts    # Cached update checker
├── src/actions/               # Deterministic, no-LLM operations
│   ├── scanFiles.ts           # Project scanner
│   ├── fixEnv.ts              # Issue detector + auto-fixers
│   └── executeCommand.ts      # Safe command execution
├── automation/                # Internal automation SDK
│   ├── index.ts               # Public API surface
│   ├── build.ts               # Build FIXD
│   ├── session.ts             # Isolated test sessions
│   ├── run.ts                 # Execute FIXD in session
│   ├── fixture.ts             # Test fixture management
│   └── cli.ts                 # fixd-dev CLI
├── characters/
│   └── agent.character.json   # Agent persona + system prompt
├── tests/
│   ├── unit/                  # Unit tests (10 files)
│   ├── integration/           # Integration tests (2 files)
│   ├── fixtures/              # Test fixtures (sample + broken)
│   └── helpers.ts             # Test utilities
├── docs/                      # Documentation
│   ├── ARCHITECTURE.md        # This file
│   ├── DESIGN.md              # Design philosophy + tradeoffs
│   ├── DEVELOPMENT.md         # Build, testing, automation SDK
│   ├── CONTRIBUTING.md        # Contribution guidelines
│   └── ROADMAP.md             # Planned features
├── scripts/                   # Shell scripts (legacy)
├── .claude/                   # Claude Code project context
│   └── adr/                   # Architectural Decision Records
└── testing/                   # External test infrastructure
    ├── fixtures/               # Integration test fixtures
    ├── sessions/               # Runtime test sessions
    └── .env                    # API keys for test runs
```

## Testing Strategy

### Unit Tests (`tests/unit/`)

10 test files covering all `cli/lib/` and `src/actions/` modules.
LLM calls mocked via `vi.mock()`. File operations use real temporary
directories under `os.tmpdir()`. 179 tests total.

### Integration Tests (`tests/integration/`)

- `agenticLoop.test.ts`: Tests the recursive agentic turn loop with
  mocked LLM responses, verifying hypothesis tracking, duplicate
  detection, outcome routing, and depth limits
- `deployFlow.test.ts`: Tests Dockerfile generation and deploy workflow
  with mocked execa

### Automation Layer Tests

The `automation/` SDK enables programmatic end-to-end testing:
- `fixd-dev build` — compile FIXD
- `fixd-dev session start --fixture <name>` — create isolated workspace
- `fixd-dev session run <id> -- <args>` — execute FIXD, capture output
- `fixd-dev session clean <id>` — clean up

### Test Fixtures

- `tests/fixtures/sample-project/`: Clean TypeScript + Prisma project
- `tests/fixtures/broken-project/`: Missing DATABASE_URL, no strict mode
- `testing/fixtures/broken-prisma/`: Prisma project without DATABASE_URL

## Important Design Decisions

See `.claude/adr/` for formal Architectural Decision Records (8 ADRs).
Key decisions documented there include:

- ADR-1: No framework for CLI (manual arg parsing)
- ADR-2: Structured markers instead of function calling
- ADR-3: Three-tier model routing (Groq/OpenRouter/Clarifai) — **superseded by ADR-0002**
- ADR-4: Deterministic scanning + LLM augmentation
- ADR-5: Recursive agentic loop with hard depth limit
- ADR-6: File-based IPC for agent communication
- ADR-7: Minimal dependencies (4 production deps)
- ADR-8: XDG-compliant config (`~/.config/fixd/.env`)

Additionally, documented in `.claude/CHANGELOG_AI.md`:

- P0-1: Follow-up chat turns always route to large model
- P0-2: Network error retry + 500/504 retry + sendMessage retry
- P0-3: Task-aware temperature and max_tokens routing
- P1-4: Promise.allSettled for independent file reads in scanFiles.ts
- P1-5: Batch memory persistence (in-memory accumulation)
- P1-6: Sub-agent parallelization rejected (data dependencies)

## Rejected Alternatives

| Proposal | Why Rejected |
|---|---|
| LangChain / AI framework | Adds dependency weight. FIXD's LLM calls are simple fetch() requests. |
| Web UI / dashboard | Violates terminal-first philosophy. Every feature works over SSH. |
| Agent server / daemon mode | Adds deployment complexity. Single process is simpler and sufficient. |
| Function calling (tool use) | Inconsistently supported across providers. Text markers work everywhere regardless of API compatibility. |
| YAML/TOML config | .env format is universally understood, requires zero parsing code. |
| Plugin system | Premature — 7 hardcoded issue types cover the most common problems. Add when demand exists. |
| Native binary (Bun compile) | npm global install works fine. Native binary adds build complexity. |
| Parallel sub-agents | Data dependencies make each stage consume the previous stage's output. Sequential is correct. |
