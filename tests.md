# fixd Test Suite Report

Generated on 2026-05-23 from real local runs in `/Users/anujs101/Developer/fixd`. Updated after a strictness audit to remove shallow integration assertions and replace them with behavioral checks.

## Section 1: Summary Table

| Test File | # Tests | Passed | Failed | Skipped | Coverage (if available) |
|---|---:|---:|---:|---:|---|
| `tests/unit/patcher.test.ts` | 30 | 30 | 0 | 0 | `cli/lib/patcher.ts`: 79.59% lines |
| `tests/unit/command-classifier.test.ts` | 30 | 30 | 0 | 0 | `cli/lib/command-classifier.ts`: 93.54% lines |
| `tests/unit/diagnostics.test.ts` | 14 | 14 | 0 | 0 | `cli/lib/diagnostics.ts`: 52.83% lines |
| `tests/unit/memory.test.ts` | 17 | 17 | 0 | 0 | `cli/lib/memory.ts`: 58.91% lines |
| `tests/unit/projectReader.test.ts` | 15 | 15 | 0 | 0 | `cli/lib/projectReader.ts`: 93.33% lines |
| `tests/unit/llm.test.ts` | 18 | 18 | 0 | 0 | `cli/lib/llm.ts`: 72.39% lines |
| `tests/unit/agent.test.ts` | 8 | 8 | 0 | 0 | `cli/lib/agent.ts`: 79.41% lines |
| `tests/unit/scanFiles.test.ts` | 11 | 11 | 0 | 0 | `src/actions/scanFiles.ts`: 84.21% lines |
| `tests/unit/fixEnv.test.ts` | 8 | 8 | 0 | 0 | `src/actions/fixEnv.ts`: 38.59% lines |
| `tests/unit/display.test.ts` | 7 | 7 | 0 | 0 | `cli/lib/display.ts`: 41.82% lines |
| `tests/integration/agenticLoop.test.ts` | 9 | 9 | 0 | 0 | Integration coverage across `cli/lib/agent.ts`, `cli/doctor.ts`, and patch flow |
| `tests/integration/deployFlow.test.ts` | 6 | 6 | 0 | 0 | Integration coverage for `cli/deploy.ts` |

Total: 173 tests, 173 passed, 0 failed, 0 skipped.

## Section 2: Setup

The suite uses Vitest 4.1.7 with the Node environment and V8 coverage through `@vitest/coverage-v8`. LLM calls are never real network calls: tests mock `cli/lib/llm.ts` exports or `global.fetch` depending on the layer under test. File operation tests use real temporary directories under `os.tmpdir()` and clean them after each test, so patching, scanning, undo, and fixer behavior are exercised against actual disk I/O. External command execution is mocked at the actual implementation seam: deploy tests mock `execa`, while diagnostics tests mock `node:child_process.exec` because `cli/lib/diagnostics.ts` uses `exec`.

## Strictness Audit

The suite was audited for shallow patterns such as checking only `toHaveBeenCalled()`, mutating test-only state instead of driving behavior, or using broad `.some()` assertions where exact call order matters. The following hardening changes are now covered by passing tests:

| Area | Hardening Applied | Evidence |
|---|---|---|
| Agentic loop state | Duplicate patch persistence is now driven through `runDoctor` across two chat prompts, and exact edit-patch application count is asserted | `tests/integration/agenticLoop.test.ts` |
| Agentic loop commands | `alreadyRan` is verified with mocked bash command extraction and exact `runCommand` calls: same command skipped within a turn, allowed in the next user turn | `tests/integration/agenticLoop.test.ts` |
| Agentic loop outcomes | FIXED, NO CHANGE, and REGRESSION now assert concrete hypothesis fields and exact feedback messages sent to the agent | `tests/integration/agenticLoop.test.ts` |
| Deploy flags | `--build`, `--run`, and `--push` tests assert the skipped confirmation prompt is absent and Docker command args are exact | `tests/integration/deployFlow.test.ts` |
| Display | Output capture now records stdout writes plus console rendering, and tests assert rendered frames/content, not just loose substrings | `tests/unit/display.test.ts` |
| Diagnostics | Stack detection checks exact checker names/results, no-stack output checks the full skipped result, and fallback checks exact command order | `tests/unit/diagnostics.test.ts` |
| Agent history | Trimming tests now assert exact message roles/content after trimming, including removal of oversized/old turns | `tests/unit/agent.test.ts` |
| Fixers and patcher | File-mutating tests assert exact file contents, exact result objects, and preserved whitespace behavior where applicable | `tests/unit/fixEnv.test.ts`, `tests/unit/patcher.test.ts` |

## Section 3: Per-Module Results

### Patcher (`cli/lib/patcher.ts`, `cli/undo.ts`)

