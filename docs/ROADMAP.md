# FIXD — Roadmap (v0.3.0)

## Completed

- ✅ Endpoint abstraction (ADR-0002): OpenAI/Anthropic/Gemini/Ollama adapters
- ✅ Plugin checker system (ADR-0003): 7 checker plugins, Discovery Engine, Issue Graph
- ✅ Repository-driven repair loop: fresh prompt per iteration, duplicate detection, loop detection
- ✅ Minimal sufficient change: per-category repair strategies, EDIT default, anti-rewrite rules
- ✅ Automation SDK: programmatic build/session/run/fixture API with `fixd-dev` CLI
- ✅ Acceptance suite: 22 end-to-end tests across 6 workflows
- ✅ Compiled binary: standalone 57MB executable via Bun compile
- ✅ Batch memory persistence: in-memory accumulation, saves reduced 10→2
- ✅ Task-aware temperature/max_tokens: per-task LLM parameters
- ✅ Retry/fallback: network error retry, 500/504 retry, sendMessage retry

## Immediate

- **Checker plugins for React/Vite/Next.js** — Frontend issues currently undetected
- **`--verbose` flag** — Raw LLM responses, full prompts, API timing
- **`--max-depth N` flag** — Override repaired depth limit of 6
- **Remove deprecated diagnostics.ts** — Migrate remaining STACK_CHECKERS to plugins
- **Remove fixEnv.ts detection overlap** — env checker is canonical, keep fixers only
- **Stream checker output** — Display results as each checker completes instead of all at once
- **Checker hot-reload in dev mode** — Watch `checkers/` directory for new plugins

## Medium-Term

- **`fixd test`** — Generate and run tests for a project
- **`fixd explain`** — Explain a specific error without full doctor mode
- **`fixd review`** — Pre-commit code review using checkers + LLM
- **Plugin distribution** — npm-published checker plugins installable via `fixd plugin add`
- **Monorepo support** — Multi-project workspaces
- **SARIF/Code Climate output** — CI integration via `fixd ci`

## Long-Term

- **`fixd watch`** — File watcher that re-runs checkers on save
- **`fixd learn`** — Interactive tutorial mode
- **Remote agent mode** — Centralized API key management for teams
- **Windows support** — Currently Unix-centric

## Deliberately Deferred

| Item | Reason |
|---|---|
| Web UI / dashboard | Violates terminal-first philosophy |
| Agent server / daemon | Adds complexity without clear benefit |
| Multi-user / team features | Premature |
| Native binary (Bun compile) | Already done — 57MB Mach-O arm64 |
| LangChain / AI framework | Violates minimal-dependency philosophy |
