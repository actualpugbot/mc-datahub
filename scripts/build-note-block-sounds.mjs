#!/usr/bin/env node
/*
 * Extract Minecraft note-block instrument sounds -> note-block-sounds.json.
 *
 * A note block's instrument comes from block.note_block.* events in the game's
 * sounds.json. In 26.2 there are 26 such events: 20 pitched instruments (the 16
 * classic ones plus the four copper `trumpet` oxidation timbres) each mapping to
 * a single sample the engine repitches across the 25 notes, and 6 imitate.<mob>
 * events that reference weighted entity.* sounds (mob-head note blocks).
 *
 * Resolution mirrors src/extraction/mobSoundExtractor.ts: read the version's
 * asset index (workspace/versions/<v>/metadata.json -> assetIndex.url), fetch
 * sounds.json through it, then resolve each sound name to a content {hash,size}
 * via the asset index. One deliberate difference from the mob extractor: the
 * type:"event" recursion here PRESERVES the referencing event's pitch/volume
 * (imitate.creeper carries pitch:0.5), folding them into the resolved variant.
 *
 * Standalone — no decompiled client / full pipeline needed. Network only.
 *   node scripts/build-note-block-sounds.mjs [version]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] ?? "26.2";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const metadataPath = path.join(repoRoot, "workspace/versions", VERSION, "metadata.json");
const outPath = path.join(repoRoot, "workspace/datasets", VERSION, "note-block-sounds.json");

const ASSET_DOWNLOAD_BASE_URL = "https://resources.download.minecraft.net";
const toAssetDownloadUrl = (hash) => `${ASSET_DOWNLOAD_BASE_URL}/${hash.slice(0, 2)}/${hash}`;
const stripNamespace = (value) => (value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value);
const round = (n) => Math.round(n * 1000) / 1000;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Resolve one raw sound name -> variant {soundPath, assetPath, hash, size, ...}. */
function toVariant(objects, rawSoundPath, entry, refPitch, refVolume) {
  const soundPath = stripNamespace(rawSoundPath).replace(/\.ogg$/i, "");
  const assetPath = `minecraft/sounds/${soundPath}.ogg`;
  const asset = objects[assetPath];
  if (!asset) {
    console.warn(`  skip (no asset index entry): ${assetPath}`);
    return undefined;
  }
  const pitch = round((entry.pitch ?? 1) * refPitch);
  const volume = round((entry.volume ?? 1) * refVolume);
  const weight = entry.weight ?? 1;
  const variant = {
    soundPath,
    assetPath,
    hash: asset.hash,
    size: asset.size,
  };
  // Match mob-sounds.json: omit defaults so the manifest stays lean.
  if (pitch !== 1) variant.pitch = pitch;
  if (volume !== 1) variant.volume = volume;
  if (weight !== 1) variant.weight = weight;
  return variant;
}

/** Resolve every variant of a sound event, recursing through type:"event" refs. */
function resolveVariants(objects, sounds, eventId, refPitch, refVolume, visited) {
  if (visited.has(eventId)) return [];
  visited.add(eventId);
  const event = sounds[eventId];
  if (!event?.sounds?.length) return [];
  const variants = [];
  for (const entry of event.sounds) {
    if (typeof entry === "string") {
      const variant = toVariant(objects, entry, {}, refPitch, refVolume);
      if (variant) variants.push(variant);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "event") {
      if (typeof entry.name !== "string") continue;
      // Preserve the referencing event's pitch/volume into the recursion.
      variants.push(
        ...resolveVariants(
          objects,
          sounds,
          entry.name,
          refPitch * (entry.pitch ?? 1),
          refVolume * (entry.volume ?? 1),
          new Set(visited),
        ),
      );
      continue;
    }
    if (typeof entry.name !== "string") continue;
    const variant = toVariant(objects, entry.name, entry, refPitch, refVolume);
    if (variant) variants.push(variant);
  }
  return variants;
}

async function main() {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const assetIndexUrl = metadata.assetIndex?.url;
  if (!assetIndexUrl) throw new Error(`no assetIndex.url in ${metadataPath}`);
  console.log(`[note-block-sounds] ${VERSION} asset index: ${assetIndexUrl}`);
  const assetIndex = await getJson(assetIndexUrl);
  const objects = assetIndex.objects ?? {};

  const soundsAsset = objects["minecraft/sounds.json"];
  if (!soundsAsset) throw new Error("minecraft/sounds.json missing from asset index");
  const sounds = await getJson(toAssetDownloadUrl(soundsAsset.hash));

  const eventIds = Object.keys(sounds)
    .filter((key) => key.startsWith("block.note_block."))
    .sort();
  console.log(`[note-block-sounds] found ${eventIds.length} block.note_block.* events`);

  const result = [];
  for (const eventId of eventIds) {
    const suffix = eventId.slice("block.note_block.".length); // harp | imitate.creeper | trumpet_exposed
    const kind = suffix.startsWith("imitate.") ? "mobhead" : "pitched";
    const variants = resolveVariants(objects, sounds, eventId, 1, 1, new Set());
    if (variants.length === 0) {
      console.warn(`  no resolvable variants: ${eventId}`);
      continue;
    }
    const entry = { instrument: suffix, event: eventId, kind, variants };
    const subtitle = sounds[eventId]?.subtitle;
    if (subtitle) entry.subtitle = subtitle;
    result.push(entry);
    console.log(`  ${suffix} (${kind}): ${variants.length} variant(s)`);
  }

  result.sort((a, b) => a.instrument.localeCompare(b.instrument));
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[note-block-sounds] wrote ${result.length} instruments -> ${path.relative(repoRoot, outPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
