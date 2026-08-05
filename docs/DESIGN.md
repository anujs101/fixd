# FIXD — Design Philosophy (v0.3.0)

## What FIXD Is

A terminal-native AI agent that diagnoses broken projects, applies fixes, and
scaffolds new ones. It's not a chatbot or SaaS — it's a CLI tool that behaves
like a senior developer pair-programming in your terminal.

## What FIXD Is Not

FIXD does not replace Claude Code, Gemini CLI, or Codex CLI. Those tools are
designed for open-ended agentic exploration. FIXD has a narrower purpose:
**detecting and fixing project misconfiguration** and **bootstrapping new
projects from validated templates**.

## Core Principles

### 1. Deterministic Where Possible
Project scanning, issue detection, and stack diagnostics run locally without
LLM calls. The LLM augments deterministic tooling — it doesn't replace it.
You see checker output before the agent ever speaks.

### 2. Human-in-the-Loop
Every file patch and non-trivial shell command requires explicit approval.
There is no `--auto-approve` flag.

### 3. Multi-Model by Task
Each LLM call routes to the appropriate endpoint + model based on task type.
Classification → fast/cheap. Diagnosis/generation → capable. This is not
user-configurable because it's an optimization, not a preference.

### 4. Boring Technology
4 production dependencies: chalk, dotenv, execa, ora. No frameworks.

### 5. Terminal-First
Every feature works over SSH, in tmux, in CI runners.

### 6. Memory Without Surveillance
`.fixd/memory.json` tracks causal chains and stack patterns across sessions.
Auto-gitignored. Never synced. No telemetry.

### 7. Determistic Scanners Are the Source of Truth
Compile errors, schema failures, missing env vars — discovered by deterministic
tools, not LLMs. The LLM reasons about verified facts. It never rediscovers
what a compiler already knows.

### 8. Extensible Through Plugins
Adding a framework means creating a checker plugin. Doctor's orchestration
logic is never modified for framework support.

## Design Tradeoffs

### Structured Markers vs. Function Calling
Text markers (`<<>>`, `<<>>`) work identically
across OpenAI-compatible, Anthropic, Gemini, and Ollama APIs. The tradeoff:
prompt engineering burden rather than provider-specific tool-calling code.

### Recursive Agentic Loop vs. Iterative Loop
The `agenticTurn()` function is recursive with a hard depth limit of 6.
Outcome-based routing (FIXED → continue, NO CHANGE → escalate, REGRESSION →
reassess) is natural in recursion. The limit prevents infinite loops.

### Sequential Sub-Agents vs. Parallel
The old explore→diagnose→synthesize pipeline was inherently sequential — each
stage consumes the previous stage's output. The new checker pipeline is
parallel (all checkers run concurrently), but the old pipeline is retained as
a legacy fallback.

### Repository as Source of Truth
The repair loop resets conversation state between iterations. The LLM receives
a fresh prompt built from current filesystem state — never a continuation of
prior reasoning. This prevents scope explosion and duplicate fixes.

## Why Not...

### Why not LangChain / CrewAI / AutoGen?
Frameworks add dependency weight and abstraction layers. FIXD's LLM calls are
simple `fetch()` requests with structured prompt assembly.

### Why not a VS Code extension?
Terminal-first means FIXD works in any environment. The terminal is the
universal developer interface.

### Why not streaming for diagnosis?
Checker results are displayed immediately when all checkers complete. The
repair loop uses non-streaming LLM calls because structured patch markers
must be complete before parsing.

### Why not a config file format?
Endpoints are stored in `~/.config/fixd/config.json` — a single JSON file.
The `.env` format is supported for legacy migration only.

## Current Limitations

- No React/Vite/Next.js checker plugins yet
- Checker pipeline limited in compiled binary (requires barrel export)
- No checker hot-reload — adding checkers requires rebuild
- Prisma binary errors not auto-fixable (correctly stalls)
- Minified JSON display-only prettification
