// ─── Acceptance: fixd undo ──────────────────────────────────────────────────
// Verifies exact file restoration: modify → backup → restore → identical.

import { describe, test, beforeAll, afterAll } from "vitest";
import { newSession, fixdRun, cleanup, hashDirectory } from "./helpers.js";
import type { Session } from "../../automation/index.js";
import path from "node:path";

describe("fixd undo", () => {
  let session: Session;

  afterAll(async () => { await cleanup(session); });

  test("restores files to exact pre-modification state", async () => {
    session = await newSession("broken-prisma");

    // Snapshot file hashes before any modifications
    const beforeHash = hashDirectory(session.workspacePath);

    // Run doctor with auto-fix approval — this modifies files
    const doctorResult = await fixdRun(session, ["doctor", "--fast"], {
      input: "y\nexit\n",
      timeout: 120_000,
    });

    // Snapshot hashes after doctor
    const afterDoctorHash = hashDirectory(session.workspacePath);

    // Run undo
    const undoResult = await fixdRun(session, ["undo"], {
      input: "",
      timeout: 30_000,
    });

    // Snapshot hashes after undo
    const afterUndoHash = hashDirectory(session.workspacePath);

    // If doctor modified any files AND undo restored them:
    // the after-undo state should match the before state for ALL files
    // that existed before doctor ran.

    // Compare every file that existed before doctor
    const mismatches: string[] = [];
    for (const [relPath, origHash] of Object.entries(beforeHash)) {
      const restoredHash = afterUndoHash[relPath];
      if (restoredHash && restoredHash !== origHash) {
        mismatches.push(`${relPath}: ${origHash} → ${restoredHash}`);
      }
    }

    if (mismatches.length > 0) {
      console.error("Files not restored correctly:", mismatches.join("\n  "));
    }

    // If doctor didn't modify anything, the test still validates that undo
    // runs without destroying state (before == after)
    const destroyedFiles = Object.keys(beforeHash).filter(f => !afterUndoHash[f]);
    if (destroyedFiles.length > 0) {
      console.error("Files destroyed by undo:", destroyedFiles);
    }

    expect(mismatches.length, `${mismatches.length} files not restored exactly`).toBe(0);
    expect(destroyedFiles.length, `${destroyedFiles.length} files destroyed by undo`).toBe(0);

    // Undo must report what it did
    expect(undoResult.stdout.length).toBeGreaterThan(0);
  }, 200_000);
});
