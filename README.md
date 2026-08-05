# fixd

Terminal-native AI agent — diagnose broken projects, apply fixes, scaffold new ones.

[![Version](https://img.shields.io/badge/version-0.3.0-6366f1?style=flat-square)](https://github.com/anujs101/fixd)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3b82f6?style=flat-square)](https://typescriptlang.org)
[![Runtime](https://img.shields.io/badge/runtime-Node%20%7C%20Bun-a855f7?style=flat-square)](https://bun.sh)

---

## What is fixd?

fixd is a CLI tool that diagnoses broken projects and scaffolds new ones. It's
not a general-purpose coding assistant. It has a narrower purpose: **detecting
and fixing project misconfiguration** and **bootstrapping projects from
validated templates**.

**Deterministic-first**: 7 checker plugins (TypeScript, Prisma, env, deps,
git, Docker, package.json) run before any LLM is called. You see real errors
from real tools before the agent speaks.

**Self-verifying**: A repair loop automatically re-runs checkers after fixes.
It stops when the project is clean — not when the LLM stops responding.

---

## Quick Start

```bash
git clone https://github.com/anujs101/fixd.git
cd fixd && npm install && npm run build

# Set up endpoints (or use legacy env vars for auto-migration)
export GROQ_API_KEY=gsk_your_key
export OPENROUTER_API_KEY=sk-or-your_key
node dist/cli/index.js status    # auto-migrates to config.json

# Or compile a standalone binary:
bun build --compile --outfile fixd --define "FIXD_BUILD_VERSION:'0.3.0'" cli/index.ts
./fixd doctor
```

---

## Commands

| Command | Description |
|---|---|
| `fixd doctor` | Full diagnostic pipeline with checker plugins + repair loop |
| `fixd doctor --fast` | Skip LLM analysis, only run deterministic checkers |
| `fixd doctor --plan` | Preview diagnosis and fix plan before applying changes |
| `fixd plan` | Alias for `fixd doctor --plan --fast` |
| `fixd init` | Interactive project scaffolding with live library docs |
| `fixd init --yes` | Scaffold with defaults (Hono + Neon + Prisma + Bun) |
| `fixd config` | Manage LLM endpoints and task routing |
| `fixd status` | Check endpoint health and show routing table |
| `fixd deploy` | Generate Dockerfile + docker-compose |
| `fixd undo` | Restore files from last patch session |
| `fixd update` | Self-update from npm |

---

## Architecture

### Doctor Pipeline

```
Stack Discovery → Checker Plugins (7, parallel) → Issue Graph →
Severity-Tiered Display → Execution Plan → LLM Analysis →
Repair Loop (re-scan → re-check → fix → verify, up to 3 iterations) →
Interactive Chat
```

- **7 deterministic checker plugins** run before any LLM is called
- **Issue Dependency Graph** identifies root causes from multiple evidence sources
- **Repository-driven repair loop**: fresh prompt each iteration, duplicate detection, loop detection
- **Minimal sufficient change**: per-category repair strategies, EDIT default over WRITE

### LLM Routing

Endpoint-based config in `~/.config/fixd/config.json`. Four compatibility
adapters: OpenAI-compatible (Groq, OpenRouter, Together, Azure, vLLM, LM Studio),
Anthropic, Gemini, Ollama. Legacy env vars auto-migrated.

### Safety

- 3-stage command classifier (regex → safe prefixes → LLM)
- Path traversal protection on all file operations
- Atomic writes (`.fixd.tmp` → `rename`)
- Backup-before-patch (`fixd undo` restores exactly)
- No `--auto-approve` flag

---

## Example

```
$ fixd doctor

  checkers
  ────────────────────────────────────────
  ℹ 4 passed, 2 failed, 0 skipped
  ✖ env: 1 error(s), 0 warning(s) (0ms)
  ✔ typescript: 0 error(s), 0 warning(s) (150ms)

  Errors (1)
    ✖ [env] Missing required environment variable: DATABASE_URL

  ℹ 1 root cause(s) — fixing these resolves downstream issues

  execution plan
  ────────────────────────────────────────
  Phase 1  env
    ✓ Missing required environment variable: DATABASE_URL

  Estimated:
  · 1 root cause(s)  · ~2 edit(s)  · 1 checker(s) will be re-run

  repair loop
  ────────────────────────────────────────
  ✔ repair iteration 2: all checkers pass — project is clean
```

---

## Documentation

| Document | Audience |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Internals: data flows, checker system, issue graph, safety, ADRs |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Build, test, automation SDK, checker development |
| [docs/DESIGN.md](docs/DESIGN.md) | Philosophy, tradeoffs, limitations |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Setup, workflow, PR guidelines |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Completed, planned, deferred |

---

## Contributing

```bash
git clone https://github.com/anujs101/fixd.git
cd fixd && npm install && npm test  # 174 tests
```

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

MIT
