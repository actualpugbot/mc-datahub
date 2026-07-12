#!/usr/bin/env node
/*
 * Download the note-block instrument oggs referenced by note-block-sounds.json
 * into the content-addressed Pages store pages/note-block/<hash[0:2]>/<hash>.ogg,
 * mirroring scripts/download-mob-sounds.mjs. Run after build-note-block-sounds.mjs.
 *
 * Content-addressed + idempotent: an object already present with the expected
 * size is skipped. raw.githubusercontent serves this tree, and pugtools copies
 * it into apps/web/public/note-block-lab/sounds/ for same-origin playback.
 *
 *   node scripts/download-note-block-sounds.mjs [version]
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] ?? "26.2";
const MAX_RETRIES = 3;
const CONCURRENCY = 8;
const ASSET_DOWNLOAD_BASE_URL = "https://resources.download.minecraft.net";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const datasetPath = path.join(repoRoot, "workspace/datasets", VERSION, "note-block-sounds.json");
const outDir = path.join(repoRoot, "pages/note-block");

const downloadUrl = (hash) => `${ASSET_DOWNLOAD_BASE_URL}/${hash.slice(0, 2)}/${hash}`;
const objectPath = (hash) => path.join(outDir, hash.slice(0, 2), `${hash}.ogg`);

function collectVariants() {
  const data = JSON.parse(readFileSync(datasetPath, "utf8"));
  const byHash = new Map();
  for (const instrument of data) {
    for (const variant of instrument.variants ?? []) {
      if (variant.hash) {
        byHash.set(variant.hash, { size: variant.size ?? 0 });
      }
    }
  }
  return byHash;
}

async function downloadOne(hash, { size }) {
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
  const byHash = collectVariants();
  const entries = [...byHash.entries()];
  console.log(`[download-note-block-sounds] ${entries.length} unique oggs -> ${path.relative(repoRoot, outDir)}`);
  const stats = { downloaded: 0, skipped: 0 };
  let cursor = 0;
  let bytes = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < entries.length) {
        const [hash, meta] = entries[cursor++];
        const outcome = await downloadOne(hash, meta);
        stats[outcome] += 1;
        bytes += meta.size;
      }
    }),
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify({ version: VERSION, objectCount: entries.length, totalBytes: bytes }, null, 2)}\n`,
  );
  console.log(
    `[download-note-block-sounds] downloaded ${stats.downloaded}, skipped ${stats.skipped}, ${(bytes / 1024).toFixed(0)} KB total`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
