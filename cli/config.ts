// ─── Endpoint configuration manager ───────────────────────────────────────────
// Manages LLM endpoints and task routing via ~/.config/fixd/config.json.

import chalk from "chalk";
import { spin, info, success, warn, error } from "./lib/display.js";
import {
    loadConfig,
    saveConfig,
    invalidateConfig,
    CONFIG_PATH,
    type Endpoint,
    type Compatibility,
    type TaskName,
    type FixdConfig,
} from "./lib/endpoints.js";
import { endpointFetch } from "./lib/adapters/dispatch.js";

// ─── Interactive wizard ──────────────────────────────────────────────────────

export async function runConfigWizard(): Promise<void> {
    console.log();
    console.log(`  ${chalk.bold.white("fixd config")}`);
    console.log(`  ${chalk.dim("Manage LLM Endpoints")}`);
    console.log();

    let config = await loadConfig();
    let running = true;

    while (running) {
        console.log(`  ${chalk.bold("Endpoints:")}`);
        if (config.endpoints.length === 0) {
            console.log(`    ${chalk.dim("(none configured)")}`);
        } else {
            for (const ep of config.endpoints) {
                const keyStatus = ep.apiKey ? chalk.green("✓ key") : chalk.dim("no key");
                console.log(`    ${chalk.cyan("●")} ${chalk.white(ep.name)} ${chalk.dim(`(${ep.compatibility})`)} ${keyStatus}`);
            }
        }
        console.log();

        console.log(`  ${chalk.bold("Task Routing:")}`);
        const tasks: TaskName[] = ["classify", "explain", "generate", "diagnose", "chat"];
        for (const task of tasks) {
            const route = config.routing[task];
            if (route?.endpoint) {
                console.log(`    ${chalk.dim(task.padEnd(12))} → ${chalk.white(route.endpoint)} / ${chalk.dim(route.model)}`);
            } else {
                console.log(`    ${chalk.dim(task.padEnd(12))} → ${chalk.dim("(unset)")}`);
            }
        }
        console.log();

        console.log(`  ${chalk.bold("Actions:")}`);
        console.log(`    ${chalk.cyan("1.")} Add Endpoint`);
        console.log(`    ${chalk.cyan("2.")} Edit Endpoint`);
        console.log(`    ${chalk.cyan("3.")} Remove Endpoint`);
        console.log(`    ${chalk.cyan("4.")} Configure Task Routing`);
        console.log(`    ${chalk.cyan("5.")} Test Endpoint`);
        console.log(`    ${chalk.cyan("q.")} Quit`);
        console.log();

        const { prompt } = await import("./lib/display.js");
        const choice = (await prompt("choice")).trim();

        switch (choice) {
            case "1": config = await addEndpoint(config); break;
            case "2": config = await editEndpoint(config); break;
            case "3": config = await removeEndpoint(config); break;
            case "4": config = await configureRouting(config); break;
            case "5": await testEndpoint(config); break;
            case "q":
            case "quit":
            case "exit":
                running = false;
                break;
            default:
                if (choice) console.log(`  ${chalk.dim("Unknown choice. Enter 1-5 or q.")}`);
        }
        console.log();
    }

    info(`Config saved to ${CONFIG_PATH}`);
}

// ─── Add endpoint ────────────────────────────────────────────────────────────

async function addEndpoint(config: FixdConfig): Promise<FixdConfig> {
    const { prompt } = await import("./lib/display.js");
    console.log();
    console.log(`  ${chalk.bold("Add Endpoint")}`);
    console.log();

    const name = (await prompt("endpoint name")).trim();
    if (!name) { console.log(`  ${chalk.dim("cancelled")}`); return config; }
    if (config.endpoints.some((e) => e.name === name)) {
        console.log(`  ${chalk.yellow("⚠")} Endpoint "${name}" already exists.`);
        return config;
    }

    const baseUrl = (await prompt("base URL (e.g. https://api.openai.com/v1)")).trim();
    if (!baseUrl) { console.log(`  ${chalk.dim("cancelled")}`); return config; }

    console.log();
    console.log(`  ${chalk.bold("Compatibility:")}`);
    console.log(`    ${chalk.cyan("1.")} OpenAI Compatible`);
    console.log(`    ${chalk.cyan("2.")} Anthropic`);
    console.log(`    ${chalk.cyan("3.")} Gemini`);
    console.log(`    ${chalk.cyan("4.")} Ollama`);
    const compatChoice = (await prompt("choice (1-4)")).trim();
    const compatMap: Record<string, Compatibility> = { "1": "openai", "2": "anthropic", "3": "gemini", "4": "ollama" };
    const compatibility = compatMap[compatChoice] ?? "openai";

    const apiKey = (await prompt("API key (press enter to skip for local endpoints)")).trim() || undefined;

    const endpoint: Endpoint = {
        name,
        baseUrl: baseUrl.replace(/\/$/, ""),
        compatibility,
        apiKey,
        models: [],
    };

    const discovered = await discoverModels(endpoint);
    if (discovered.length > 0) {
        console.log();
        console.log(`  ${chalk.bold("Available models:")}`);
        for (const m of discovered) console.log(`    ${chalk.dim(">")} ${chalk.white(m)}`);
        console.log(`  ${chalk.dim("(select during task routing)")}`);
        endpoint.models = discovered;
    } else {
        console.log();
        console.log(`  ${chalk.yellow("⚠")} Couldn't list models.`);
        const manual = (await prompt("Enter model name manually (or press enter to skip)")).trim();
        if (manual) endpoint.models = [manual];
    }

    config.endpoints.push(endpoint);
    await saveConfig(config);
    invalidateConfig();
    success(`Endpoint "${name}" added.`);
    return config;
}