The patcher parses LLM patch markers and applies create, edit, delete, rename, backup, atomic write, and undo operations. It needs strong tests because mistakes here can corrupt or delete user files.

| Test Description | Status | Notes |
|---|---|---|
| Parses WRITE, EDIT, DELETE, RENAME, multiple operations, empty WRITE content, nested code fences, malformed blocks, and literal special characters | PASS | 10 parser tests passed |
| Applies WRITE creates and overwrites files on real disk | PASS | Existing files are backed up before overwrite |
| Applies EDIT exact and whitespace-normalized replacements | PASS | Whitespace-normalized edits preserve the unmatched trailing whitespace in the original file |
| Applies DELETE and RENAME | PASS | Missing DELETE target is skipped gracefully before apply |
| Rejects relative and absolute path traversal | PASS | No write outside the project root |
| Creates one backup session containing all originals changed in one apply call | PASS | `.fixd/last-backup` points to the session |
| Merges JSON objects and replaces arrays during JSON patching | PASS | Array replacement is documented actual behavior |
| Cleans atomic temp files and preserves originals on write failure | PASS | Failure simulated with a pre-existing temp directory |
| Undo restores last backup, rejects tampered backup paths, and handles missing backup state | PASS | `runUndo()` completes without writing outside root |

### Command Classifier (`cli/lib/command-classifier.ts`)

The classifier decides whether commands can run automatically or require confirmation. It needs tests because unsafe classification could run destructive commands without user approval.

| Test Description | Status | Notes |
|---|---|---|
| Stage 1 always-confirm regexes catch destructive commands | PASS | `rm`, `sudo`, `kill`, hard reset, Prisma reset, curl/wget pipe-to-shell all confirm |
| Stage 1 allows `npx ts-node` to fall through | PASS | Verified via LLM fallback mock |
| Conservative auto-run level allows only read-only safe commands | PASS | Install/build commands confirm |
| Moderate auto-run level allows installs, typecheck, lint, Prisma generate, and Vitest | PASS | Commits and Docker builds still confirm |
| Aggressive auto-run level allows git commit, git push, and Docker build | PASS | Matches configured aggressive behavior |
| LLM fallback accepts `auto-run` and `confirm` only | PASS | Throws and unexpected strings default to confirm |

### Memory System (`cli/lib/memory.ts`)

The memory system persists project context, historical fixes, stack patterns, and prompt formatting. It needs tests because corrupted or unbounded memory can degrade future agent decisions.

| Test Description | Status | Notes |
|---|---|---|
| Loads empty defaults for missing memory and roundtrips saved memory | PASS | Uses real `.fixd/memory.json` in temp dirs |
| Creates `.fixd`, writes atomically, and creates `.fixd/.gitignore` | PASS | No `.tmp` file remains after save |
| Migrates old memory missing `causalChain`, `stackPatterns`, or `userPreferences` | PASS | Missing fields are defaulted |
| Caps `fixedIssues`, `causalChain`, and `chatSummaries` | PASS | `chatSummaries` cap verified at 10 |
| Prunes stale and low-confidence stack patterns while retaining at least 5 best entries | PASS | Date-sensitive tests use relative stale timestamps |
| Formats empty, causal-history, and known-stack memory for prompts | PASS | No `undefined` appears in empty output |

### Project Reader (`cli/lib/projectReader.ts`)

The project reader selects relevant source context for agent prompts. It needs tests to avoid over-reading, leaking generated files, or omitting important project files.

| Test Description | Status | Notes |
|---|---|---|
| Normalizes relative paths | PASS | Covers leading `./`, parent segments, double slash, and empty string behavior |
| Always includes `package.json` | PASS | Verified with real fixture files |
| Includes Prisma and agent files when query-relevant | PASS | Query terms select expected files |
| Skips files over 50KB and respects the output budget | PASS | Large generated fixture content is excluded/truncated |
| Excludes `node_modules`, `.fixd`, and `dist` | PASS | Exclusion rules verified against real directories |
| Wraps output in project-file delimiters | PASS | `--- PROJECT FILES ---` and `--- END PROJECT FILES ---` present |
| Explicit issue paths bypass relevance scoring | PASS | Requested paths are included directly |

### LLM Client (`cli/lib/llm.ts`)

The LLM client chooses model tiers, calls provider APIs, handles retries/fallbacks, strips reasoning tags, and streams output. It needs tests because production tests must not call real APIs.

| Test Description | Status | Notes |
|---|---|---|
| `pickModel` routes generate/diagnose/chat-with-code to large and classify/explain/plain-chat to small | PASS | 8 routing cases passed |
| Handles normal responses, `<think>` blocks, and length truncation warnings | PASS | Warning text is asserted when `finish_reason` is `length` |
| Retries 429 responses and falls back on 500/provider failures | PASS | OpenRouter, Clarifai, and Groq fallback paths exercised |
| Handles network timeout without crashing process | PASS | `AbortError` path verified |
| Streams SSE chunks incrementally, strips split `<think>` blocks, and stops on `[DONE]` | PASS | Async generator behavior asserted |

