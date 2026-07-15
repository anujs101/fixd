# FIXD — Design Philosophy

## What FIXD Is

FIXD is a terminal-native AI agent that diagnoses broken projects, applies
fixes, and scaffolds new ones — directly from the command line. It's not a
chatbot, not a SaaS platform, not an IDE plugin. It's a CLI tool that
behaves like a senior developer pair-programming in your terminal.

## What FIXD Is Not

FIXD is not a general-purpose coding assistant. It doesn't replace Claude
Code, Gemini CLI, or Codex CLI. Those tools are designed for open-ended
conversation and agentic exploration. FIXD is designed for a narrower,
higher-leverage purpose: **detecting and fixing project misconfiguration**
and **bootstrapping new projects from validated templates**.

The philosophical difference:

- **Claude Code / Codex CLI**: "Tell me what you want to build, and I'll
  help you build it step by step." Open-ended. Conversation-driven. Good
  for exploration.

- **FIXD**: "This project is broken. Find what's wrong and fix it."
  Diagnostic-first. Pipeline-driven. Good for when you already have a
  project and something isn't working.

## Core Principles

### 1. Deterministic Where Possible

Project scanning, issue detection, and stack diagnostics run locally
without any LLM call. The LLM augments deterministic tooling — it doesn't
replace it. You see `tsc` and `eslint` output before the agent ever
speaks.

This means:
- Issues detected by the local engine are **guaranteed real**, not
  hallucinated
- Local detection is **instant and free**
- The LLM provides **context and synthesis** that regex can't

### 2. Human-in-the-Loop

Every file patch and non-trivial shell command requires explicit approval.
The agent proposes; the developer decides. There is no `--auto-approve`
flag and there never will be.

### 3. Multi-Model by Task, Not by Preference

FIXD routes each LLM call to the appropriate model based on what it's
doing, not on what you configured. Classification calls go to fast/cheap
models. Diagnosis and generation go to capable models. This is not
user-configurable because it's an optimization problem, not a preference:

| Task | Why this model |
|---|---|
| classify | Needs deterministic output, 512 tokens max |
| explain | Short summaries, small model suffices |
| generate | Creative code generation, needs headroom |
| diagnose | Precise technical analysis, needs large context |
| chat | Balanced, follows conversation context |

### 4. Boring Technology

FIXD has 4 production dependencies: `chalk` (colors), `dotenv` (env
files), `execa` (safe subprocess execution), `ora` (spinners). No
frameworks. No DI containers. No agent orchestration libraries. Every
dependency must justify its inclusion.

### 5. Terminal-First, Always

No web UI. No browser dashboard. No Electron shell. The terminal IS the
interface. Every feature must work over SSH, in tmux, in CI runners, and
in thin terminal emulators.

### 6. Memory Without Surveillance

FIXD remembers what it fixed across sessions via `.fixd/memory.json`. This
file is auto-gitignored and never leaves your machine. Causal chains and
stack patterns make FIXD smarter over time without any telemetry, cloud
sync, or external service.

## Design Tradeoffs

### Structured Markers vs. Function Calling

FIXD uses text markers (`<<>>`, `<<>>`) instead of
OpenAI/Anthropic function calling for file operations. This is a deliberate
choice: it works identically across OpenAI-compatible, Anthropic, Gemini, and Ollama APIs without
provider-specific tool-calling implementations. The tradeoff is that the
model must follow format instructions precisely, which requires careful
system prompt engineering.

### Recursive Agentic Loop vs. Iterative Loop

The `agenticTurn()` function is recursive, not iterative. Each turn
computes a fix outcome and recurses with the result. This makes
outcome-based routing natural (FIXED → continue, NO CHANGE → escalate,
REGRESSION → reassess) but imposes a hard depth limit to prevent infinite
loops. The limit is 6 — at that point, FIXD generates a stuck report
showing everything it tried.

### Sequential Sub-Agents vs. Parallel

The doctor pipeline runs `explore → diagnose → synthesize` sequentially,
not in parallel. Analysis during the P1-6 audit confirmed this is correct:
each stage consumes the previous stage's output as required input. Attempting
parallelism would degrade diagnosis quality for marginal speed gain.

### In-Process vs. Agent Server

Everything runs in a single Node.js process. No background daemon, no
agent server, no WebSocket connection. This means zero infrastructure
requirements and instant startup, but it also means FIXD can't run
background monitoring or scheduled tasks.

## Why Not...

### Why not use LangChain / CrewAI / AutoGen?
Frameworks add dependency weight and abstraction layers that obscure
what's actually happening. FIXD's LLM calls are simple `fetch()` requests
with structured prompt assembly. The complexity is in the orchestration
logic (outcome routing, hypothesis tracking, memory persistence), not in
the LLM integration.

### Why not a VS Code extension?
Terminal-first means FIXD works in any environment: local shell, SSH
session, tmux pane, CI runner, cloud VM. An IDE extension would limit the
audience. The terminal is the universal developer interface.

### Why not streaming for diagnosis?
Streaming is used for `fixd init` (scaffolding generation) where
real-time output matters. Diagnosis responses are structured blocks
(SEVERITY/TYPE/PROBLEM/FIX) that are parsed and rendered — streaming
would interleave with the structured renderer and produce garbled output.

### Why not a config file format?
API keys go in `~/.config/fixd/.env`, managed by `fixd config`. There is
no `.fixdrc`, `fixd.config.js`, or `fixd.toml`. The `.env` format is
universally understood, works with existing tooling, and requires zero
parsing code. Keeps things boring.
