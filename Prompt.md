```
Fix `fixd init` file writing. Currently streams scaffold response but never writes 
files to disk. Patch markers exist in patcher.ts but init never calls proposeAndApply.

## Problem
`cli/init.ts` sends scaffold prompt, streams response, prints it — done. Nothing 
written to disk. User gets a wall of text instead of an actual project.

## Fix

### Step 1: Scaffold prompt must enforce patch marker output

In `cli/init.ts`, update `scaffoldPrompt` to explicitly require patch markers:

```typescript
const scaffoldPrompt = `
${docsContext}

Scaffold a complete new project with these specs:
- Project name: ${projectName}
- Backend framework: ${framework || "hono"}
- Database: ${database || "postgres"}
${dbHost ? `- Database hosting: ${dbHost}` : ""}
- ORM: ${orm || "prisma"}
- Auth: ${auth || "none"}
- Frontend: ${frontend || "none"}
- Package manager: ${pkgManager || "bun"}
- Output directory: ${projectName}/

OUTPUT RULES — follow exactly or files will not be created:
1. Output EVERY file using this exact format:
<<<WRITE: ${projectName}/path/to/file>>>
full file content here
<<<END>>>

2. Files to generate (minimum):
   - ${projectName}/package.json
   - ${projectName}/tsconfig.json
   - ${projectName}/.env
   - ${projectName}/.env.example
   - ${projectName}/.gitignore
   - ${projectName}/README.md
   - ${projectName}/src/index.ts (entry point)
   ${orm === "prisma" ? `- ${projectName}/prisma/schema.prisma` : ""}
   ${auth !== "none" ? `- ${projectName}/src/lib/auth.ts` : ""}

3. After ALL file blocks, output exactly one line:
   SCAFFOLD_COMPLETE

4. No prose before the first <<<WRITE block.
5. No explanations between file blocks.
6. Use current syntax from the injected documentation above — not training data.
`.trim();
```

### Step 2: Collect full streamed response before parsing

Currently init streams chunks and prints them. Change to collect first, then parse and write:

```typescript
// in runInit(), replace the streaming display block:

section("scaffolding");
const s = spin("generating project...");

// collect full response — don't stream print (patch markers need full text)
let fullResponse = "";
try {
  for await (const chunk of askStream(scaffoldPrompt, "generate")) {
    fullResponse += chunk;
    // show progress without printing raw text
    if (fullResponse.includes("<<<WRITE:")) {
      const fileCount = (fullResponse.match(/<<<WRITE:/g) ?? []).length;
      s.text = `generating... (${fileCount} file${fileCount > 1 ? "s" : ""} so far)`;
    }
  }
} catch (err: any) {
  s.stop();
  warn(err.message);
  closePrompt();
  return;
}

s.stop();

// strip think blocks
const clean = fullResponse.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

// check we got something
if (!clean.includes("<<<WRITE:")) {
  warn("agent did not output any files — raw response:");
  console.log(chalk.dim(clean.slice(0, 500)));
  closePrompt();
  return;
}
```

### Step 3: Parse and write files using patcher

```typescript
import { proposeAndApply } from "./lib/patcher.js";
import path from "node:path";
import fs from "node:fs/promises";

// after collecting fullResponse:
const outputDir = path.join(process.cwd(), projectName);

// create output directory
try {
  await fs.mkdir(outputDir, { recursive: true });
} catch (err: any) {
  warn(`could not create ${outputDir}: ${err.message}`);
  closePrompt();
  return;
}

section("writing files");

// use autoApprove — user already confirmed the full scaffold
const results = await proposeAndApply(clean, outputDir, {
  autoApprove: true,
  // override path resolution — patcher resolves relative to outputDir
  // but agent outputs paths like "myproject/src/index.ts"
  // strip the projectName prefix since outputDir already is the project root
  pathPrefix: projectName,
});

const written  = results.filter(r => r.applied);
const failed   = results.filter(r => !r.applied);

for (const r of written) {
  success(`created: ${r.path}`);
}
for (const r of failed) {
  warn(`failed:  ${r.path} — ${r.error}`);
}

if (written.length === 0) {
  warn("no files written — check agent output format");
  closePrompt();
  return;
}
```

### Step 4: Run post-scaffold setup commands

After files written, run git init + install:

```typescript
import { runCommand } from "./lib/executor.js";

section("setup");

// git init
const gitResult = await runCommand("git init", outputDir);
if (gitResult.exitCode === 0) {
  success("git init");
  await runCommand(`git add . && git commit -m "init: fixd scaffold"`, outputDir);
  success("initial commit");
} else {
  warn("git init failed — init manually");
}

// install dependencies
const installCmd = pkgManager === "bun"  ? "bun install"
                 : pkgManager === "pnpm" ? "pnpm install"
                 : pkgManager === "yarn" ? "yarn"
                 : "npm install";

info(`running ${installCmd}...`);
const installSpinner = spin("installing dependencies...");
const installResult  = await runCommand(installCmd, outputDir);
installSpinner.stop();

if (installResult.exitCode === 0) {
  success("dependencies installed");
} else {
  warn("install failed — run manually:");
  console.log(`  cd ${projectName} && ${installCmd}`);
}
```

### Step 5: Fix path prefix stripping in `cli/lib/patcher.ts`

Agent outputs paths like `myproject/src/index.ts` but `outputDir` is already 
`/abs/path/to/myproject`. Need to strip the project name prefix.

Add `pathPrefix` option to `ApplyOptions` and strip in `parsePatchOperations`:

```typescript
// in patcher.ts, update parsePatchOperations to accept options:
export function parsePatchOperations(
  agentText: string,
  options?: { pathPrefix?: string }
): PatchOperation[] {
  // after extracting path from <<<WRITE: path>>>:
  let resolvedPath = extractedPath.trim();
  
  // strip projectName prefix if present
  if (options?.pathPrefix) {
    const prefix = options.pathPrefix.replace(/\/?$/, "/");
    if (resolvedPath.startsWith(prefix)) {
      resolvedPath = resolvedPath.slice(prefix.length);
    }
    // also handle without trailing slash
    if (resolvedPath.startsWith(options.pathPrefix + "/")) {
      resolvedPath = resolvedPath.slice(options.pathPrefix.length + 1);
    }
  }
  
  // ... rest of parsing
}
```

Pass pathPrefix through `proposeAndApply` → `applyPatchSet` → `parsePatchOperations`.

### Step 6: Expected output after fix

```
  your stack
  ────────────────────────────────────────
  project      my-api
  framework    hono
  database     postgres
  db host      neon
  orm          prisma
  auth         better-auth
  pkg manager  bun

  ? scaffold this project? (y/n) › y

  ⠋ fetching latest docs...
  ℹ fetched docs for: hono, prisma

  scaffolding
  ────────────────────────────────────────
  ⠋ generating... (6 files so far)

  writing files
  ────────────────────────────────────────
  ✔ created: package.json
  ✔ created: tsconfig.json
  ✔ created: .env
  ✔ created: .env.example
  ✔ created: .gitignore
  ✔ created: src/index.ts
  ✔ created: prisma/schema.prisma
  ✔ created: src/lib/auth.ts
  ✔ created: README.md

  setup
  ────────────────────────────────────────
  ✔ git init
  ✔ initial commit
  ✔ dependencies installed

  goodbye.
```

## Do not touch
- `cli/lib/display.ts`
- `cli/lib/diagnostics.ts`
- `cli/lib/executor.ts`
- `cli/lib/context7.ts`
- `cli/lib/memory.ts`
- `src/actions/`
```