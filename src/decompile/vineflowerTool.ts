import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

export type VineflowerSource =
  | "env-command"
  | "env-jar"
  | "workspace-tools-jar"
  | "project-tools-jar"
  | "path"
  | "missing";

export interface ResolvedVineflowerTool {
  command?: string;
  source: VineflowerSource;
  location?: string;
  message: string;
  searchedPaths: string[];
}

export function resolveVineflowerTool(projectRoot: string, workspaceRoot: string): ResolvedVineflowerTool {
  const explicitCommand = process.env.MCDATAHUB_VINEFLOWER_CMD?.trim();
  if (explicitCommand) {
    return {
      command: explicitCommand,
      source: "env-command",
      location: "MCDATAHUB_VINEFLOWER_CMD",
      message: "Using MCDATAHUB_VINEFLOWER_CMD from the environment.",
      searchedPaths: [
        "MCDATAHUB_VINEFLOWER_CMD",
        "MCDATAHUB_VINEFLOWER_JAR",
        join(workspaceRoot, "tools"),
        join(projectRoot, "tools"),
        "PATH: vineflower, fernflower",
      ],
    };
  }

  const configuredJar = process.env.MCDATAHUB_VINEFLOWER_JAR?.trim();
  if (configuredJar) {
    const jarPath = resolvePath(projectRoot, configuredJar);
    if (!existsSync(jarPath)) {
      return {
        source: "missing",
        location: jarPath,
        message: `MCDATAHUB_VINEFLOWER_JAR points to a missing file: ${jarPath}`,
        searchedPaths: [
          "MCDATAHUB_VINEFLOWER_CMD",
          jarPath,
          join(workspaceRoot, "tools"),
          join(projectRoot, "tools"),
          "PATH: vineflower, fernflower",
        ],
      };
    }

    return {
      command: buildJarCommand(jarPath),
      source: "env-jar",
      location: jarPath,
      message: `Using Vineflower JAR from MCDATAHUB_VINEFLOWER_JAR: ${jarPath}`,
      searchedPaths: [
        "MCDATAHUB_VINEFLOWER_CMD",
        jarPath,
        join(workspaceRoot, "tools"),
        join(projectRoot, "tools"),
        "PATH: vineflower, fernflower",
      ],
    };
  }

  const workspaceToolDir = join(workspaceRoot, "tools");
  const workspaceJar = findVineflowerJar(workspaceToolDir);
  if (workspaceJar) {
    return {
      command: buildJarCommand(workspaceJar),
      source: "workspace-tools-jar",
      location: workspaceJar,
      message: `Using Vineflower JAR from workspace tools: ${workspaceJar}`,
      searchedPaths: [
        "MCDATAHUB_VINEFLOWER_CMD",
        "MCDATAHUB_VINEFLOWER_JAR",
        workspaceToolDir,
        join(projectRoot, "tools"),
        "PATH: vineflower, fernflower",
      ],
    };
  }

  const projectToolDir = join(projectRoot, "tools");
  const projectJar = findVineflowerJar(projectToolDir);
  if (projectJar) {
    return {
      command: buildJarCommand(projectJar),
      source: "project-tools-jar",
      location: projectJar,
      message: `Using Vineflower JAR from project tools: ${projectJar}`,
      searchedPaths: [
        "MCDATAHUB_VINEFLOWER_CMD",
        "MCDATAHUB_VINEFLOWER_JAR",
        workspaceToolDir,
        projectToolDir,
        "PATH: vineflower, fernflower",
      ],
    };
  }

  const executable = findExecutableOnPath(["vineflower", "fernflower"]);
  if (executable) {
    return {
      command: `${shellEscape(executable)} {input} {output}`,
      source: "path",
      location: executable,
      message: `Using Vineflower executable from PATH: ${executable}`,
      searchedPaths: [
        "MCDATAHUB_VINEFLOWER_CMD",
        "MCDATAHUB_VINEFLOWER_JAR",
        workspaceToolDir,
        projectToolDir,
        "PATH: vineflower, fernflower",
      ],
    };
  }

  return {
    source: "missing",
    message:
      "No Vineflower tool was detected. Set MCDATAHUB_VINEFLOWER_CMD, set MCDATAHUB_VINEFLOWER_JAR, place vineflower.jar in workspace/tools or ./tools, or install a vineflower executable.",
    searchedPaths: [
      "MCDATAHUB_VINEFLOWER_CMD",
      "MCDATAHUB_VINEFLOWER_JAR",
      workspaceToolDir,
      projectToolDir,
      "PATH: vineflower, fernflower",
    ],
  };
}

function resolvePath(projectRoot: string, value: string): string {
  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

function buildJarCommand(path: string): string {
  return `java -jar ${shellEscape(path)} {input} {output}`;
}

function findVineflowerJar(directory: string): string | undefined {
  if (!existsSync(directory)) {
    return undefined;
  }

  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^vineflower(?:[-.].+)?\.jar$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => compareJarNames(left, right));

  return candidates[0];
}

function compareJarNames(left: string, right: string): number {
  const leftName = basename(left).toLowerCase();
  const rightName = basename(right).toLowerCase();
  if (leftName === "vineflower.jar" && rightName !== "vineflower.jar") {
    return -1;
  }
  if (rightName === "vineflower.jar" && leftName !== "vineflower.jar") {
    return 1;
  }
  return leftName.localeCompare(rightName);
}

function findExecutableOnPath(names: string[]): string | undefined {
  const segments = (process.env.PATH ?? "")
    .split(delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    for (const name of names) {
      const candidate = join(segment, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
