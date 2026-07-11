#!/usr/bin/env node
/*
 * Extract Minecraft mob jockeys (mobs that spawn riding other mobs) ->
 * mob-riders.json + the rider/mount images consumers need to composite them.
 *
 * Source-derived: every vanilla mob-riding-mob spawn goes through
 * EntitySpawnReason.JOCKEY, so this scans the decompiled entity sources for
 * those sites, resolves the created entity through the EntityTypes registry,
 * infers the ride direction from the adjacent startRiding call, and captures
 * the guarding random chance. In 26.2 that finds the chicken jockey, spider
 * jockey, zombie horseman, drowned on zombie nautilus, and the two strider
 * riders. A curated overlay adds display names and notes the code cannot
 * cheaply express (the chicken jockey rider is the baby-zombie family).
 *
 * Assets: for each pair the canonical rider/mount images from the dataset's
 * mob-images/ are copied into datasets/<v>/mob-riders/images/ so consumers
 * can composite a jockey without re-deriving datahub layouts.
 *
 *   node scripts/build-mob-riders.mjs [version]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] ?? "26.2";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sourceRoot = path.join(repoRoot, "workspace/versions", VERSION, "decompiled/client/net/minecraft/world/entity");
const datasetDir = path.join(repoRoot, "workspace/datasets", VERSION);
const mobImagesDir = path.join(datasetDir, "mob-images");
const outJson = path.join(datasetDir, "mob-riders.json");
const outImages = path.join(datasetDir, "mob-riders", "images");

/** Display names + facts the spawn code cannot cheaply express. */
const CURATED = {
  zombie_on_chicken: {
    name: "Chicken jockey",
    riderIsBaby: true,
    notes: "Spawns from baby zombies; the husk, drowned, zombie villager and zombified piglin subclasses inherit the same code.",
  },
  skeleton_on_spider: { name: "Spider jockey" },
  zombie_on_zombie_horse: { name: "Zombie horseman" },
  drowned_on_zombie_nautilus: { name: "Drowned nautilus jockey" },
  zombified_piglin_on_strider: {
    name: "Strider rider",
    notes: "Comes holding a warped fungus on a stick, strider pre-saddled.",
  },
  strider_on_strider: { name: "Strider piggyback", riderIsBaby: true },
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".java")) out.push(full);
  }
  return out;
}

