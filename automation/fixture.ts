import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";

export async function listFixtures(
  fixturesRoot: string,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(fixturesRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}
