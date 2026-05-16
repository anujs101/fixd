import chalk from "chalk";
import ora, { type Ora } from "ora";
import readline from "readline";

// ─── Color Palette ────────────────────────────────────────────────────────────
//
//  cyan   #00D4FF  brand, headers, bullets, agent id
//  violet #925FD8  agent thinking / internal reasoning
//  green  #00E87A  success, fixes applied, LOW severity
//  amber  #FFB800  warnings, MEDIUM severity, inline code
//  rose   #FF4F5E  errors, HIGH severity
//  white          main response text
//  dim            metadata, decorators, borders

const C = {
    cyan:   (s: string) => chalk.hex("#00D4FF")(s),
    violet: (s: string) => chalk.hex("#9D6FDB")(s),
    green:  (s: string) => chalk.hex("#00E87A")(s),
    amber:  (s: string) => chalk.hex("#FFB800")(s),
    rose:   (s: string) => chalk.hex("#FF4F5E")(s),
    white:  chalk.white,
    dim:    chalk.dim,
    bold:   chalk.bold,
};

// ─── Brand ────────────────────────────────────────────────────────────────────

export const BRAND = chalk.bold.hex("#00D4FF")("fixd");
export const ARROW = chalk.dim("›");
export const SEP   = chalk.dim("─".repeat(50));

// ─── Spinner ──────────────────────────────────────────────────────────────────

let activeSpinner: Ora | null = null;

export function spin(text: string): Ora {
    activeSpinner = ora({
        text: chalk.dim(text),
        spinner: "dots",
        color: "cyan",
    }).start();
    return activeSpinner;
}

export function stopSpin() {
    activeSpinner?.stop();
    activeSpinner = null;
}

// ─── Header ───────────────────────────────────────────────────────────────────

export function printHeader(command: string) {
    console.log();
    console.log(`  ${BRAND} ${ARROW} ${C.cyan(command)}`);
    console.log(`  ${chalk.dim("dev environment agent · openrouter + groq")}`);
    console.log(`  ${SEP}`);
    console.log();
}

// ─── Inline Markdown ──────────────────────────────────────────────────────────
//  **bold**, *italic*, `code`, [HIGH], [MEDIUM], [LOW]

