#!/usr/bin/env node
/*
 * Download the music disc record oggs referenced by music-disc-sounds.json
 * into the content-addressed Pages store pages/music-discs/<hash[0:2]>/<hash>.ogg,
 * mirroring scripts/download-note-block-sounds.mjs. Run after
 * build-music-disc-sounds.mjs.
 *
 * Content-addressed + idempotent: an object already present with the expected
 * size is skipped. pugtools copies these into apps/web/public/music-discs/
 * for same-origin playback (no Mojang CDN at runtime).
 *
 *   node scripts/download-music-disc-sounds.mjs [version]
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] ?? "26.2";
const MAX_RETRIES = 3;
const CONCURRENCY = 6;
const ASSET_DOWNLOAD_BASE_URL = "https://resources.download.minecraft.net";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const datasetPath = path.join(repoRoot, "workspace/datasets", VERSION, "music-disc-sounds.json");
const outDir = path.join(repoRoot, "pages/music-discs");

const downloadUrl = (hash) => `${ASSET_DOWNLOAD_BASE_URL}/${hash.slice(0, 2)}/${hash}`;
const objectPath = (hash) => path.join(outDir, hash.slice(0, 2), `${hash}.ogg`);

async function downloadOne({ hash, size }) {
  const dest = objectPath(hash);
  if (existsSync(dest) && (size === 0 || statSync(dest).size === size)) {
    return "skipped";
  }
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(downloadUrl(hash));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (size > 0 && buffer.length !== size) {
        throw new Error(`size mismatch: got ${buffer.length}, want ${size}`);
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, buffer);
      return "downloaded";
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw new Error(`${hash}: ${lastError?.message ?? "download failed"}`);
}

async function main() {
  const tracks = JSON.parse(readFileSync(datasetPath, "utf8"));
  console.log(`[download-music-disc-sounds] ${tracks.length} tracks -> ${path.relative(repoRoot, outDir)}`);
  const stats = { downloaded: 0, skipped: 0 };
  let cursor = 0;
  let bytes = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < tracks.length) {
        const track = tracks[cursor++];
        const outcome = await downloadOne(track);
        stats[outcome] += 1;
        bytes += track.size;
      }
    }),
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify({ version: VERSION, objectCount: tracks.length, totalBytes: bytes }, null, 2)}\n`,
  );
  console.log(
    `[download-music-disc-sounds] downloaded ${stats.downloaded}, skipped ${stats.skipped}, ${(bytes / 1024 / 1024).toFixed(1)} MB total`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
