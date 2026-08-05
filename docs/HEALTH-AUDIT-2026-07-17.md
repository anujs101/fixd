# FIXD Repository Health Audit — 2026-07-17

## Summary

**Risk level: MODERATE.** The codebase is functional but has structural
issues that will cause regressions if not addressed. The last 20 commits
show a clear "fix the fix" cycle centered on `cli/doctor.ts` (10 of 20
commits touched it). Multiple overlapping mechanisms for the same
responsibilities now exist. The checker plugin system was deployed on top
of the old diagnostics infrastructure without removing the old system.
The patch validation+dudup mechanisms were layered on without consolidating
the existing triedFixes logic.

**Recommendation:** Scoped refactor pass before adding more features.
Prioritize `doctor.ts` structural cleanup, consolidating overlapping
mechanisms, and adding checker unit tests. This will reduce the regression
rate and make future changes safer.

---

## Finding 1: `doctor.ts` is a Monolith With Multi-Purpose State

| Dimension | Value |
|---|---|
| File | `cli/doctor.ts` |
| Size | ~1350 lines |
| Commits touching it | 10 of last 20 (50%) |
| Imports from | 14 modules |
| Throw/catch instances | 22 |
| Variables declared | 40+ in `runDoctor()` scope |
| Responsibilities | Scanning, issue detection, checker orchestration, LLM analysis, repair loop, chat loop, hypothesis tracking, memory management, command execution |

**Concrete risk:** Every bug fix or feature addition to any part of the
doctor pipeline requires touching this file. The `runDoctor()` function
manages scanner state, checker state, LLM state, repair loop state, chat
state, and memory state in a single flat scope. Adding a new phase or
modifying an existing one means navigating 1350 lines to find the right
insertion point. The repair loop (Phase 4) was added between Phases 4 and
5, and the checker pipeline (Phase 3a) was inserted between Phases 2 and
3b — the phase numbering itself is now inconsistent.

**Why it matters:** This file will continue to be the locus of "fix the
fix" cycles. Every change risks breaking an unrelated phase because all
phases share scope.

**Fix priority:** Extract phases into separate functions or modules.
The checker pipeline is already modular (discovery.ts, checker-loader.ts,
issue-graph.ts) but the doctor orchestrator still manages all state inline.

---

## Finding 2: Three Overlapping Issue Detection Mechanisms

| Mechanism | Location | What it finds |
|---|---|---|
| `detectIssues()` | `src/actions/fixEnv.ts` | 7 hardcoded issue types (MISSING_DATABASE_URL, PRISMA_POOLED, PORT_CONFLICT, etc.) |
| `checkers/env/plugin.ts` | `checkers/env/` | MISSING_ENV_VAR via .env parsing + schema inspection |
| `runDiagnostics()` | `cli/lib/diagnostics.ts` | 10 STACK_CHECKERS (tsc, eslint, mypy, cargo, go vet, etc.) |

**Overlap:** Both `fixEnv.ts` and `checkers/env/plugin.ts` detect
MISSING_DATABASE_URL. Both `diagnostics.ts` and `checkers/typescript/plugin.ts`
run `tsc --noEmit`. The old system was not removed when the new one was
added.

**Concrete risk:** A user running `fixd doctor` sees the same issue
reported twice (once by the old detector, once by the new checker).
This is already happening: the user's session output showed both
"MISSING_DATABASE_URL" from detectIssues() and a separate "Missing required
environment variable" from the env checker.

**Fix priority:** Consolidate into checker plugins. Remove `detectIssues()`
detection logic, keep only its fixer functions. Migrate remaining
STACK_CHECKERS to checker plugins, then deprecate `diagnostics.ts`.

---

## Finding 3: Two Duplicate Detection Systems

| System | Location | Key |
|---|---|---|
| `SessionState.triedFixes` | `cli/doctor.ts` (agenticTurn) | `filepath::searchString` (exact match) |
| `isNormalizedDuplicate()` | `cli/lib/patcher.ts` | Normalized content hash (whitespace-collapsed, syntax-collapsed) |

**Overlap:** Both systems exist to prevent identical patches. `triedFixes`
catches duplicates within a single agenticTurn recursion chain (depth-based).
`isNormalizedDuplicate` catches duplicates across the entire session
(module-level Set). They use different keys (exact search string vs.
normalized content) and different scopes (agenticTurn chain vs. module
global).

