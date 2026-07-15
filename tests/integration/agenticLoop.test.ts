import { afterEach, describe, expect, test, vi } from "vitest";

const loopState = vi.hoisted(() => ({
  responses: [] as string[],
  appliedPatchCount: 0,
  prompts: [] as string[],
  commandRuns: [] as string[],
  detectedIssueBatches: [] as Array<Array<{ severity: "HIGH" | "MEDIUM" | "LOW"; type: string; description: string; autoFixable: false; file?: string }>>,
}));

vi.mock("../../cli/lib/display.js", () => ({
  printHeader: vi.fn(),
  agentSays: vi.fn(),
  agentWantsToRun: vi.fn(),
  printCommandResult: vi.fn(),
  spin: vi.fn(() => ({ stop: vi.fn() })),
  section: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  printIssue: vi.fn(),
  printFix: vi.fn(),
  prompt: vi.fn(async () => loopState.prompts.shift() ?? "exit"),
  confirm: vi.fn(async () => true),
  closePrompt: vi.fn(),
  bye: vi.fn(),
}));

vi.mock("../../cli/lib/agent.js", () => ({
  sendMessage: vi.fn(async () => [{ text: loopState.responses.shift() ?? "no-op", actions: [] }]),
  disconnect: vi.fn(),
  setActiveProject: vi.fn(),
  primeContext: vi.fn(),
}));

vi.mock("../../cli/lib/patcher.js", () => ({
  proposeAndApply: vi.fn(async (text: string) => {
    const editMatch = text.match(/<<<EDIT:\s*([^>]+)>>>/);
    if (!editMatch) return [];
    loopState.appliedPatchCount++;
    return [{ op: "edit", path: editMatch[1].trim(), applied: true, diff: "" }];
  }),
  resetBackupSession: vi.fn(),
}));

vi.mock("../../cli/lib/projectReader.js", () => ({ readRelevantFiles: vi.fn(async () => "") }));
vi.mock("../../cli/lib/context7.js", () => ({
  detectLibrariesInProject: vi.fn(async () => []),
  fetchDocsForQuery: vi.fn(async () => []),
  formatDocsForPrompt: vi.fn(() => ""),
  scoreDocRelevance: vi.fn(async (_query: string, libs: string[]) => libs),
}));
vi.mock("../../cli/lib/sub-agents.js", () => ({
  exploreProject: vi.fn(async () => null),
  diagnoseWithAgent: vi.fn(async () => ""),
  synthesizeDiagnosis: vi.fn(async () => ""),
}));
vi.mock("../../cli/lib/command-classifier.js", () => ({ classifyCommand: vi.fn(async () => ({ classification: "auto-run", reason: "safe-prefix" })) }));
vi.mock("../../cli/lib/diagnostics.js", () => ({
  runDiagnostics: vi.fn(async () => []),
  formatDiagnosticsForContext: vi.fn(() => ""),
  getAllErrors: vi.fn(() => []),
}));
vi.mock("../../cli/lib/executor.js", () => ({
  extractPendingCommands: vi.fn((text: string, alreadyRan: Set<string>) => {
    const commands = [...text.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1].trim())
      .filter((command) => command.length > 0 && !alreadyRan.has(command));
    return commands.map((command) => ({ command, reason: "test command" }));
  }),
  runCommand: vi.fn(async (command: string) => {
    loopState.commandRuns.push(command);
    return { command, stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };
  }),
  formatResultForAgent: vi.fn((result: { command: string }) => `command result: ${result.command}`),
}));
vi.mock("../../cli/lib/memory.js", () => ({
  loadMemory: vi.fn(async (projectRoot: string) => ({ projectRoot, lastScanned: null, fixedIssues: [], knownStack: {}, chatSummaries: [], userPreferences: {}, causalChain: [], stackPatterns: [] })),
  saveMemory: vi.fn(async () => undefined),
  updateFromScan: vi.fn((memory: unknown) => memory),
  recordFix: vi.fn((memory: unknown) => memory),
  summarizeSession: vi.fn(async (memory: unknown) => memory),
  addCausalEntry: vi.fn((memory: unknown) => memory),
  recordStackPattern: vi.fn((memory: unknown) => memory),
}));

