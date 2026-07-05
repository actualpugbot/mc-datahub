import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { fileExists } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  EntityRenderDefinition,
  ItemDefinition,
  LootTableDefinition,
  MobAttributeValue,
  MobDimensionsDefinition,
  MobExperienceDefinition,
  MobHostility,
  MobImageDefinition,
  MobModelDefinition,
  MobProfileDefinition,
  MobSoundDefinition,
  TagDefinition,
  TranslationEntry,
} from "../domain/types.js";

/**
 * The already-extracted per-mob collections this extractor joins against. Every one is keyed by
 * the same `minecraft:<id>` entity id as the render `entities` spine, so the join is a lookup, not
 * a re-derivation.
 */
export interface MobProfileExtractionInputs {
  /** Rendered-mob spine (`renderData.entities`); one profile is produced per entry. */
  entities: EntityRenderDefinition[];
  lootTables: LootTableDefinition[];
  mobSounds: MobSoundDefinition[];
  mobImages: MobImageDefinition[];
  mobModels: MobModelDefinition[];
  translations: TranslationEntry[];
  tags: TagDefinition[];
  items: ItemDefinition[];
}

/** Root-relative path (from the decompiled client tree) of the entity source packages. */
const ENTITY_SOURCE_ROOT = "net/minecraft/world/entity";
const ATTRIBUTES_PATH = "net/minecraft/world/entity/ai/attributes/Attributes.java";
const DEFAULT_ATTRIBUTES_PATH = "net/minecraft/world/entity/ai/attributes/DefaultAttributes.java";
const ENTITY_TYPES_PATH = "net/minecraft/world/entity/EntityTypes.java";
const ENTITY_TYPE_IDS_PATH = "net/minecraft/world/entity/EntityTypeIds.java";

/** Attribute registry field name → registry key (`MAX_HEALTH` → `max_health`). Java constants map 1:1. */
function constantToRegistryKey(constant: string): string {
  return constant.toLowerCase();
}

/** Well-known scalar attributes surfaced as convenience mirrors on the profile. */
const SCALAR_ATTRIBUTES: Record<string, keyof MobProfileDefinition> = {
  MAX_HEALTH: "maxHealth",
  MOVEMENT_SPEED: "movementSpeed",
  ATTACK_DAMAGE: "attackDamage",
  ARMOR: "armor",
  KNOCKBACK_RESISTANCE: "knockbackResistance",
  FOLLOW_RANGE: "followRange",
};

/** EntityType registration facts parsed from `EntityTypes.java`. */
interface EntityRegistration {
  /** Java constant, e.g. `COW`. */
  constant: string;
  /** Registry local id, e.g. `cow`. */
  localId: string;
  /** Concrete entity class named in `Builder.of(Class::new, …)`, e.g. `Cow`. */
  className?: string;
  /** `MobCategory` enum name, e.g. `CREATURE`. */
  mobCategory?: string;
  width?: number;
  height?: number;
  eyeHeight?: number;
  fireImmune: boolean;
  clientTrackingRange?: number;
  /** False when `.notInPeaceful()` is present. */
  spawnsInPeaceful: boolean;
}

/** Which class + static method builds a given entity's attributes (`Cow.createAttributes()`). */
interface AttributeBuilderRef {
  className: string;
  method: string;
}

interface ResolvedClassDeclaration {
  superClass?: string;
  interfaces: string[];
}

export class MobProfileExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(clientRoot: string, inputs: MobProfileExtractionInputs): Promise<MobProfileDefinition[]> {
    if (!(await fileExists(join(clientRoot, ENTITY_TYPES_PATH)))) {
      this.logger.warn(`Mob profile extraction skipped; no decompiled entity source at ${clientRoot}.`);
      // Still emit aggregation-only profiles so consumers get identity + render/sound/loot data.
      return inputs.entities.map((entity) => this.aggregateOnlyProfile(entity, inputs));
    }

    const context = await this.loadSourceContext(clientRoot);

    return inputs.entities.map((entity) => this.buildProfile(entity, inputs, context)).sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---------------------------------------------------------------------------
  // Source context
  // ---------------------------------------------------------------------------

