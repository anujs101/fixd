import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { printHeader, info, warn, error, success, confirm, prompt, spin } from "./lib/display.js";
import { scanProject } from "../src/actions/scanFiles.js";
import { exploreProject } from "./lib/sub-agents.js";
import { ask } from "./lib/llm.js";

interface DeployOptions {
    build?: boolean;
    run?: boolean;
    push?: boolean;
}

function safeNodeTag(requiredNodeVersion: string | null): string {
    if (!requiredNodeVersion) return "lts";
    const major = requiredNodeVersion.match(/\d+/)?.[0];
    return major || "lts";
}

async function generateDockerfile(projectRoot: string): Promise<string> {
    const scan = await scanProject(projectRoot);
    const explore = await exploreProject(projectRoot);
    const nodeTag = safeNodeTag(scan.requiredNodeVersion);
    const runningPorts = scan.runningPorts.map((p) => p.port).join(", ") || "none detected";

    const dockerPrompt = `You are generating a production-ready Dockerfile for a ${explore?.framework || "Node.js"} project.

Project scan:
- Package manager: ${explore?.packageManager || scan.detectedPackageManager || "npm"}
- Runtime: ${explore?.runtime || "node"}
- Framework: ${explore?.framework || "unknown"}
- Has TypeScript: ${explore?.hasTypeScript ?? Boolean(scan.tsconfig)}
- Has Prisma: ${explore?.hasPrisma ?? scan.prisma.found}
- Node version required: ${nodeTag}
- Running ports detected: ${runningPorts}

package.json scripts available:
${scan.packageJson?.scripts ? JSON.stringify(scan.packageJson.scripts, null, 2) : "none"}

Generate ONLY the Dockerfile content. No explanation. No markdown fences. Start with FROM.
Rules:
- Use multi-stage build (builder + runner stage)
- Use node:${nodeTag}-alpine as base
- Install only production deps in runner stage
- If TypeScript detected: run build step in builder stage
- If Prisma detected: run prisma generate in builder stage
- COPY .env.example as .env if no .env exists pattern
- EXPOSE the correct port (default 3000 if unknown)
- Use non-root user in runner stage
- CMD should use the detected start script`;

    const dockerfile = await ask(dockerPrompt, "generate");
    return dockerfile.trim().replace(/^```(?:dockerfile)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

async function generateDockerCompose(
    projectRoot: string,
    imageName: string,
    port: string
): Promise<string> {
    const projectName = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const envExamplePath = path.join(projectRoot, ".env.example");
    const envVars = fs.existsSync(envExamplePath)
        ? fs
            .readFileSync(envExamplePath, "utf-8")
            .split("\n")
            .filter((line) => line.trim() && !line.trim().startsWith("#") && line.includes("="))
            .map((line) => {
                const key = line.split("=")[0].trim();
                return `      - ${key}=\${${key}}`;
            })
            .join("\n")
        : "";

    return `version: '3.8'
services:
  ${projectName}:
    image: ${imageName}
    build: .
    ports:
      - "${port}:${port}"
    environment:
${envVars || "      # Add your environment variables here"}
    restart: unless-stopped
`;
}

async function dockerAvailable(): Promise<boolean> {
    try {
        await execa("docker", ["info"], { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

export async function runDeploy(projectRoot: string, options: DeployOptions = {}): Promise<void> {
    printHeader("deploy");

    const hasDocker = await dockerAvailable();
    if (!hasDocker) {
        error("Docker is not running or not installed.");
        info("Install Docker: https://docs.docker.com/get-docker/");
        process.exit(1);
    }

    const projectName = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const dockerfilePath = path.join(projectRoot, "Dockerfile");
    const composePath = path.join(projectRoot, "docker-compose.yml");

    let dockerfile: string;
    if (fs.existsSync(dockerfilePath)) {
        info("Dockerfile already exists — using existing.");
        dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    } else {
        const genSpinner = spin("Generating Dockerfile...");
        try {
            dockerfile = await generateDockerfile(projectRoot);
            genSpinner.succeed("Dockerfile generated");
        } catch (err) {
            genSpinner.fail("Failed to generate Dockerfile");
            error(String(err));
            process.exit(1);
        }

        console.log(`\n${dockerfile}\n`);
        const writeIt = await confirm("Write this Dockerfile to project?");
        if (!writeIt) {
            warn("Dockerfile not written. Exiting.");
            return;
        }
        fs.writeFileSync(dockerfilePath, dockerfile, "utf-8");
        success(`Dockerfile written to ${dockerfilePath}`);
    }

    const exposeMatch = dockerfile.match(/^EXPOSE\s+(\d+)/m);
    const port = exposeMatch ? exposeMatch[1] : "3000";
    const imageName = `${projectName}:latest`;

    if (!fs.existsSync(composePath)) {
        const compose = await generateDockerCompose(projectRoot, imageName, port);
        const writeCompose = await confirm("Generate docker-compose.yml?");
        if (writeCompose) {
            fs.writeFileSync(composePath, compose, "utf-8");
            success(`docker-compose.yml written to ${composePath}`);
        }
    }

    const doBuild = options.build ?? (await confirm(`Build Docker image "${imageName}"?`));
    if (doBuild) {
        info(`Building ${imageName}...`);
        console.log();
        try {
            await execa("docker", ["build", "-t", imageName, "."], {
                cwd: projectRoot,
                stdio: "inherit",
            });
            console.log();
            success(`Image built: ${imageName}`);
        } catch {
            error("Docker build failed. Check output above.");
            process.exit(1);
        }
    }

    const doRun = options.run ?? (await confirm(`Run container locally on port ${port}?`));
    if (doRun) {
        info(`Starting container on http://localhost:${port}...`);
        console.log();
        try {
            const { stdout } = await execa("docker", [
                "run",
                "-d",
                "--rm",
                "-p", `${port}:${port}`,
                "--name", `${projectName}-fixd`,
                imageName,
            ], { cwd: projectRoot });
            const containerId = stdout.trim().slice(0, 12);
            success(`Container started (id: ${containerId})`);
            info(`App running at http://localhost:${port}`);
            info(`Stop with: docker stop ${projectName}-fixd`);
            info(`Logs with:  docker logs -f ${projectName}-fixd`);
        } catch {
            error("Failed to start container. Try: docker run manually.");
        }
    }

    const doPush = options.push ?? (await confirm("Push image to a container registry?"));
    if (doPush) {
        console.log();
        info("Supported: Docker Hub (docker.io), GitHub Container Registry (ghcr.io), or custom");
        const registry = await prompt("Registry prefix (e.g. docker.io/username or ghcr.io/username, leave blank to skip):");

        if (registry.trim()) {
            const remoteTag = `${registry.trim()}/${projectName}:latest`;
            info(`Tagging as ${remoteTag}...`);
            await execa("docker", ["tag", imageName, remoteTag], { stdio: "inherit" });

            info(`Pushing ${remoteTag}...`);
            console.log();
            try {
                await execa("docker", ["push", remoteTag], {
                    cwd: projectRoot,
                    stdio: "inherit",
                });
                console.log();
                success(`Image pushed: ${remoteTag}`);
            } catch {
                error("Push failed. Make sure you are logged in: docker login");
            }
        }
    }

    console.log();
    success("fixd deploy complete.");
}
