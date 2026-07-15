# FIXD — Roadmap

> Last updated: 2026-07-15 | Based on v0.3.0

## Recently Completed

- ✅ **P0-1**: Follow-up chat turns always route to large model
- ✅ **P0-2**: Network error retry, 500/504 retry, sendMessage retry
- ✅ **P0-3**: Task-aware temperature and max_tokens routing
- ✅ **P1-4**: Promise.allSettled for independent file reads
- ✅ **P1-5**: Batch memory persistence (in-memory accumulation, saves reduced 10→2)
- ✅ **P1-6**: Sub-agent parallelization — investigated and rejected (data dependencies)
- ✅ **Automation SDK**: Internal programmatic API for driving FIXD (build, session, run, fixture, CLI)
- ✅ **ADR-0001**: Internal automation layer design documented
- ✅ **Endpoint Abstraction**: Provider-centric → endpoint-centric architecture. Any OpenAI-compatible, Anthropic, Gemini, or Ollama endpoint works. Config via `~/.config/fixd/config.json`. Auto-migration from legacy env vars. ADR-0002.
- ✅ **ADR-0002**: Endpoint abstraction layer design documented

## Immediate (Next 1-2 sprints)

### Reliability
- **Graceful degradation when endpoint is down** — Inform user which
  endpoint is serving each request and surface errors clearly
- **Validate patch SEARCH strings before proposing** — Whitespace-normalized
  retry helps, but silent failures still produce confusing NO CHANGE outcomes

### Developer Experience
- **`--verbose` flag** — Show raw LLM responses, full prompts, API timing
- **`--max-depth N` flag** — Override hardcoded depth limit of 6
- **Progress persistence for interrupted sessions** — Save session memory
  on Ctrl+C before exit

## Medium-Term (1-3 months)

### New Commands
- **`fixd test`** — Generate and run tests for a project
- **`fixd explain`** — Explain a specific error or code pattern without
  entering full doctor mode
- **`fixd review`** — Pre-commit code review using diagnostic engine + LLM

### Architecture
- **Plugin system for issue detectors** — Currently `detectIssues()` has 7
  hardcoded types. Community plugins for specific frameworks
- **Plugin system for diagnostic checkers** — Community checkers for new
  languages without forking

### Performance
- **Stream sub-agent responses** — Real-time diagnosis display instead of
  spinner-then-dump
- **Cache project scans** — mtime-based invalidation to avoid re-reading
  files on every `agenticTurn()` recursion
- **Increase test coverage** — Core functions need better integration coverage

## Long-Term (3-6 months)

### Vision
- **`fixd watch`** — File watcher that re-runs diagnostics on save
- **`fixd ci`** — Machine-readable output (SARIF/Code Climate) for CI
- **Multi-project workspaces** — Monorepo support
- **`fixd learn`** — Interactive tutorial mode that teaches about issues
  rather than just fixing them
- **Remote agent mode** — Optional cloud service for teams with centralized
  API key management

### Architecture
- **Extract `cli/lib/` into `@fixd/core`** — Enable IDE integrations,
  CI/CD tooling, third-party consumption
- **Formal schemas for sub-agent communication** — Type generation,
  validation, documentation

### Quality
- **Optional telemetry** — Anonymized usage data for understanding real-world
  usage patterns
- **Windows support** — Currently Unix-centric (lsof, kill, path separators)
- **Formal verification of safety properties** — Command classifier and path
  traversal guard are security-critical

## Deliberately Deferred

| Item | Reason |
|---|---|
| Web UI / dashboard | Violates terminal-first design philosophy |
| Agent server / daemon mode | Adds deployment complexity without clear user benefit |
| Multi-user / team features | Premature — tool is single-user by design |
| Plugin marketplace | Premature — needs plugin system first |
| Native binary (Bun compile) | npm global install works fine; binary adds build complexity |
| LangChain / AI framework | Violates minimal-dependency philosophy |

## Impact Ranking

Ranked by (user impact × implementation feasibility):

1. `--verbose` flag — Unlocks self-serve debugging
2. Streaming sub-agent responses — Perceived performance, better UX
3. Plugin issue detectors — Community leverage, ecosystem growth
4. `fixd test` command — Natural feature expansion
5. `fixd explain` — Addresses common "quick question" use case
6. Cache project scans — Cuts doctor latency on re-scans
7. Long-term vision items — Major features, need foundation first