function renderInline(text: string): string {
    return text
        // **bold** or __bold__
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => chalk.bold.white(a ?? b))
        // *italic*
        .replace(/\*([^*]+)\*/g, (_, a) => chalk.italic.white(a))
        // `inline code`
        .replace(/`([^`]+)`/g, (_, a) => C.amber(` ${a} `))
        // Severity badges inline
        .replace(/\[(HIGH)\]/g,   () => chalk.bgRed.white.bold(" HIGH "))
        .replace(/\[(MEDIUM)\]/g, () => chalk.bgHex("#FFB800").black.bold(" MEDIUM "))
        .replace(/\[(LOW)\]/g,    () => chalk.bgGray.white(" LOW "))
        // **HIGH —** style severity headers (without brackets)
        .replace(/\*\*(HIGH)\s*[—–-]/g,   () => chalk.bold.hex("#FF4F5E")("■ HIGH —"))
        .replace(/\*\*(MEDIUM)\s*[—–-]/g, () => chalk.bold.hex("#FFB800")("■ MEDIUM —"))
        .replace(/\*\*(LOW)\s*[—–-]/g,    () => chalk.bold.hex("#00E87A")("■ LOW —"));
}

// ─── Code Block Renderer ──────────────────────────────────────────────────────

function renderCodeBlock(lines: string[], lang: string, prefix: string): string[] {
    const width = Math.max(50, ...lines.map((l) => l.length)) + 4;
    const bar = chalk.dim("─".repeat(width));
    const tag = lang ? C.amber(` ${lang} `) : "";

    const out: string[] = [];
    out.push(`${prefix}  ${chalk.dim("┌")}${bar}${tag}`);
    for (const line of lines) {
        // Highlight common keywords across TypeScript / shell / prisma
        const coloredLine = line
            .replace(/\b(import|export|from|const|let|var|async|await|return|function|type|interface|class|new|if|else|for|of|in)\b/g,
                (m) => chalk.hex("#925FD8")(m))
            .replace(/\b(true|false|null|undefined|void)\b/g,
                (m) => chalk.hex("#FF8C5A")(m))
            .replace(/"([^"]+)"/g, (_, s) => C.green(`"${s}"`))
            .replace(/'([^']+)'/g, (_, s) => C.green(`'${s}'`))
            .replace(/(\/\/.*$)/gm, (_, c) => chalk.dim(c));

        out.push(`${prefix}  ${chalk.dim("│")} ${coloredLine}`);
    }
    out.push(`${prefix}  ${chalk.dim("└")}${bar}`);
    return out;
}

// ─── Markdown Block Renderer ──────────────────────────────────────────────────
//  Parses and renders a block of markdown text into terminal lines.

function renderMarkdown(text: string, prefix = "  "): string[] {
    const out: string[] = [];
    const rawLines = text.split("\n");

    let inCode = false;
    let codeLang = "";
    let codeBuffer: string[] = [];

    for (const line of rawLines) {
        // Code block fence
        if (line.startsWith("```")) {
            if (inCode) {
                out.push(...renderCodeBlock(codeBuffer, codeLang, prefix));
                codeBuffer = [];
                inCode = false;
            } else {
                inCode = true;
                codeLang = line.slice(3).trim();
            }
            continue;
        }

        if (inCode) {
            codeBuffer.push(line);
            continue;
        }

        // Empty line
        if (!line.trim()) {
            out.push("");
            continue;
        }

        // H1 — cyan bold
        if (/^#\s/.test(line)) {
            out.push(`${prefix}${C.cyan(chalk.bold(line.replace(/^#\s/, "")))}`);
            out.push(`${prefix}${chalk.dim("─".repeat(40))}`);
            continue;
        }

        // H2/H3 — white bold
        if (/^#{2,3}\s/.test(line)) {
            out.push(`${prefix}${chalk.bold.white(line.replace(/^#{2,3}\s/, ""))}`);
            continue;
        }

        // Bullet or dash list
        if (/^[-*•]\s/.test(line)) {
            const content = line.replace(/^[-*•]\s/, "");
            out.push(`${prefix}  ${C.cyan("●")} ${renderInline(content)}`);
            continue;
        }

        // Numbered list
        const numMatch = line.match(/^(\d+)\.\s(.+)/);
        if (numMatch) {
            out.push(`${prefix}  ${chalk.dim(numMatch[1] + ".")} ${renderInline(numMatch[2])}`);
            continue;
        }

        // Regular paragraph — render inline markdown
        out.push(`${prefix}${renderInline(line)}`);
    }

    // Non-closed code block
    if (inCode && codeBuffer.length > 0) {
        out.push(...renderCodeBlock(codeBuffer, codeLang, prefix));
    }

    return out;
}

// ─── XML Block Parser ─────────────────────────────────────────────────────────
//
//  Handled tags:
//    <thought>   — agent's internal reasoning
//    <text>      — main response text
//    <prompt>    — suggested follow-up prompts
//    <source>    — citations / references
//    <data>      — raw data payloads

type XmlBlock = { tag: string; content: string };

function parseAgentBlocks(raw: string): XmlBlock[] {
    const blocks: XmlBlock[] = [];

    // Unwrap outer <response> if present
    const responseMatch = raw.match(/<response>([\s\S]*?)<\/response>/i);
    const inner = responseMatch ? responseMatch[1] : raw;

    // If no known XML tags, treat as plain text
    if (!/<(thought|text|source|data|prompt)[\s>]/i.test(inner)) {
        const cleaned = inner.replace(/<[^>]+>/g, "").trim();
        return cleaned ? [{ tag: "text", content: cleaned }] : [];
    }

    const tagRe = /<(thought|text|source|data|prompt)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(inner)) !== null) {
        // Any raw text before this tag
        const before = inner.slice(lastIndex, match.index).replace(/<[^>]+>/g, "").trim();
        if (before) blocks.push({ tag: "text", content: before });

        blocks.push({ tag: match[1].toLowerCase(), content: match[2].trim() });
        lastIndex = match.index + match[0].length;
    }

    // Trailing text after last tag
    const after = inner.slice(lastIndex).replace(/<[^>]+>/g, "").trim();
    if (after) blocks.push({ tag: "text", content: after });

    return blocks.length > 0 ? blocks : [{ tag: "text", content: inner.replace(/<[^>]+>/g, "").trim() }];
}