  private async loadSourceContext(clientRoot: string): Promise<SourceContext> {
    const { classIndex, sources } = await buildClassIndex(join(clientRoot, ENTITY_SOURCE_ROOT), clientRoot);
    const readClassSync = (path: string | undefined): string | null => (path ? (sources.get(path) ?? null) : null);

    const attributeDefaults = parseAttributeDefaults(readClassSync(ATTRIBUTES_PATH) ?? "");
    const localIdByConstant = parseEntityTypeIds(readClassSync(ENTITY_TYPE_IDS_PATH) ?? "");
    const registrations = parseEntityRegistrations(readClassSync(ENTITY_TYPES_PATH) ?? "", localIdByConstant);
    const attributeBuilders = parseAttributeBuilderRefs(readClassSync(DEFAULT_ATTRIBUTES_PATH) ?? "");

    return {
      classIndex,
      readClassSync,
      attributeDefaults,
      registrations,
      attributeBuilders,
      attributeMemo: new Map(),
      declarationMemo: new Map(),
    };
  }

  // ---------------------------------------------------------------------------
  // Per-mob assembly
  // ---------------------------------------------------------------------------

  private buildProfile(
    entity: EntityRenderDefinition,
    inputs: MobProfileExtractionInputs,
    context: SourceContext,
  ): MobProfileDefinition {
    const localId = stripNamespace(entity.id);
    const warnings: string[] = [];
    const registration = findRegistration(context, localId);
    if (!registration) {
      warnings.push(`No EntityType registration found for ${localId}; stats are unavailable.`);
    }

    const profile: MobProfileDefinition = {
      id: entity.id,
      localId,
      displayName: resolveDisplayName(entity, localId, inputs.translations),
      hostility: "unknown",
      fireImmune: registration?.fireImmune ?? false,
      attributes: [],
      modelLayerIds: entity.modelLayerIds ?? [],
      tags: resolveEntityTags(entity.id, inputs.tags),
      warnings,
    };

    if (registration) {
      profile.mobCategory = registration.mobCategory;
      profile.spawnsInPeaceful = registration.spawnsInPeaceful;
      profile.clientTrackingRange = registration.clientTrackingRange;
      const dimensions = resolveDimensions(registration);
      if (dimensions) {
        profile.dimensions = dimensions;
      }
    }

    // Attributes + hostility + experience need the concrete entity class.
    const attributeRef = context.attributeBuilders.get(registration?.constant ?? localId.toUpperCase());
    const className = attributeRef?.className ?? registration?.className;
    if (className) {
      const classPath = context.classIndex.get(className);
      profile.sourceClass = classPath;
    }

    if (attributeRef) {
      const resolved = this.resolveAttributes(attributeRef, context, warnings);
      profile.attributes = resolved;
      for (const attr of resolved) {
        const key = SCALAR_ATTRIBUTES[attr.constant];
        if (key) {
          (profile as unknown as Record<string, number>)[key] = attr.value;
        }
      }
    } else if (registration) {
      warnings.push(`No attribute builder mapping found for ${localId}; attributes are unavailable.`);
    }

    if (className) {
      const ancestry = this.resolveAncestry(className, context);
      profile.hostility = classifyHostility(entity.id, ancestry);
      profile.experience = this.resolveExperience(className, ancestry, context);
    }

    const drops = resolveDrops(localId, inputs.lootTables);
    if (drops) {
      profile.drops = drops;
    }
    const sounds = resolveSounds(entity.id, inputs.mobSounds);
    if (sounds) {
      profile.sounds = sounds;
    }
    const images = resolveImages(entity.id, inputs.mobImages);
    if (images) {
      profile.images = images;
    }
    const spawnEgg = resolveSpawnEgg(localId, inputs.items);
    if (spawnEgg) {
      profile.spawnEgg = spawnEgg;
    }

    return profile;
  }

