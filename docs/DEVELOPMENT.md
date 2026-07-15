# FIXD — Development Guide

This document covers building, testing, and automating FIXD. It is written
for contributors who want to modify FIXD and verify their changes.

## Prerequisites

- **Node.js** ≥ 18 or **Bun** ≥ 1.0
- At least one LLM endpoint (see Configuration below)
- _(Optional)_ **Context7 API key** (for live library docs in `fixd init`)

## Configuration

FIXD uses endpoint-based config in `~/.config/fixd/config.json`. Run the
interactive wizard to set up endpoints:

```bash
node dist/cli/index.js config
```

Or set legacy env vars and let FIXD auto-migrate:

```bash
export GROQ_API_KEY=gsk_your_key_here
export OPENROUTER_API_KEY=sk-or-your_key_here
node dist/cli/index.js status  # auto-migrates to config.json
```

## Building

```bash
# Production build (TypeScript → dist/)
npm run build         # tsc -p tsconfig.cli.json

# Or via the automation SDK
npx tsx automation/cli.ts build
```

The build produces `dist/cli/index.js` — the CLI entry point referenced
by the `fixd` binary in `package.json`.

Two tsconfig files exist:
- `tsconfig.json` — Full project config (includes tests, declarations)
- `tsconfig.cli.json` — CLI build only (no tests, no declarations)

## Running Locally

```bash
# Development mode (tsx, no build needed)
npm run fixd -- status
npm run fixd -- doctor

# Production mode (after build)
node dist/cli/index.js status
node dist/cli/index.js doctor

# Global install
npm link
fixd status
```

## Testing

### Unit and Integration Tests

```bash
# Run all tests
npm test              # vitest run

# Watch mode
npm run test:watch    # vitest

# Coverage report
npm run test:coverage # vitest run --coverage

# Specific test file
npx vitest run tests/unit/llm.test.ts
```

### Test Structure

```
tests/
├── unit/                    # 10 test files
│   ├── agent.test.ts        # Session state, history, priming
│   ├── command-classifier.test.ts  # 3-stage safety pipeline
│   ├── diagnostics.test.ts  # Stack detection, lint parsing
│   ├── display.test.ts      # Terminal UI primitives
│   ├── fixEnv.test.ts       # Issue detector + auto-fixers
│   ├── llm.test.ts          # Model routing, retry, fallback
│   ├── memory.test.ts       # CRUD, pruning, confidence
│   ├── patcher.test.ts      # Patch parsing, applying, backup
│   ├── projectReader.test.ts # File relevance scoring
│   └── scanFiles.test.ts    # Project scanner
├── integration/
│   ├── agenticLoop.test.ts  # Recursive turn loop with mocked LLM
│   └── deployFlow.test.ts   # Docker generation with mocked execa
├── fixtures/                # Test project templates
│   ├── sample-project/      # Clean TS + Prisma project
│   └── broken-project/      # Missing DATABASE_URL, no strict mode
└── helpers.ts               # makeTmpDir, cleanupDir, writeFixture
```

179 tests total. Coverage targets: `cli/lib/**` and `src/actions/**`.

## Automation SDK

The `automation/` directory provides a programmatic API for driving FIXD.
It is used by Claude Code, regression tests, CI, and manual development.

### API (6 functions, 4 types)

```typescript
// Build FIXD
build(projectRoot: string): Promise<BuildArtifact>
// BuildArtifact = { path: string; type: "node" | "binary"; builtAt: Date }

// Session management
createSession(sessionsRoot: string, options?: {
  fixturePath?: string; envPath?: string
}): Promise<Session>
// Session = { id: string; workspacePath: string }

cleanSession(session: Session): Promise<void>
listSessions(sessionsRoot: string): Promise<SessionSummary[]>
// SessionSummary = { id: string; createdAt: Date }

// Execute FIXD
run(session: Session, artifact: BuildArtifact, args: string[], options?: {
  input?: string; timeout?: number; env?: Record<string, string>
}): Promise<RunResult>
// RunResult = { exitCode: number | null; stdout: string; stderr: string;
//               duration: number; signal: string | null }

// Fixture management
listFixtures(fixturesRoot: string): Promise<string[]>
```

### CLI Usage

```
fixd-dev build [--project <path>]
fixd-dev fixture list [--fixtures <path>]
fixd-dev session start [--fixture <name>] [--env <path>]
fixd-dev session run <id> [--pipe <input>] [--timeout <ms>]
              [--env KEY=VALUE]... [--env-file <path>] -- <args...>
fixd-dev session clean <id>
fixd-dev session list
```

### Typical Workflow

```bash
# 1. Build FIXD
fixd-dev build

# 2. Create an isolated test session
fixd-dev session start --fixture broken-prisma --env-file ../testing/.env

# 3. Run FIXD in the session
fixd-dev session run sess-20260715-143022-a3f2 -- doctor --fast

# 4. Or with piped input
fixd-dev session run sess-20260715-143022-a3f2 --pipe "exit" -- doctor

# 5. Inspect results (exit code, stdout, stderr, duration)

# 6. Clean up
fixd-dev session clean sess-20260715-143022-a3f2
```

### Programmatic Usage

```typescript
import { build, createSession, run, cleanSession } from "./automation/index.js";

const artifact = await build(process.cwd());
const session = await createSession("../testing/sessions", {
  fixturePath: "../testing/fixtures/broken-prisma",
  envPath: "../testing/.env",
});
const result = await run(session, artifact, ["doctor", "--fast"], {
  input: "exit",
  timeout: 60_000,
});
console.log(result.exitCode, result.stdout);
await cleanSession(session);
```

## Test Fixtures

Fixtures are minimal, self-contained projects that trigger specific FIXD
behaviors. They live in `testing/fixtures/` (separate from source code).

### Available Fixtures

| Fixture | Purpose |
|---|---|
| `broken-prisma` | Prisma schema with missing DATABASE_URL — tests doctor's env detection |

### Creating a New Fixture

```bash
mkdir -p testing/fixtures/my-fixture
# Add package.json, tsconfig.json, and any files that reproduce the bug
# Run: fixd-dev fixture list   (should show the new fixture)
```

## Project Conventions

See `.claude/CONVENTIONS.md` for the full coding conventions. Key points:

- **ESM**: `"type": "module"`, use `.js` extensions in local imports
- **Strict TypeScript**: `strict: true` in tsconfig
- **No throwing in library code**: Return fallback values or error objects
- **No `.then()` chains**: Always `async/await`
- **kebab-case files**, **camelCase variables**, **PascalCase types**
- **Never-Throw pattern**: filesystem/network functions catch and return null/empty

## Commit Messages

Format: `<type>: <description>`

- `feat:` — New feature
- `fix:` — Bug fix
- `refactor:` — Code restructuring
- `docs:` — Documentation
- `chore:` — Maintenance

## Debugging

### Verbose LLM Output

Set environment variables to see API-level detail:
```bash
NODE_DEBUG=fixd fixd doctor --fast
```

### Inspecting Sessions

Failed test runs preserve their sessions for debugging:
```bash
fixd-dev session list
# Inspect the workspace, stdout, .fixd/memory.json
ls testing/sessions/<id>/workspace/
```

### Common Issues

| Symptom | Likely Cause |
|---|---|
| `No endpoint configured for task` | Run `fixd config` to set up endpoints |
| "readline was closed" | Running in non-TTY mode with piped input — expected |
| All providers fail | Network issue or expired API keys |
| Test timeout (>5s) | Retry loop sleeping — tests use `retry-after: 0` to avoid this |