// ─── Block Visual Renderers ───────────────────────────────────────────────────

function renderThoughtBlock(content: string) {
    // Dim violet, with ┆ left border — signals internal reasoning
    console.log();
    console.log(`  ${C.violet("┆")} ${chalk.dim.italic(C.violet("thinking"))}`);
    for (const line of content.split("\n")) {
        if (!line.trim()) { console.log(`  ${C.violet("┆")}`); continue; }
        console.log(`  ${C.violet("┆")} ${chalk.dim(renderInline(line))}`);
    }
    console.log(`  ${C.violet("┆")}`);
}

function renderTextBlock(content: string) {
    // Main response — left border │ in cyan, white text
    const lines = renderMarkdown(content, "");
    for (const line of lines) {
        if (!line) { console.log(); continue; }
        console.log(`  ${chalk.dim("│")} ${line}`);
    }
}

function renderPromptBlock(content: string) {
    // Suggestion box — amber, indented
    console.log();
    console.log(`  ${C.amber("┌─")} ${C.amber(chalk.bold("suggestion"))}`);
    for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        console.log(`  ${C.amber("│")}  ${C.amber(renderInline(line))}`);
    }
    console.log(`  ${C.amber("└")}${chalk.dim("─".repeat(46))}`);
}

function renderSourceBlock(content: string) {
    // Dim citation block
    console.log();
    console.log(`  ${chalk.dim("· source")}  ${chalk.dim.underline(content.trim())}`);
}

function renderDataBlock(content: string) {
    // Treat data as a code block
    const lang = "json";
    const lines = content.trim().split("\n");
    const rendered = renderCodeBlock(lines, lang, "");
    for (const l of rendered) console.log(l);
}

// ─── Main: agentSays ─────────────────────────────────────────────────────────

export function agentSays(raw: string) {
    stopSpin();
    if (!raw?.trim()) return;

    const blocks = parseAgentBlocks(raw);
    if (blocks.length === 0) return;

    console.log();
    console.log(`  ${C.cyan("╭─")} ${BRAND} ${chalk.dim("says")}`);

    for (const block of blocks) {
        switch (block.tag) {
            case "thought": renderThoughtBlock(block.content); break;
            case "text":    renderTextBlock(block.content);    break;
            case "prompt":  renderPromptBlock(block.content);  break;
            case "source":  renderSourceBlock(block.content);  break;
            case "data":    renderDataBlock(block.content);    break;
            default:        renderTextBlock(block.content);    break;
        }
    }

    console.log(`  ${C.cyan("╰")}${chalk.dim("─".repeat(48))}`);
    console.log();
}

// ─── Status messages ──────────────────────────────────────────────────────────

export function info(msg: string) {
    console.log(`  ${C.cyan("ℹ")} ${chalk.dim(msg)}`);
}

export function success(msg: string) {
    console.log(`  ${C.green("✔")} ${msg}`);
}

export function warn(msg: string) {
    console.log(`  ${C.amber("⚠")} ${C.amber(msg)}`);
}

export function error(msg: string) {
    console.log(`  ${C.rose("✖")} ${C.rose(msg)}`);
}

export function step(n: number, total: number, msg: string) {
    console.log(`  ${chalk.dim(`[${n}/${total}]`)} ${msg}`);
}

// ─── Issue display ────────────────────────────────────────────────────────────

export function printIssue(severity: "HIGH" | "MEDIUM" | "LOW", description: string) {
    const badge =
        severity === "HIGH"
            ? chalk.bgHex("#FF4F5E").white.bold("  HIGH  ")
            : severity === "MEDIUM"
                ? chalk.bgHex("#FFB800").black.bold(" MEDIUM ")
                : chalk.bgGray.white("  LOW   ");

    const icon =
        severity === "HIGH"   ? C.rose("●") :
        severity === "MEDIUM" ? C.amber("●") :
                                C.green("●");

    console.log(`  ${icon} ${badge}  ${chalk.bold.white(description)}`);
}

