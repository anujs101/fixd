// ─── Checker Plugin Loader ──────────────────────────────────────────────────
// Scans checkers/ directory, loads all plugins, filters by discovered stack.

import { readdirSync, existsSync, type Dirent } from "node:fs";
import path from "node:path";
import type { CheckerPlugin, KnownStack } from "./checker-types.js";

export async function loadAllCheckers(checkerDir: string): Promise<CheckerPlugin[]> {
  if (!existsSync(checkerDir)) return [];

  const plugins: CheckerPlugin[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(checkerDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const pluginPath = path.join(checkerDir, entry.name, "plugin.js");
    if (!existsSync(pluginPath)) continue;

    try {
      // Dynamic import needs a file:// URL on some Node versions
      const mod = await import(pluginPath.startsWith("file://") ? pluginPath : `file://${pluginPath}`);
      const plugin = (mod.default?.default ?? mod.default) as CheckerPlugin;
      if (plugin && plugin.id && typeof plugin.check === "function") {
        plugins.push(plugin);
      }
    } catch {
      // Plugin failed to load — skip
    }
  }

  return plugins.sort((a, b) => a.priority - b.priority);
}

/**
 * Filter plugins to only those whose `requires` signals are all present
 * in the discovered stack.
 */
export function filterByStack(
  plugins: CheckerPlugin[],
  stack: KnownStack,
): CheckerPlugin[] {
  return plugins.filter((plugin) =>
    plugin.requires.every((signal) => stack.signals[signal]?.confidence > 0)
  );
}

/** Build a human-readable label for a checker. */
export function describePlugin(plugin: CheckerPlugin): string {
  return `${plugin.name} [${plugin.id}] (${plugin.category}) — requires: ${plugin.requires.join(", ") || "none"}`;
}
