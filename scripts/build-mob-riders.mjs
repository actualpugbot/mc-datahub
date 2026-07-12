#!/usr/bin/env node
/*
 * Extract the complete Minecraft riding/passenger system -> mob-riders.json
 * (+ the rider/mount images consumers need to composite jockeys).
 *
 * Source-derived from the decompiled client. The dataset has five parts:
 *
 *   mechanics        - the global rules: the positioning formula, attachment
 *                      fallbacks, seat selection, scale handling, boarding
 *                      rules, control/steering defaults. Numeric constants are
 *                      re-extracted from the source each run (warn on drift).
 *   display          - what the CLIENT does visually: the humanoid/illager
 *                      riding pose angles, body-yaw clamps, baby model
 *                      transform, saddle/rein layer behaviour.
 *   entities         - per entity type: hitbox, eye height, every PASSENGER
 *                      seat point, the VEHICLE mount point, passenger caps,
 *                      saddle/steering/control rules, and which class-level
 *                      overrides customise the defaults.
 *   overrideSources  - the verbatim Java bodies of every riding-related
 *                      override referenced by `entities`, keyed by class, so
 *                      consumers can reproduce seat math the registry cannot
 *                      express (boats, camels, striders, slimes, ...).
 *   riders           - the jockey pairs (mobs that spawn riding other mobs),
 *                      scanned from EntitySpawnReason.JOCKEY sites, with
 *                      spawn chances and composite images.
 *
 * Assets: for each jockey pair the canonical rider/mount images from the
 * dataset's mob-images/ are copied into datasets/<v>/mob-riders/images/.
 *
 *   node scripts/build-mob-riders.mjs [version]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = process.argv[2] ?? "26.2";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const workspaceRoot = process.env.MCDATAHUB_WORKSPACE_ROOT ?? path.join(repoRoot, "workspace");
const clientRoot = path.join(workspaceRoot, "versions", VERSION, "decompiled/client");
const sourceRoot = path.join(clientRoot, "net/minecraft/world/entity");
const datasetDir = path.join(workspaceRoot, "datasets", VERSION);
const mobImagesDir = path.join(datasetDir, "mob-images");
const outJson = path.join(datasetDir, "mob-riders.json");
const outImages = path.join(datasetDir, "mob-riders", "images");

const warnings = [];
function warn(message) {
  warnings.push(message);
  console.warn(`  [warn] ${message}`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".java")) out.push(full);
  }
  return out;
}

/** Text of a call's argument list: scan forward from `(` balancing parens. */
function callArgs(text, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openParenIndex + 1, i);
    }
  }
  return null;
}

/** Every `.name(...)` call in a builder chunk, with balanced-paren args. */
function builderCalls(chunk, name) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = chunk.indexOf(`.${name}(`, from);
    if (at === -1) return out;
    const args = callArgs(chunk, at + name.length + 1);
    if (args !== null) out.push(args);
    from = at + name.length + 2;
  }
}

function parseVec3s(args) {
  const out = [];
  for (const m of args.matchAll(/new Vec3\(\s*(-?[\d.]+)F?,\s*(-?[\d.]+)F?,\s*(-?[\d.]+)F?\s*\)/g)) {
    out.push({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) });
  }
  return out;
}

/* ====================================================================== */
/* 1. EntityTypes registry: id, class, hitbox, declared attachment points */
/* ====================================================================== */

