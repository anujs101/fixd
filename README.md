<div align="center">

# fixd

### Your terminal-native dev environment agent — diagnose, scaffold, and ship faster.

[![Version](https://img.shields.io/badge/version-0.3.0-6366f1?style=flat-square)](https://github.com/anujs101/fixd)
[![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3b82f6?style=flat-square)](https://typescriptlang.org)
[![Runtime](https://img.shields.io/badge/runtime-Node%20%7C%20Bun-a855f7?style=flat-square)](https://bun.sh)

</div>

---

## What is fixd?

fixd is a terminal-native AI agent that diagnoses broken projects, applies
fixes, and scaffolds new ones — directly from the command line.

It's not a general-purpose coding assistant. Claude Code, Gemini CLI, and
Codex CLI are designed for open-ended conversation and agentic exploration.
fixd has a narrower, higher-leverage purpose: **detecting and fixing project
misconfiguration** and **bootstrapping new projects from validated templates**.

The philosophical difference:

- **General-purpose assistants**: "Tell me what you want to build, and
  I'll help you build it step by step." Conversation-driven. Good for
  exploration.
- **fixd**: "This project is broken. Find what's wrong and fix it."
  Diagnostic-first. Pipeline-driven. Good for when you already have a
  project and something isn't working.

No dashboard. No SaaS. No agent server. Just run `fixd` in your project.

---

## Quick Start

```bash
git clone https://github.com/anujs101/fixd.git
cd fixd && npm install

# Build and run the config wizard
npm run build
node dist/cli/index.js config
```

The config wizard helps you add LLM endpoints. For a quick start with
Groq + OpenRouter, set the legacy env vars and FIXD will auto-migrate:

```bash
export GROQ_API_KEY=gsk_your_key_here
export OPENROUTER_API_KEY=sk-or-your_key_here
node dist/cli/index.js status  # auto-migrates to ~/.config/fixd/config.json
```

---

## Commands

| Command | Description |
|---|---|
| `fixd doctor` | Full diagnostic pipeline: scan → detect → diagnose → fix → verify → chat |
| `fixd doctor --fast` | Single-agent mode — faster, skips sub-agent pipeline |
| `fixd doctor --plan` | Show diagnosis and fix plan before applying any changes |
| `fixd plan` | Alias for `fixd doctor --plan --fast` |
| `fixd init` | Interactive project scaffolding with live docs |
| `fixd init --yes` | Scaffold with defaults (Hono + Neon + Prisma + Bun) |
| `fixd config` | Manage API keys in `~/.config/fixd/.env` |
| `fixd status` | Check API connectivity and active models |
| `fixd deploy` | Generate Dockerfile + docker-compose, build, run, or push |
| `fixd undo` | Restore all files from the last patch session |
| `fixd update` | Self-update from npm |

---

## How It Works

### `fixd doctor` — Diagnostic Pipeline

```
Scan (deterministic) → Detect Issues (deterministic) → LLM Analysis →
Auto-Fix (deterministic) → Verify → Interactive Chat
```

1. **Local scan** reads every config file, running ports, and runtime
   versions — zero LLM calls, instant results.
2. **Stack diagnostics** run `tsc`, `eslint`, `mypy`, `cargo check`, and
   more in parallel — you see real errors before the agent speaks.
3. **LLM analysis** explores your project, diagnoses issues, and synthesizes
   a unified summary. Small model for exploration, large model for diagnosis.
4. **Auto-fix** applies fixable issues with your approval, then verifies by
   re-scanning.
5. **Interactive chat** lets you ask follow-up questions, request specific
   fixes, and approve patches — all with memory across turns.

Every fix attempt is tracked: FIXED, NO CHANGE, or REGRESSION. The agent
routes accordingly. Identical patches are blocked automatically. At depth 6,
a stuck report shows everything that was tried.

### `fixd init` — Scaffolding with Live Docs

Interactive interview → plan generation → live library docs via Context7 →
streaming code generation → file write → git init → dependency install.

Fetches version-accurate docs for your exact stack before generating code.
No stale API hallucinations. Writes a `FIXD.md` so future `fixd doctor`
sessions know your stack immediately.

### `fixd plan` — Safe Preview

Runs the full diagnostic pipeline, shows the synthesis summary, and asks
for approval before entering the chat loop. Zero changes unless you confirm.

---

## Architecture at a Glance

fixd uses a **deterministic-first** architecture. Project scanning, issue
detection, and stack diagnostics run locally without any LLM call. LLMs
augment — they don't replace — deterministic tooling.

Compatibility-based endpoint routing — configure any OpenAI-compatible,
Anthropic, Gemini, or Ollama endpoint, then assign each task type to
an endpoint + model pair:

| Task | Default routing | Configurable via |
|---|---|---|
| classify, explain | Fast endpoint | `fixd config` → Configure Task Routing |
| diagnose, generate | Capable endpoint | `fixd config` → Configure Task Routing |
| chat | Capable endpoint | `fixd config` → Configure Task Routing |

Every file patch requires explicit approval. Every shell command goes
through a 3-stage safety classifier. All writes are atomic. All patches
are backed up before applying.

Persistent memory in `.fixd/memory.json` (auto-gitignored) tracks causal
chains and stack patterns across sessions — fixd gets smarter with every
project it fixes.

**4 production dependencies.** No frameworks. No agent servers.

For the full architecture, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Example Session

```
$ fixd doctor

  fixd › doctor
  dev environment agent · endpoints via fixd config
  ──────────────────────────────────────────────────

  ℹ scanning project at /home/user/my-api

  issues found
  ────────────────────────────────────────
  ●   HIGH    MISSING_DATABASE_URL
     Prisma schema found but DATABASE_URL is not set in .env.
     Auto-fixable: yes

  ●   HIGH    CONFIG
     problem: DATABASE_URL is missing for Prisma connection.
     fix:     Set DATABASE_URL in the .env file.

  apply 1 auto-fix? › yes

  ─── verification ────────────────────────
  ✔ 1 issue resolved
  ✔ project is clean

  ─── chat mode ───────────────────────────
  ask anything about your project
  › you: what about authentication?
```

---

## Configuration

FIXD uses an endpoint-based config system. Endpoints are LLM services
identified by base URL + compatibility type. This means any
OpenAI-compatible API, Anthropic, Gemini, or Ollama instance works the
same way.

### Setting up endpoints

```bash
fixd config                    # Interactive endpoint manager
fixd config endpoints          # List configured endpoints
fixd config routing            # Show task → endpoint mapping
fixd config test <name>        # Test an endpoint's connectivity
```

Config is stored in `~/.config/fixd/config.json`. If you have legacy
env vars (`GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CLARIFAI_PAT`), FIXD
will auto-migrate them on first run.

### Compatibility types

| Type | Works with |
|---|---|
| OpenAI Compatible | Groq, OpenRouter, Together, Fireworks, Azure, vLLM, LiteLLM, LM Studio, custom gateways |
| Anthropic | Claude API |
| Gemini | Google Gemini API |
| Ollama | Local Ollama, Open WebUI |

### Optional

- **Context7 API key** — `CONTEXT7_API_KEY` env var. Live library docs
  during `fixd init`. Without it, init works but uses training-data docs.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the configuration
reference and endpoint routing details.

---

## Safety

- **Path traversal protection** — all file operations validated to stay
  within the project root
- **Atomic writes** — files written to `.fixd.tmp` then renamed, preventing
  partial writes
- **Backup-before-patch** — every modified file backed up before writing;
  `fixd undo` restores atomically
- **3-stage command classifier** — regex allowlist → hardcoded safe prefixes
  → LLM classifier. Destructive commands always require explicit approval
- **No `--auto-approve` flag** — there never will be one
- **Memory isolation** — `.fixd/memory.json` auto-gitignored, never synced

---

## Documentation

| Document | Audience |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Contributors — system internals, data flows, design decisions |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Contributors — build, testing, automation SDK |
| [docs/DESIGN.md](docs/DESIGN.md) | Contributors — philosophy, goals, tradeoffs |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | New contributors — setup, workflow, PR guidelines |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Everyone — planned features and priorities |

---

## Contributing

Pull requests are welcome. For significant changes, open an issue first.

```bash
git clone https://github.com/anujs101/fixd.git
cd fixd && npm install
npm test  # 179 tests must pass
```

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full development workflow.

---

## License

MIT © [Anuj Singh](https://github.com/anujs101)
