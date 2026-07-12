#!/usr/bin/env node
/*
 * Extract which mobs have baby forms and what those babies actually are ->
 * mob-babies.json + a canonical baby image per mob.
 *
 * Source-derived: a vanilla mob is baby-capable in one of two ways. Ageable
 * mobs extend AgeableMob (age counter, grows up after -babyStartAge ticks,
 * age-lockable with a golden dandelion unless tagged cannot_be_age_locked);
 * flag mobs (zombie family, piglin, zoglin) carry a permanent boolean and
 * never grow up. This scans the decompiled entity class hierarchy for both,
 * reading each mob's real numbers instead of assuming the defaults:
 * getAgeScale overrides (camel 0.6, turtle 0.3, happy ghast 0.2375, ...),
 * getBabyStartAge overrides (sniffer -48000), explicit BABY_DIMENSIONS
 * hitboxes (zombie, piglin, zoglin), canBeABaby() opt-outs (camel husk) and
 * the flag babies' transient speed boost.
 *
 * Assets: each baby-capable mob's canonical baby texture from the dataset's
 * mob-images/ is copied into datasets/<v>/mob-babies/images/. Mobs whose
 * baby is just the adult texture scaled down get usesAdultTexture: true.
 *
 *   node scripts/build-mob-babies.mjs [version]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] ?? "26.2";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const workspaceRoot = process.env.MCDATAHUB_WORKSPACE_ROOT ?? path.join(repoRoot, "workspace");
const clientRoot = path.join(workspaceRoot, "versions", VERSION, "decompiled/client");
const entityRoot = path.join(clientRoot, "net/minecraft/world/entity");
const datasetDir = path.join(workspaceRoot, "datasets", VERSION);
const outJson = path.join(datasetDir, "mob-babies.json");
const outImages = path.join(datasetDir, "mob-babies", "images");

const DEFAULT_SCALE = 0.5; // LivingEntity.DEFAULT_BABY_SCALE
const DEFAULT_BABY_START_AGE = -24000; // AgeableMob.BABY_START_AGE

/**
 * Adult -> separate juvenile entity relationships. These pairs are not baby
 * forms (the adult opts out via canBeABaby), so they need a curated record.
 */
const JUVENILE_ENTITIES = [
  {
    adult: "minecraft:frog",
    juvenile: "minecraft:tadpole",
    notes: "Breeding frogs lays frogspawn that hatches into tadpoles; frogs themselves cannot be babies.",
  },
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const round = (n) => Math.round(n * 10000) / 10000;

/* ---- entity class index + hierarchy --------------------------------------- */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".java")) out.push(full);
  }
  return out;
}

