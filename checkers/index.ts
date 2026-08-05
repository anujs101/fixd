// ─── Checker plugin barrel ───────────────────────────────────────────────────
// Imports all checker plugins so Bun's compiler bundles them into the binary.
// Used as a fallback when filesystem-based plugin loading fails (compiled mode).

import typescriptChecker from "./typescript/plugin.js";
import envChecker from "./env/plugin.js";
import prismaChecker from "./prisma/plugin.js";
import depsChecker from "./dependencies/plugin.js";
import gitChecker from "./git/plugin.js";
import dockerChecker from "./docker/plugin.js";
import pkgJsonChecker from "./package-json/plugin.js";
import type { CheckerPlugin } from "../cli/lib/checker-types.js";

export const BUNDLED_CHECKERS: CheckerPlugin[] = [
  typescriptChecker,
  envChecker,
  prismaChecker,
  depsChecker,
  gitChecker,
  dockerChecker,
  pkgJsonChecker,
];