// ─── Edit endpoint ───────────────────────────────────────────────────────────

async function editEndpoint(_config: FixdConfig): Promise<FixdConfig> {
    console.log(`  ${chalk.dim("Not yet implemented. Remove and re-add the endpoint.")}`);
    return _config;
}

// ─── Remove endpoint ─────────────────────────────────────────────────────────

async function removeEndpoint(config: FixdConfig): Promise<FixdConfig> {
    const { prompt } = await import("./lib/display.js");
    if (config.endpoints.length === 0) {
        console.log(`  ${chalk.dim("No endpoints to remove.")}`);
        return config;
    }
    console.log();
    for (let i = 0; i < config.endpoints.length; i++) {
        console.log(`    ${chalk.cyan(`${i + 1}.`)} ${config.endpoints[i].name}`);
    }
    const choice = (await prompt("remove which endpoint? (number)")).trim();
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= config.endpoints.length) {
        console.log(`  ${chalk.dim("cancelled")}`);
        return config;
    }
    const removed = config.endpoints.splice(idx, 1)[0];
    for (const task of Object.keys(config.routing) as TaskName[]) {
        if (config.routing[task].endpoint === removed.name) {
            config.routing[task] = { endpoint: "", model: "" };
        }
    }
    await saveConfig(config);
    invalidateConfig();
    success(`Endpoint "${removed.name}" removed.`);
    return config;
}

// ─── Configure task routing ──────────────────────────────────────────────────

async function configureRouting(config: FixdConfig): Promise<FixdConfig> {
    const { prompt } = await import("./lib/display.js");
    if (config.endpoints.length === 0) {
        console.log(`  ${chalk.dim("Add an endpoint first.")}`);
        return config;
    }
    console.log();
    console.log(`  ${chalk.bold("Configure Task Routing")}`);
    console.log(`  ${chalk.dim("Select an endpoint and model for each task type.")}`);
    console.log();

    const tasks: TaskName[] = ["classify", "explain", "generate", "diagnose", "chat"];
    for (const task of tasks) {
        console.log(`  ${chalk.bold(`${task}:`)}`);
        for (let i = 0; i < config.endpoints.length; i++) {
            const ep = config.endpoints[i];
            console.log(`    ${chalk.cyan(`${i + 1}.`)} ${ep.name} ${chalk.dim(`(${ep.compatibility})`)}`);
        }
        const choice = (await prompt(`  endpoint for ${task} (1-${config.endpoints.length}, or enter to skip)`)).trim();
        if (!choice) continue;
        const idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= config.endpoints.length) continue;
        const ep = config.endpoints[idx];

        let model = "";
        if (ep.models.length > 0) {
            console.log();
            console.log(`  ${chalk.bold("Available models:")}`);
            for (let i = 0; i < ep.models.length; i++) {
                console.log(`    ${chalk.cyan(`${i + 1}.`)} ${ep.models[i]}`);
            }
            const mChoice = (await prompt(`  model for ${task} (1-${ep.models.length}, or type manually)`)).trim();
            const mIdx = parseInt(mChoice, 10) - 1;
            model = (!isNaN(mIdx) && mIdx >= 0 && mIdx < ep.models.length)
                ? ep.models[mIdx]
                : mChoice;
        } else {
            model = (await prompt(`  model name for ${task}`)).trim();
        }
        if (model) {
            config.routing[task] = { endpoint: ep.name, model };
            console.log(`  ${chalk.green("✔")} ${task} → ${ep.name} / ${model}`);
        }
        console.log();
    }

    await saveConfig(config);
    invalidateConfig();
    success("Task routing updated.");
    return config;
}

// ─── Test endpoint ────────────────────────────────────────────────────────────