const idsByConst = new Map();
const idsFile = path.join(sourceRoot, "EntityTypeIds.java");
if (existsSync(idsFile)) {
  for (const m of readFileSync(idsFile, "utf8").matchAll(/([A-Z_0-9]+)\s*=[^;"]*"(?:minecraft:)?([a-z_]+)"/g)) {
    idsByConst.set(m[1], m[2]);
  }
}

// Named Vec3 constants used inside builder chains (e.g. the player's
// Avatar.DEFAULT_VEHICLE_ATTACHMENT).
const namedVec3s = new Map();
const avatarFile = path.join(sourceRoot, "Avatar.java");
if (existsSync(avatarFile)) {
  const m = readFileSync(avatarFile, "utf8").match(
    /DEFAULT_VEHICLE_ATTACHMENT\s*=\s*new Vec3\(\s*(-?[\d.]+)F?,\s*(-?[\d.]+)F?,\s*(-?[\d.]+)F?\s*\)/,
  );
  if (m) namedVec3s.set("Avatar.DEFAULT_VEHICLE_ATTACHMENT", { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) });
}

const registrySource = readFileSync(path.join(sourceRoot, "EntityTypes.java"), "utf8");
const constToId = new Map();
const classToId = new Map();
/** id -> { class, width, height, eyeHeight, passengerAttachments[], vehicleAttachment } */
const registry = new Map();
const registryPattern = /EntityType<([\w.]+)>\s+([A-Z_0-9]+)\s*=\s*register\(\s*EntityTypeIds\.([A-Z_0-9]+)([\s\S]*?)\n {3}\);/g;
for (const match of registrySource.matchAll(registryPattern)) {
  const [, className, constant, idConstant, builder] = match;
  const id = idsByConst.get(idConstant) ?? idConstant.toLowerCase();
  constToId.set(constant, id);
  const simple = className.split(".").pop();
  if (!classToId.has(simple)) classToId.set(simple, id);

  const entry = { class: simple };
  const sized = builder.match(/\.sized\(([\d.]+)F?,\s*([\d.]+)F?\)/);
  if (sized) {
    entry.width = Number(sized[1]);
    entry.height = Number(sized[2]);
  }
  const eye = builder.match(/\.eyeHeight\(([\d.]+)F?\)/);
  if (eye) entry.eyeHeight = Number(eye[1]);

  // .passengerAttachments(y1, y2, ...) or .passengerAttachments(Vec3...)
  const passengerPoints = [];
  for (const args of builderCalls(builder, "passengerAttachments")) {
    const vecs = parseVec3s(args);
    if (vecs.length > 0) passengerPoints.push(...vecs);
    else {
      for (const y of args.split(",")) {
        const n = Number(y.trim().replace(/F$/, ""));
        if (!Number.isNaN(n)) passengerPoints.push({ x: 0, y: n, z: 0 });
      }
    }
  }
  for (const args of builderCalls(builder, "attach")) {
    if (args.includes("EntityAttachment.PASSENGER")) passengerPoints.push(...parseVec3s(args));
  }
  if (passengerPoints.length > 0) entry.passengerAttachments = passengerPoints;

  // .vehicleAttachment(Vec3 | named constant) and .ridingOffset(f) -> (0,-f,0)
  for (const args of builderCalls(builder, "vehicleAttachment")) {
    const vecs = parseVec3s(args);
    if (vecs.length > 0) entry.vehicleAttachment = vecs[0];
    else if (namedVec3s.has(args.trim())) entry.vehicleAttachment = namedVec3s.get(args.trim());
    else warn(`unresolved vehicleAttachment arg "${args.trim()}" on ${id}`);
  }
  const ridingOffset = builder.match(/\.ridingOffset\((-?[\d.]+)F?\)/);
  if (ridingOffset && !entry.vehicleAttachment) {
    entry.vehicleAttachment = { x: 0, y: -Number(ridingOffset[1]), z: 0 };
  }
  registry.set(id, entry);
}
console.log(`[mob-riders] registry: ${registry.size} entity types`);

/* ====================================================================== */
/* 2. Class scan: inheritance graph + riding-related override bodies      */
/* ====================================================================== */

// Defined on these classes = the system default, not a per-mob override.
const BASE_CLASSES = new Set(["Entity", "LivingEntity", "Mob"]);
const RIDING_METHODS = [
  "getPassengerAttachmentPoint",
  "getPassengerRidingPosition",
  "getVehicleAttachmentPoint",
  "positionRider",
  "canAddPassenger",
  "couldAcceptPassenger",
  "canRide",
  "getControllingPassenger",
  "onPassengerTurned",
  "clampRotation",
  "getDismountLocationForPassenger",
  "tickRidden",
  "getRiddenInput",
  "getRiddenSpeed",
  "getAgeScale",
  "canUseSlot",
  "rideHeight",
  "getSinglePassengerXOffset",
  "getMaxPassengers",
];

/** Extract `name(...) { ... }` with balanced braces; null if abstract/absent. */
function extractMethod(text, name) {
  const sig = new RegExp(`(?:public|protected|private)[^\\n;{=]*\\b${name}\\(`, "g");
  for (const m of text.matchAll(sig)) {
    let i = m.index + m[0].length;
    // Skip past the parameter list.
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      i += 1;
    }
    // Body or abstract `;`?
    while (i < text.length && text[i] !== "{" && text[i] !== ";") i += 1;
    if (text[i] !== "{") continue;
    depth = 0;
    while (i < text.length) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          const line = text.slice(0, m.index).split("\n").length;
          const code = text
            .slice(m.index, i + 1)
            .split("\n")
            .map((l) => l.replace(/^ {3}/, ""))
            .join("\n");
          return { line, code };
        }
      }
      i += 1;
    }
  }
  return null;
}

