// ─── Issue Dependency Graph Builder ──────────────────────────────────────────
// Constructs a DAG from checker results using multiple evidence sources.
// Identifies root causes (nodes with no incoming edges) — these are what the
// LLM receives, not the full flat list of all errors.

import type {
  CheckerResult, CheckerPlugin, CheckerCategory,
  IssueNode, IssueEdge, IssueGraph, AggregatedIssue,
} from "./checker-types.js";

// ─── Aggregate ───────────────────────────────────────────────────────────────

/** Flatten checker results into issue nodes. */
export function aggregateIssues(results: CheckerResult[], plugins: CheckerPlugin[]): IssueNode[] {
  const nodes: IssueNode[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const plugin = plugins.find(p => p.id === result.checker);
    const autoFixable = plugin?.canAutoFix ?? false;

    for (const err of result.errors) {
      const key = `${result.checker}:${err.file ?? ""}:${err.line ?? ""}:${err.code ?? err.message.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      nodes.push({
        id: key,
        checker: result.checker,
        category: result.category,
        severity: err.severity === "error" ? "HIGH" : err.severity === "warning" ? "MEDIUM" : "LOW",
        message: err.message,
        file: err.file,
        line: err.line,
        autoFixable,
      });
    }
  }
  return nodes;
}

// ─── Graph builder ───────────────────────────────────────────────────────────

/**
 * Build an issue dependency graph from checker results and plugin metadata.
 * Uses multiple evidence sources:
 *   1. Checker dependency chain (requires)
 *   2. File overlap (same file, different checkers)
 *   3. Category ordering (env → deps → schema → compile → lint → build)
 *   4. Import/code-level heuristics (from error messages)
 */
export function buildIssueGraph(
  results: CheckerResult[],
  plugins: CheckerPlugin[],
): IssueGraph {
  const nodes = aggregateIssues(results, plugins);
  const edges: IssueEdge[] = [];

  // ── 1. Checker dependency chain ─────────────────────────────────────────
  // If checker A depends on signal X and checker B validates signal X,
  // then B's failures are root causes for A's failures.
  for (const resultA of results) {
    for (const resultB of results) {
      if (resultA.checker === resultB.checker) continue;
      const pluginA = plugins.find(p => p.id === resultA.checker);
      const pluginB = plugins.find(p => p.id === resultB.checker);
      if (!pluginA || !pluginB) continue;

      // Does A require anything that B's category covers?
      // e.g., prisma requires "Prisma" signal; env checker validates DATABASE_URL
      // which prisma needs → env failures block prisma
      if (resultB.errors.length > 0 && resultA.errors.length > 0) {
        // Simple heuristic: if B's category is env/deps and A depends on those
        if (resultB.category === "env" && pluginA.requires.length > 0) {
          for (const nodeA of nodes.filter(n => n.checker === resultA.checker)) {
            for (const nodeB of nodes.filter(n => n.checker === resultB.checker)) {
              edges.push({ from: nodeB.id, to: nodeA.id, relationship: "blocks", confidence: 0.7 });
            }
          }
        }
      }
    }
  }

  // ── 2. File overlap ─────────────────────────────────────────────────────
  // Two checkers reporting errors in the same file → linked.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].file && nodes[j].file && nodes[i].file === nodes[j].file) {
        // The one with lower-priority checker is typically downstream
        const pi = plugins.find(p => p.id === nodes[i].checker);
        const pj = plugins.find(p => p.id === nodes[j].checker);
        if (pi && pj && pi.priority < pj.priority) {
          edges.push({ from: nodes[i].id, to: nodes[j].id, relationship: "same_file", confidence: 0.5 });
        } else if (pj && pi && pj.priority < pi.priority) {
          edges.push({ from: nodes[j].id, to: nodes[i].id, relationship: "same_file", confidence: 0.5 });
        }
      }
    }
  }

  // ── 3. Import/code-level heuristics ─────────────────────────────────────
  // "Cannot find module X" → other errors in importing files are effects.
  const moduleNotFound = nodes.filter(n => n.message.includes("Cannot find module") || n.message.includes("Cannot find name"));
  for (const root of moduleNotFound) {
    for (const other of nodes) {
      if (other.id === root.id) continue;
      if (other.file && root.file && other.file !== root.file) {
        // Low confidence: same file is more reliable (handled above)
        edges.push({ from: root.id, to: other.id, relationship: "causes", confidence: 0.3 });
      }
    }
  }

  // ── 4. Category ordering ────────────────────────────────────────────────
  const categoryOrder: CheckerCategory[] = ["env", "deps", "schema", "compile", "lint", "build", "container", "vcs", "structure"];
  for (let ci = 0; ci < categoryOrder.length; ci++) {
    for (let cj = ci + 1; cj < categoryOrder.length; cj++) {
      const nodesI = nodes.filter(n => n.category === categoryOrder[ci] && n.file);
      const nodesJ = nodes.filter(n => n.category === categoryOrder[cj] && n.file);
      for (const ni of nodesI) {
        for (const nj of nodesJ) {
          if (ni.file === nj.file) {
            edges.push({ from: ni.id, to: nj.id, relationship: "same_category", confidence: 0.4 });
          }
        }
      }
    }
  }

  // Deduplicate edges
  const edgeSet = new Set<string>();
  const uniqueEdges: IssueEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}→${e.to}:${e.relationship}`;
    if (!edgeSet.has(key)) { edgeSet.add(key); uniqueEdges.push(e); }
  }

  // Compute root causes (no incoming edges)
  const hasIncoming = new Set(uniqueEdges.map(e => e.to));
  const rootCauses = nodes.filter(n => !hasIncoming.has(n.id));

  // Compute leaf issues (no outgoing edges)
  const hasOutgoing = new Set(uniqueEdges.map(e => e.from));
  const leafIssues = nodes.filter(n => !hasOutgoing.has(n.id));

  return { nodes, edges: uniqueEdges, rootCauses, leafIssues };
}

// ─── Format for LLM ─────────────────────────────────────────────────────────

/** Per-category repair instructions — the LLM must follow these exactly. */
const CATEGORY_RULES: Record<string, string> = {
  compile: "COMPILER ERROR — fix ONLY the exact line(s) reported. Use <<<EDIT>>> with SEARCH/REPLACE. Do NOT rewrite the entire file. Do NOT add new code.",
  lint: "LINT ISSUE — fix ONLY the reported rule violation. One targeted <<<EDIT>>> per issue.",
  schema: "SCHEMA ISSUE — fix ONLY the reported schema problem. Do NOT add new models or relationships.",
  env: "ENV ISSUE — add ONLY the missing variable. Use a single <<<EDIT>>> on .env.",
  deps: "DEPENDENCY ISSUE — edit package.json to add/remove ONLY the reported dependency.",
  build: "BUILD FAILURE — fix ONLY the build errors. Do NOT regenerate the entire project.",
  structure: "MISSING FILE — create ONLY the reported missing file. Minimal viable content.",
  container: "DOCKER ISSUE — fix ONLY the reported Dockerfile problem.",
  vcs: "GIT ISSUE — report the issue; do NOT run git commands.",
};

/** Format the issue graph as a structured report for the LLM. */
export function formatGraphForPrompt(graph: IssueGraph, stackLabel: string): string {
  const lines: string[] = [
    `## Stack: ${stackLabel}`,
    `## Issues: ${graph.nodes.length} total, ${graph.rootCauses.length} root causes`,
    ``,
  ];

  if (graph.rootCauses.length === 0) {
    lines.push("No issues detected. All checkers passed.");
    return lines.join("\n");
  }

  // Group root causes by category
  const byCategory = new Map<string, typeof graph.rootCauses>();
  for (const rc of graph.rootCauses) {
    if (!byCategory.has(rc.category)) byCategory.set(rc.category, []);
    byCategory.get(rc.category)!.push(rc);
  }

  for (const [category, causes] of byCategory) {
    const rule = CATEGORY_RULES[category] ?? "Fix the reported issue with the smallest possible change.";
    lines.push(`## ${category.toUpperCase()} (${causes.length} issue(s))`);
    lines.push(`  REPAIR STRATEGY: ${rule}`);
    for (const rc of causes) {
      const label = rc.file ? `${rc.file}${rc.line ? `:${rc.line}` : ""}` : "(no file)";
      lines.push(`  - ${rc.message} ${label !== "(no file)" ? `(${label})` : ""}`);
    }
    lines.push("");
  }

  lines.push("## CRITICAL RULES");
  lines.push("1. Make the SMALLEST possible change that satisfies the checker.");
  lines.push("2. Use <<<EDIT>>> with SEARCH/REPLACE for line-level fixes — never <<<WRITE>>> for existing files.");
  lines.push("3. <<<WRITE>>> only for files that genuinely do not exist.");
  lines.push("4. Never rewrite an entire file to fix a single-line error.");
  lines.push("5. Never add new features, routes, middleware, models, or architecture.");
  lines.push("6. Preserve all existing code that the checker did not flag.");
  lines.push("7. For parser/syntax errors (TS1xxx): fix ONLY the reported token, not the surrounding code.");
  lines.push("8. Output patches directly. No explanations. No prose.");

  return lines.join("\n");
}