async function testEndpoint(config: FixdConfig): Promise<void> {
    const { prompt } = await import("./lib/display.js");
    if (config.endpoints.length === 0) {
        console.log(`  ${chalk.dim("No endpoints to test.")}`);
        return;
    }
    console.log();
    for (let i = 0; i < config.endpoints.length; i++) {
        console.log(`    ${chalk.cyan(`${i + 1}.`)} ${config.endpoints[i].name}`);
    }
    const choice = (await prompt("test which endpoint? (number)")).trim();
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= config.endpoints.length) {
        console.log(`  ${chalk.dim("cancelled")}`);
        return;
    }
    const ep = config.endpoints[idx];
    const model = ep.models[0] ?? "unknown";

    const s = spin(`testing ${ep.name} with model "${model}"...`);
    try {
        const res = await endpointFetch(ep, {
            model,
            messages: [{ role: "user", content: "Reply with just: ok" }],
            max_tokens: 10,
            temperature: 0,
        });
        s.stop();
        if (res.ok) {
            const data = await res.json().catch(() => ({})) as any;
            const text = data?.choices?.[0]?.message?.content ?? "(empty response)";
            console.log(`  ${chalk.green("✔")} ${ep.name} reachable`);
            console.log(`  ${chalk.dim("response:")} ${text.slice(0, 60)}`);
        } else {
            const errText = await res.text().catch(() => "").then((t: string) => t.slice(0, 200));
            console.log(`  ${chalk.red("✖")} ${ep.name} returned ${res.status}`);
            if (errText) console.log(`  ${chalk.dim(errText)}`);
        }
    } catch (err: any) {
        s.stop();
        console.log(`  ${chalk.red("✖")} ${ep.name} unreachable: ${err.message}`);
    }
}

// ─── Model discovery ─────────────────────────────────────────────────────────

async function discoverModels(endpoint: Endpoint): Promise<string[]> {
    if (endpoint.compatibility === "openai") {
        try {
            const headers: Record<string, string> = {};
            if (endpoint.apiKey) headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
            const res = await fetch(`${endpoint.baseUrl}/models`, {
                headers,
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return [];
            const data = await res.json() as any;
            const models: string[] = (data?.data ?? [])
                .map((m: any) => m.id ?? m.name ?? "")
                .filter(Boolean)
                .sort();
            return models.slice(0, 30);
        } catch {
            return [];
        }
    }

    if (endpoint.compatibility === "ollama") {
        try {
            const res = await fetch(`${endpoint.baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) return [];
            const data = await res.json() as any;
            return ((data?.models ?? []) as any[]).map((m: any) => m.name ?? m.model ?? "").filter(Boolean).sort();
        } catch {
            return [];
        }
    }

    return [];
}

// ─── CLI subcommand handlers ─────────────────────────────────────────────────

export async function runConfigList(): Promise<void> {
    const config = await loadConfig();
    if (config.endpoints.length === 0) {
        console.log("(no endpoints configured)");
        console.log(`Run ${chalk.white("fixd config")} to set up endpoints.`);
        return;
    }
    for (const ep of config.endpoints) {
        console.log(`${ep.name}  ${ep.compatibility}  ${ep.baseUrl}  ${ep.apiKey ? "🔑" : "no-key"}  models: ${ep.models.join(", ") || "(none)"}`);
    }
    console.log();
    console.log("Task routing:");
    for (const [task, route] of Object.entries(config.routing)) {
        if (route.endpoint) {
            console.log(`  ${task} → ${route.endpoint} / ${route.model}`);
        }
    }
}

export async function runConfigRouting(): Promise<void> {
    const config = await loadConfig();
    for (const [task, route] of Object.entries(config.routing)) {
        console.log(`${task} → ${route.endpoint || "(unset)"} / ${route.model || "(unset)"}`);
    }
}

export async function runConfigTest(name: string): Promise<void> {
    const config = await loadConfig();
    const ep = config.endpoints.find((e) => e.name === name);
    if (!ep) {
        console.log(`Endpoint "${name}" not found.`);
        return;
    }
    const s = spin(`testing ${ep.name}...`);
    const model = ep.models[0] ?? "unknown";
    try {
        const res = await endpointFetch(ep, {
            model,
            messages: [{ role: "user", content: "Reply with just: ok" }],
            max_tokens: 10,
            temperature: 0,
        });
        s.stop();
        if (res.ok) {
            const data = await res.json().catch(() => ({})) as any;
            const text = data?.choices?.[0]?.message?.content ?? "(empty)";
            console.log(`${chalk.green("✔")} ${ep.name} reachable — response: ${text.slice(0, 60)}`);
        } else {
            console.log(`${chalk.red("✖")} ${ep.name} returned ${res.status}`);
        }
    } catch (err: any) {
        s.stop();
        console.log(`${chalk.red("✖")} ${ep.name} unreachable: ${err.message}`);
    }
}
