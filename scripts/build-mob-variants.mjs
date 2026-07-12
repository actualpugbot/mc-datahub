#!/usr/bin/env node
/*
 * Extract the climate variant registries (temperate|warm|cold cows, pigs,
 * chickens, frogs and zombie nautiluses) -> mob-variants.json + the adult and
 * baby variant textures consumers need to show each form.
 *
 * Data-derived: 26.x ships these as datapack registries under
 * data/minecraft/<species>_variant/<key>.json with {asset_id, baby_asset_id?,
 * model?, spawn_conditions}. A registry qualifies as a climate registry when
 * its keys are a subset of {temperate, warm, cold} (mirroring
 * TemperatureVariants); other texture-variant registries (cat, wolf, ...) are
 * logged and skipped. Spawn-condition biome tags are flattened by recursively
 * expanding data/minecraft/tags/worldgen/biome so consumers get concrete
 * biome lists. The <species>_sound_variant registries (moody cow, picky
 * chicken, big/mini pig) ride along: they shipped in the same 26.x variant
 * push and are keyed to the same mobs.
 *
 * Assets: each variant's adult + baby texture is resolved through the
 * dataset's mob-images.json sourcePaths (falling back to the decompiled
 * client textures) and copied into datasets/<v>/mob-variants/images/.
 *
 *   node scripts/build-mob-variants.mjs [version]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] ?? "26.2";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const workspaceRoot = process.env.MCDATAHUB_WORKSPACE_ROOT ?? path.join(repoRoot, "workspace");
const clientRoot = path.join(workspaceRoot, "versions", VERSION, "decompiled/client");
const dataRoot = path.join(clientRoot, "data/minecraft");
const biomeTagsDir = path.join(dataRoot, "tags/worldgen/biome");
const datasetDir = path.join(workspaceRoot, "datasets", VERSION);
const outJson = path.join(datasetDir, "mob-variants.json");
const outImages = path.join(datasetDir, "mob-variants", "images");

const CLIMATE_KEYS = new Set(["temperate", "warm", "cold"]);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/* ---- dataset joins: mob profiles + exported texture paths ---------------- */
const profiles = readJson(path.join(datasetDir, "mob-profiles.json")).mobs;
const profilesByLocalId = new Map(profiles.map((m) => [m.localId, m]));

// mob-images.json knows which archive texture each exported PNG came from;
// resolve asset ids through it so variants reuse the already-exported files.
const imageBySourcePath = new Map();
for (const mob of readJson(path.join(datasetDir, "mob-images.json")).mobs ?? []) {
  for (const variant of mob.variants ?? []) {
    if (variant.sourcePath && variant.imagePath) imageBySourcePath.set(variant.sourcePath, variant.imagePath);
  }
}

/* ---- biome tag expansion -------------------------------------------------- */
function expandBiomeTag(tagId, seen = new Set()) {
  const name = tagId.replace(/^#/, "").replace(/^minecraft:/, "");
  if (seen.has(name)) return [];
  seen.add(name);
  const file = path.join(biomeTagsDir, `${name}.json`);
  if (!existsSync(file)) {
    console.warn(`  missing biome tag ${name}`);
    return [];
  }
  const biomes = [];
  for (const value of readJson(file).values ?? []) {
    const id = typeof value === "string" ? value : value.id;
    if (id.startsWith("#")) biomes.push(...expandBiomeTag(id, seen));
    else biomes.push(id);
  }
  return biomes;
}

/* ---- texture materialisation ---------------------------------------------- */
mkdirSync(outImages, { recursive: true });
function materialiseTexture(assetId) {
  if (!assetId) return null;
  const relTexture = `assets/minecraft/textures/${assetId.replace(/^minecraft:/, "")}.png`;
  const exported = imageBySourcePath.get(relTexture);
  const source = exported ? path.join(datasetDir, exported) : path.join(clientRoot, relTexture);
  if (!existsSync(source)) {
    console.warn(`  missing texture for ${assetId}`);
    return null;
  }
  const basename = `${path.basename(assetId)}.png`;
  copyFileSync(source, path.join(outImages, basename));
  return `images/${basename}`;
}

/* ---- sound variant registries --------------------------------------------- */
const soundKeys = (obj) =>
  Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => k.endsWith("_sound"))
      .map(([k, v]) => [camel(k), v]),
  );

