// ─── fixd action logic (ElizaOS-free) ────────────────────────────────────────
// These modules contain the core scanning / execution logic.
// They are imported directly by the CLI — no ElizaOS runtime needed.

export { scanProject } from "./actions/scanFiles.js";
export { executeCommand, killPort } from "./actions/executeCommand.js";
export { detectIssues } from "./actions/fixEnv.js";