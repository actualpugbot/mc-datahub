#!/usr/bin/env node
// Retrofit block-entity-models.json into an already-processed dataset
// without re-running the full extraction pipeline.
// Usage: node scripts/regen-block-entity-models.mjs [version]
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MobModelExtractor } from "../dist/extraction/mobModelExtractor.js";
import { writeJsonFile } from "../dist/core/fs.js";
import { createConsoleLogger } from "../dist/core/logger.js";

const version = process.argv[2] ?? "26.2";
const root = new URL("..", import.meta.url).pathname;
const decompiledClientRoot = join(root, "workspace/versions", version, "decompiled", "client");
const datasetDir = join(root, "workspace/datasets", version);

const extractor = new MobModelExtractor(createConsoleLogger(true));
const blockEntities = await extractor.extractBlockEntityModels(decompiledClientRoot);

for (const entry of blockEntities) {
  const layers = entry.layers.map((layer) => `${layer.id}:${layer.status ?? "baked"}`).join(" ");
  console.log(`${entry.id} -> ${layers}`);
}

const generatedAt = JSON.parse(readFileSync(join(datasetDir, "mob-models.json"), "utf8")).generatedAt;
await writeJsonFile(join(datasetDir, "block-entity-models.json"), {
  version,
  generatedAt,
  blockEntities,
});
console.log(`Wrote ${blockEntities.length} block-entity models to ${join(datasetDir, "block-entity-models.json")}`);