function readSoundVariants(species) {
  const dir = path.join(dataRoot, `${species}_sound_variant`);
  if (!existsSync(dir)) return null;
  const variants = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const key = path.basename(file, ".json");
    const json = readJson(path.join(dir, file));
    const nested = "adult_sounds" in json;
    variants.push({
      key,
      id: `minecraft:${key}`,
      adultSounds: soundKeys(nested ? json.adult_sounds : json),
      babySounds: nested && json.baby_sounds ? soundKeys(json.baby_sounds) : null,
    });
  }
  return variants;
}

/* ---- climate variant registries -------------------------------------------- */
function modelLayerFor(species, model, assetId, layerIds) {
  const candidates =
    model === "normal" ? [species, path.basename(assetId)] : [`${model}_${species}`, path.basename(assetId), species];
  return candidates.find((c) => layerIds.includes(c)) ?? null;
}

const speciesEntries = [];
const registryDirs = readdirSync(dataRoot).filter((d) => d.endsWith("_variant") && !d.endsWith("_sound_variant"));
for (const dir of registryDirs.sort()) {
  const species = dir.slice(0, -"_variant".length);
  const files = readdirSync(path.join(dataRoot, dir)).filter((f) => f.endsWith(".json"));
  const keys = files.map((f) => path.basename(f, ".json"));
  if (!keys.every((k) => CLIMATE_KEYS.has(k))) {
    console.log(`[mob-variants] skipping ${dir} (${keys.length} entries, not a climate registry)`);
    continue;
  }
  const profile = profilesByLocalId.get(species);
  if (!profile) {
    console.warn(`[mob-variants] skipping ${dir}: no mob profile for '${species}'`);
    continue;
  }
  const layerIds = profile.modelLayerIds ?? [];

  const variants = [];
  for (const key of [...CLIMATE_KEYS].filter((k) => keys.includes(k))) {
    const json = readJson(path.join(dataRoot, dir, `${key}.json`));
    const model = json.model ?? "normal";
    const modelLayerId = modelLayerFor(species, model, json.asset_id, layerIds);
    const spawnConditions = (json.spawn_conditions ?? []).map((entry) => ({
      priority: entry.priority ?? 0,
      biomeTag: entry.condition?.biomes?.replace(/^#/, "") ?? null,
    }));
    const biomeTags = spawnConditions.map((c) => c.biomeTag).filter(Boolean);
    variants.push({
      key,
      id: `minecraft:${key}`,
      model,
      modelLayerId,
      babyModelLayerId: modelLayerId && layerIds.includes(`${modelLayerId}_baby`) ? `${modelLayerId}_baby` : null,
      assetId: json.asset_id,
      babyAssetId: json.baby_asset_id ?? null,
      image: materialiseTexture(json.asset_id),
      babyImage: materialiseTexture(json.baby_asset_id),
      spawnConditions,
      // null = the unconditional fallback: spawns anywhere no other variant won.
      biomes: biomeTags.length > 0 ? [...new Set(biomeTags.flatMap((t) => expandBiomeTag(t)))].sort() : null,
    });
  }

  speciesEntries.push({
    id: profile.id,
    localId: species,
    displayName: profile.displayName,
    registry: `minecraft:${dir}`,
    defaultVariant: variants.find((v) => v.spawnConditions.some((c) => !c.biomeTag))?.key ?? null,
    variants,
    soundVariants: readSoundVariants(species),
  });
}

const payload = { version: VERSION, generatedAt: new Date().toISOString(), species: speciesEntries };
writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[mob-variants] ${speciesEntries.length} species -> ${path.relative(repoRoot, outJson)}`);
for (const entry of speciesEntries) {
  const kinds = entry.variants.map((v) => `${v.key}${v.babyImage ? "+baby" : ""}`).join(", ");
  const sounds = entry.soundVariants ? `, sounds: ${entry.soundVariants.map((s) => s.key).join("/")}` : "";
  console.log(`  ${entry.localId.padEnd(16)} ${kinds}${sounds}`);
}