/* ---- EntityTypes registry: constant + class -> entity id ---------------- */
// Registrations reference EntityTypeIds.<CONST>; resolve those to the string
// ids when the ids file is parseable, falling back to lowercase(CONST),
// which matches every vanilla id.
const idsFile = path.join(sourceRoot, "EntityTypeIds.java");
const idsByConst = new Map();
if (existsSync(idsFile)) {
  const idsSource = readFileSync(idsFile, "utf8");
  for (const match of idsSource.matchAll(/([A-Z_0-9]+)\s*=[^;"]*"(?:minecraft:)?([a-z_]+)"/g)) {
    idsByConst.set(match[1], match[2]);
  }
}
const registrySource = readFileSync(path.join(sourceRoot, "EntityTypes.java"), "utf8");
const constToId = new Map();
const classToId = new Map();
const registryPattern = /EntityType<([\w.]+)>\s+([A-Z_0-9]+)\s*=\s*register\(\s*EntityTypeIds\.([A-Z_0-9]+)/g;
for (const match of registrySource.matchAll(registryPattern)) {
  const [, className, constant, idConstant] = match;
  const id = idsByConst.get(idConstant) ?? idConstant.toLowerCase();
  constToId.set(constant, id);
  const simple = className.split(".").pop();
  if (!classToId.has(simple)) classToId.set(simple, id);
}
console.log(`[mob-riders] registry: ${constToId.size} entity types`);

/* ---- scan for JOCKEY spawn sites ---------------------------------------- */
const riders = new Map();
for (const file of walk(sourceRoot)) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("EntitySpawnReason.JOCKEY")) continue;
  const lines = text.split("\n");
  const selfClass = path.basename(file, ".java");
  const selfId = classToId.get(selfClass);
  if (!selfId) continue;

  for (let i = 0; i < lines.length; i += 1) {
    const createMatch = lines[i].match(/(\w+)\s*=\s*EntityTypes\.([A-Z_0-9]+)\.create\(.*EntitySpawnReason\.JOCKEY/);
    if (!createMatch) continue;
    const [, variable, constant] = createMatch;
    const otherId = constToId.get(constant);
    if (!otherId) continue;

    // Ride direction from the startRiding call near the creation site.
    const window = lines.slice(i, i + 14).join("\n");
    let riderId;
    let mountId;
    if (new RegExp(`this\\.startRiding\\(${variable}\\b`).test(window)) {
      riderId = selfId;
      mountId = otherId;
    } else if (
      new RegExp(`${variable}\\.startRiding\\(this\\b`).test(window) ||
      new RegExp(`spawnJockey\\([^)]*\\b${variable}\\b`).test(window)
    ) {
      riderId = otherId;
      mountId = selfId;
    } else {
      console.warn(`  ambiguous direction in ${selfClass}.java:${i + 1}, skipping`);
      continue;
    }

    // The guarding random chance, if one sits just above the creation site.
    let chance = null;
    let guard = null;
    for (let back = i; back >= Math.max(0, i - 10); back -= 1) {
      const floatGuard = lines[back].match(/nextFloat\(\)\s*<\s*([0-9.]+)F?/);
      const intGuard = lines[back].match(/nextInt\((\d+)\)\s*==\s*0/);
      if (floatGuard) {
        chance = Number(floatGuard[1]);
        guard = lines[back].trim();
        break;
      }
      if (intGuard) {
        chance = 1 / Number(intGuard[1]);
        guard = lines[back].trim();
        break;
      }
    }

    const id = `${riderId}_on_${mountId}`;
    const curated = CURATED[id] ?? {};
    riders.set(id, {
      id,
      name: curated.name ?? `${riderId} on ${mountId}`,
      riderId,
      mountId,
      riderIsBaby: curated.riderIsBaby ?? false,
      chance,
      guard,
      sourceFile: `${selfClass}.java:${i + 1}`,
      ...(curated.notes ? { notes: curated.notes } : {}),
    });
  }
}

/* ---- canonical rider/mount images ---------------------------------------- */
function canonicalImage(mobId, wantBaby) {
  const dir = path.join(mobImagesDir, mobId);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
  const preferred = wantBaby ? [`${mobId}_baby.png`, `${mobId}_temperate_baby.png`] : [`${mobId}.png`, `${mobId}_temperate.png`];
  const chosen =
    preferred.find((name) => files.includes(name)) ??
    files.filter((f) => f.startsWith(mobId) && (wantBaby ? f.includes("baby") : !f.includes("baby"))).sort()[0] ??
    files.sort()[0];
  return chosen ? path.join(dir, chosen) : null;
}

mkdirSync(outImages, { recursive: true });
const entries = [...riders.values()].sort((a, b) => a.id.localeCompare(b.id));
for (const entry of entries) {
  const riderSrc = canonicalImage(entry.riderId, entry.riderIsBaby);
  const mountSrc = canonicalImage(entry.mountId, false);
  if (riderSrc) {
    entry.riderImage = `images/${entry.id}__rider.png`;
    copyFileSync(riderSrc, path.join(outImages, `${entry.id}__rider.png`));
  } else {
    console.warn(`  no rider image for ${entry.riderId}`);
  }
  if (mountSrc) {
    entry.mountImage = `images/${entry.id}__mount.png`;
    copyFileSync(mountSrc, path.join(outImages, `${entry.id}__mount.png`));
  } else {
    console.warn(`  no mount image for ${entry.mountId}`);
  }
}

const payload = { version: VERSION, generatedAt: new Date().toISOString(), riders: entries };
writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[mob-riders] ${entries.length} jockey pairs -> ${path.relative(repoRoot, outJson)}`);
for (const entry of entries) {
  console.log(
    `  ${entry.id.padEnd(32)} chance=${entry.chance ?? "?"} ${entry.riderImage ? "img+" : "img-"} (${entry.sourceFile})`,
  );
}
