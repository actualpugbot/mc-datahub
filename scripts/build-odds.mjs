#!/usr/bin/env node
// Rebuild fishing-odds.json and loot-odds.json for a version straight from the workspace it already
// has: the dataset sidecars supply the loot tables, tags, enchantments, translations, item stats and
// recipes, and the decompiled client supplies the fishing loop. Nothing is downloaded or decompiled.
// Usage: node scripts/build-odds.mjs [version] [--no-dataset-json]
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";
import { FishingMechanicsExtractor } from "../dist/extraction/fishingMechanicsExtractor.js";
import { buildFishingOddsDataset, buildLootOddsDataset, loadLootOddsData } from "../dist/extraction/lootOdds/index.js";
import { readJsonFile, writeJsonFile, writeTextFile } from "../dist/core/fs.js";
import { createConsoleLogger } from "../dist/core/logger.js";

const args = process.argv.slice(2);
const version = args.find((argument) => !argument.startsWith("--")) ?? "26.2";
const syncDatasetJson = !args.includes("--no-dataset-json");

const root = new URL("..", import.meta.url).pathname;
const workspaceRoot = process.env.MCDATAHUB_WORKSPACE_ROOT ?? join(root, "workspace");
const decompiledClientRoot = join(workspaceRoot, "versions", version, "decompiled", "client");
const datasetDir = join(workspaceRoot, "datasets", version);

if (!existsSync(join(datasetDir, "loot-tables.json"))) {
  console.error(`No loot-tables.json for ${version}; expected it under ${datasetDir}.`);
  process.exit(1);
}
if (!existsSync(join(decompiledClientRoot, "net/minecraft/world/entity/projectile/FishingHook.java"))) {
  console.error(`No decompiled FishingHook.java for ${version}; expected it under ${decompiledClientRoot}.`);
  process.exit(1);
}

const startedAt = Date.now();
const logger = createConsoleLogger(true);
const data = await loadLootOddsData(datasetDir);
console.log(`Loaded ${data.tables.size} loot tables for ${version}.`);

const mechanics = await new FishingMechanicsExtractor(logger).extract(decompiledClientRoot);
if (!mechanics) {
  console.error(`The fishing mechanics extractor found nothing for ${version}.`);
  process.exit(1);
}

const fishingOdds = buildFishingOddsDataset({ data, mechanics });
const lootOdds = buildLootOddsDataset({ data });

// The version stamp mirrors the one the pipeline writes, so a regenerated file is byte-comparable
// with a freshly processed one.
const generatedAt = readGeneratedAt();

await writeJsonFile(join(datasetDir, "fishing-odds.json"), { version, generatedAt, ...fishingOdds });
await writeTextFile(join(datasetDir, "loot-odds.json"), JSON.stringify({ version, generatedAt, ...lootOdds }));

if (syncDatasetJson) {
  // Keep the combined dataset.json in sync so the API/load path sees the new collections.
  const dataset = await readJsonFile(join(datasetDir, "dataset.json"));
  dataset.fishingOdds = fishingOdds;
  dataset.lootOdds = lootOdds;
  await writeJsonFile(join(datasetDir, "dataset.json"), dataset);
  console.log(`Updated fishingOdds and lootOdds blocks in ${join(datasetDir, "dataset.json")}.`);
}

report();

function readGeneratedAt() {
  const versionFile = join(datasetDir, "version.json");
  if (existsSync(versionFile)) {
    const stamp = JSON.parse(readFileSync(versionFile, "utf8")).generatedAt;
    if (stamp) return stamp;
  }
  return JSON.parse(readFileSync(join(datasetDir, "dataset.json"), "utf8")).generatedAt;
}

function report() {
  const openWater = (luck) => fishingOdds.oddsGrid.cells.find((cell) => cell.luck === luck && cell.inOpenWater);
  for (const luck of [0, 3]) {
    const categories = openWater(luck)?.categories ?? [];
    const shares = categories.map((entry) => `${entry.name} ${(entry.probability * 100).toFixed(3)}%`).join("  ");
    console.log(`luck ${String(luck).padStart(2)} open water: ${shares}`);
  }

  console.log(`scenarios: ${fishingOdds.scenarios.length}  timing rows: ${fishingOdds.timing.rows.length}`);
  console.log(
    `loot odds: bartering=${lootOdds.bartering.items.length} archaeology=${lootOdds.archaeology.length} ` +
      `gifts=${lootOdds.gifts.length} mobDrops=${lootOdds.mobDrops.length} chests=${lootOdds.chests.length}`,
  );

  const warnings = [...fishingOdds.warnings, ...lootOdds.warnings];
  console.log(`warnings: ${warnings.length}`);
  for (const warning of warnings) console.log(`  - ${warning}`);

  for (const name of ["fishing-odds.json", "loot-odds.json"]) {
    const path = join(datasetDir, name);
    const raw = statSync(path).size;
    const gzip = gzipSync(readFileSync(path)).length;
    console.log(`${name.padEnd(18)} ${mib(raw)} raw  ${mib(gzip)} gzip`);
  }

  console.log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`.padStart(10);
}
