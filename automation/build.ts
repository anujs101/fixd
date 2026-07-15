import { execa } from "execa";
import path from "node:path";

export type BuildArtifact = {
  path: string;
  type: "node" | "binary";
  builtAt: Date;
};

export async function build(projectRoot: string): Promise<BuildArtifact> {
  const start = Date.now();

  await execa("npx", ["tsc", "-p", "tsconfig.cli.json"], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  return {
    path: path.join(projectRoot, "dist", "cli", "index.js"),
    type: "node",
    builtAt: new Date(),
  };
}
