// ─── Checker Plugin Loader ──────────────────────────────────────────────────
// Scans checkers/ directory, loads all plugins, filters by discovered stack.
// Falls back to bundled checkers when running in compiled mode.

import { readdirSync, existsSync, type Dirent } from "node:fs";
import path from "node:path";
import type { CheckerPlugin, KnownStack } from "./checker-types.js";

export async function loadAllCheckers(checkerDir: string): Promise<CheckerPlugin[]> {
  // Try filesystem loading first (development mode)
  if (existsSync(checkerDir)) {
    const plugins: CheckerPlugin[] = [];
    let entries: Dirent[];
    try {
      entries = readdirSync(checkerDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const pluginPath = path.join(checkerDir, entry.name, "plugin.js");
      if (!existsSync(pluginPath)) continue;

      try {
        const mod = await import(pluginPath.startsWith("file://") ? pluginPath : `file://${pluginPath}`);
        const plugin = (mod.default?.default ?? mod.default) as CheckerPlugin;
        if (plugin && plugin.id && typeof plugin.check === "function") {
          plugins.push(plugin);
        }
      } catch {
        // Plugin failed to load — skip
      }
    }

    if (plugins.length > 0) {
      return plugins.sort((a, b) => a.priority - b.priority);
    }
  }

  // Fallback: bundled checkers (compiled binary mode)
  try {
    const { BUNDLED_CHECKERS } = await import("../../checkers/index.js");
    if (BUNDLED_CHECKERS && BUNDLED_CHECKERS.length > 0) {
      return [...BUNDLED_CHECKERS].sort((a, b) => a.priority - b.priority);
    }
  } catch {
    // No bundled checkers available either
  }

  return [];
}

export function filterByStack(
  plugins: CheckerPlugin[],
  stack: KnownStack,
): CheckerPlugin[] {
  return plugins.filter((plugin) =>
    plugin.requires.every((signal) => stack.signals[signal]?.confidence > 0)
  );
}

export function describePlugin(plugin: CheckerPlugin): string {
  return `${plugin.name} [${plugin.id}] (${plugin.category}) — requires: ${plugin.requires.join(", ") || "none"}`;
}
