import { spawn } from "node:child_process";
import type { Logger } from "../core/logger.js";

export interface TemplateContext {
  input: string;
  output: string;
  mappings: string;
  version: string;
  kind: string;
}

export interface CommandExecutionResult {
  command: string;
  ok: boolean;
  stderr: string;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{(input|output|mappings|version|kind)\}/g, (_, key: keyof TemplateContext) =>
    shellEscape(context[key]),
  );
}

export async function executeTemplateCommand(
  template: string,
  context: TemplateContext,
  logger: Logger,
): Promise<CommandExecutionResult> {
  const command = renderTemplate(template, context);
  logger.debug(`Executing command: ${command}`);

  const stderrChunks: string[] = [];
  const child = spawn(command, {
    shell: true,
    stdio: ["ignore", "inherit", "pipe"],
  });

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  return {
    command,
    ok: exitCode === 0,
    stderr: stderrChunks.join(""),
  };
}