### Agent Session (`cli/lib/agent.ts`)

The agent session owns chat history, project-specific prompt injection, memory context, and priming. It needs tests because context loss or uncontrolled history growth changes agent behavior across turns.

| Test Description | Status | Notes |
|---|---|---|
| `sendMessage` appends user and assistant turns | PASS | LLM call mocked |
| Trims oversized history while preserving recent turns | PASS | Exact post-trim role/content sequence is asserted |
| Keeps the system prompt present after trimming | PASS | System role remains available |
| Injects `FIXD.md` content when present and uses base prompt when absent | PASS | Real temp project roots |
| Injects memory context when `.fixd/memory.json` exists | PASS | Prompt contains project memory block |
| `primeContext` adds an assistant turn without LLM/fetch | PASS | No network call occurs |

### Scan Files (`src/actions/scanFiles.ts`)

The scanner detects package metadata, environment health, Prisma connection shape, package manager, and Docker ports. It needs tests because downstream diagnostics and fixes depend on this structured snapshot.

| Test Description | Status | Notes |
|---|---|---|
| Reads package name and version | PASS | Real `package.json` fixture |
| Detects missing `DATABASE_URL` | PASS | `.env` parsed from disk |
| Detects pooled Prisma URL by `pooler.` and port `6543` | PASS | Both heuristics covered |
| Detects direct Prisma URL and missing `directUrl` | PASS | Schema/env combinations covered |
| Detects Bun, pnpm, and Yarn lockfiles | PASS | Package manager precedence tested independently |
| Parses docker-compose host/container ports | PASS | Compose YAML fixture parsed |
| Returns empty Prisma scan when schema is absent | PASS | No crash when `prisma/` is missing |

### Auto-Fixers (`src/actions/fixEnv.ts`)

Auto-fixers repair common environment, Prisma, and TypeScript config issues. They need tests because they modify configuration files directly.

| Test Description | Status | Notes |
|---|---|---|
| `fixPrismaDirectUrl` adds `DIRECT_URL` to `.env` | PASS | Exact file contents and changed file list asserted |
| `fixPrismaDirectUrl` adds `directUrl = env("DIRECT_URL")` to schema | PASS | Exact schema output and diff line asserted |
| `fixPrismaDirectUrl` is idempotent | PASS | No duplicate keys after second run |
| `addMissingEnvKey` adds placeholders and preserves existing values | PASS | Existing values are not overwritten |
| `fixTsconfigStrict` sets or adds `strict: true` | PASS | JSON parsed after write |
| Fixer writes leave no `.fixd.tmp` file behind | PASS | Atomic temp cleanup verified |

### Diagnostics Engine (`cli/lib/diagnostics.ts`)

Diagnostics discovers project stacks, runs checkers concurrently, and parses compiler output. It needs tests because failures must be reported without breaking the whole agent loop.

| Test Description | Status | Notes |
|---|---|---|
| Detects TypeScript, ESLint, Rust, Go, no-stack, and multi-stack projects | PASS | Exact stack names, checker commands, skipped result shape, and multi-stack set asserted |
| Parses TypeScript, ESLint compact, and Rust errors into structured fields | PASS | `file`, `line`, `col`, `code`, and severity checked where applicable |
| Returns empty errors for zero-output success | PASS | Mocked checker success |
| Runs checkers concurrently | PASS | Delayed mocked commands complete below sequential duration |
| One checker throwing does not stop others | PASS | TypeScript failure is parseable and ESLint success is still returned in the same result set |
| Prefers local `node_modules/.bin/tsc` and falls back to `npx tsc` | PASS | Exact fallback command order asserted |

### Display System (`cli/lib/display.ts`)

Display functions render agent output and confirmation prompts. They need tests because terminal output must hide internal reasoning and prompt defaults must be safe.

| Test Description | Status | Notes |
|---|---|---|
| `agentSays` renders markdown code blocks | PASS | Rendered frame and code content asserted |
| Strips `<thought>` blocks and renders `<text>` content | PASS | Internal content absent; public content present in rendered frame |
| Handles malformed tags without crashing | PASS | Malformed content is rendered through fallback text path |
| `confirm` resolves true for `y`, false for `n`, and false for empty input | PASS | Safe default verified |

### Agentic Loop State (`cli/doctor.ts` integration)

The agentic loop integration tests verify state persistence and outcome feedback across recursive repair turns. It needs tests because loop state must not reset or reapply the same fix repeatedly.

