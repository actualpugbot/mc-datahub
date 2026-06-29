/*
 * Generate `biomes.json` for one or more versions from the already-decompiled
 * vanilla data in `workspace/versions/<version>/decompiled/client`, without
 * re-running the full extraction pipeline (keeps the rest of the committed
 * dataset untouched). Usage: `tsx scripts/dump-biomes.ts [version ...]`.
 */
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { buildBiomes } from "../src/extraction/biomes.js";
import { normalizeMinecraftId, normalizeTagEntry } from "../src/extraction/normalizers.js";
import type { JsonValue, TagDefinition, TranslationEntry } from "../src/domain/types.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_VERSIONS = ["26.1.1", "26.1.2", "26.2"];

async function readDirRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function parseBiomeTags(clientDir: string): Promise<TagDefinition[]> {
  const tagDir = join(clientDir, "data/minecraft/tags/worldgen/biome");
  const files = await readDirRecursive(tagDir);
  const tags: TagDefinition[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as JsonValue;
    if (Array.isArray(raw) || !raw || typeof raw !== "object") {
      continue;
    }
    const rel = relative(tagDir, file)
      .replaceAll("\\", "/")
      .replace(/\.json$/, "");
    const values = Array.isArray(raw.values)
      ? raw.values.map((value) => normalizeTagEntry(value)).filter((value): value is string => typeof value === "string")
      : [];
    tags.push({
      id: normalizeMinecraftId(`biome/${rel}`),
      registry: "worldgen",
      replace: raw.replace === true,
      values,
      sourcePath: `data/minecraft/tags/worldgen/biome/${rel}.json`,
      raw,
    });
  }
  return tags;
}

async function readTranslations(clientDir: string): Promise<TranslationEntry[]> {
  const langPath = join(clientDir, "assets/minecraft/lang/en_us.json");
  try {
    const raw = JSON.parse(await fs.readFile(langPath, "utf8")) as Record<string, unknown>;
    return Object.entries(raw)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => ({ key, value }));
  } catch {
    return [];
  }
}

async function dumpVersion(version: string): Promise<void> {
  const clientDir = join(repoRoot, "workspace/versions", version, "decompiled/client");
  const biomeDir = join(clientDir, "data/minecraft/worldgen/biome");
  const biomeFiles = (await readDirRecursive(biomeDir)).filter((file) => file.endsWith(".json"));
  if (biomeFiles.length === 0) {
    console.warn(`[skip] ${version}: no decompiled biome definitions found.`);
    return;
  }

  const entries: Record<string, string> = {};
  const paths: string[] = [];
  for (const file of biomeFiles) {
    const key = relative(biomeDir, file)
      .replaceAll("\\", "/")
      .replace(/\.json$/, "");
    const archivePath = `data/minecraft/worldgen/biome/${key}.json`;
    entries[archivePath] = await fs.readFile(file, "utf8");
    paths.push(archivePath);
  }

  const dimensionTypeDir = join(clientDir, "data/minecraft/dimension_type");
  const dimensionTypeFiles = (await readDirRecursive(dimensionTypeDir)).filter((file) => file.endsWith(".json"));
  for (const file of dimensionTypeFiles) {
    const key = relative(clientDir, file).replaceAll("\\", "/");
    entries[key] = await fs.readFile(file, "utf8");
    paths.push(key);
  }
  const source = new InMemoryArchiveSource(entries);
  const tags = await parseBiomeTags(clientDir);
  const translations = await readTranslations(clientDir);
  const biomes = await buildBiomes(paths, source, tags, translations);

  const outDir = join(repoRoot, "workspace/datasets", version);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "biomes.json");
  const payload = { version, generatedAt: new Date().toISOString(), biomes };
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[ok] ${version}: wrote ${biomes.length} biomes -> ${relative(repoRoot, outPath)}`);
}

async function main(): Promise<void> {
  const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_VERSIONS;
  for (const version of versions) {
    await dumpVersion(version);
  }
}

await main();