  /** Fallback used when no decompiled source exists: identity + aggregation only. */
  private aggregateOnlyProfile(entity: EntityRenderDefinition, inputs: MobProfileExtractionInputs): MobProfileDefinition {
    const localId = stripNamespace(entity.id);
    const profile: MobProfileDefinition = {
      id: entity.id,
      localId,
      displayName: resolveDisplayName(entity, localId, inputs.translations),
      hostility: "unknown",
      fireImmune: false,
      attributes: [],
      modelLayerIds: entity.modelLayerIds ?? [],
      tags: resolveEntityTags(entity.id, inputs.tags),
      warnings: ["No decompiled client source available; only render/sound/loot data was aggregated."],
    };
    const drops = resolveDrops(localId, inputs.lootTables);
    if (drops) profile.drops = drops;
    const sounds = resolveSounds(entity.id, inputs.mobSounds);
    if (sounds) profile.sounds = sounds;
    const images = resolveImages(entity.id, inputs.mobImages);
    if (images) profile.images = images;
    const spawnEgg = resolveSpawnEgg(localId, inputs.items);
    if (spawnEgg) profile.spawnEgg = spawnEgg;
    return profile;
  }

  // ---------------------------------------------------------------------------
  // Attribute chain resolution
  // ---------------------------------------------------------------------------

  private resolveAttributes(ref: AttributeBuilderRef, context: SourceContext, warnings: string[]): MobAttributeValue[] {
    const resolved = this.resolveBuilderChain(ref.className, ref.method, context, new Set(), warnings);
    if (!resolved) {
      warnings.push(`Could not resolve attribute chain for ${ref.className}.${ref.method}().`);
      return [];
    }
    return [...resolved.values()];
  }

  /**
   * Resolve a `createAttributes`-style builder into a map of constant → value, following the base
   * call (`Monster.createMonsterAttributes()` …) up to the `AttributeSupplier.builder()` root. The
   * top-level call marks its own numeric `.add`s as `mob`; ancestors mark theirs `inherited`; bare
   * `.add(Attributes.X)` calls resolve to the `Attributes.java` registry default.
   */
  private resolveBuilderChain(
    className: string,
    method: string,
    context: SourceContext,
    seen: Set<string>,
    warnings: string[],
    isTop = true,
  ): Map<string, MobAttributeValue> | null {
    const key = `${className}#${method}`;
    if (seen.has(key)) {
      return new Map();
    }
    seen.add(key);
    const memoKey = `${key}#${isTop ? "top" : "base"}`;
    const cached = context.attributeMemo.get(memoKey);
    if (cached) {
      return new Map(cached);
    }

    // Java resolves `Cow.createAttributes()` to an inherited static defined on a parent
    // (`AbstractCow`), so when the method isn't declared on this class, walk up the superclass chain.
    const located = this.locateMethodBody(className, method, context);
    if (!located) {
      warnings.push(`Attribute builder method ${className}.${method}() not found in the class hierarchy.`);
      return null;
    }
    const body = located.body;

    const parsed = parseBuilderReturn(body);
    const result = new Map<string, MobAttributeValue>();

    if (parsed.base) {
      // An unqualified base call (`createBaseHorseAttributes()`) is an inherited static, resolved
      // against the class the current method actually lives on.
      const baseOwner = parsed.base.owner ?? located.className;
      const baseResolved = this.resolveBuilderChain(baseOwner, parsed.base.method, context, seen, warnings, false);
      if (baseResolved) {
        for (const [constant, value] of baseResolved) {
          result.set(constant, value);
        }
      }
    }

    for (const add of parsed.adds) {
      const hasExplicitValue = add.value !== undefined && Number.isFinite(add.value);
      const value = hasExplicitValue ? (add.value as number) : context.attributeDefaults.get(add.constant);
      if (value === undefined) {
        warnings.push(`No default value for attribute ${add.constant} on ${located.className}.${method}().`);
        continue;
      }
      if (add.computed) {
        warnings.push(
          `${constantToRegistryKey(add.constant)} is computed at runtime on ${located.className}; showing the registry default (${value}).`,
        );
      }
      result.set(add.constant, {
        attribute: constantToRegistryKey(add.constant),
        constant: add.constant,
        value,
        origin: add.computed ? "default" : hasExplicitValue ? (isTop ? "mob" : "inherited") : "default",
      });
    }

    context.attributeMemo.set(memoKey, new Map(result));
    return result;
  }