| Test Description | Status | Notes |
|---|---|---|
| Keeps one `SessionState` alive across a `runDoctor` chat session | PASS | Same patch across two prompts is applied once and then skipped as duplicate |
| Persists `triedFixes` and accumulates hypotheses across turns | PASS | Exact tried-fix key, applied patch count, hypothesis fixes, and outcomes asserted |
| Resets `alreadyRan` between separate user chat turns | PASS | Exact command run sequence is `["ls", "ls"]` across two prompts |
| Handles FIXED, NO CHANGE, and REGRESSION outcomes | PASS | Exact hypothesis deltas and feedback messages asserted |
| Depth 6 generates a stuck report instead of crashing | PASS | Rendered stuck report includes the remaining issue type |

### Deploy Flow (`cli/deploy.ts` integration)

Deploy integration tests verify the CLI can generate Docker artifacts and optionally build, run, and push without talking to a real Docker daemon. It needs tests because deploy touches generated files and external commands.

| Test Description | Status | Notes |
|---|---|---|
| Generates `Dockerfile` from mocked LLM output | PASS | File written to temp project root |
| Generates `docker-compose.yml` from mocked LLM output | PASS | File written to temp project root |
| `--build`, `--run`, and `--push` skip confirmation for their respective Docker commands | PASS | Exact skipped prompt absence and exact Docker command args asserted |
| Missing Docker is handled gracefully | PASS | Mocked `docker info` failure exits through the graceful error path |

## Section 4: Bugs Found

No currently failing source-code bugs remain exposed by this suite. All listed tests produce real assertions and passed in the final run.

| Bug ID | File | Test That Found It | Description | Severity |
|---|---|---|---|---|
| None | N/A | N/A | No failing bug remains in the final verified run | N/A |

## Section 5: Coverage Report

Coverage command: `bun run test:coverage`

```text
% Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
cli/lib/patcher.ts |   75.62 |    70.96 |   89.28 |   79.59 | ...
cli/lib/command-classifier.ts | 94.11 | 90.00 | 100.00 | 93.54 | ...
cli/lib/memory.ts |    58.69 |    40.22 |   55.55 |   58.91 | ...
cli/lib/projectReader.ts | 88.46 | 71.42 | 75.00 | 93.33 | ...
cli/lib/llm.ts |       69.84 |    65.87 |   84.21 |   72.39 | ...
cli/lib/agent.ts |     76.92 |    54.83 |   72.72 |   79.41 | ...
src/actions/scanFiles.ts | 81.65 | 75.00 | 100.00 | 84.21 | ...
src/actions/fixEnv.ts | 39.83 | 23.94 | 42.85 | 38.59 | ...
-------------------|---------|----------|---------|---------|-------------------

Coverage summary:
Statements   : 49.66% (894/1800)
Branches     : 38.86% (412/1060)
Functions    : 48.76% (118/242)
Lines        : 51.11% (823/1610)
```

Full coverage run summary:

```text
Test Files  12 passed (12)
Tests       173 passed (173)
Duration    816ms
```

## Section 6: Gaps and Recommendations

| Gap | Why It Remains | Risk | Recommendation |
|---|---|---|---|
| Real LLM provider integration | Tests intentionally mock LLM/fetch to avoid network calls and nondeterminism | Medium | Add a separately gated smoke test using test credentials and strict quotas |
| Real Docker daemon behavior | Deploy tests mock `execa`, so Docker build/run/push command effects are not validated | Medium | Add optional integration tests behind an env flag on machines with Docker installed |
| Real compiler/linter binaries | Diagnostics tests mock `execa`, so parser and orchestration are covered but not tool installation quirks | Medium | Add fixture-project smoke tests for `tsc`, ESLint, Cargo, and Go where toolchains are available |
| Low line coverage for broad CLI helpers | Coverage includes unrelated library files such as `context7.ts`, `executor.ts`, `sub-agents.ts`, and `versionCheck.ts` | Medium | Add separate suites for command execution, context lookup, sub-agent orchestration, and version checks |
| LLM retry spinner artifacts in test stdout | LLM retry tests intentionally exercise rate-limit paths, and spinner text is still visible in Vitest output | Low | Consider mocking `spin()` in `llm.test.ts` if quieter test output becomes important |

## Verification Commands Run

```bash
bun run tsc --noEmit
bun run test
bun run test:coverage
bunx vitest run tests/integration/agenticLoop.test.ts tests/integration/deployFlow.test.ts tests/unit/display.test.ts tests/unit/agent.test.ts tests/unit/fixEnv.test.ts tests/unit/patcher.test.ts
```

Final observed results:

```text
bun run tsc --noEmit: exit 0
bun run test: 12 test files passed, 173 tests passed, 0 failed, 0 skipped
bun run test:coverage: 12 test files passed, 173 tests passed, coverage summary emitted
focused hardening run: 6 test files passed, 68 tests passed
```