const sourceByClass = new Map();
const parentByClass = new Map();
for (const file of walk(entityRoot)) {
  const name = path.basename(file, ".java");
  const text = readFileSync(file, "utf8");
  sourceByClass.set(name, text);
  const decl = text.match(/\bclass\s+(\w+)(?:<[^>{]*>)?\s+extends\s+([\w.]+)/);
  if (decl && decl[1] === name) parentByClass.set(name, decl[2].split(".").pop());
}

function ancestry(className) {
  const chain = [];
  for (let cls = className; cls && sourceByClass.has(cls) && !chain.includes(cls); cls = parentByClass.get(cls)) {
    chain.push(cls);
  }
  return chain; // self first, then superclasses
}

/* ---- EntityTypes registry: entity id -> entity class ---------------------- */
const idsByConst = new Map();
const idsSource = readFileSync(path.join(entityRoot, "EntityTypeIds.java"), "utf8");
for (const match of idsSource.matchAll(/([A-Z_0-9]+)\s*=[^;"]*"(?:minecraft:)?([a-z_]+)"/g)) {
  idsByConst.set(match[1], match[2]);
}
const classById = new Map();
const registrySource = readFileSync(path.join(entityRoot, "EntityTypes.java"), "utf8");
for (const match of registrySource.matchAll(
  /EntityType<([\w.]+)>\s+[A-Z_0-9]+\s*=\s*register\(\s*EntityTypeIds\.([A-Z_0-9]+)/g,
)) {
  const id = idsByConst.get(match[2]) ?? match[2].toLowerCase();
  classById.set(id, match[1].split(".").pop());
}

/* ---- per-class fact extraction -------------------------------------------- */
// First match wins walking self -> superclasses, so overrides shadow defaults.
function findInAncestry(chain, fn) {
  for (const cls of chain) {
    const found = fn(sourceByClass.get(cls), cls);
    if (found !== undefined && found !== null) return found;
  }
  return null;
}

const resolveConstant = (source, token) => {
  if (/^-?[\d.]+$/.test(token)) return Number(token);
  const constant = source.match(new RegExp(`${token}\\s*=\\s*(-?[\\d.]+)F?;`));
  return constant ? Number(constant[1]) : null;
};

const definesBabyFlag = (cls) => /EntityDataAccessor<Boolean>\s+DATA_BABY_ID/.test(sourceByClass.get(cls));

// BABY_DIMENSIONS comes in two forms: literal `EntityDimensions.scalable(w, h)`
// and `EntityTypes.<CONST>.getDimensions().scale(f)` (resolved through the
// referenced mob's registered dimensions), both optionally .withEyeHeight().
function parseBabyDimensions(chain, adultDimsByConst) {
  return findInAncestry(chain, (source) => {
    const statement = source.match(/EntityDimensions\s+BABY_DIMENSIONS\s*=\s*([\s\S]*?);/);
    if (!statement) return null;
    const eye = statement[1].match(/withEyeHeight\(([\d.]+)F?\)/);
    const scalable = statement[1].match(/scalable\(([\d.]+)F?,\s*([\d.]+)F?\)/);
    if (scalable) {
      return {
        width: Number(scalable[1]),
        height: Number(scalable[2]),
        // EntityDimensions.scalable defaults eyeHeight to 85% of height.
        eyeHeight: eye ? Number(eye[1]) : round(Number(scalable[2]) * 0.85),
      };
    }
    // .withAttachments(...) etc. may sit between getDimensions() and scale().
    const scaled = statement[1].match(/EntityTypes\.([A-Z_0-9]+)[\s\S]*?\.scale\(([\d.]+)F?\)/);
    if (scaled) {
      const base = adultDimsByConst(scaled[1]);
      if (!base) return null;
      const factor = Number(scaled[2]);
      return {
        width: round(base.width * factor),
        height: round(base.height * factor),
        eyeHeight: eye ? Number(eye[1]) : base.eyeHeight !== undefined ? round(base.eyeHeight * factor) : undefined,
      };
    }
    return null;
  });
}

/* ---- age-lock opt-out tag -------------------------------------------------- */
const cannotBeAgeLocked = new Set();
const ageLockTagFile = path.join(clientRoot, "data/minecraft/tags/entity_type/cannot_be_age_locked.json");
if (existsSync(ageLockTagFile)) {
  for (const value of readJson(ageLockTagFile).values ?? []) {
    cannotBeAgeLocked.add(typeof value === "string" ? value : value.id);
  }
}

/* ---- join against the mob datasets ----------------------------------------- */
const profiles = readJson(path.join(datasetDir, "mob-profiles.json")).mobs;
const profilesById = new Map(profiles.map((m) => [m.id, m]));
const imagesByLocalId = new Map((readJson(path.join(datasetDir, "mob-images.json")).mobs ?? []).map((m) => [m.localId, m]));
const adultDimsByConst = (constant) => {
  const id = idsByConst.get(constant) ?? constant.toLowerCase();
  return profilesById.get(`minecraft:${id}`)?.dimensions ?? null;
};

mkdirSync(outImages, { recursive: true });
const babies = [];
const skipped = [];
for (const profile of profiles) {
  const className = classById.get(profile.localId) ?? path.basename(profile.sourceClass ?? "", ".java");
  const chain = ancestry(className);
  if (chain.length === 0) continue;

  const ageable = chain.includes("AgeableMob");
  const flagClass = chain.find((cls) => cls !== "AgeableMob" && definesBabyFlag(cls));
  if (!ageable && !flagClass) continue;

  const canBeABaby = findInAncestry(chain, (source) => {
    const override = source.match(/boolean\s+canBeABaby\(\)\s*\{\s*return\s+(true|false);/);
    return override ? override[1] === "true" : null;
  });
  if (canBeABaby === false) {
    skipped.push(`${profile.localId} (canBeABaby=false in ${className})`);
    continue;
  }

  const scale =
    findInAncestry(
      chain.filter((c) => c !== "LivingEntity"),
      (source) => {
        const override = source.match(/float\s+getAgeScale\(\)\s*\{\s*return\s+this\.isBaby\(\)\s*\?\s*([\d.]+)F?\s*:/);
        return override ? Number(override[1]) : null;
      },
    ) ?? DEFAULT_SCALE;

  const explicitDims = parseBabyDimensions(chain, adultDimsByConst);
  const adult = profile.dimensions ?? {};
  const babyDimensions =
    explicitDims ??
    (adult.width !== undefined
      ? {
          width: round(adult.width * scale),
          height: round(adult.height * scale),
          ...(adult.eyeHeight !== undefined ? { eyeHeight: round(adult.eyeHeight * scale) } : {}),
        }
      : null);

  const babyStartAge = ageable
    ? (findInAncestry(chain, (source) => {
        const override = source.match(/int\s+getBabyStartAge\(\)\s*\{\s*return\s+([-\w.]+);/);
        return override ? resolveConstant(source, override[1].split(".").pop()) : null;
      }) ?? DEFAULT_BABY_START_AGE)
    : null;

  const speedModifier = flagClass
    ? findInAncestry(chain, (source) => {
        const modifier = source.match(
          /SPEED_MODIFIER_BABY\s*=\s*new AttributeModifier\([\s\S]*?,\s*([\d.]+),\s*AttributeModifier\.Operation\.(\w+)/,
        );
        return modifier ? { amount: Number(modifier[1]), operation: modifier[2].toLowerCase() } : null;
      })
    : null;

  // Canonical baby texture: the dataset's mob-images variants tagged "baby".
  const imageEntry = imagesByLocalId.get(profile.localId);
  const babyVariants = (imageEntry?.variants ?? []).filter((v) => v.role === "baby");
  const preferred = [`${profile.localId}_baby.png`, `${profile.localId}_temperate_baby.png`];
  const canonical =
    babyVariants.find((v) => preferred.includes(path.basename(v.imagePath))) ??
    babyVariants.sort((a, b) => a.imagePath.localeCompare(b.imagePath))[0] ??
    null;
  let babyImage = null;
  if (canonical && existsSync(path.join(datasetDir, canonical.imagePath))) {
    babyImage = `images/${profile.localId}_baby.png`;
    copyFileSync(path.join(datasetDir, canonical.imagePath), path.join(outImages, `${profile.localId}_baby.png`));
  }

  babies.push({
    id: profile.id,
    localId: profile.localId,
    displayName: profile.displayName,
    babyType: ageable ? "ageable" : "flag",
    scale,
    adultDimensions: adult.width !== undefined ? adult : null,
    babyDimensions,
    babyDimensionsOrigin: explicitDims ? "explicit" : "scaled",
    growsUp: ageable,
    growthTicks: babyStartAge !== null ? -babyStartAge : null,
    ageLockable: ageable && !cannotBeAgeLocked.has(profile.id),
    babySpeedModifier: speedModifier,
    babyImage,
    adultImage: imageEntry?.imagePath ?? null,
    usesAdultTexture: babyImage === null,
    babyModelLayerIds: (profile.modelLayerIds ?? []).filter((l) => /(^|_)baby($|_)/.test(l)),
    sourceClass: profile.sourceClass ?? null,
  });
}

babies.sort((a, b) => a.localId.localeCompare(b.localId));
const payload = {
  version: VERSION,
  generatedAt: new Date().toISOString(),
  defaults: { scale: DEFAULT_SCALE, growthTicks: -DEFAULT_BABY_START_AGE },
  juvenileEntities: JUVENILE_ENTITIES,
  mobs: babies,
};
writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[mob-babies] ${babies.length} baby-capable mobs -> ${path.relative(repoRoot, outJson)}`);
for (const skip of skipped) console.log(`  skipped ${skip}`);
for (const mob of babies) {
  const bits = [
    mob.babyType,
    `scale=${mob.scale}`,
    mob.growsUp ? `grows in ${mob.growthTicks}t` : "never grows",
    mob.babyImage ? "img+" : "img-",
  ];
  console.log(`  ${mob.localId.padEnd(20)} ${bits.join(" ")}`);
}
