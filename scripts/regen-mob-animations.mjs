#!/usr/bin/env node
// Re-extract mob animations into an already-processed dataset without running
// the full pipeline (re-uses the dataset's existing mob-models.json geometry).
// Requires a prior `npm run build`. Usage: node scripts/regen-mob-animations.mjs [version]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFile } from "../dist/core/fs.js";
import { createConsoleLogger } from "../dist/core/logger.js";
import { MobAnimationExtractor } from "../dist/extraction/mobAnimationExtractor.js";

const version = process.argv[2] ?? "26.2";
const root = new URL("..", import.meta.url).pathname;
const decompiledClientRoot = join(root, "workspace/versions", version, "decompiled", "client");
const datasetDir = join(root, "workspace/datasets", version);

// The animation extractor consumes the mob-models entries directly (it needs the
// baked layer geometry for each mob's base pose and bone names).
const models = JSON.parse(readFileSync(join(datasetDir, "mob-models.json"), "utf8"));

const extractor = new MobAnimationExtractor(createConsoleLogger(false));
const mobs = await extractor.extract(models.mobs, decompiledClientRoot);

const summary = { baked: 0, partial: 0, unresolved: 0 };
let clips = 0;
const gaps = [];
for (const mob of mobs) {
  summary[mob.status] += 1;
  clips += mob.clips.length;
  if (mob.status === "unresolved") gaps.push(mob.localId);
}
console.log(`baked=${summary.baked} partial=${summary.partial} unresolved=${summary.unresolved} clips=${clips}`);
if (gaps.length) console.log(`no clips: ${gaps.join(", ")}`);

await writeJsonFile(join(datasetDir, "mob-animations.json"), {
  version,
  generatedAt: models.generatedAt,
  mobs,
});

// Patch the combined dataset.json in place so its embedded copy stays in sync.
try {
  const dataset = JSON.parse(readFileSync(join(datasetDir, "dataset.json"), "utf8"));
  dataset.mobAnimations = mobs;
  await writeJsonFile(join(datasetDir, "dataset.json"), dataset);
} catch {
  // dataset.json may not exist for partial workspaces; the sidecar is still written.
}

console.log(`Wrote ${mobs.length} mob animations to ${join(datasetDir, "mob-animations.json")}`);
