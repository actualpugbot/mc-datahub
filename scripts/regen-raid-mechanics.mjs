#!/usr/bin/env node
// Retrofit raid-mechanics.json into an already-processed dataset (and refresh the
// raidMechanics block of dataset.json) without re-running the full pipeline.
// Usage: node scripts/regen-raid-mechanics.mjs [version]
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { RaidMechanicsExtractor } from "../dist/extraction/raidMechanicsExtractor.js";
import { readJsonFile, writeJsonFile } from "../dist/core/fs.js";
import { createConsoleLogger } from "../dist/core/logger.js";

const version = process.argv[2] ?? "26.2";
const root = new URL("..", import.meta.url).pathname;
const workspaceRoot = process.env.MCDATAHUB_WORKSPACE_ROOT ?? join(root, "workspace");
const decompiledClientRoot = join(workspaceRoot, "versions", version, "decompiled", "client");
const datasetDir = join(workspaceRoot, "datasets", version);

const extractor = new RaidMechanicsExtractor(createConsoleLogger(true));
const raidMechanics = await extractor.extract(decompiledClientRoot);

if (!raidMechanics) {
  console.error(`No raid data found for ${version}; is ${decompiledClientRoot} decompiled?`);
  process.exit(1);
}

for (const table of raidMechanics.rosterTable) {
  const waves = [...table.waves, table.bonusWave].map(
    (wave) => `${wave.isBonusWave ? "B" : wave.wave}:${wave.totalMin}-${wave.totalMax}`,
  );
  console.log(`${table.difficulty.padEnd(6)} groups=${table.numGroups}  ${waves.join("  ")}`);
}
console.log(`sources: ${raidMechanics.sourcePaths.length}  warnings: ${raidMechanics.warnings.length}`);

const generatedAt = JSON.parse(readFileSync(join(datasetDir, "dataset.json"), "utf8")).generatedAt;

await writeJsonFile(join(datasetDir, "raid-mechanics.json"), { version, generatedAt, ...raidMechanics });
console.log(`Wrote ${join(datasetDir, "raid-mechanics.json")}`);

// Keep the combined dataset.json in sync so the API/load path sees the new collection.
const dataset = await readJsonFile(join(datasetDir, "dataset.json"));
dataset.raidMechanics = raidMechanics;
await writeJsonFile(join(datasetDir, "dataset.json"), dataset);
console.log(`Updated raidMechanics block in ${join(datasetDir, "dataset.json")}`);