/** class -> { file, extends, methods: { name: {line, code} } } */
const classes = new Map();
for (const file of walk(sourceRoot)) {
  const name = path.basename(file, ".java");
  const text = readFileSync(file, "utf8");
  const ext = text.match(new RegExp(`class\\s+${name}(?:<[^>{]*>)?\\s+extends\\s+([\\w.]+)`));
  const info = {
    file: path.relative(sourceRoot, file).replaceAll("\\", "/"),
    extends: ext ? ext[1].split(".").pop() : null,
    methods: {},
  };
  for (const method of RIDING_METHODS) {
    if (!text.includes(` ${method}(`)) continue;
    const found = extractMethod(text, method);
    if (!found) continue;
    // canUseSlot is mostly armor plumbing; only saddle/harness gating matters.
    if (method === "canUseSlot" && !/EquipmentSlot\.(SADDLE|BODY)/.test(found.code)) continue;
    info.methods[method] = found;
  }
  classes.set(name, info);
}
console.log(`[mob-riders] scanned ${classes.size} entity classes`);

/** Walk the extends chain; nearest non-base definition of `method`. */
function resolveOverride(className, method) {
  for (let cls = className; cls && classes.has(cls); cls = classes.get(cls).extends) {
    if (BASE_CLASSES.has(cls)) return null;
    if (classes.get(cls).methods[method]) return cls;
  }
  return null;
}

/* ====================================================================== */
/* 3. Curated interpretations of the override code (validated vs scan)    */
/* ====================================================================== */

// Passenger caps, read from the canAddPassenger/getMaxPassengers overrides.
const MAX_PASSENGERS = {
  AbstractBoat: { maxPassengers: 2 },
  AbstractChestBoat: { maxPassengers: 1 },
  Camel: {
    maxPassengers: 3,
    playerMountCap: 2,
    notes: "canAddPassenger allows a third passenger, but player mounting (mobInteract) stops at two",
  },
  HappyGhast: { maxPassengers: 4 },
  Strider: { maxPassengers: 1 },
  AbstractNautilus: { maxPassengers: 1 },
  Marker: { maxPassengers: 0 },
  OminousItemSpawner: { maxPassengers: 0 },
};

// Who steers, read from the getControllingPassenger overrides.
const CONTROLLED_BY = {
  AbstractBoat: { controller: "first living passenger" },
  AbstractHorse: { controller: "player", requiresSaddle: true },
  Pig: { controller: "player", requiresSaddle: true, controlItem: "carrot_on_a_stick" },
  Strider: { controller: "player", requiresSaddle: true, controlItem: "warped_fungus_on_a_stick" },
  AbstractNautilus: { controller: "player", requiresSaddle: true },
  HappyGhast: {
    controller: "player",
    requiresHarness: true,
    notes: "needs the body-slot harness; refuses while on its still timeout",
  },
};

// Saddle/harness equipment gating, read from the canUseSlot overrides
// (26.x has no Saddleable interface - saddles are the SADDLE equipment slot,
// the happy ghast harness is the BODY slot).
const SADDLE_RULES = {
  Pig: { slot: "saddle", condition: "alive && !baby" },
  Strider: {
    slot: "saddle",
    condition: "alive && !baby",
    notes: "naturally-spawned cold striders may self-saddle; saddle is a guaranteed drop",
  },
  AbstractHorse: { slot: "saddle", condition: "alive && !baby && tamed" },
  AbstractNautilus: { slot: "saddle", condition: "alive && !baby && tamed", notes: "surfacing strips the saddle underwater" },
  HappyGhast: { slot: "body", condition: "alive && !baby", notes: "the harness; also what makes it rideable" },
};

