#!/usr/bin/env node
import { build } from "./build.js";
import {
  createSession,
  cleanSession,
  listSessions,
} from "./session.js";
import { run } from "./run.js";
import { listFixtures } from "./fixture.js";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

// ── Defaults ────────────────────────────────────────────────────────────

function getDefaults() {
  const projectRoot = process.cwd();
  return {
    projectRoot,
    sessionsRoot: path.join(projectRoot, "..", "testing", "sessions"),
    fixturesRoot: path.join(projectRoot, "..", "testing", "fixtures"),
    envPath: path.join(projectRoot, "..", "testing", ".env"),
  };
}

// ── Help ────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
FIXD Automation CLI — internal tool for driving FIXD programmatically

Usage:
  fixd-dev build [--project <path>]
  fixd-dev fixture list [--fixtures <path>]
  fixd-dev session start [--fixture <name>] [--env <path>] [--sessions <path>] [--fixtures <path>]
  fixd-dev session run <id> [--pipe <input>] [--timeout <ms>] [--env KEY=VALUE]... [--env-file <path>] [--project <path>] [--sessions <path>] -- <args...>
  fixd-dev session clean <id> [--sessions <path>]
  fixd-dev session list [--sessions <path>]
  fixd-dev --help

Defaults:
  --project   Current working directory
  --fixtures  ../testing/fixtures (relative to project)
  --sessions  ../testing/sessions (relative to project)
  --env       ../testing/.env (relative to project)
  --timeout   300000 (5 minutes)

Examples:
  fixd-dev build
  fixd-dev fixture list
  fixd-dev session start --fixture broken-prisma
  fixd-dev session run sess-20260715-143022-a3f2 --env-file ../testing/.env -- doctor --fast
  fixd-dev session run sess-20260715-143022-a3f2 --pipe "fix prisma\\nexit\\n" -- doctor
  fixd-dev session list
  fixd-dev session clean sess-20260715-143022-a3f2
`);
}

// ── Arg helpers ─────────────────────────────────────────────────────────

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function parseRepeatableFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
}

function parseEnv(args: string[], envFile?: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const pair of parseRepeatableFlag(args, "--env")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }

  if (envFile && existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (!env[key]) {
          env[key] = value;
        }
      }
    }
  }

  return Object.keys(env).length > 0 ? env : undefined as any;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const defaults = getDefaults();

  switch (command) {
    // ── build ──────────────────────────────────────────────────────
    case "build": {
      const projectRoot = parseFlag(args, "--project") ?? defaults.projectRoot;
      const artifact = await build(projectRoot);
      // machine-readable JSON on stdout
      console.log(JSON.stringify(artifact, null, 2));
      break;
    }

    // ── fixture ────────────────────────────────────────────────────
    case "fixture": {
      const sub = args[1];
      if (sub !== "list") {
        console.error("Usage: fixd-dev fixture list [--fixtures <path>]");
        process.exit(1);
      }
      const fixturesRoot = parseFlag(args, "--fixtures") ?? defaults.fixturesRoot;
      const fixtures = await listFixtures(fixturesRoot);
      console.log(fixtures.join("\n"));
      break;
    }

    // ── session ────────────────────────────────────────────────────
    case "session": {
      const sub = args[1];
      const sessionsRoot =
        parseFlag(args, "--sessions") ?? defaults.sessionsRoot;

      switch (sub) {
        // ── start ──────────────────────────────────────────────
        case "start": {
          const fixtureName = parseFlag(args, "--fixture");
          const envPath = parseFlag(args, "--env") ?? defaults.envPath;
          const fixturesRoot =
            parseFlag(args, "--fixtures") ?? defaults.fixturesRoot;

          const options: { fixturePath?: string; envPath?: string } = {};

          if (fixtureName) {
            const fixturePath = path.join(fixturesRoot, fixtureName);
            if (!existsSync(fixturePath)) {
              console.error(`Fixture not found: ${fixtureName} (${fixturePath})`);
              process.exit(1);
            }
            options.fixturePath = fixturePath;
          }

          if (existsSync(envPath)) {
            options.envPath = envPath;
          }

          const session = await createSession(sessionsRoot, options);
          console.log(JSON.stringify(session, null, 2));
          break;
        }

        // ── run ─────────────────────────────────────────────────
        case "run": {
          const sessionId = args[2];
          if (!sessionId) {
            console.error("Usage: fixd-dev session run <id> [--pipe <input>] [--timeout <ms>] [--env KEY=VALUE]... [--env-file <path>] -- <args...>");
            process.exit(1);
          }

          const input = parseFlag(args, "--pipe");
          const timeoutStr = parseFlag(args, "--timeout");
          const envFile = parseFlag(args, "--env-file");
          const projectRoot =
            parseFlag(args, "--project") ?? defaults.projectRoot;

          // parse --env KEY=VALUE and --env-file <path>
          const env = parseEnv(args, envFile);

          // split on --
          const dashDash = args.indexOf("--");
          const fixdArgs = dashDash >= 0 ? args.slice(dashDash + 1) : [];

          if (fixdArgs.length === 0) {
            console.error("Error: no FIXD arguments provided after --");
            process.exit(1);
          }

          // reconstruct session from convention
          const workspacePath = path.join(sessionsRoot, sessionId, "workspace");
          if (!existsSync(workspacePath)) {
            console.error(`Session workspace not found: ${workspacePath}`);
            process.exit(1);
          }

          const artifact = {
            path: path.join(projectRoot, "dist", "cli", "index.js"),
            type: "node" as const,
            builtAt: new Date(),
          };

          const result = await run(
            { id: sessionId, workspacePath },
            artifact,
            fixdArgs,
            {
              input: input ?? undefined,
              timeout: timeoutStr ? parseInt(timeoutStr, 10) : undefined,
              env,
            },
          );

          console.log(JSON.stringify(result, null, 2));
          process.exit(result.exitCode ?? 1);
        }

        // ── clean ───────────────────────────────────────────────
        case "clean": {
          const sessionId = args[2];
          if (!sessionId) {
            console.error("Usage: fixd-dev session clean <id> [--sessions <path>]");
            process.exit(1);
          }
          const workspacePath = path.join(sessionsRoot, sessionId, "workspace");
          await cleanSession({ id: sessionId, workspacePath });
          console.log(`Cleaned session: ${sessionId}`);
          break;
        }

        // ── list ────────────────────────────────────────────────
        case "list": {
          const sessions = await listSessions(sessionsRoot);
          if (sessions.length === 0) {
            console.log("(no sessions)");
          } else {
            for (const s of sessions) {
              console.log(`${s.id}\t${s.createdAt.toISOString()}`);
            }
          }
          break;
        }

        default: {
          console.error("Usage: fixd-dev session <start|run|clean|list>");
          process.exit(1);
        }
      }
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error("Run fixd-dev --help for usage.");
      process.exit(1);
    }
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
