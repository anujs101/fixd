# FIXD — Architecture (v0.3.0)

This document describes the internal architecture as implemented. For design
philosophy, see [DESIGN.md](DESIGN.md). For build/test/automation, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Project Layout

```
fixd/
├── cli/                       # CLI entry point + commands (lazy-loaded)
│   ├── index.ts               # Arg parsing, preflight, command routing
│   ├── doctor.ts              # Diagnostic orchestrator + repair loop
│   ├── init.ts                # Project scaffolding
│   ├── config.ts              # Endpoint manager
│   ├── deploy.ts              # Dockerfile generation
│   ├── undo.ts                # Backup restoration
│   ├── update.ts              # Self-update from npm
│   └── lib/                   # Shared modules
│       ├── llm.ts             # Endpoint-based LLM client
│       ├── agent.ts           # Session state + system prompt
│       ├── endpoints.ts       # Endpoint config + migration
│       ├── discovery.ts       # Stack Discovery Engine
│       ├── checker-types.ts   # Plugin contract + shared types
│       ├── checker-loader.ts  # Plugin loader (filesystem + bundled fallback)
│       ├── issue-graph.ts     # Issue Dependency Graph builder
│       ├── sub-agents.ts      # exploreProject/diagnoseWithAgent/synthesize
│       ├── diagnostics.ts     # Legacy stack diagnostics (deprecated by checkers)
│       ├── memory.ts          # Persistent project memory
│       ├── patcher.ts         # Patch marker parser + atomic apply
│       ├── executor.ts        # Shell command extraction + execution
│       ├── projectReader.ts   # Scored file relevance reader
│       ├── command-classifier.ts # 3-stage safety pipeline
│       ├── display.ts         # Terminal UI primitives
│       ├── context7.ts        # Live library doc fetcher
│       ├── versionCheck.ts    # Cached npm update checker
│       └── adapters/          # LLM compatibility adapters
│           ├── dispatch.ts    # Routes by compatibility type
│           ├── openai.ts      # OpenAI-compatible (/chat/completions)
│           ├── anthropic.ts   # Anthropic (/v1/messages)
│           ├── gemini.ts      # Google Gemini (generateContent)
│           └── ollama.ts      # Ollama (/api/chat)
├── checkers/                  # Deterministic checker plugins
│   ├── index.ts               # Barrel export for compiled binary bundling
│   ├── env/plugin.ts          # Environment variable validation
│   ├── typescript/plugin.ts   # tsc --noEmit
│   ├── prisma/plugin.ts       # prisma validate + generate
│   ├── dependencies/plugin.ts # Lockfile + missing deps
│   ├── git/plugin.ts          # Uncommitted changes, detached HEAD
│   ├── docker/plugin.ts       # Dockerfile validation
│   └── package-json/plugin.ts # package.json structure
├── automation/                # Internal automation SDK
│   ├── index.ts               # Public API surface
│   ├── build.ts               # build()
│   ├── session.ts             # createSession/cleanSession/listSessions
│   ├── run.ts                 # run()
│   ├── fixture.ts             # listFixtures
│   └── cli.ts                 # fixd-dev CLI
├── src/actions/               # Deterministic, no-LLM operations
│   ├── scanFiles.ts           # Project scanner (never throws)
│   ├── fixEnv.ts              # 7 hardcoded issue detectors + auto-fixers
│   └── executeCommand.ts      # Safe command execution (never throws)
├── tests/                     # 18 test files (174 tests)
│   ├── unit/                  # 10 unit test files
│   ├── integration/           # 2 integration test files
│   ├── acceptance/            # 6 end-to-end test files (22 tests)
│   └── fixtures/              # Test project templates
├── docs/                      # Documentation
├── .claude/                   # Claude Code project context
│   └── adr/                   # 3 Architectural Decision Records
├── characters/
│   └── agent.character.json   # Agent persona + system prompt
├── testing/                   # External test infrastructure
│   ├── fixtures/               # Integration test fixtures
│   ├── sessions/               # Runtime test sessions
│   └── .env                    # API keys for test runs
├── fixd                       # Compiled standalone binary (57MB, Bun)
├── package.json               # 4 prod deps, 5 dev deps
└── tsconfig.cli.json          # CLI build config (includes automation/, checkers/)
```

## End-to-End Request Lifecycle

### `fixd doctor` (refactored July 2026)

