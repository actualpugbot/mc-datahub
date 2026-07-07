/*
 * Downloads the game's mob sound objects (ogg vorbis) from Mojang's public
 * resources CDN into a committed, content-addressed store so the pugtools.com
 * mob tools can serve them same-origin instead of hot-linking Mojang at runtime.
 *
 * The sound *metadata* (hash + CDN url + resource-pack path) already lives in
 *   workspace/datasets/<version>/mob-sounds.json
 * but the ogg bytes themselves are external objects Minecraft streams on demand,
 * so they exist nowhere in this repo. This is the one place we touch Mojang: a
 * one-shot prep step that materialises the bytes here. pugtools then copies from
 * `pages/mob-sounds/` into its own `public/` at build time (see the sibling
 * pugtools repo's scripts/build-mob-sound-assets.mjs).
 *
 * Published/committed layout (content-addressed, mirrors Mojang's own):
 *   pages/mob-sounds/<hash[0:2]>/<hash>.ogg
 *   pages/mob-sounds/manifest.json        version + counts (integrity check)
 *
 * Usage:
 *   node scripts/download-mob-sounds.mjs [version]
 *   node scripts/download-mob-sounds.mjs --file <path/to/mob-sounds.json>
 *   version defaults to the newest processed dataset in workspace/state.json.
 *   --file tops the store up from an arbitrary mob-sounds.json (variants must
 *   carry `hash` + `url`); use it to cover extra objects a downstream consumer
 *   pins that the current dataset no longer references.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const datasetsDir = path.join(repoRoot, "workspace", "datasets");
const statePath = path.join(repoRoot, "workspace", "state.json");
const CONCURRENCY = 16;
const MAX_RETRIES = 4;

function resolveVersion(requested) {
  if (requested) return requested;
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const processed = Object.entries(state.processedVersions ?? {})
      .map(([version, details]) => ({
        version,
        at: new Date(details?.processedAt ?? 0).getTime() || 0,
      }))
      .sort((a, b) => b.at - a.at || b.version.localeCompare(a.version));
    if (processed[0]) return processed[0].version;
  }
  throw new Error(
    "No version given and none found in workspace/state.json processedVersions.",
  );
}

function collectVariants(dataset) {
  // hash -> { url, size } deduped (objects are content-addressed).
  const uniq = new Map();
  for (const mob of dataset.mobs ?? []) {
    for (const event of mob.soundEvents ?? []) {
      for (const variant of event.variants ?? []) {
        const { hash, url, size } = variant;
        if (!hash || !url) continue;
        if (!uniq.has(hash)) uniq.set(hash, { url, size: size ?? 0 });
      }
    }
  }
  return uniq;
}

function objectPath(outDir, hash) {
  return path.join(outDir, hash.slice(0, 2), `${hash}.ogg`);
}

async function downloadOne(hash, { url, size }, outDir) {
  const dest = objectPath(outDir, hash);
  if (existsSync(dest)) {
    // Content-addressed: a right-sized existing file is already correct.
    if (size === 0 || statSync(dest).size === size) return "skipped";
  }
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
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

function resolveSource() {
  const args = process.argv.slice(2);
  const fileFlag = args.indexOf("--file");
  if (fileFlag !== -1) {
    const filePath = args[fileFlag + 1];
    if (!filePath) throw new Error("--file requires a path argument.");
    return { label: path.basename(filePath), datasetPath: path.resolve(filePath) };
  }
  const version = resolveVersion(args[0]);
  return {
    label: version,
    datasetPath: path.join(datasetsDir, version, "mob-sounds.json"),
  };
}

async function run() {
  const { label, datasetPath } = resolveSource();
  if (!existsSync(datasetPath)) {
    console.error(`[download-mob-sounds] missing dataset: ${datasetPath}`);
    process.exit(1);
  }

  const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
  const variants = collectVariants(dataset);
  const outDir = path.join(repoRoot, "pages", "mob-sounds");
  mkdirSync(outDir, { recursive: true });

  console.log(
    `[download-mob-sounds] ${label}: ${variants.size} unique objects -> ${outDir}`,
  );

  const entries = [...variants.entries()];
  const counts = { downloaded: 0, skipped: 0 };
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const index = cursor++;
      const [hash, meta] = entries[index];
      try {
        counts[await downloadOne(hash, meta, outDir)] += 1;
      } catch (error) {
        failures.push(error.message);
      }
      const done = counts.downloaded + counts.skipped + failures.length;
      if (done % 200 === 0 || done === entries.length) {
        console.log(
          `  ${done}/${entries.length} (dl ${counts.downloaded}, skip ${counts.skipped}, fail ${failures.length})`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker),
  );

  if (failures.length > 0) {
    console.error(`[download-mob-sounds] ${failures.length} failed:`);
    for (const message of failures.slice(0, 20)) console.error(`  - ${message}`);
    process.exit(1);
  }

  // Manifest reflects the whole on-disk store, not just this run's dataset, so
  // incremental `--file` top-ups accumulate rather than shrink the count.
  let storeCount = 0;
  let storeBytes = 0;
  for (const shard of readdirSync(outDir, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardDir = path.join(outDir, shard.name);
    for (const file of readdirSync(shardDir)) {
      if (!file.endsWith(".ogg")) continue;
      storeCount += 1;
      storeBytes += statSync(path.join(shardDir, file)).size;
    }
  }
  writeFileSync(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(
      {
        objectCount: storeCount,
        totalBytes: storeBytes,
        note: "Content-addressed mob sound objects from resources.download.minecraft.net. Regenerate with scripts/download-mob-sounds.mjs.",
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `[download-mob-sounds] done: ${counts.downloaded} downloaded, ${counts.skipped} present; store now ${storeCount} objects (${(storeBytes / 1024 / 1024).toFixed(1)} MB).`,
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
