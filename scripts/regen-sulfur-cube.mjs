#!/usr/bin/env node
// Retrofit sulfur-cube.json into an already-processed dataset (and refresh the
// sulfurCube block of dataset.json) without re-running the full pipeline.
// Usage: node scripts/regen-sulfur-cube.mjs [version]
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SulfurCubeExtractor } from "../dist/extraction/sulfurCubeExtractor.js";
import { readJsonFile, writeJsonFile } from "../dist/core/fs.js";
import { createConsoleLogger } from "../dist/core/logger.js";

const version = process.argv[2] ?? "26.2";
const root = new URL("..", import.meta.url).pathname;
const workspaceRoot = process.env.MCDATAHUB_WORKSPACE_ROOT ?? join(root, "workspace");
const decompiledClientRoot = join(workspaceRoot, "versions", version, "decompiled", "client");
const datasetDir = join(workspaceRoot, "datasets", version);

const extractor = new SulfurCubeExtractor(createConsoleLogger(true));
const sulfurCube = await extractor.extract(decompiledClientRoot);

if (!sulfurCube) {
  console.error(`No sulfur cube data found for ${version}; is ${decompiledClientRoot} decompiled?`);
  process.exit(1);
}

for (const archetype of sulfurCube.archetypes) {
  console.log(
    `${archetype.key.padEnd(16)} blocks=${String(archetype.blockCount).padStart(3)}  ` +
      `mobility=${archetype.behavior.mobility} bounce=${archetype.behavior.bounciness} ` +
      `friction=${archetype.behavior.friction} drag=${archetype.behavior.airDrag}` +
      `${archetype.explosive ? " [explosive]" : ""}${archetype.dealsContactDamage ? " [contact-damage]" : ""}` +
      `${archetype.buoyant ? " [buoyant]" : ""}`,
  );
}
if (sulfurCube.warnings.length > 0) {
  console.log(`warnings: ${sulfurCube.warnings.length}`);
}

const generatedAt = JSON.parse(readFileSync(join(datasetDir, "dataset.json"), "utf8")).generatedAt;

await writeJsonFile(join(datasetDir, "sulfur-cube.json"), { version, generatedAt, ...sulfurCube });
console.log(`Wrote ${sulfurCube.archetypes.length} archetypes to ${join(datasetDir, "sulfur-cube.json")}`);

// Keep the combined dataset.json in sync so the API/load path sees the new collection.
const dataset = await readJsonFile(join(datasetDir, "dataset.json"));
dataset.sulfurCube = sulfurCube;
await writeJsonFile(join(datasetDir, "dataset.json"), dataset);
console.log(`Updated sulfurCube block in ${join(datasetDir, "dataset.json")}`);