**Concrete risk:** A patch that passes `triedFixes` (different search
string formatting) but is semantically identical will be caught by
`isNormalizedDuplicate`. But the reverse is also true: a patch caught by
`isNormalizedDuplicate` won't trigger the agenticTurn re-prompt logic
(because `triedFixes` never saw it). The agent continues without knowing
its patch was rejected. This is the gap that allowed the Prisma
hallucination bug to repeat.

**Fix priority:** Consolidate into one system with a single scope.
`isNormalizedDuplicate` should replace `triedFixes`, or `triedFixes`
should use the normalized key. The rejected-patch feedback loop should
work regardless of which system caught the duplicate.

---

## Finding 4: Doctor's Phase Numbering is Inconsistent

Current code comments in `doctor.ts`:

```
Phase 1:  local scan + real diagnostics
Phase 2:  detect issues locally
Phase 3a: Deterministic checker plugins (ADR-0003)
Phase 3b: LLM analysis
Phase 4:  Repair loop
Phase 5:  interactive chat
```

**Issues:**
- The old Phase 3 (explore→diagnose→synthesize) was renamed to 3b but
  still exists as a legacy fallback
- The old Phase 4 (auto-fix) was removed but Phase 4b (repair loop) was
  renamed to Phase 4 — the numbering gap is confusing
- "Phase 3a-extension" comment exists but it's just variable assignment,
  not a real phase
- The plan mode gate sits between Phase 3b and Phase 4 without its own
  phase number

**Why it matters:** Documentation references these phases. When a bug
report says "Phase 4 didn't run," it's ambiguous whether that means the
repair loop or the old auto-fix.

---

## Finding 5: Chat Mode Has No Verification Loop

The repair loop (Phase 4) verifies checks after each iteration and
automatically continues. But chat mode (Phase 5) does not:

| Feature | Repair Loop | Chat Mode |
|---|---|---|
| Re-runs checkers after fixes | Yes | No |
| Injects hypothesis history | Yes (via repair prompt) | No |
| Stops on zero root causes | Yes | No |
| Detects stalled progress | Yes | No |
| Force large model for schema fixes | No | No |

After the repair loop exhausts its 3 iterations, the user falls into chat
mode with no verification or hypothesis injection. This is where the Prisma
hallucination loop occurred — the agent had no memory of the 3 failed
repair attempts.

**Concrete risk:** Any bug that survives the repair loop will repeat
indefinitely in chat mode. The user must manually detect the loop and
intervene.

---

## Finding 6: No Checker Plugin Unit Tests

| Test type | Checker coverage |
|---|---|
| Unit tests (`tests/unit/`) | 0 checker test files |
| Acceptance tests (`tests/acceptance/`) | doctor.test.ts exercises env + package-json + prisma checkers |

The only test exercising checker plugins is the acceptance test — which
runs the full binary end-to-end. Individual plugins have ZERO unit tests.
This means:

- A broken checker plugin (e.g., typescript checker parsing failure)
  will only be caught when someone runs the full acceptance suite
- Adding a new checker has no test harness to validate it
- Checker output format changes won't be caught by `npm test`

**Concrete risk:** The Prisma checker hallucination bug survived because
no test validates that `prisma validate` output is correctly parsed.

---

## Finding 7: `patcher.ts` Now Depends on `execa`

The pre-apply Prisma validation (Fix 1) added `import { execa } from "execa"`
to `cli/lib/patcher.ts`. Previously, the patcher was a pure filesystem
module with no subprocess execution. This is a layering change — the
patcher now reaches out to external tools.

**Why it matters:** The patcher was previously testable without mocking
external processes. Now tests that exercise `applyPatch` with `.prisma`
files will call `execa("prisma", ["validate"])`. If prisma isn't installed
in the test environment, the validation fails gracefully — but this changes
the test surface area.

**Risk level:** Low. The validation is guarded and falls back gracefully.
But it's a layering boundary worth noting.

---

## Finding 8: `discovery.ts` and `scanFiles.ts` Both Scan Projects

| Module | What it does |
|---|---|
| `src/actions/scanFiles.ts` | Reads package.json, tsconfig, .env, prisma, docker — returns `ProjectScan` |
| `cli/lib/discovery.ts` | Detects tech stack from config files, deps, dirs, file patterns — returns `KnownStack` |

Both read the same files (package.json, tsconfig.json, .env, prisma
directory). Both are called during `runDoctor()` (Phase 1 and Phase 3a
respectively). The results are stored separately (`scan` variable and
`knownStack` variable) with no deduplication of I/O.

