import chalk from "chalk";
import { sendMessage, disconnect } from "./lib/agent.js";
import {
    printHeader,
    agentSays,
    section,
    info,
    warn,
    spin,
    confirm,
    closePrompt,
    bye,
} from "./lib/display.js";

export async function runDeploy() {
    printHeader("deploy");
    info(`deploying project at ${chalk.white(process.cwd())}`);
    console.log();

    const go = await confirm(
        "this will containerize your project and deploy it to nosana. continue?"
    );

    if (!go) {
        info("cancelled.");
        closePrompt();
        return;
    }

    section("containerizing");
    const dockerSpinner = spin("generating dockerfile...");

    const dockerResponse = await sendMessage(
        `Generate a production-ready Dockerfile for the project at ${process.cwd()}. ` +
        `Analyse the package.json and tsconfig to determine the correct build steps, entry point, and exposed port. ` +
        `Output the Dockerfile content in a \`\`\`Dockerfile block. ` +
        `Then describe how to deploy it to the Nosana GPU network using the Nosana job definition format.`,
        "generate"
    ).catch((err: any) => {
        dockerSpinner.stop();
        warn(err.message);
        return [];
    });

    dockerSpinner.stop();

    for (const msg of dockerResponse) {
        agentSays(msg.text);
    }

    closePrompt();
    bye();
    disconnect();
}