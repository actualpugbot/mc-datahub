#!/usr/bin/env node
// Retrofit tree-features.json into an already-processed dataset (and refresh the
// treeFeatures block of dataset.json) without re-running the full pipeline.
// Usage: node scripts/regen-tree-features.mjs [version]
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { TreeFeaturesExtractor } from "../dist/extraction/treeFeaturesExtractor.js";
import { readJsonFile, writeJsonFile } from "../dist/core/fs.js";
import { createConsoleLogger } from "../dist/core/logger.js";

const version = process.argv[2] ?? "26.2";
const root = new URL("..", import.meta.url).pathname;
const workspaceRoot = process.env.MCDATAHUB_WORKSPACE_ROOT ?? join(root, "workspace");
const decompiledClientRoot = join(workspaceRoot, "versions", version, "decompiled", "client");
const datasetDir = join(workspaceRoot, "datasets", version);

const extractor = new TreeFeaturesExtractor(createConsoleLogger(true));
const treeFeatures = await extractor.extract(decompiledClientRoot);

if (!treeFeatures) {
  console.error(`No tree feature data found for ${version}; is ${decompiledClientRoot} decompiled?`);
  process.exit(1);
}

for (const family of treeFeatures.families) {
  const grower = family.grower;
  const growth = grower
    ? `grower=${grower.name} secondary=${grower.secondaryChance}` +
      `${grower.canBeTwoByTwo ? (grower.requiresTwoByTwo ? " [2x2 only]" : " [2x2 optional]") : ""}`
    : family.fungus
      ? `fungus=${family.fungus.plantedFeature}`
      : "no grower";
  console.log(`${family.family.padEnd(10)} blocks=${String(family.blocks.length).padStart(2)}  ${growth}`);
}
console.log(`features: ${treeFeatures.features.length}`);
if (treeFeatures.warnings.length > 0) {
  console.log(`warnings: ${treeFeatures.warnings.length}`);
  for (const warning of treeFeatures.warnings) {
    console.log(`  - ${warning}`);
  }
}

const generatedAt = JSON.parse(readFileSync(join(datasetDir, "dataset.json"), "utf8")).generatedAt;

await writeJsonFile(join(datasetDir, "tree-features.json"), { version, generatedAt, ...treeFeatures });
console.log(`Wrote ${treeFeatures.families.length} families to ${join(datasetDir, "tree-features.json")}`);

// Keep the combined dataset.json in sync so the API/load path sees the new collection.
const dataset = await readJsonFile(join(datasetDir, "dataset.json"));
dataset.treeFeatures = treeFeatures;
await writeJsonFile(join(datasetDir, "dataset.json"), dataset);
console.log(`Updated treeFeatures block in ${join(datasetDir, "dataset.json")}`);
