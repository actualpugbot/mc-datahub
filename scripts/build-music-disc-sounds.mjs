#!/usr/bin/env node
/*
 * Extract Minecraft music disc tracks -> music-disc-sounds.json.
 *
 * Every jukebox song plays one music_disc.* sound event whose single sound is
 * a full streamed record (records/<name>.ogg in the asset objects). This
 * resolves each event from datasets/<v>/jukebox-songs.json (run
 * `dump jukebox-songs <v>` first) through the version's sounds.json to a
 * content {hash, size}, keyed by the song's registry key, so the download
 * script and consumers never re-derive paths.
 *
 * Standalone like build-note-block-sounds.mjs: no decompiled client needed,
 * network only.
 *   node scripts/build-music-disc-sounds.mjs [version]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] ?? "26.2";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const metadataPath = path.join(repoRoot, "workspace/versions", VERSION, "metadata.json");
const songsPath = path.join(repoRoot, "workspace/datasets", VERSION, "jukebox-songs.json");
const outPath = path.join(repoRoot, "workspace/datasets", VERSION, "music-disc-sounds.json");

const ASSET_DOWNLOAD_BASE_URL = "https://resources.download.minecraft.net";
const toAssetDownloadUrl = (hash) => `${ASSET_DOWNLOAD_BASE_URL}/${hash.slice(0, 2)}/${hash}`;
const stripNamespace = (value) => (value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main() {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const assetIndexUrl = metadata.assetIndex?.url;
  if (!assetIndexUrl) throw new Error(`no assetIndex.url in ${metadataPath}`);
  console.log(`[music-disc-sounds] ${VERSION} asset index: ${assetIndexUrl}`);
  const assetIndex = await getJson(assetIndexUrl);
  const objects = assetIndex.objects ?? {};

  const soundsAsset = objects["minecraft/sounds.json"];
  if (!soundsAsset) throw new Error("minecraft/sounds.json missing from asset index");
  const sounds = await getJson(toAssetDownloadUrl(soundsAsset.hash));

  const songs = JSON.parse(readFileSync(songsPath, "utf8")).songs;
  console.log(`[music-disc-sounds] resolving ${songs.length} jukebox songs`);

  const result = [];
  for (const song of songs) {
    const eventId = stripNamespace(song.soundEvent);
    const event = sounds[eventId];
    const entry = event?.sounds?.[0];
    const rawSoundPath = typeof entry === "string" ? entry : entry?.name;
    if (typeof rawSoundPath !== "string") {
      console.warn(`  skip (no sound entry): ${eventId}`);
      continue;
    }
    const soundPath = stripNamespace(rawSoundPath).replace(/\.ogg$/i, "");
    const assetPath = `minecraft/sounds/${soundPath}.ogg`;
    const asset = objects[assetPath];
    if (!asset) {
      console.warn(`  skip (no asset index entry): ${assetPath}`);
      continue;
    }
    result.push({
      key: song.key,
      itemId: song.itemId,
      event: eventId,
      soundPath,
      assetPath,
      hash: asset.hash,
      size: asset.size,
    });
    console.log(`  ${song.key}: ${assetPath} (${(asset.size / 1024).toFixed(0)} KB)`);
  }

  result.sort((a, b) => a.key.localeCompare(b.key));
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  const totalBytes = result.reduce((sum, entry) => sum + entry.size, 0);
  console.log(
    `[music-disc-sounds] wrote ${result.length} tracks (${(totalBytes / 1024 / 1024).toFixed(1)} MB) -> ${path.relative(repoRoot, outPath)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
