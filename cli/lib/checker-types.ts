// ─── Checker Plugin Types ────────────────────────────────────────────────────
// Shared types for the plugin checker system (ADR-0003).
// Every checker plugin implements CheckerPlugin. Doctor loads plugins,
// Discovery Engine detects stacks, Issue Graph connects causes to effects.

// ─── Checker categories ──────────────────────────────────────────────────────

export type CheckerCategory =
  | "env"         // environment variables, secrets
  | "deps"        // dependencies, lockfiles, package managers
  | "schema"      // database schemas, ORM configs
  | "compile"     // type checking, compilation
  | "lint"        // style, code quality
  | "build"       // production builds
  | "container"   // Docker, containers
  | "vcs"         // git, version control
  | "structure";  // project structure, missing files

// ─── Checker result ──────────────────────────────────────────────────────────

export interface ParsedError {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  severity: "error" | "warning" | "info";
  message: string;
  raw: string;
}

export interface CheckerResult {
  checker: string;          // checker id, e.g. "typescript"
  category: CheckerCategory;
  passed: boolean;
  errors: ParsedError[];
  warnings: ParsedError[];
  skipped: boolean;
  skipReason?: string;
  durationMs: number;
}

// ─── Aggregated issue ────────────────────────────────────────────────────────

export interface AggregatedIssue {
  id: string;               // unique: "typescript:src/index.ts:12:TS2345"
  checker: string;
  category: CheckerCategory;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  autoFixable: boolean;
}

export interface FixOperation {
  op: "create" | "edit" | "delete" | "rename";
  path: string;
  content?: string;
  search?: string;
  replace?: string;
  to?: string;
}

// ─── Issue graph ─────────────────────────────────────────────────────────────

export interface IssueNode {
  id: string;
  checker: string;
  category: CheckerCategory;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  file?: string;
  line?: number;
  autoFixable: boolean;
}

export interface IssueEdge {
  from: string;     // issue id (cause)
  to: string;       // issue id (effect)
  relationship: "blocks" | "depends_on" | "causes" | "same_file" | "same_category";
  confidence: number;
}

export interface IssueGraph {
  nodes: IssueNode[];
  edges: IssueEdge[];
  rootCauses: IssueNode[];    // no incoming edges
  leafIssues: IssueNode[];    // no outgoing edges
}

// ─── Stack discovery ─────────────────────────────────────────────────────────

export interface StackSignal {
  technology: string;          // e.g. "TypeScript", "React", "Vite"
  confidence: number;          // 0-1
  evidence: string[];          // e.g. ["tsconfig.json exists", "typescript in devDeps"]
}

export interface KnownStack {
  signals: Record<string, StackSignal>;  // technology name → signal
  detectedAt: string;                     // ISO timestamp
  projectHash: string;                    // mtime-based hash for invalidation
}

// ─── Plugin interface ────────────────────────────────────────────────────────

export interface CheckerPlugin {
  id: string;
  name: string;
  category: CheckerCategory;
  requires: string[];          // signals needed: ["TypeScript"] or ["TypeScript","React","Vite"]
  check(projectPath: string, options?: CheckOptions): Promise<CheckerResult>;
  canAutoFix: boolean;
  fix?(issues: AggregatedIssue[], projectPath: string): Promise<FixOperation[]>;
  priority: number;            // lower = runs earlier
  description: string;
}

export interface CheckOptions {
  timeout?: number;
}

// ─── Doctor orchestrator types ───────────────────────────────────────────────

export interface DoctorReport {
  stack: KnownStack;
  checkersRun: number;
  checkersFailed: number;
  checkersSkipped: number;
  totalErrors: number;
  totalWarnings: number;
  graph: IssueGraph;
  categories: Partial<Record<CheckerCategory, IssueNode[]>>;
}