for (const [table, name] of [
  [MAX_PASSENGERS, "MAX_PASSENGERS"],
  [CONTROLLED_BY, "CONTROLLED_BY"],
  [SADDLE_RULES, "SADDLE_RULES"],
]) {
  for (const cls of Object.keys(table)) {
    const expectMethod = {
      MAX_PASSENGERS: ["canAddPassenger", "getMaxPassengers"],
      CONTROLLED_BY: ["getControllingPassenger"],
      SADDLE_RULES: ["canUseSlot"],
    }[name];
    if (!classes.has(cls) || !expectMethod.some((m) => classes.get(cls).methods[m])) {
      warn(`curated ${name}.${cls} no longer matches an override in the source - re-check`);
    }
  }
}

/* ====================================================================== */
/* 4. Per-entity assembly                                                 */
/* ====================================================================== */

const overrideSources = {};
function referenceOverride(cls, method) {
  const info = classes.get(cls);
  overrideSources[cls] ??= { file: info.file, methods: {} };
  overrideSources[cls].methods[method] ??= info.methods[method];
}

const entities = {};
for (const [id, reg] of [...registry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const entity = { class: reg.class };
  if (reg.width !== undefined) {
    entity.width = reg.width;
    entity.height = reg.height;
  }
  entity.eyeHeight = reg.eyeHeight ?? (reg.height !== undefined ? Number((reg.height * 0.85).toFixed(5)) : undefined);

  if (reg.passengerAttachments) {
    entity.passengerAttachments = reg.passengerAttachments;
    entity.passengerAttachmentsSource = "builder";
  } else if (reg.height !== undefined) {
    entity.passengerAttachments = [{ x: 0, y: reg.height, z: 0 }];
    entity.passengerAttachmentsSource = "fallback-top-of-hitbox";
  }
  entity.vehicleAttachment = reg.vehicleAttachment ?? { x: 0, y: 0, z: 0 };
  entity.vehicleAttachmentSource = reg.vehicleAttachment ? "builder" : "fallback-feet";

  // Class-level overrides along the inheritance chain.
  const overrides = {};
  if (classes.has(reg.class)) {
    for (const method of RIDING_METHODS) {
      const cls = resolveOverride(reg.class, method);
      if (!cls) continue;
      overrides[method] = cls;
      referenceOverride(cls, method);
    }
  }
  if (Object.keys(overrides).length > 0) entity.overrides = overrides;

  // Structured rules derived from those overrides.
  const capCls = overrides.canAddPassenger ?? overrides.getMaxPassengers;
  if (capCls && MAX_PASSENGERS[capCls]) Object.assign(entity, MAX_PASSENGERS[capCls]);
  else if (capCls) warn(`no curated passenger cap for ${capCls} (${id}) - recording override only`);
  entity.maxPassengers ??= 1;

  const controlCls = overrides.getControllingPassenger;
  if (controlCls && CONTROLLED_BY[controlCls]) entity.controlledBy = CONTROLLED_BY[controlCls];

  const saddleCls = overrides.canUseSlot;
  if (saddleCls && SADDLE_RULES[saddleCls]) entity.saddle = SADDLE_RULES[saddleCls];

  if (overrides.tickRidden) entity.playerSteerable = true;

  const ageCls = overrides.getAgeScale;
  if (ageCls) {
    const m = classes.get(ageCls).methods.getAgeScale.code.match(/isBaby\(\)\s*\?\s*([\d.]+)F/);
    if (m) entity.babyAgeScale = Number(m[1]);
  }

  entities[id] = entity;
}

/* ====================================================================== */
/* 5. Mechanics + display constants, re-extracted from the source         */
/* ====================================================================== */

function grab(file, pattern, description, transform = (m) => Number(m[1])) {
  const full = path.join(clientRoot, file);
  if (existsSync(full)) {
    const m = readFileSync(full, "utf8").match(pattern);
    if (m) return transform(m);
  }
  warn(`could not extract ${description} from ${file}`);
  return null;
}

const entityJava = "net/minecraft/world/entity/Entity.java";
const livingJava = "net/minecraft/world/entity/LivingEntity.java";

const boardingCooldownTicks = grab(entityJava, /boardingCooldown = (\d+)/, "boarding cooldown");
const defaultBabyAgeScale = grab(livingJava, /isBaby\(\)\s*\?\s*([\d.]+)F\s*:\s*1\.0F/, "default baby age scale");
const boatYawClampDeg = grab(
  "net/minecraft/world/entity/vehicle/boat/AbstractBoat.java",
  /Mth\.clamp\(delta, -([\d.]+)F, \1F\)/,
  "boat passenger yaw clamp",
);
const riderBodyYawMaxHeadDeltaDeg = grab(
  "net/minecraft/client/renderer/entity/LivingEntityRenderer.java",
  /Mth\.clamp\(Mth\.wrapDegrees\(headRot - bodyRot\), -([\d.]+)F, \1F\)/,
  "rider body-yaw head clamp",
);

// The humanoid riding pose block (players, zombies, skeletons, piglins, ...).
const humanoidRidingPose = grab(
  "net/minecraft/client/model/HumanoidModel.java",
  /if \(state\.isPassenger\) \{([\s\S]*?)\n {6}\}/,
  "humanoid riding pose",
  (m) => {
    const block = m[1];
    const legX = block.match(/rightLeg\.xRot = (-[\d.]+)F/);
    const legZ = block.match(/rightLeg\.zRot = ([\d.]+)F/);
    return {
      armXRotAdd: "-PI/5 (-0.62832) added on top of the walk swing",
      legXRot: legX ? Number(legX[1]) : null,
      legYRot: "±PI/10 (right +, left -)",
      legZRot: legZ ? `±${legZ[1]} (right +, left -)` : null,
    };
  },
);

const babyModelTransform = grab(
  "net/minecraft/client/model/BabyModelTransform.java",
  /this\(scaleHead, babyYHeadOffset, babyZHeadOffset, ([\d.]+)F, ([\d.]+)F, ([\d.]+)F, headParts\)/,
  "baby model transform defaults",
  (m) => ({
    headScale: Number(m[1]),
    bodyScale: Number(m[2]),
    bodyYOffset: Number(m[3]),
    note: "body parts scale 1/bodyScale (=0.5) and shift down bodyYOffset model units; head parts stay full size (or 1.5/headScale when scaleHead) and shift +5y +2z",
  }),
);

const canTurnInBoats = (() => {
  const tagFile = path.join(clientRoot, "data/minecraft/tags/entity_type/can_turn_in_boats.json");
  if (!existsSync(tagFile)) return null;
  return JSON.parse(readFileSync(tagFile, "utf8")).values.map((v) => v.replace("minecraft:", ""));
})();

const mechanics = {
  positioning: {
    formula:
      "riderPos = vehiclePos + rotY(passengerAttachment[seatIndex], -vehicleYaw) - rotY(riderVehicleAttachment, -riderYaw)",
    seatIndex: "vehicle.getPassengers().indexOf(passenger), clamped into the declared seat list",
    passengerAttachmentFallback: "(0, hitboxHeight, 0) when an entity declares no seats",
    vehicleAttachmentFallback: "(0, 0, 0) - the rider's feet sit exactly on the seat point",
    yawRotation:
      "attachment points are rotated around Y by -yaw degrees (vehicle yaw for seats, the rider's own yaw for its vehicle point)",
    scaling:
      "dimensions (and their attachment points) are pre-scaled by ageScale * SCALE attribute; LivingEntity vehicles additionally pass getScale()*getAgeScale() into seat overrides (Camel/Boat/Strider math multiplies by it)",
    livingVsNonLiving:
      "only LivingEntity vehicles apply scale to seats (LivingEntity.getPassengerRidingPosition); boats/minecarts use raw dimensions",
    sourceRefs: [
      "Entity.java positionRider/getPassengerRidingPosition",
      "LivingEntity.java getPassengerRidingPosition",
      "EntityAttachments.java getClamped",
    ],
  },
  rules: {
    defaultMaxPassengers: 1,
    canRideDefault: "!sneaking && boardingCooldown <= 0",
    boardingCooldownTicks,
    couldAcceptPassengerDefault: true,
    noRidingCycles: "startRiding refuses if the vehicle chain already contains the would-be rider",
    playerPassengersMoveToFront:
      "server-side, a boarding player is inserted at index 0 unless the first passenger is already a player",
    controllingPassenger: {
      entityDefault: "none",
      mobDefault: "the first passenger, if it is a Mob that canControlVehicle() and the vehicle is not NoAi",
      perVehicle: "see entities[*].controlledBy",
    },
    rideTick: "each tick the passenger's motion is zeroed and the vehicle re-places it via positionRider",
    dismount:
      "getDismountLocationForPassenger picks a safe adjacent pose; overridden by boats, minecarts, striders, animals, horses, happy ghasts",
    saddles:
      "26.x has no Saddleable interface - the saddle is the SADDLE equipment slot (harness = BODY slot); see entities[*].saddle",
    jockeySpawns: "every mob-riding-mob spawn goes through EntitySpawnReason.JOCKEY; see riders[]",
    defaultBabyAgeScale,
  },
  display: {
    renderPosition:
      "the client applies NO extra seat offset at render time - positionRider runs client-side too, so the passenger's interpolated entity position IS the seat (sole exception: position-lerped minecarts add a passengerOffset)",
    humanoidRidingPose,
    ridingPoseModels:
      "HumanoidModel (state.isPassenger) and IllagerModel (state.isRiding) - same angles; most quadruped models have no riding pose",
    walkAnimationWhilePassenger: "zeroed (LivingEntityRenderer skips walk animation for passengers)",
    riderBodyYaw: {
      onLivingVehicle: `render-side, the rider's body yaw snaps to the vehicle body yaw; the head may deviate up to ±${riderBodyYawMaxHeadDeltaDeg ?? "?"}° (past 50° the body bends 20% of the way toward the head)`,
      inBoats: `logic-side clamp of rider yaw to boat yaw ±${boatYawClampDeg ?? "?"}°; entities tagged can_turn_in_boats are exempt`,
      canTurnInBoats,
      steeredVehicles:
        "horses/camels/pigs/striders set their OWN yaw from the controlling rider each tick (tickRidden), so the pair stays aligned",
      boatSideSaddle: "an Animal in a full boat gets its body yaw turned 90° or 270° (entity id parity) - the side-saddle look",
    },
    baby: {
      geometry:
        "babies are separate baked models: body parts at half size shifted down 24 model units, head kept proportionally large (BabyModelTransform)",
      babyModelTransform,
      seat: "ageScale (default 0.5) shrinks the hitbox/attachments, so baby seats and baby riders land correctly without extra work",
      scaleAttribute:
        "the SCALE attribute is applied as a uniform model scale at render time; ageScale is NOT (it is baked into the geometry)",
    },
    vehicleSide: {
      saddleLayers:
        "saddles/harnesses render as equipment layers on the vehicle (pig/strider/horse/camel/donkey/mule/nautilus/happy ghast); reins become visible when isVehicle()",
      striderRidden: "the strider model stops pitching its body while ridden",
      chickenJockey: "the chicken itself renders unchanged - the jockey is pure attachment-point positioning",
    },
  },
};

/* ====================================================================== */
/* 6. Jockey pairs (EntitySpawnReason.JOCKEY scan)                        */
/* ====================================================================== */

const BABY_SCALE = defaultBabyAgeScale ?? 0.5;
const CURATED_JOCKEYS = {
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

function jockeyDimensions(id) {
  const e = entities[id];
  if (!e || e.width === undefined) return null;
  return {
    width: e.width,
    height: e.height,
    passengerAttachment: e.passengerAttachments?.[0] ?? null,
    vehicleAttachment: e.vehicleAttachment,
  };
}

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
      warn(`ambiguous jockey direction in ${selfClass}.java:${i + 1}, skipping`);
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
    const curated = CURATED_JOCKEYS[id] ?? {};
    const riderIsBaby = curated.riderIsBaby ?? false;
    riders.set(id, {
      id,
      name: curated.name ?? `${riderId} on ${mountId}`,
      riderId,
      mountId,
      riderIsBaby,
      // Real hitbox sizes + seat/mount points so consumers can composite the
      // pair with game-accurate proportions (full data in entities[]).
      riderDimensions: jockeyDimensions(riderId),
      mountDimensions: jockeyDimensions(mountId),
      riderScale: riderIsBaby ? BABY_SCALE : 1,
      mountSeatOverride: entities[mountId]?.overrides?.getPassengerAttachmentPoint ?? null,
      chance,
      guard,
      sourceFile: `${selfClass}.java:${i + 1}`,
      ...(curated.notes ? { notes: curated.notes } : {}),
    });
  }
}