  /** Find a static builder method body, walking up the superclass chain (inherited Java statics). */
  private locateMethodBody(
    className: string,
    method: string,
    context: SourceContext,
  ): { className: string; body: string } | null {
    let current: string | undefined = className;
    const guard = new Set<string>();
    while (current && !guard.has(current)) {
      guard.add(current);
      const source = context.readClassSync(context.classIndex.get(current));
      if (source) {
        const body = extractMethodBody(source, method);
        if (body !== null) {
          return { className: current, body };
        }
      }
      current = this.resolveDeclaration(current, context)?.superClass;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Hostility + experience
  // ---------------------------------------------------------------------------

  /** Collect the full superclass chain (self first) plus every interface encountered along it. */
  private resolveAncestry(className: string, context: SourceContext): Ancestry {
    const classes: string[] = [];
    const interfaces = new Set<string>();
    let current: string | undefined = className;
    const guard = new Set<string>();
    while (current && !guard.has(current)) {
      guard.add(current);
      classes.push(current);
      const decl = this.resolveDeclaration(current, context);
      if (!decl) break;
      for (const iface of decl.interfaces) {
        interfaces.add(iface);
      }
      current = decl.superClass;
    }
    return { classes, interfaces };
  }

  private resolveDeclaration(className: string, context: SourceContext): ResolvedClassDeclaration | null {
    const cached = context.declarationMemo.get(className);
    if (cached !== undefined) {
      return cached;
    }
    const path = context.classIndex.get(className);
    const source = path ? context.readClassSync(path) : null;
    const decl = source ? parseClassDeclaration(source, className) : null;
    context.declarationMemo.set(className, decl);
    return decl;
  }

  private resolveExperience(className: string, ancestry: Ancestry, context: SourceContext): MobExperienceDefinition {
    const path = context.classIndex.get(className);
    const source = path ? context.readClassSync(path) : null;
    if (source) {
      const assignments = [...source.matchAll(/this\.xpReward\s*=\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
      const dynamic = assignments.find((expr) => /[*+/-]|nextInt|size|isBaby/i.test(expr));
      const constant = assignments.find((expr) => /^\d+$/.test(expr));
      if (dynamic) {
        return {
          variable: true,
          value: constant ? Number(constant) : undefined,
          note: "Reward is computed at runtime (size/equipment/baby-scaled); base value shown when a constant seed exists.",
        };
      }
      if (constant) {
        return { value: Number(constant), variable: false };
      }
      // An override with no field assignment (e.g. getBaseExperienceReward) still means variable.
      if (/getBaseExperienceReward/.test(source) && !assignments.length) {
        return { variable: true, note: "Reward is overridden in source without a constant field." };
      }
    }
    // Fall back to the base-class defaults established by constructors.
    if (ancestry.classes.includes("Monster")) {
      return { value: 5, variable: false, note: "Inherited Monster default (xpReward = 5)." };
    }
    if (ancestry.classes.includes("Animal") || ancestry.classes.includes("AgeableMob")) {
      return { variable: true, note: "Passive breeding animals drop 1–3 experience." };
    }
    return { variable: true, note: "Experience reward could not be determined from source." };
  }
}

// =============================================================================
// Source context helpers
// =============================================================================

interface SourceContext {
  classIndex: Map<string, string>;
  /** Synchronous read from the pre-populated entity-source cache; keyed by client-root-relative path. */
  readClassSync: (path: string | undefined) => string | null;
  attributeDefaults: Map<string, number>;
  registrations: Map<string, EntityRegistration>;
  attributeBuilders: Map<string, AttributeBuilderRef>;
  attributeMemo: Map<string, Map<string, MobAttributeValue>>;
  declarationMemo: Map<string, ResolvedClassDeclaration | null>;
}

interface Ancestry {
  classes: string[];
  interfaces: Set<string>;
}

/**
 * Build a `SimpleClassName` → client-root-relative path index over the entity source tree, and
 * read every file into a source cache, so base classes referenced deep in attribute chains
 * (`Monster`, `Animal`, `Mob`, `LivingEntity`, …) resolve synchronously without re-reading disk.
 */
async function buildClassIndex(
  entityRoot: string,
  clientRoot: string,
): Promise<{ classIndex: Map<string, string>; sources: Map<string, string> }> {
  const classIndex = new Map<string, string>();
  const sources = new Map<string, string>();
  const files = await listJavaFiles(entityRoot).catch(() => [] as string[]);
  await Promise.all(
    files.map(async (file) => {
      const rel = relative(clientRoot, file).replace(/\\/g, "/");
      const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.java$/, "");
      // Prefer the first (shallowest) match on collision; the entity tree rarely collides by name.
      if (!classIndex.has(base)) {
        classIndex.set(base, rel);
      }
      try {
        sources.set(rel, await fs.readFile(file, "utf8"));
      } catch {
        // Unreadable file: leave it out of the cache; readClassSync returns null for it.
      }
    }),
  );
  return { classIndex, sources };
}

async function listJavaFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".java")) {
      files.push(path);
    }
  }
  return files;
}