vi.mock("../../src/actions/scanFiles.js", () => ({ scanProject: vi.fn(async () => ({
  projectPath: "/tmp/project",
  packageJson: { name: "x", scripts: {} },
  tsconfig: {},
  env: { vars: {}, missing: [], raw: "" },
  prisma: { found: false, provider: null, connectionType: null, hasDirectUrl: false, rawSchema: null },
  dockerCompose: null,
  dockerPorts: [],
  runningPorts: [],
  nodeVersion: "v24.0.0",
  bunVersion: "1.2.0",
  requiredNodeVersion: null,
  detectedPackageManager: "npm",
  errors: [],
})) }));
vi.mock("../../src/actions/fixEnv.js", () => ({
  fixTypescriptNodeTypes: vi.fn(),
  detectIssues: vi.fn(() => loopState.detectedIssueBatches.shift() ?? []),
}));

import { proposeAndApply } from "../../cli/lib/patcher.js";
import { sendMessage } from "../../cli/lib/agent.js";
import { agentSays } from "../../cli/lib/display.js";
import { runCommand } from "../../cli/lib/executor.js";
import { __doctorTest, runDoctor } from "../../cli/doctor.js";

describe("agentic loop state", () => {
  afterEach(() => {
    vi.clearAllMocks();
    loopState.responses.length = 0;
    loopState.prompts.length = 0;
    loopState.appliedPatchCount = 0;
    loopState.commandRuns.length = 0;
    loopState.detectedIssueBatches.length = 0;
  });

  test("SessionState factory creates one state object per runDoctor entry to chat", async () => {
    loopState.prompts.push("fix first", "fix second", "exit");
    loopState.responses.push(
      "<<<EDIT: src/index.ts>>>\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>",
      "done after first patch",
      "<<<EDIT: src/index.ts>>>\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>",
      "done after duplicate skip",
    );
    await runDoctor("/tmp/project", false, false);
    const patchApplyCalls = vi.mocked(proposeAndApply).mock.calls.filter((call) => call[0].includes("<<<EDIT:"));
    expect(patchApplyCalls).toHaveLength(1);
    expect(vi.mocked(sendMessage).mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.stringContaining("Skipped: identical fix already attempted"),
    ]));
  });

  test("triedFixes set persists across turns", async () => {
    const state = __doctorTest.makeSessionState();
    loopState.responses.push(
      "<<<EDIT: src/index.ts>>>\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>",
      "done",
      "<<<EDIT: src/index.ts>>>\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>",
      "done",
    );
    await __doctorTest.agenticTurn("fix", "/tmp/project", 0, state, new Set<string>(), [], [], [], []);
    await __doctorTest.agenticTurn("fix again", "/tmp/project", 0, state, new Set<string>(), [], [], [], []);
    expect(state.triedFixes.has("src/index.ts::old")).toBe(true);
    expect(loopState.appliedPatchCount).toBe(1);
    expect(vi.mocked(sendMessage).mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.stringContaining("Skipped: identical fix already attempted"),
    ]));
  });

  test("hypotheses array accumulates entries across turns", async () => {
    const state = __doctorTest.makeSessionState();
    loopState.responses.push(
      "<<<EDIT: a.ts>>>\n<<<SEARCH>>>\na\n<<<REPLACE>>>\na2\n<<<END>>>",
      "done a",
      "<<<EDIT: b.ts>>>\n<<<SEARCH>>>\nb\n<<<REPLACE>>>\nb2\n<<<END>>>",
      "done b",
      "<<<EDIT: c.ts>>>\n<<<SEARCH>>>\nc\n<<<REPLACE>>>\nc2\n<<<END>>>",
      "done c",
    );
    await __doctorTest.agenticTurn("fix a", "/tmp/project", 0, state, new Set<string>(), [], [], [], []);
    await __doctorTest.agenticTurn("fix b", "/tmp/project", 0, state, new Set<string>(), [], [], [], []);
    await __doctorTest.agenticTurn("fix c", "/tmp/project", 0, state, new Set<string>(), [], [], [], []);
    expect(state.hypotheses.map((h) => h.fix)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(state.hypotheses.map((h) => h.outcome)).toEqual(["no_change", "no_change", "no_change"]);
  });

  test("alreadyRan resets between user chat turns", async () => {
    loopState.prompts.push("run ls", "run ls", "exit");
    loopState.responses.push(
      "```bash\nls\n```",
      "```bash\nls\n```",
      "```bash\nls\n```",
      "done",
    );
    await runDoctor("/tmp/project", false, false);
    expect(vi.mocked(runCommand).mock.calls.map((call) => call[0])).toEqual(["ls", "ls"]);
  });

  test("FIXED outcome recurses after a patch", async () => {
    const state = __doctorTest.makeSessionState();
    loopState.responses.push("<<<EDIT: src/index.ts>>>\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>", "done");
    await __doctorTest.agenticTurn("fix", "/tmp/project", 0, state, new Set<string>(), [], [], [], [{ severity: "HIGH", type: "ISSUE", description: "broken", autoFixable: false }]);
    expect(state.totalFixAttempts).toBe(1);
    expect(state.hypotheses[0]).toMatchObject({ fix: "src/index.ts", outcome: "resolved", issuesBefore: 1, issuesAfter: 0 });
    expect(vi.mocked(sendMessage).mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.stringContaining("Fix Outcome: FIXED"),
    ]));
  });

  test("NO CHANGE outcome sends fix outcome back to agent", async () => {
    const state = __doctorTest.makeSessionState();
    loopState.responses.push("<<<EDIT: src/index.ts>>>\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>", "done");
    await __doctorTest.agenticTurn("fix", "/tmp/project", 0, state, new Set<string>(), [], [], [], []);
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining("Fix Outcome: NO CHANGE"), "diagnose");
    expect(state.hypotheses[0]).toMatchObject({ outcome: "no_change", issuesBefore: 0, issuesAfter: 0 });
  });

  test("REGRESSION outcome sends regression warning back to agent", async () => {
    const state = __doctorTest.makeSessionState();
    loopState.detectedIssueBatches.push([{ severity: "HIGH", type: "NEW_ISSUE", description: "new problem", autoFixable: false }]);
    loopState.responses.push("<<<EDIT: src/index.ts>>>\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>", "done");
    await __doctorTest.agenticTurn("fix", "/tmp/project", 0, state, new Set<string>(), [], [], [], []);
    expect(state.hypotheses[0]).toMatchObject({ outcome: "regression", issuesBefore: 0, issuesAfter: 1 });
    expect(vi.mocked(sendMessage).mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.stringContaining("Fix Outcome: REGRESSION"),
    ]));
  });

  test("depth 6 generates stuck report instead of crashing", async () => {
    const state = __doctorTest.makeSessionState();
    await __doctorTest.agenticTurn("fix", "/tmp/project", 6, state, new Set<string>(), [], [], [], [{ severity: "HIGH", type: "STILL_BROKEN", description: "remaining", autoFixable: false }]);
    expect(vi.mocked(agentSays).mock.calls[0][0]).toContain("Auto-fix limit reached");
    expect(vi.mocked(agentSays).mock.calls[0][0]).toContain("STILL_BROKEN");
  });

  test("duplicate patch is not reapplied", async () => {
    const state = __doctorTest.makeSessionState();
    state.triedFixes.add("src/index.ts::old");
    loopState.responses.push("<<<EDIT: src/index.ts>>>\n<<<SEARCH>>>\nold\n<<<REPLACE>>>\nnew\n<<<END>>>", "done");
    await __doctorTest.agenticTurn("fix", "/tmp/project", 0, state, new Set<string>(), [], [], [], []);
    expect(vi.mocked(proposeAndApply).mock.calls.filter((call) => call[0].includes("<<<EDIT:"))).toHaveLength(0);
  });
});