/* ====================================================================== */
/* 7. Canonical rider/mount images                                        */
/* ====================================================================== */

// mob-images/ groups by texture family (drowned.png lives in zombie/,
// zombie_nautilus.png in nautilus/, horse_zombie.png in horse/), so index
// every png by basename and match on the mob id - including the reversed
// compound form (zombie_horse -> horse_zombie).
const imageIndex = new Map();
if (existsSync(mobImagesDir)) {
  for (const file of walk_images(mobImagesDir)) {
    const base = path.basename(file, ".png");
    if (!imageIndex.has(base)) imageIndex.set(base, file);
  }
}
function walk_images(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk_images(full));
    else if (entry.name.endsWith(".png")) out.push(full);
  }
  return out.sort();
}

function canonicalImage(mobId, wantBaby) {
  const reversed = mobId.split("_").reverse().join("_");
  const stems = [mobId, reversed];
  const suffix = wantBaby ? "_baby" : "";
  for (const stem of stems) {
    const exact = imageIndex.get(`${stem}${suffix}`) ?? imageIndex.get(`${stem}_temperate${suffix}`);
    if (exact) return exact;
  }
  for (const stem of stems) {
    const prefixed = [...imageIndex.keys()]
      .filter((b) => b.startsWith(`${stem}_`) && (wantBaby ? b.endsWith("_baby") : !b.includes("baby")))
      .sort()[0];
    if (prefixed) return imageIndex.get(prefixed);
  }
  return null;
}

