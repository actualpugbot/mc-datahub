#!/usr/bin/env node
// Retrofit enriched enchantments.json and anvil-mechanics.json into an
// already-processed dataset without re-running the full extraction pipeline.
// Usage: node scripts/regen-enchantments.mjs [version]
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { AnvilMechanicsExtractor } from "../dist/extraction/anvilMechanicsExtractor.js";
import { enrichEnchantments } from "../dist/extraction/enchantments.js";
import { writeJsonFile } from "../dist/core/fs.js";
import { createConsoleLogger } from "../dist/core/logger.js";

const version = process.argv[2] ?? "26.2";
const root = new URL("..", import.meta.url).pathname;
const decompiledClientRoot = join(root, "workspace/versions", version, "decompiled", "client");
const datasetDir = join(root, "workspace/datasets", version);

const readJson = (name) => JSON.parse(readFileSync(join(datasetDir, name), "utf8"));

const logger = createConsoleLogger(true);
const baseEnchantments = readJson("enchantments.json");
const tags = readJson("tags.json");
const translationsFile = readJson("translations.json");
const translations = Array.isArray(translationsFile) ? translationsFile : translationsFile.translations;

const enchantments = enrichEnchantments(baseEnchantments, tags, translations);
for (const enchantment of enchantments) {
  const exclusive = enchantment.exclusiveSetIds?.length ?? 0;
  const supported = enchantment.supportedItemIds?.length ?? 0;
  console.log(`${enchantment.id} -> ${enchantment.displayName ?? "?"} (items: ${supported}, exclusive: ${exclusive})`);
}

const extractor = new AnvilMechanicsExtractor(logger);
const anvilMechanics = await extractor.extract(decompiledClientRoot);

const dataset = JSON.parse(readFileSync(join(datasetDir, "dataset.json"), "utf8"));
dataset.enchantments = enchantments;
if (anvilMechanics) {
  dataset.anvilMechanics = anvilMechanics;
}

await writeJsonFile(join(datasetDir, "enchantments.json"), enchantments);
if (anvilMechanics) {
  await writeJsonFile(join(datasetDir, "anvil-mechanics.json"), {
    version,
    generatedAt: dataset.generatedAt,
    ...anvilMechanics,
  });
}
await writeJsonFile(join(datasetDir, "dataset.json"), dataset);

console.log(`Wrote ${enchantments.length} enriched enchantments to ${join(datasetDir, "enchantments.json")}`);
if (anvilMechanics) {
  const warnings = anvilMechanics.warnings.length;
  console.log(
    `Wrote anvil mechanics (${warnings} warning${warnings === 1 ? "" : "s"}) to ${join(datasetDir, "anvil-mechanics.json")}`,
  );
} else if (!existsSync(decompiledClientRoot)) {
  console.log(`No decompiled client source for ${version}; skipped anvil mechanics.`);
}
