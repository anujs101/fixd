# FIXD — Contributing (v0.3.0)

## Setup

```bash
git clone https://github.com/anujs101/fixd.git
cd fixd && npm install && npm run build
```

Set up LLM endpoints:
```bash
node dist/cli/index.js config
# or via legacy env vars:
export GROQ_API_KEY=gsk_xxx OPENROUTER_API_KEY=sk-or-xxx
node dist/cli/index.js status  # auto-migrates
```

## Workflow

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Make changes. Follow `.claude/CONVENTIONS.md`.
3. Build and test: `npm run build && npm test`
4. For runtime changes, verify through automation:
   ```bash
   fixd-dev session start --fixture broken-prisma
   fixd-dev session run <id> --env-file ../testing/.env -- doctor --fast
   ```
5. Commit: `git commit -m "type: description"`
6. Push and open PR.

## What to Work On

- **Checker plugins**: Add new checkers in `checkers/<name>/plugin.ts`
- **Bug fixes**: Deterministic issue detectors (`fixEnv.ts`), checker improvements
- **Documentation**: docs/, error messages, help text
- **Fixtures**: New test fixtures in `testing/fixtures/`

## PR Guidelines

- Keep changes focused. One issue per PR.
- Run `npm test` (174 tests) and `npm run acceptance` (22 tests) before submitting.
- For runtime changes, include automation verification in PR description.
- Follow commit format: `type: description`

## Code Review Checklist

- Correctness: does the change fix the issue?
- Safety: does it introduce new failure modes?
- Conventions: `.claude/CONVENTIONS.md`
- Tests: are new paths tested?
- Docs: are new features documented?

## Architecture Quick Reference

- `cli/` — Commands (lazy-loaded)
- `cli/lib/` — Shared modules (LLM, agent, checkers, memory, patcher, etc.)
- `cli/lib/adapters/` — LLM compatibility adapters
- `checkers/` — Deterministic checker plugins
- `src/actions/` — Deterministic operations (scan, detect, execute)
- `automation/` — Internal automation SDK
- `tests/` — 18 test files (unit + integration + acceptance)

## Key ADRs

- [ADR-0001](../.claude/adr/ADR-0001-internal-automation-layer.md) — Automation SDK
- [ADR-0002](../.claude/adr/ADR-0002-endpoint-abstraction.md) — Endpoint abstraction
- [ADR-0003](../.claude/adr/ADR-0003-plugin-checker-architecture.md) — Plugin checker system