mkdirSync(outImages, { recursive: true });
const jockeys = [...riders.values()].sort((a, b) => a.id.localeCompare(b.id));
for (const entry of jockeys) {
  const riderSrc = canonicalImage(entry.riderId, entry.riderIsBaby);
  const mountSrc = canonicalImage(entry.mountId, false);
  if (riderSrc) {
    entry.riderImage = `images/${entry.id}__rider.png`;
    copyFileSync(riderSrc, path.join(outImages, `${entry.id}__rider.png`));
  } else {
    warn(`no rider image for ${entry.riderId}`);
  }
  if (mountSrc) {
    entry.mountImage = `images/${entry.id}__mount.png`;
    copyFileSync(mountSrc, path.join(outImages, `${entry.id}__mount.png`));
  } else {
    warn(`no mount image for ${entry.mountId}`);
  }
}

/* ====================================================================== */
/* 8. Write                                                               */
/* ====================================================================== */

const payload = {
  version: VERSION,
  generatedAt: new Date().toISOString(),
  mechanics,
  entities,
  overrideSources,
  riders: jockeys,
  ...(warnings.length > 0 ? { warnings } : {}),
};
writeFileSync(outJson, `${JSON.stringify(payload, null, 2)}\n`);

const withSeats = Object.values(entities).filter((e) => e.passengerAttachmentsSource === "builder").length;
const withOverrides = Object.values(entities).filter((e) => e.overrides).length;
console.log(
  `[mob-riders] ${Object.keys(entities).length} entities (${withSeats} declared seats, ${withOverrides} with riding overrides), ` +
    `${Object.keys(overrideSources).length} override classes, ${jockeys.length} jockey pairs -> ${path.relative(repoRoot, outJson)}`,
);
for (const entry of jockeys) {
  console.log(
    `  ${entry.id.padEnd(32)} chance=${entry.chance ?? "?"} ${entry.riderImage ? "img+" : "img-"} (${entry.sourceFile})`,
  );
}
if (warnings.length > 0) console.log(`[mob-riders] ${warnings.length} warning(s)`);