**Why it matters:** Every doctor run reads the same files twice through
different code paths. This is inefficient but not dangerous. More
importantly, the two scans can produce contradictory results (e.g.,
scanFiles sees a tsconfig.json but discovery doesn't detect TypeScript).

---

## Finding 9: Memory Management is Split Across Three Modules

| Module | Memory responsibility |
|---|---|
| `cli/lib/memory.ts` | CRUD operations, schema, persistence |
| `cli/lib/agent.ts` | Read caching (`_memoryCache`), format for prompt |
| `cli/doctor.ts` | Write timing (checkpoint save, final save), in-memory mutations |

The `currentMemory` variable in `doctor.ts` is mutated directly in the
repair loop, while `agent.ts` has its own cache that is NOT updated when
`doctor.ts` mutates memory. This means the agent's injected memory context
is stale during the repair loop — it doesn't see the causal entries and
stack patterns that were just added.

**Concrete risk:** The agent operates on stale memory. Causal entries from
the current session's fixes are not injected into subsequent LLM prompts
until the final save at session end.

---

## Finding 10: Test Gaps — Interactive Paths Unexercised

| Path | Tested by |
|---|---|
| `--fast` mode, `--yes` init | Acceptance tests |
| Repair loop with checker results | Acceptance tests |
| Chat mode with hypothesis injection | NOT TESTED |
| Manual approval (y/n) in chat mode | NOT TESTED (requires interactive TTY) |
| Schema fix routing (large model force) | NOT TESTED |
| Prisma pre-apply validation rejection | NOT TESTED |
| Normalized dedup across turns | NOT TESTED |
| Loop detection (stall after 2 iterations) | NOT TESTED |

The interactive paths (chat mode approval, hypothesis injection, duplicate
feedback) have zero automated coverage. These are the paths where the
Prisma hallucination bug occurred.

**Why it matters:** The automation SDK (`fixd-dev`) supports piped input
for interactive commands. These paths CAN be tested but haven't been.

---

## Prioritized Findings

### Structural Risk (fix before adding features)

1. **`doctor.ts` monolith** — Most-patched file, all phases share scope.
   Extract phases into separate orchestrator functions. This will prevent
   future "fix the fix" cycles.

2. **Overlapping issue detection** — `fixEnv.ts` + `checkers/env/` both
   detect MISSING_DATABASE_URL. Consolidate into checker plugins.

3. **Two dedup systems** — `triedFixes` + `isNormalizedDuplicate` with
   different scopes and feedback mechanisms. Consolidate.

4. **Chat mode lacks verification loop** — After repair loop exhausts,
   chat mode has no checker re-runs, no hypothesis injection, no loop
   detection. This is the gap the Prisma bug exploited.

### Quality Risk

5. **No checker unit tests** — All 7 checker plugins have zero unit tests.
   Buggy parsers or output formats won't be caught.

6. **Stale memory in agent context** — `agent.ts` cache not updated when
   `doctor.ts` mutates memory. Agent operates on stale context.

7. **Test gaps in interactive paths** — Schema fix routing, duplicate
   rejection feedback, loop detection have zero coverage.

### Maintenance Risk

8. **Phase numbering confusion** — 3a, 3b, renamed 4, plan mode gate
   without number. Documentation and bug reports will be ambiguous.

9. **Dual project scanning** — `scanFiles.ts` + `discovery.ts` read the
   same files twice. Potential for contradictory results.

10. **`patcher.ts` now shells out** — Layering change adds `execa`
    dependency to previously-pure filesystem module. Acceptable but notable.

---

## Recommendation

**Do not add more features until #1-4 are addressed.** The current
structure is functional but brittle. The Prisma hallucination bug was
a predictable consequence of the gaps listed above — and it will happen
again in a different form if those gaps remain.

### Refactor order

1. **Extract `doctor.ts` phases** — Move checker orchestration,
   LLM analysis, and repair loop into separate files or functions.
   Target: `doctor.ts` < 600 lines.

2. **Consolidate issue detection** — Remove detection from `fixEnv.ts`,
   keep only fixer functions. Add detection to `checkers/env/`.

3. **Consolidate dedup** — Replace `triedFixes` with `isNormalizedDuplicate`.
   Ensure rejected patches feed back to agent in both repair loop AND
   chat mode.

4. **Add chat mode verification** — Extend hypothesis injection and
   checker re-run to chat mode. The repair loop and chat mode should
   share a single "apply + verify" function.

5. **Add checker unit tests** — At minimum: env, typescript, prisma checkers.

### Safe to defer

- Dual scanning (Finding 8): Performance concern, not correctness
- Phase numbering (Finding 8 in maintenance): Cosmetic
- Memory caching (Finding 6 in quality): Not causing visible bugs yet
