# FIXD — Contributing

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/fixd.git
   cd fixd
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Set up LLM endpoints (required for development):
   ```bash
   npm run build
   node dist/cli/index.js config
   ```
   Or use legacy env vars for auto-migration:
   ```bash
   export GROQ_API_KEY=gsk_your_key_here
   export OPENROUTER_API_KEY=sk-or-your_key_here
   ```
5. Verify your setup:
   ```bash
   npm run build
   npm test
   ```

## Development Workflow

1. Create a feature branch:
   ```bash
   git checkout -b feat/your-feature
   ```

2. Make your changes. Follow the coding conventions in
   `.claude/CONVENTIONS.md`.

3. Build and test:
   ```bash
   npm run build
   npm test
   ```

4. If your change affects FIXD's runtime behavior, test through the
   automation layer:
   ```bash
   npm run build
   fixd-dev session start --fixture broken-prisma
   fixd-dev session run <id> --env-file ../testing/.env -- doctor --fast
   fixd-dev session clean <id>
   ```

5. Commit with a descriptive message:
   ```bash
   git commit -m "fix: description of what you fixed"
   ```

6. Push and open a pull request.

## What to Work On

- **Good first issues**: Bug fixes for deterministic issue detectors
  (`fixEnv.ts`), diagnostic checker improvements (`diagnostics.ts`),
  test coverage improvements
- **Feature work**: Check the [ROADMAP.md](ROADMAP.md) for planned features
- **Documentation**: Improvements to docs/, error messages, help text
- **Fixtures**: New test fixtures in `testing/fixtures/` that reproduce
  real-world project misconfigurations

## Pull Request Guidelines

- Keep changes focused. One issue per PR.
- Include tests for new behavior.
- Run `npm test` before submitting — 179 tests must pass.
- For runtime changes, include an automation layer verification in the
  PR description (or a test fixture that reproduces the issue).
- Update `.claude/CHANGELOG_AI.md` with your change.
- Follow the commit message format: `<type>: <description>`.

## Code Review

All PRs are reviewed for:
- Correctness: does the change actually fix the issue?
- Safety: does it introduce new failure modes?
- Convention compliance: `.claude/CONVENTIONS.md`
- Test coverage: are new paths tested?
- Documentation: are new features documented?

## Design Philosophy

Before contributing, read [DESIGN.md](DESIGN.md). Key principles:

1. **Deterministic where possible** — prefer local detection over LLM calls
2. **Human-in-the-loop** — never auto-approve destructive operations
3. **Minimal dependencies** — justify every new package
4. **Terminal-first** — every feature must work over SSH, in tmux, in CI
5. **Boring technology** — simple code over clever abstractions

## Architecture

For detailed internals, see [ARCHITECTURE.md](ARCHITECTURE.md).

Quick reference:
- `cli/` — Commands (lazy-loaded)
- `cli/lib/` — Shared library modules (LLM, agent, memory, patcher, etc.)
- `src/actions/` — Deterministic operations (scan, detect, execute)
- `automation/` — Internal automation SDK
- `tests/` — Unit and integration tests

## Documentation

- `docs/ARCHITECTURE.md` — System internals
- `docs/DEVELOPMENT.md` — Build, testing, automation SDK
- `docs/DESIGN.md` — Philosophy, goals, tradeoffs
- `docs/ROADMAP.md` — Planned features
- `.claude/adr/` — Architectural Decision Records
- `.claude/CONVENTIONS.md` — Coding conventions

## License

MIT. See [LICENSE](../LICENSE) (if present) or the package.json license field.