```
1. ENV LOADING (cli/index.ts)
   Legacy env vars → .env files. Auto-migration to ~/.config/fixd/config.json.

2. PREFLIGHT
   Load endpoint config. Migrate legacy keys if present.
   Verify at least one endpoint is reachable.

3. PHASE 1+2 — SCAN + DETECT (doctor-phases/scan.ts)
   scanProject() → ProjectScan
   runDiagnostics() → legacy checker output
   detectIssues() → 2 issue types (PORT_CONFLICT, NODE_VERSION_MISMATCH)
   Note: 5 types consolidated to checker plugins (Step 2 refactor)

4. PHASE 3 — CHECKER ORCHESTRATION (doctor-phases/checkers.ts)
   discoverStack() → KnownStack with confidence scores
   loadAllCheckers() → filesystem or bundled fallback
   filterByStack() → only matching plugins
   Execute all active checkers in parallel
   buildIssueGraph() → DAG with root cause identification
   Display: severity tiers, execution plan, per-category repair strategies

5. PHASE 4 — LLM ANALYSIS (inline in doctor.ts)
   Fast mode: single sendMessage("diagnose") with checker context
   Full mode: skip explore/diagnose/synthesize if checkers ran

6. PHASE 5 — REPAIR LOOP (doctor-phases/repair.ts)
   Repository-driven: fresh prompt + filesystem state each iteration.
   Duplicate detection via normalized-content hashing (Step 3).
   Loop detection: stall after 2 iterations with identical issue graph.
   Max 3 iterations. Stopping condition: 0 root causes.

7. PHASE 6 — CHAT + VERIFICATION (inline in doctor.ts)
   agenticTurn() recursion with hypothesis tracking + outcome routing.
   verifyAfterFix() after each turn (shared with repair loop, Step 4).
   Stall detection: warns after 3 turns with no progress.
   Single dedup system: isNormalizedDuplicate (patcher.ts).
```

### `fixd init`

```
Interview → Plan (sub-agent) → Context7 doc fetch → Streaming generation →
Patch application → Git init → Dependencies install → FIXD.md → Memory warm-up
```

## Checker Plugin System

### Plugin Contract

```typescript
interface CheckerPlugin {
  id: string;               // "typescript"
  name: string;             // "TypeScript Compiler"
  category: CheckerCategory; // compile | lint | schema | build | env | deps | container | vcs | structure
  requires: string[];       // ["TypeScript"] or ["TypeScript", "React", "Vite"]
  check(projectPath: string): Promise<CheckerResult>;
  canAutoFix: boolean;
  fix?(issues, projectPath): Promise<FixOperation[]>;
  priority: number;         // lower = runs earlier
  description: string;
}
```

### Active Checkers (v0.3.0)

| Plugin | Category | Priority | Requires | Command |
|---|---|---|---|---|
| env | env | 5 | (none) | Reads .env + prisma schema |
| package-json | structure | 8 | (none) | Validates JSON + fields |
| dependencies | deps | 10 | (none) | Lockfile + script deps |
| prisma | schema | 15 | Prisma | prisma validate + generate |
| typescript | compile | 20 | TypeScript | tsc --noEmit |
| docker | container | 80 | Docker | Dockerfile validation |
| git | vcs | 90 | (none) | git status + branch check |

### Loading Strategy

1. Try filesystem: scan `checkers/*/plugin.js` directories, dynamic import
2. Fallback to `BUNDLED_CHECKERS` from `checkers/index.ts` barrel
3. Filter by discovered stack: only plugins whose `requires` are satisfied

## Issue Dependency Graph

Built from 6 evidence sources after all checkers complete:

| Source | How it contributes |
|---|---|
| Checker dependencies | Plugin A requires Signal X; Plugin B validates X → B's failures are root causes for A |
| File overlap | Two checkers reporting errors in same file → linked |
| Import graph | "Cannot find module X" → other errors in importing files are effects |
| Package/dependency graph | Missing dep → compile errors in dependent packages |
| Category ordering | env → deps → schema → compile → lint → build |
| Build pipeline | Schema errors → compile errors → build errors |

Root causes (nodes with no incoming edges) are what the LLM receives.

## LLM Routing

### Endpoint System

Config stored in `~/.config/fixd/config.json`. Each endpoint is identified by
name, base URL, compatibility type, and optional API key. Task routing maps
each task type to an endpoint + model pair.

Four compatibility adapters normalize all responses to OpenAI format:
- `openai` — Works with Groq, OpenRouter, Together, Azure, vLLM, LM Studio, LiteLLM
- `anthropic` — Claude API with response normalization
- `gemini` — Google Gemini with response normalization
- `ollama` — Local Ollama with NDJSON streaming normalization

### Task Parameters (v0.3.0)

| Task | Temperature | Max Tokens | Rationale |
|---|---|---|---|
| classify | 0.1 | 512 | Deterministic, short |
| explain | 0.5 | 2048 | Balanced, moderate |
| generate | 0.7 | 8192 | Creative, long |
| diagnose | 0.3 | 8192 | Precise, long |
| chat | 0.7 | 4096 | Balanced, moderate-long |

### Retry Behavior

- HTTP 429: exponential backoff (15s × attempt) or retry-after header
- HTTP 500/502/503/504: linear backoff (5s × attempt)
- Network errors: linear backoff (5s × attempt)
- Auth errors (401/403): throw immediately
- Max 3 retries per endpoint per call
- sendMessage() adds 1 additional top-level retry after 2s delay

## File Patch Pipeline