// =============================================================================
// Parsers
// =============================================================================

/** `MAX_HEALTH = register("max_health", new RangedAttribute("…", 20.0, 1.0, 1024.0)…)` → `MAX_HEALTH → 20`. */
export function parseAttributeDefaults(source: string): Map<string, number> {
  const defaults = new Map<string, number>();
  const pattern =
    /public static final Holder<Attribute>\s+([A-Z_0-9]+)\s*=\s*register\(\s*"[^"]+"\s*,\s*new RangedAttribute\(\s*"[^"]+"\s*,\s*([-\d.eEfFdD]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const constant = match[1];
    const raw = match[2];
    if (!constant || raw === undefined) continue;
    const value = parseJavaNumber(raw);
    if (value !== undefined) {
      defaults.set(constant, value);
    }
  }
  return defaults;
}

/** `public static final ResourceKey<…> COW = create("cow");` → `COW → cow`. */
export function parseEntityTypeIds(source: string): Map<string, string> {
  const ids = new Map<string, string>();
  const pattern = /public static final ResourceKey<EntityType<\?>>\s+([A-Z_0-9]+)\s*=\s*create\(\s*"([^"]+)"\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const constant = match[1];
    const localId = match[2];
    if (constant && localId) {
      ids.set(constant, localId);
    }
  }
  return ids;
}

/**
 * Parse each `register(EntityTypeIds.CONST, EntityType.Builder.of(Class::new, MobCategory.CAT)…)`
 * block in `EntityTypes.java` into an {@link EntityRegistration}.
 */
export function parseEntityRegistrations(
  source: string,
  localIdByConstant: Map<string, string>,
): Map<string, EntityRegistration> {
  const registrations = new Map<string, EntityRegistration>();
  const marker = "register(";
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    const args = extractBalanced(source, start + marker.length - 1, "(", ")");
    if (!args) {
      searchFrom = start + marker.length;
      continue;
    }
    searchFrom = start + marker.length + args.length;

    const constantMatch = args.match(/EntityTypeIds\.([A-Z_0-9]+)/);
    const builderMatch = args.match(
      /EntityType\.Builder\.\s*(?:<[^>]*>\s*)?of\(\s*([A-Za-z_]\w*)::new\s*,\s*MobCategory\.([A-Z_]+)/,
    );
    const constant = constantMatch?.[1];
    if (!constant || !builderMatch) {
      continue;
    }
    const localId = localIdByConstant.get(constant) ?? constant.toLowerCase();
    const sized = args.match(/\.sized\(\s*([-\d.eEfF]+)\s*,\s*([-\d.eEfF]+)\s*\)/);
    const eye = args.match(/\.eyeHeight\(\s*([-\d.eEfF]+)\s*\)/);
    const tracking = args.match(/\.clientTrackingRange\(\s*(\d+)\s*\)/);
    registrations.set(localId, {
      constant,
      localId,
      className: builderMatch[1],
      mobCategory: builderMatch[2],
      width: sized?.[1] ? parseJavaNumber(sized[1]) : undefined,
      height: sized?.[2] ? parseJavaNumber(sized[2]) : undefined,
      eyeHeight: eye?.[1] ? parseJavaNumber(eye[1]) : undefined,
      fireImmune: /\.fireImmune\(\)/.test(args),
      clientTrackingRange: tracking?.[1] ? Number(tracking[1]) : undefined,
      spawnsInPeaceful: !/\.notInPeaceful\(\)/.test(args),
    });
  }
  return registrations;
}

