import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = ["MCDATAHUB_WORKSPACE_ROOT", "MCDATAHUB_VINEFLOWER_CMD", "MCDATAHUB_VINEFLOWER_JAR", "PATH"] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  await Promise.all(
    Array.from(tempDirs, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  tempDirs.clear();
});

describe("config toolchain discovery", () => {
  test("prefers MCDATAHUB_VINEFLOWER_CMD when it is set", async () => {
    const projectRoot = await createTempProject();
    process.env.PATH = "";
    process.env.MCDATAHUB_VINEFLOWER_CMD = "custom-vineflower {input} {output}";

    const config = loadConfig(projectRoot);

    expect(config.toolchain.vineflowerCommand).toBe("custom-vineflower {input} {output}");
    expect(config.toolchain.vineflower.source).toBe("env-command");
    expect(config.toolchain.vineflower.location).toBe("MCDATAHUB_VINEFLOWER_CMD");
  });

  test("auto-detects workspace/tools/vineflower.jar", async () => {
    const projectRoot = await createTempProject();
    process.env.PATH = "";

    const jarPath = join(projectRoot, "workspace", "tools", "vineflower.jar");
    await mkdir(join(projectRoot, "workspace", "tools"), { recursive: true });
    await writeFile(jarPath, "");

    const config = loadConfig(projectRoot);

    expect(config.toolchain.vineflowerCommand).toBe(`java -jar '${jarPath}' {input} {output}`);
    expect(config.toolchain.vineflower.source).toBe("workspace-tools-jar");
    expect(config.toolchain.vineflower.location).toBe(jarPath);
  });

  test("reports a helpful message when no Vineflower tool is available", async () => {
    const projectRoot = await createTempProject();
    process.env.PATH = "";

    const config = loadConfig(projectRoot);

    expect(config.toolchain.vineflowerCommand).toBeUndefined();
    expect(config.toolchain.vineflower.source).toBe("missing");
    expect(config.toolchain.vineflower.message).toMatch(/No Vineflower tool was detected/);
    expect(config.toolchain.vineflower.searchedPaths).toContain(join(projectRoot, "workspace", "tools"));
  });
});

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mc-datahub-config-"));
  tempDirs.add(root);
  return root;
}
