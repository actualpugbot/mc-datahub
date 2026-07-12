#!/usr/bin/env node
// Retrofit the shared-voice fallbacks (see SHARED_MOB_SOUND_FALLBACKS in
// src/extraction/mobSoundExtractor.ts) into an already-processed dataset
// without re-running the full pipeline: mobs whose entry has no sound events
// borrow their donor mob's fully-materialised events.
// Usage: node scripts/regen-mob-sound-fallbacks.mjs [version]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFile } from "../dist/core/fs.js";

const FALLBACKS = new Map([
  ["cave_spider", "spider"],
  ["trader_llama", "llama"],
]);

const version = process.argv[2] ?? "26.2";
const root = new URL("..", import.meta.url).pathname;
const datasetDir = join(root, "workspace/datasets", version);
const soundsPath = join(datasetDir, "mob-sounds.json");

const dataset = JSON.parse(readFileSync(soundsPath, "utf8"));
const byId = new Map(dataset.mobs.map((mob) => [mob.localId, mob]));

let patched = 0;
for (const [localId, donorId] of FALLBACKS) {
  const mob = byId.get(localId);
  const donor = byId.get(donorId);
  if (!mob || !donor) {
    console.warn(`skip ${localId}: ${!mob ? "mob" : "donor"} missing from dataset`);
    continue;
  }
  if (mob.soundEvents.length > 0) {
    console.log(`skip ${localId}: already has ${mob.soundEvents.length} events`);
    continue;
  }
  mob.soundEvents = donor.soundEvents;
  mob.soundId = donor.soundId;
  mob.soundEventCount = donor.soundEventCount;
  mob.soundVariantCount = donor.soundVariantCount;
  patched += 1;
  console.log(`${localId} ← ${donorId}: ${donor.soundEventCount} events, ${donor.soundVariantCount} variants`);
}

await writeJsonFile(soundsPath, dataset);
console.log(`Patched ${patched} mobs in ${soundsPath}`);

// Keep the combined dataset.json's embedded copy in sync when present.
try {
  const combinedPath = join(datasetDir, "dataset.json");
  const combined = JSON.parse(readFileSync(combinedPath, "utf8"));
  if (combined.mobSounds) {
    combined.mobSounds = dataset.mobs;
    await writeJsonFile(combinedPath, combined);
    console.log("Patched embedded mobSounds in dataset.json");
  }
} catch {
  // dataset.json may not exist for partial workspaces; the sidecar is enough.
}
