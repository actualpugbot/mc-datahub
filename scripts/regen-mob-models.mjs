#!/usr/bin/env node
// Re-extract mob models into an already-processed dataset without running
// the full pipeline (re-uses the dataset's existing mob list).
// Usage: node scripts/regen-mob-models.mjs [version]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFile } from "../dist/core/fs.js";
import { createConsoleLogger } from "../dist/core/logger.js";
import { MobModelExtractor } from "../dist/extraction/mobModelExtractor.js";

const version = process.argv[2] ?? "26.2";
const root = new URL("..", import.meta.url).pathname;
const decompiledClientRoot = join(root, "workspace/versions", version, "decompiled", "client");
const datasetDir = join(root, "workspace/datasets", version);

const existing = JSON.parse(readFileSync(join(datasetDir, "mob-models.json"), "utf8"));
const mobList = existing.mobs.map((mob) => ({
  id: mob.id,
  localId: mob.localId,
  displayName: mob.displayName,
}));

const extractor = new MobModelExtractor(createConsoleLogger(false));
const mobs = await extractor.extract(mobList, decompiledClientRoot);

const summary = { baked: 0, partialOnly: 0, none: 0 };
const gaps = [];
for (const mob of mobs) {
  if (!mob.layers.length) {
    summary.none += 1;
    gaps.push(`${mob.localId}:no-layers`);
  } else if (mob.layers.some((layer) => layer.status === "baked")) {
    summary.baked += 1;
  } else {
    summary.partialOnly += 1;
    gaps.push(`${mob.localId}:${mob.layers[0].status}`);
  }
}
console.log(`baked=${summary.baked} partialOnly=${summary.partialOnly} none=${summary.none}`);
if (gaps.length) console.log(`gaps: ${gaps.join(", ")}`);

await writeJsonFile(join(datasetDir, "mob-models.json"), {
  version,
  generatedAt: existing.generatedAt,
  mobs,
});
console.log(`Wrote ${mobs.length} mob models to ${join(datasetDir, "mob-models.json")}`);
