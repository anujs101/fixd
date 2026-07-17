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

  lines.push("## Root Causes");
  for (let i = 0; i < graph.rootCauses.length; i++) {
    const rc = graph.rootCauses[i];
    const label = rc.file ? `${rc.file}${rc.line ? `:${rc.line}` : ""}` : "(no file)";
    lines.push(`  ${i + 1}. [${rc.category}] ${rc.severity} — ${rc.message} (${label})`);
  }

  // Group downstream effects by root cause
  const effects = new Map<string, IssueNode[]>();
  for (const edge of graph.edges) {
    if (!effects.has(edge.from)) effects.set(edge.from, []);
    const target = graph.nodes.find(n => n.id === edge.to);
    if (target) effects.get(edge.from)!.push(target);
  }

  if (effects.size > 0) {
    lines.push("");
    lines.push("## Downstream Effects");
    for (const [causeId, effs] of effects) {
      const cause = graph.nodes.find(n => n.id === causeId);
      if (!cause || effs.length === 0) continue;
      lines.push(`  ${cause.message.slice(0, 80)} → causes ${effs.length} downstream issue(s):`);
      for (const e of effs.slice(0, 5)) {
        lines.push(`    - [${e.category}] ${e.message.slice(0, 80)}`);
      }
    }
  }

  lines.push("");
  lines.push("## Instructions");
  lines.push("You are fixd. The issues above were detected by deterministic tools.");
  lines.push("Your job: explain root causes, prioritize fixes, coordinate multi-file edits.");
  lines.push("Do NOT propose running compilers/linters — they already ran. Output patches directly.");

  return lines.join("\n");
}
