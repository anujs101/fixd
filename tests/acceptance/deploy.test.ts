// ─── Acceptance: fixd deploy ────────────────────────────────────────────────
// Verifies deploy generates valid Docker artifacts. Requires Docker.

import { describe, test, beforeAll, afterAll } from "vitest";
import { newSession, fixdRun, cleanup } from "./helpers.js";
import type { Session } from "../../automation/index.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dockerAvailable = (() => {
  try { require("node:child_process").execSync("docker info", { timeout: 5000, stdio: "ignore" }); return true; }
  catch { return false; }
})();

function findDockerfile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const e of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "Dockerfile") return path.join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
      const found = findDockerfile(path.join(dir, e.name));
      if (found) return found;
    }
  }
  return null;
}

function validateDockerfile(content: string): string[] {
  const errors: string[] = [];
  if (!/^FROM\s+\S+/im.test(content)) errors.push("missing FROM instruction");
  if (!/COPY|ADD/i.test(content)) errors.push("no COPY or ADD instruction");
  if (!/EXPOSE|CMD|ENTRYPOINT/i.test(content)) errors.push("no EXPOSE, CMD, or ENTRYPOINT");
  if (/\/Users\//.test(content)) errors.push("contains hardcoded user paths");
  return errors;
}

describe("fixd deploy", () => {
  let session: Session;

  beforeAll(async () => {
    session = await newSession();
    await fixdRun(session, ["init", "--yes"], { input: "", timeout: 180_000 });
  }, 200_000);

  afterAll(async () => { await cleanup(session); });

  test("generates a valid Dockerfile", async () => {
    if (!dockerAvailable) {
      // Docker not available — verify deploy gives a clear error message
      const result = await fixdRun(session, ["deploy"], {
        input: "",
        timeout: 30_000,
      });
      const lower = result.stdout.toLowerCase();
      expect(
        lower.includes("docker") || lower.includes("not running") || lower.includes("not installed"),
        "deploy should report Docker unavailability clearly"
      ).toBe(true);
      return;
    }

    // Docker is available — full acceptance test
    // Answer: write Dockerfile? yes, docker-compose? no, build? no, push? no
    await fixdRun(session, ["deploy"], {
      input: "y\nn\nn\nn\n",
      timeout: 120_000,
    });

    const df = findDockerfile(session.workspacePath);
    expect(df, "Dockerfile must exist on disk").not.toBeNull();

    const content = readFileSync(df!, "utf-8");
    const errors = validateDockerfile(content);
    expect(errors, `Dockerfile validation errors: ${errors.join("; ")}`).toEqual([]);
    expect(content.length).toBeGreaterThan(100);
  }, 340_000);
});