1. **Parse**: Extract markers from LLM response via regex
2. **Validate**: Path traversal guard — reject paths escaping projectRoot
3. **Match**: Find exact SEARCH string in file. Whitespace-normalized retry if exact fails.
4. **Replace**: Construct new file content
5. **Backup**: Copy original to .fixd/backups/<timestamp>/
6. **Write**: Atomic write via .fixd.tmp → rename

### Patch Markers

- `<<<EDIT: path>>>` `<<<SEARCH>>>`...`<<<REPLACE>>>`...`<<<END>>>` — Targeted edit (default)
- `<<<WRITE: path>>>`...`<<<END>>>` — Create new file only
- `<<<DELETE: path>>>` — Delete file
- `<<<RENAME: old -> new>>>` — Rename file

## Safety Model

### Command Classification (3-stage)
1. Always-confirm regex: rm -rf, sudo, git reset --hard, eval, pipe-to-shell
2. Safe prefix sets: conservative (ls, cat), moderate (npm install), aggressive (git push)
3. LLM classifier: for ambiguous commands

### File Safety
- Path traversal protection on all patches
- Atomic writes (.tmp → rename)
- Backup-before-patch: every modified file backed up
- `fixd undo`: restores from most recent backup session atomically
- Duplicate detection: identical patches blocked within same session

### Memory Isolation
- `.fixd/memory.json` auto-gitignored
- API keys in `~/.config/fixd/config.json`, never in project dirs
- No telemetry, no cloud sync

## Memory System

### Schema
```typescript
interface ProjectMemory {
  projectRoot: string;
  lastScanned: string | null;
  fixedIssues: FixedIssue[];       // last 50
  knownStack: Partial<StackSnapshot> & { signals?: Record<string, StackSignal> };
  chatSummaries: ChatSummary[];    // last 10
  userPreferences: Record<string, string>;
  causalChain: CausalEntry[];      // last 30
  stackPatterns: StackPattern[];   // up to 50 (confidence-scored)
}
```

### Lifecycle
- Session start: load from .fixd/memory.json
- Phase 1: updateFromScan() checkpoint save
- Phase 4 (repair loop): in-memory mutations (causal entries + stack patterns)
- Session end: summarizeSession() final persist

## Known Issues & Limitations

1. **Checker plugin system limited in compiled binary**: Filesystem-based plugin
   loading doesn't work. `BUNDLED_CHECKERS` fallback works but adding new
   checkers requires editing `checkers/index.ts` and recompiling.

2. **Prisma binary errors not auto-fixable**: Prisma schema validation errors
   related to binary version mismatches require manual intervention. The repair
   loop correctly stalls after detecting no progress.

3. **Conversation history contamination in full mode**: The `exploreProject()`
   pipeline can still produce findings that contradict checker results. Full
   mode now skips explore/diagnose when checkers provided results, but the
   legacy fallback path may still produce stale output.

4. **No checker for React/Vite/Next.js**: The checker plugin system was
   designed for these but the plugins haven't been implemented yet. Frontend
   issues are undetected by the deterministic pipeline.

5. **Minified JSON formatting is display-only**: The LLM sees prettified JSON
   but the actual file remains minified if the LLM doesn't modify it. This
   can cause confusion when SEARCH strings match the prettified version but
   not the actual file.

6. **Single build artifact**: The compiled binary bundles all checkers and
   adapters into one 57MB file. No code splitting or lazy loading at the
   checker level.

7. **No checker hot-reload**: Adding a checker requires a rebuild. There's no
   watch mode or runtime plugin directory scanning in compiled mode.

## Technical Debt

1. **diagnostics.ts is duplicated by checkers**: The old `STACK_CHECKERS`
   system still runs alongside the new checker plugins. Both produce similar
   output. `diagnostics.ts` should be deprecated and its checkers migrated.

2. **fixEnv.ts overlaps with env checker**: Both detect MISSING_DATABASE_URL.
   The env checker is the canonical source; `fixEnv.ts` should be reduced to
   fixer functions only, not detection.

3. **Unused imports in doctor.ts**: `recordFix`, `AppliedFix`, `withCwd` are
   imported but no longer used after the old Phase 4 was replaced by the
   repair loop.

4. **exploreProject() still exists in sub-agents.ts**: It's only called in
   the legacy fallback path. If the checker pipeline is working, it's dead code.

5. **No streaming in checker output**: Checker results appear all at once
   after all checkers complete. Large projects with slow checkers (cargo check)
   block the display.

6. **Agent conversation history grows indefinitely**: Only trimmed by token
   budget. No semantic summarization between repair loop iterations.

## Design Decisions (ADRs)

- **ADR-0001**: Internal Automation Layer — `automation/` SDK with 6 functions
- **ADR-0002**: Endpoint Abstraction — Compatibility-based routing, 4 adapters
- **ADR-0003**: Plugin Checker Architecture — Discovery Engine, checker plugins,
  Issue Dependency Graph, Doctor as orchestrator. Supersedes the hardcoded
  provider model and the LLM-as-scanner pipeline.