export function printFix(description: string, diff?: string) {
    console.log(`  ${C.green("→")} ${chalk.white(description)}`);
    if (diff) {
        console.log();
        for (const line of diff.split("\n")) {
            if (line.startsWith("+++") || line.startsWith("---")) {
                console.log(chalk.dim(`     ${line}`));
            } else if (line.startsWith("+")) {
                console.log(C.green(`     ${line}`));
            } else if (line.startsWith("-")) {
                console.log(C.rose(`     ${line}`));
            } else {
                console.log(chalk.dim(`     ${line}`));
            }
        }
        console.log();
    }
}

// ─── Section divider ──────────────────────────────────────────────────────────

export function section(title: string) {
    console.log();
    console.log(`  ${chalk.bold.white(title)}`);
    console.log(`  ${chalk.dim("─".repeat(40))}`);
}

// ─── Command approval display ───────────────────────────────────────────────

/**
 * Shows a styled "agent wants to run" permission request.
 * Call this before asking the confirm() prompt.
 * @param cwd - the project directory being operated on (not process.cwd())
 */
export function agentWantsToRun(command: string, reason?: string, cwd?: string) {
    const bar = chalk.dim("─".repeat(54));
    console.log();
    console.log(`  ${C.amber("╭─")} ${C.amber(chalk.bold("agent wants to run"))}`);
    if (reason) {
        console.log(`  ${C.amber("│")}  ${chalk.dim(reason)}`);
    }
    console.log(`  ${C.amber("│")}`);
    console.log(`  ${C.amber("│")}  ${chalk.dim("$")} ${chalk.bold.white(command)}`);
    console.log(`  ${C.amber("│")}`);
    console.log(`  ${C.amber("│")}  ${chalk.dim("cwd: ")}${chalk.dim(cwd ?? process.cwd())}`);
    console.log(`  ${C.amber("╰")}${bar}`);
}

/**
 * Shows the result of an executed command.
 */
export function printCommandResult(result: { command: string; stdout: string; stderr: string; exitCode: number; durationMs: number }) {
    const ok = result.exitCode === 0;
    const badge = ok
        ? chalk.bgHex("#00E87A").black.bold(" ✔ OK ")
        : chalk.bgHex("#FF4F5E").white.bold(" ✖ FAIL ");
    const timing = chalk.dim(`${result.durationMs}ms`);

    console.log();
    console.log(`  ${badge}  ${chalk.dim("$")} ${chalk.bold.white(result.command)}  ${timing}`);

    if (result.stdout) {
        const lines = result.stdout.split("\n").slice(0, 40);  // cap at 40 lines
        const bar  = chalk.dim("─".repeat(52));
        console.log(`  ${chalk.dim("┌")}${bar}`);
        for (const line of lines) {
            // Highlight error/warning keywords in output
            const colored = line
                .replace(/\berror\b/gi, C.rose("error"))
                .replace(/\bwarning\b/gi, C.amber("warning"))
                .replace(/(\d+)\s+error/gi, (_, n) => C.rose(`${n} error`))
                .replace(/(\d+)\s+warning/gi, (_, n) => C.amber(`${n} warning`));
            console.log(`  ${chalk.dim("│")} ${colored}`);
        }
        if (result.stdout.split("\n").length > 40) {
            console.log(`  ${chalk.dim("│")} ${chalk.dim("... (truncated)")}`)
        }
        console.log(`  ${chalk.dim("└")}${bar}`);
    }

    if (result.stderr) {
        console.log(`  ${C.rose("stderr:")}`);
        for (const line of result.stderr.split("\n").slice(0, 20)) {
            console.log(`  ${C.rose("│")} ${chalk.dim(line)}`);
        }
    }
    console.log();
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

export function prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(
            `\n  ${C.cyan("?")} ${chalk.bold.white(question)} ${chalk.dim("› ")}`,
            (answer) => resolve(answer.trim())
        );
    });
}

export function confirm(question: string): Promise<boolean> {
    return new Promise((resolve) => {
        rl.question(
            `\n  ${C.cyan("?")} ${chalk.bold.white(question)} ${chalk.dim("(y/n) › ")}`,
            (answer) => resolve(answer.trim().toLowerCase().startsWith("y"))
        );
    });
}

export function closePrompt() {
    rl.close();
}

// ─── Goodbye ──────────────────────────────────────────────────────────────────

export function bye() {
    console.log();
    console.log(`  ${chalk.dim("goodbye.")}`);
    console.log();
}