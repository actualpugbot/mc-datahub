#!/usr/bin/env node
/** Rebuilds villager-trades.json from an already-downloaded Minecraft client JAR. */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ZipArchiveSource } from "../dist/archive/zipArchiveSource.js";
import { buildVillagerTrades } from "../dist/extraction/villagerTrades.js";

const version = process.argv[2];
if (!version) {
  console.error("Usage: npm run build:villager-trades -- <version>");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionRoot = path.join(repoRoot, "workspace", "versions", version);
const datasetRoot = path.join(repoRoot, "workspace", "datasets", version);
const clientJar = path.join(versionRoot, "downloads", "client.jar");
const translationsPath = path.join(datasetRoot, "translations.json");
const outputPath = path.join(datasetRoot, "villager-trades.json");

for (const required of [clientJar, translationsPath]) {
  if (!existsSync(required)) {
    throw new Error(`Missing prepared version artifact: ${required}`);
  }
}

const source = new ZipArchiveSource(clientJar);
const paths = await source.listPaths();
const translationsPayload = JSON.parse(await readFile(translationsPath, "utf8"));
const translations = Array.isArray(translationsPayload) ? translationsPayload : (translationsPayload.translations ?? []);
const dataset = await buildVillagerTrades(paths, source, translations);
if (!dataset) {
  throw new Error(`Minecraft ${version} does not contain data-driven villager trade registries.`);
}

await writeFile(
  outputPath,
  `${JSON.stringify({ version, generatedAt: new Date().toISOString(), ...dataset }, null, 2)}\n`,
  "utf8",
);
console.log(
  JSON.stringify(
    {
      version,
      outputPath,
      trades: dataset.trades.length,
      pools: dataset.pools.length,
      warnings: dataset.warnings,
    },
    null,
    2,
  ),
);