/** `.put(EntityTypes.COW, Cow.createAttributes().build())` → `COW → { className: "Cow", method: "createAttributes" }`. */
export function parseAttributeBuilderRefs(source: string): Map<string, AttributeBuilderRef> {
  const refs = new Map<string, AttributeBuilderRef>();
  const pattern = /\.put\(\s*EntityTypes\.([A-Z_0-9]+)\s*,\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\(\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const [, constant, className, method] = match;
    if (constant && className && method) {
      refs.set(constant, { className, method });
    }
  }
  return refs;
}

interface BuilderReturn {
  /** The base builder call. `owner` is absent for bare inherited static calls (`createBaseHorseAttributes()`). */
  base?: { owner?: string; method: string };
  adds: Array<{ constant: string; value?: number; computed: boolean }>;
}

/**
 * Parse a `createAttributes`-style method body's `return …;` chain into its base builder call and
 * its `.add(Attributes.X[, value])` list. The base is the leading `()` call in the chain: it may be
 * qualified (`Animal.createAnimalAttributes()`), a bare inherited static (`createBaseHorseAttributes()`),
 * or the `AttributeSupplier.builder()` / `new AttributeSupplier.Builder()` root (→ no base). `.add`
 * values that are non-literal expressions (`generateRandomMaxHealth(...)`) are marked `computed`.
 */
export function parseBuilderReturn(body: string): BuilderReturn {
  const returnStart = body.indexOf("return");
  const scope = returnStart === -1 ? body : body.slice(returnStart + "return".length);
  const end = scope.indexOf(";");
  const expression = end === -1 ? scope : scope.slice(0, end);

  let base: BuilderReturn["base"];
  if (!/(?:new\s+AttributeSupplier\.Builder|AttributeSupplier\.builder)\s*\(/.test(expression)) {
    const leading = expression.match(/^\s*([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*)\s*\(\s*\)/);
    const callee = leading?.[1]?.replace(/\s+/g, "");
    if (callee) {
      const dot = callee.lastIndexOf(".");
      base = dot === -1 ? { method: callee } : { owner: callee.slice(0, dot).split(".").pop(), method: callee.slice(dot + 1) };
    }
  }

  const adds: BuilderReturn["adds"] = [];
  let idx = 0;
  while (true) {
    const at = expression.indexOf(".add(", idx);
    if (at === -1) break;
    const inner = extractBalanced(expression, at + ".add".length, "(", ")");
    idx = at + ".add(".length;
    if (!inner) continue;
    const parsed = inner.match(/^\s*Attributes\.([A-Z_0-9]+)\s*(?:,\s*([\s\S]+?)\s*)?$/);
    const constant = parsed?.[1];
    if (!constant) continue;
    const rawValue = parsed[2];
    let value: number | undefined;
    let computed = false;
    if (rawValue !== undefined) {
      value = parseJavaNumber(rawValue);
      computed = value === undefined; // a non-literal argument (method call / field reference)
    }
    adds.push({ constant, value, computed });
  }
  return { base, adds };
}

/** Parse `class X extends Y implements A, B` for the named class. */
export function parseClassDeclaration(source: string, className: string): ResolvedClassDeclaration | null {
  const pattern = new RegExp(
    `\\bclass\\s+${escapeRegExp(className)}\\b[^{]*?(?:extends\\s+([A-Za-z_][\\w.]*)(?:<[^{]*?>)?)?\\s*(?:implements\\s+([^{]+))?\\{`,
    "s",
  );
  const match = source.match(pattern);
  if (!match) {
    return { interfaces: [] };
  }
  const superClass = match[1] ? simpleName(match[1]) : undefined;
  const interfaces = match[2]
    ? match[2]
        .split(",")
        .map((entry) => simpleName(entry.replace(/<[^>]*>/g, "").trim()))
        .filter(Boolean)
    : [];
  return { superClass, interfaces };
}

// =============================================================================
// Join helpers
// =============================================================================

function classifyHostility(entityId: string, ancestry: Ancestry): MobHostility {
  const localId = stripNamespace(entityId);
  if (localId === "ender_dragon" || localId === "wither") {
    return "boss";
  }
  if (ancestry.interfaces.has("NeutralMob")) {
    return "neutral";
  }
  if (ancestry.interfaces.has("Enemy") || ancestry.classes.includes("Monster")) {
    return "hostile";
  }
  if (
    ancestry.classes.includes("Animal") ||
    ancestry.classes.includes("AgeableMob") ||
    ancestry.classes.includes("AmbientCreature") ||
    ancestry.classes.includes("WaterAnimal") ||
    ancestry.classes.includes("PathfinderMob") ||
    ancestry.classes.includes("Mob")
  ) {
    return "passive";
  }
  return "unknown";
}

function resolveDimensions(registration: EntityRegistration): MobDimensionsDefinition | undefined {
  if (registration.width === undefined || registration.height === undefined) {
    return undefined;
  }
  const dimensions: MobDimensionsDefinition = {
    width: registration.width,
    height: registration.height,
  };
  if (registration.eyeHeight !== undefined) {
    dimensions.eyeHeight = registration.eyeHeight;
  }
  return dimensions;
}

function resolveDisplayName(entity: EntityRenderDefinition, localId: string, translations: TranslationEntry[]): string {
  const key = `entity.minecraft.${localId}`;
  const entry = translations.find((t) => t.key === key);
  return entry?.value ?? entity.displayName ?? localId;
}

function resolveEntityTags(entityId: string, tags: TagDefinition[]): string[] {
  return tags
    .filter((tag) => tag.registry === "entity_type" && Array.isArray(tag.values) && tag.values.includes(entityId))
    .map((tag) => tag.id)
    .sort();
}

function resolveDrops(localId: string, lootTables: LootTableDefinition[]) {
  const lootTableId = `minecraft:entities/${localId}`;
  const table = lootTables.find((t) => t.id === lootTableId);
  if (!table) {
    return undefined;
  }
  return {
    lootTableId,
    itemDrops: table.itemDrops ?? [],
    functions: table.functions ?? [],
  };
}

function resolveSounds(entityId: string, mobSounds: MobSoundDefinition[]) {
  const mob = mobSounds.find((m) => m.id === entityId);
  if (!mob) {
    return undefined;
  }
  return {
    eventCount: mob.soundEventCount ?? mob.soundEvents.length,
    events: mob.soundEvents.map((event) => event.id),
  };
}

function resolveImages(entityId: string, mobImages: MobImageDefinition[]) {
  const mob = mobImages.find((m) => m.id === entityId);
  if (!mob) {
    return undefined;
  }
  const variantImagePaths = Array.from(new Set(mob.variants.map((variant) => variant.imagePath).filter(Boolean)));
  return {
    imagePath: mob.imagePath,
    variantImagePaths,
  };
}

function resolveSpawnEgg(localId: string, items: ItemDefinition[]): string | undefined {
  const eggId = `minecraft:${localId}_spawn_egg`;
  return items.some((item) => item.id === eggId) ? eggId : undefined;
}

// =============================================================================
// Low-level utilities
// =============================================================================

function stripNamespace(id: string): string {
  const index = id.indexOf(":");
  return index === -1 ? id : id.slice(index + 1);
}

function simpleName(qualified: string): string {
  const trimmed = qualified.trim();
  const withoutGenerics = trimmed.replace(/<[^>]*>/g, "");
  const parts = withoutGenerics.split(".");
  return parts[parts.length - 1] ?? withoutGenerics;
}

function findRegistration(context: SourceContext, localId: string): EntityRegistration | undefined {
  return context.registrations.get(localId);
}

/** Parse a Java numeric literal (`0.23F`, `40.0`, `35.0`, `1.0D`, `128L`) into a JS number. */
export function parseJavaNumber(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/[fFdDlL]$/, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(cleaned)) {
    return undefined;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Return the substring inside a balanced bracket pair. `openIndex` points at (or before) the first
 * `open`; scanning begins there. Returns the inner text (without the outer brackets), or null.
 */
export function extractBalanced(source: string, openIndex: number, open: string, close: string): string | null {
  const start = source.indexOf(open, openIndex);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return source.slice(start + 1, i);
      }
    }
  }
  return null;
}

/** Extract the `{ … }` body of a `static AttributeSupplier.Builder <method>()` declaration. */
export function extractMethodBody(source: string, method: string): string | null {
  const signature = new RegExp(`AttributeSupplier\\.Builder\\s+${escapeRegExp(method)}\\s*\\([^)]*\\)\\s*\\{`);
  const match = signature.exec(source);
  if (!match) {
    return null;
  }
  const braceStart = source.indexOf("{", match.index);
  const body = extractBalanced(source, braceStart, "{", "}");
  return body;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
