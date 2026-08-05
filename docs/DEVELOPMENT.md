# FIXD — Development Guide (v0.3.0)

## Prerequisites

- Node.js ≥ 18 or Bun ≥ 1.0
- At least one LLM endpoint (OpenAI-compatible, Anthropic, Gemini, or Ollama)
- Optional: Context7 API key for live library docs in `fixd init`

## Configuration

FIXD uses endpoint-based config in `~/.config/fixd/config.json`. Run:

```bash
node dist/cli/index.js config
```

Legacy env vars (GROQ_API_KEY, OPENROUTER_API_KEY) are auto-migrated on first run.

## Project Setup

```bash
git clone https://github.com/anujs101/fixd.git
cd fixd && npm install
npm run build
```

## Building

```bash
npm run build              # tsc -p tsconfig.cli.json → dist/
bun build --compile ...    # standalone binary (57MB, 214 modules)
```

Two tsconfig files: `tsconfig.json` (full project), `tsconfig.cli.json` (CLI only).

## Running

```bash
npm run fixd -- status     # dev mode (tsx, no build)
node dist/cli/index.js status  # production mode
npm link && fixd status    # global install
./fixd doctor              # compiled binary
```

## Testing

```bash
npm test                   # 174 unit+integration tests
npm run test:watch         # vitest watch mode
npm run test:coverage      # with coverage report
npm run acceptance         # 22 end-to-end tests (requires API keys)
```

### Test Structure

```
tests/
├── unit/                  # 10 files — all cli/lib/ and src/actions/ modules
├── integration/           # 2 files — agenticLoop, deployFlow
├── acceptance/            # 6 files — init, doctor, config, status, undo, deploy
├── fixtures/              # sample-project, broken-project
└── helpers.ts             # makeTmpDir, cleanupDir, writeFixture
```

Acceptance tests use the real compiled binary through the automation SDK.
They make real LLM calls and verify filesystem state.

## Automation SDK

The `automation/` directory provides programmatic FIXD execution:

```typescript
import { build, createSession, run, cleanSession } from "./automation/index.js";

const artifact = await build(process.cwd());
const session = await createSession("../testing/sessions", {
  fixturePath: "../testing/fixtures/broken-prisma",
  envPath: "../testing/.env",
});
const result = await run(session, artifact, ["doctor", "--fast"], { input: "exit" });
console.log(result.stdout);
await cleanSession(session);
```

### CLI Usage

```
fixd-dev build
fixd-dev fixture list
fixd-dev session start [--fixture <name>] [--env <path>]
fixd-dev session run <id> [--pipe <input>] [--timeout <ms>] [--env KEY=VALUE] [--env-file <path>] -- <args...>
fixd-dev session clean <id>
fixd-dev session list
```

## Checker Development

Add a new checker by creating `checkers/<name>/plugin.ts`:

```typescript
import type { CheckerPlugin, CheckerResult } from "../../cli/lib/checker-types.js";

const myChecker: CheckerPlugin = {
  id: "my-checker",
  name: "My Checker",
  category: "compile",
  requires: ["TypeScript"],
  priority: 25,
  canAutoFix: false,
  description: "Runs my custom check",

  async check(projectPath: string): Promise<CheckerResult> {
    // Run the check, return structured errors
    return {
      checker: "my-checker", category: "compile",
      passed: true, errors: [], warnings: [], skipped: false, durationMs: 0,
    };
  },
};

export default myChecker;
```

Then add it to `checkers/index.ts` for compiled binary support.

## Acceptance Test Fixtures

Fixtures live in `testing/fixtures/`:

| Fixture | What it tests |
|---|---|
| `broken-prisma` | Prisma schema with missing DATABASE_URL |
| `broken-ts` | TypeScript project with type errors |
| `empty-project` | Empty project (graceful handling) |

## Coding Conventions

- ESM (`"type": "module"`), strict TypeScript
- kebab-case files, camelCase variables, PascalCase types
- `.js` extensions in local imports
- No throwing in library code — return fallback values
- No `.then()` chains — always async/await
- 4 production dependencies (chalk, dotenv, execa, ora)

## Common Issues

| Symptom | Cause |
|---|---|
| "No endpoint configured" | Run `fixd config` to set up endpoints |
| "readline was closed" | Running in non-TTY mode — expected |
| Prisma validate fails with P1012 | Prisma binary version mismatch — manual fix needed |
| Checker pipeline doesn't run in binary | Rebuild with `bun build --compile` |
| Typescript shows failed with 0 errors | tsc exit code ≠ 0 for non-error reasons — cosmetic |
