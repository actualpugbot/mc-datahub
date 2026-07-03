import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileExists, readJsonFile } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  SulfurCubeArchetypeDefinition,
  SulfurCubeAttributeModifier,
  SulfurCubeBaseAttribute,
  SulfurCubeBehavior,
  SulfurCubeBlock,
  SulfurCubeContactDamage,
  SulfurCubeDataset,
  SulfurCubeEntityMeta,
  SulfurCubeExplosion,
  SulfurCubeHotDamageType,
  SulfurCubeKnockback,
  SulfurCubeSound,
} from "../domain/types.js";

const ARCHETYPE_DIR = "data/minecraft/sulfur_cube_archetype";
const ITEM_TAG_DIR = "data/minecraft/tags/item";
const FOOD_TAG = "data/minecraft/tags/item/sulfur_cube_food.json";
const IMMUNE_TAG = "data/minecraft/tags/damage_type/sulfur_cube_with_block_immune_to.json";
const HOT_DAMAGE_TYPE = "data/minecraft/damage_type/sulfur_cube_hot.json";
const ENTITY_SOURCE = "net/minecraft/world/entity/monster/cubemob/SulfurCube.java";
const ARCHETYPES_SOURCE = "net/minecraft/world/entity/SulfurCubeArchetypes.java";
const ATTRIBUTES_SOURCE = "net/minecraft/world/entity/ai/attributes/Attributes.java";
const MOB_SOURCE = "net/minecraft/world/entity/Mob.java";
const LIVING_ENTITY_SOURCE = "net/minecraft/world/entity/LivingEntity.java";
const LANG_PATH = "assets/minecraft/lang/en_us.json";
const ENTITY_TEXTURE_DIR = "assets/minecraft/textures/entity/sulfur_cube";
const SPAWN_BIOME = "data/minecraft/worldgen/biome/sulfur_caves.json";

// The static builder chain that assembles the cube's base AttributeSupplier, innermost first.
// createSulfurCubeAttributes() = Mob.createMobAttributes().add(TEMPT_RANGE, 8.0)
// Mob.createMobAttributes()    = LivingEntity.createLivingAttributes().add(FOLLOW_RANGE, 16.0)
const ATTRIBUTE_BUILDERS: Array<{ source: string; method: string }> = [
  { source: LIVING_ENTITY_SOURCE, method: "createLivingAttributes" },
  { source: MOB_SOURCE, method: "createMobAttributes" },
  { source: ENTITY_SOURCE, method: "createSulfurCubeAttributes" },
];

interface RawArchetype {
  items?: unknown;
  attribute_modifiers?: Array<{ attribute?: string; amount?: number; operation?: string; id?: string }>;
  buoyant?: boolean;
  explosion?: { power?: number; causes_fire?: boolean; fuse?: number };
  contact_damage?: { damage_type?: string; amount?: number; attribute_to_source?: boolean };
  knockback_modifiers?: { horizontal_power?: number; vertical_power?: number };
  sound_settings?: {
    hit_sound?: string;
    push_sound?: string;
    push_sound_cooldown?: number;
    push_sound_impulse_threshold?: number;
  };
}

/**
 * Derives the Sulfur Cube's block-dependent behavior. A cube swallows a block-item and adopts the
 * "archetype" whose item tag contains that block: different attribute modifiers, knockback, sounds,
 * buoyancy, and optional explosion/contact damage. The archetypes are data-driven
 * (`data/minecraft/sulfur_cube_archetype/*.json`) and their block lists come from item tags, so this
 * resolves the tags to concrete block ids and reads a few entity constants from source. Gaps become
 * warnings instead of guesses.
 */
export class SulfurCubeExtractor {
  private displayNames = new Map<string, string>();
  private tagCache = new Map<string, string[]>();

  constructor(private readonly logger: Logger) {}

  async extract(decompiledClientRoot: string): Promise<SulfurCubeDataset | undefined> {
    const archetypeDir = join(decompiledClientRoot, ARCHETYPE_DIR);
    if (!(await fileExists(archetypeDir))) {
      this.logger.warn(`Skipping sulfur cube; ${ARCHETYPE_DIR} was not found under ${decompiledClientRoot}.`);
      return undefined;
    }

    this.displayNames = await this.loadLang(decompiledClientRoot);
    this.tagCache = new Map();

    const warnings: string[] = [];
    const sourcePaths: string[] = [ARCHETYPE_DIR];

    const order = await this.readArchetypeOrder(decompiledClientRoot, sourcePaths);
    const files = (await readdir(archetypeDir)).filter((name) => name.endsWith(".json"));
    const archetypes: SulfurCubeArchetypeDefinition[] = [];

    for (const file of files) {
      const key = file.replace(/\.json$/, "");
      const archetype = await this.readArchetype(decompiledClientRoot, key, warnings);
      if (archetype) {
        archetypes.push(archetype);
      }
    }

    archetypes.sort((left, right) => {
      const li = order.indexOf(left.key);
      const ri = order.indexOf(right.key);
      if (li !== ri) {
        return (li < 0 ? Number.MAX_SAFE_INTEGER : li) - (ri < 0 ? Number.MAX_SAFE_INTEGER : ri);
      }
      return left.key.localeCompare(right.key);
    });

    const blockIndex: Record<string, string> = {};
    for (const archetype of archetypes) {
      for (const block of archetype.blocks) {
        if (blockIndex[block.id] && blockIndex[block.id] !== archetype.key) {
          warnings.push(`Block ${block.id} maps to both ${blockIndex[block.id]} and ${archetype.key}.`);
        }
        blockIndex[block.id] = archetype.key;
      }
    }

    const entity = await this.readEntityMeta(decompiledClientRoot, sourcePaths, warnings);
    const baseAttributes = await this.readBaseAttributeSupplier(decompiledClientRoot, sourcePaths, warnings);
    const immunitiesWhenHoldingBlock = await this.readSimpleTagValues(decompiledClientRoot, IMMUNE_TAG, warnings);
    if (immunitiesWhenHoldingBlock.length > 0) {
      sourcePaths.push(IMMUNE_TAG);
    }
    const hotDamageType = await this.readHotDamageType(decompiledClientRoot, sourcePaths);

    for (const warning of warnings) {
      this.logger.warn(`Sulfur cube: ${warning}`);
    }

    return {
      entity,
      behaviorModel: this.behaviorModel(),
      baseAttributes,
      immunitiesWhenHoldingBlock,
      hotDamageType,
      archetypes,
      blockIndex,
      sourcePaths,
      warnings,
    };
  }

  private async readArchetype(root: string, key: string, warnings: string[]): Promise<SulfurCubeArchetypeDefinition | undefined> {
    const relativePath = `${ARCHETYPE_DIR}/${key}.json`;
    let raw: RawArchetype;
    try {
      raw = await readJsonFile<RawArchetype>(join(root, relativePath));
    } catch (error) {
      warnings.push(`Could not read archetype ${key}: ${(error as Error).message}.`);
      return undefined;
    }

    const modifiers = this.readModifiers(raw, key, warnings);
    const itemsTag = typeof raw.items === "string" ? raw.items : `#minecraft:sulfur_cube_archetype/${key}`;
    const { blocks, blockTags } = await this.resolveArchetypeBlocks(root, raw.items, key, warnings);

    return {
      id: `minecraft:${key}`,
      key,
      displayName: titleCase(key),
      behavior: this.behavior(modifiers),
      attributeModifiers: modifiers,
      buoyant: raw.buoyant === true,
      explosive: raw.explosion != null,
      dealsContactDamage: raw.contact_damage != null,
      explosion: this.explosion(raw.explosion),
      contactDamage: this.contactDamage(raw.contact_damage),
      knockback: this.knockback(raw.knockback_modifiers),
      sound: this.sound(raw.sound_settings),
      itemsTag,
      blockTags,
      blocks,
      blockCount: blocks.length,
      sourcePath: relativePath,
    };
  }

  private readModifiers(raw: RawArchetype, key: string, warnings: string[]): SulfurCubeAttributeModifier[] {
    if (!Array.isArray(raw.attribute_modifiers)) {
      warnings.push(`Archetype ${key} has no attribute_modifiers.`);
      return [];
    }

    return raw.attribute_modifiers
      .filter((entry) => typeof entry.attribute === "string")
      .map((entry) => ({
        attribute: entry.attribute as string,
        amount: typeof entry.amount === "number" ? entry.amount : 0,
        operation: typeof entry.operation === "string" ? entry.operation : "add_value",
        id: typeof entry.id === "string" ? entry.id : "",
      }));
  }

  /**
   * Recovers the game's `archetype(speed, bounce, friction, drag)` numbers from the resolved modifiers.
   * Base bounciness/knockback are 0 and base friction/air-drag are 1, so add_value modifiers give the
   * effective value directly and add_multiplied_total modifiers give (value - 1).
   */
  private behavior(modifiers: SulfurCubeAttributeModifier[]): SulfurCubeBehavior {
    const addValue = (attribute: string) =>
      modifiers.find((m) => m.attribute === `minecraft:${attribute}` && m.operation === "add_value")?.amount ?? 0;
    const multiplied = (attribute: string) =>
      modifiers.find((m) => m.attribute === `minecraft:${attribute}` && m.operation === "add_multiplied_total")?.amount ?? 0;

    return {
      mobility: round(-addValue("knockback_resistance")),
      bounciness: round(addValue("bounciness")),
      friction: round(multiplied("friction_modifier") + 1),
      airDrag: round(multiplied("air_drag_modifier") + 1),
    };
  }

  private explosion(raw: RawArchetype["explosion"]): SulfurCubeExplosion | undefined {
    if (!raw) {
      return undefined;
    }
    return {
      power: typeof raw.power === "number" ? raw.power : 0,
      causesFire: raw.causes_fire === true,
      fuse: typeof raw.fuse === "number" ? raw.fuse : 0,
    };
  }

  private contactDamage(raw: RawArchetype["contact_damage"]): SulfurCubeContactDamage | undefined {
    if (!raw || typeof raw.damage_type !== "string") {
      return undefined;
    }
    return {
      damageType: raw.damage_type,
      amount: typeof raw.amount === "number" ? raw.amount : 0,
      attributeToSource: raw.attribute_to_source === true,
    };
  }

  private knockback(raw: RawArchetype["knockback_modifiers"]): SulfurCubeKnockback {
    return {
      horizontalPower: typeof raw?.horizontal_power === "number" ? raw.horizontal_power : 0,
      verticalPower: typeof raw?.vertical_power === "number" ? raw.vertical_power : 0,
    };
  }

  private sound(raw: RawArchetype["sound_settings"]): SulfurCubeSound {
    return {
      hit: typeof raw?.hit_sound === "string" ? raw.hit_sound : "",
      push: typeof raw?.push_sound === "string" ? raw.push_sound : "",
      pushCooldownSeconds: typeof raw?.push_sound_cooldown === "number" ? raw.push_sound_cooldown : 0,
      pushImpulseThreshold: typeof raw?.push_sound_impulse_threshold === "number" ? raw.push_sound_impulse_threshold : 0,
    };
  }

  private async resolveArchetypeBlocks(
    root: string,
    items: unknown,
    key: string,
    warnings: string[],
  ): Promise<{ blocks: SulfurCubeBlock[]; blockTags: string[] }> {
    const refs = typeof items === "string" ? [items] : Array.isArray(items) ? items : [];
    const blockTags = new Set<string>();
    const ids = new Set<string>();

    for (const ref of refs) {
      if (typeof ref !== "string") {
        continue;
      }
      if (ref.startsWith("#")) {
        // First-level nested tag refs of the archetype tag are kept for provenance.
        const nested = await this.readItemTagRaw(root, ref.slice(1));
        for (const value of nested) {
          if (typeof value === "string" && value.startsWith("#")) {
            blockTags.add(value);
          }
        }
        for (const id of await this.resolveItemTag(root, ref.slice(1), new Set(), warnings)) {
          ids.add(id);
        }
      } else {
        ids.add(normalizeId(ref));
      }
    }

    if (ids.size === 0) {
      warnings.push(`Archetype ${key} resolved to zero blocks.`);
    }

    const blocks = Array.from(ids)
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, name: this.nameFor(id) }));

    return { blocks, blockTags: Array.from(blockTags).sort((left, right) => left.localeCompare(right)) };
  }

  /** Reads the raw `values` array of an item tag file, or [] if missing. */
  private async readItemTagRaw(root: string, tagId: string): Promise<unknown[]> {
    const path = join(root, ITEM_TAG_DIR, `${stripNamespace(tagId)}.json`);
    if (!(await fileExists(path))) {
      return [];
    }
    try {
      const raw = await readJsonFile<{ values?: unknown[] }>(path);
      return Array.isArray(raw.values) ? raw.values : [];
    } catch {
      return [];
    }
  }

  /** Recursively resolves an item tag to concrete item ids, guarding against cycles. */
  private async resolveItemTag(root: string, tagId: string, seen: Set<string>, warnings: string[]): Promise<string[]> {
    const normalizedTag = stripNamespace(tagId);
    const cached = this.tagCache.get(normalizedTag);
    if (cached) {
      return cached;
    }
    if (seen.has(normalizedTag)) {
      return [];
    }
    seen.add(normalizedTag);

    const values = await this.readItemTagRaw(root, tagId);
    if (values.length === 0 && !(await fileExists(join(root, ITEM_TAG_DIR, `${normalizedTag}.json`)))) {
      warnings.push(`Item tag #minecraft:${normalizedTag} referenced by the archetypes was not found.`);
    }

    const ids = new Set<string>();
    for (const value of values) {
      const entry = typeof value === "string" ? value : isRecord(value) && typeof value.id === "string" ? value.id : "";
      if (!entry) {
        continue;
      }
      if (entry.startsWith("#")) {
        for (const nested of await this.resolveItemTag(root, entry.slice(1), seen, warnings)) {
          ids.add(nested);
        }
      } else {
        ids.add(normalizeId(entry));
      }
    }

    const resolved = Array.from(ids);
    this.tagCache.set(normalizedTag, resolved);
    return resolved;
  }

  private async readEntityMeta(root: string, sourcePaths: string[], warnings: string[]): Promise<SulfurCubeEntityMeta> {
    const meta: SulfurCubeEntityMeta = {
      id: "minecraft:sulfur_cube",
      displayName: this.displayNames.get("entity.minecraft.sulfur_cube") ?? "Sulfur Cube",
      spawnBiome: (await fileExists(join(root, SPAWN_BIOME))) ? "minecraft:sulfur_caves" : undefined,
      fullSize: 2,
      babySize: 1,
      bucketItem: "minecraft:sulfur_cube_bucket",
      spawnEggItem: "minecraft:sulfur_cube_spawn_egg",
      contentComponent: "minecraft:sulfur_cube_content",
      particle: "minecraft:sulfur_cube_goo",
      foodItems: await this.readSimpleTagValues(root, FOOD_TAG, warnings),
      swallowableTag: "minecraft:sulfur_cube_swallowable",
      shearable: true,
      bucketable: true,
      textures: await this.readEntityTextures(root),
    };

    const sourcePath = join(root, ENTITY_SOURCE);
    if (!(await fileExists(sourcePath))) {
      warnings.push(`${ENTITY_SOURCE} was not found; entity constants use fallbacks.`);
      return meta;
    }

    sourcePaths.push(ENTITY_SOURCE);
    const source = await readFile(sourcePath, "utf8");
    meta.fullSize = intConst(source, "MAX_SIZE") ?? meta.fullSize;
    meta.babySize = intConst(source, "MIN_SIZE") ?? meta.babySize;
    meta.splitCount = intConst(source, "SPLIT_COUNT");
    meta.pickupTimerTicks = intConst(source, "PICKUP_TIMER_DURATION");

    const health = source.match(/setBaseValue\((\d+)\s*\*\s*actualSize\)/);
    if (health) {
      meta.healthPerSize = Number(health[1]);
    } else {
      warnings.push("Health-per-size (4 * actualSize) was not found in SulfurCube.java.");
    }

    const tempt = source.match(/TEMPT_RANGE,\s*([\d.]+)/);
    if (tempt) {
      meta.temptRange = Number(tempt[1]);
    }

    const xp = source.match(/(\d+)\s*\+\s*this\.random\.nextInt\((\d+)\)/);
    if (xp) {
      const base = Number(xp[1]);
      meta.experienceReward = { min: base, max: base + Number(xp[2]) - 1 };
    }

    return meta;
  }

  /**
   * Resolves the cube's complete base attribute supplier by parsing the static builder chain
   * (LivingEntity.createLivingAttributes → Mob.createMobAttributes → SulfurCube.createSulfurCubeAttributes)
   * and looking up each attribute's registry default/min/max in Attributes.java. Preserves builder order;
   * later `.add(attr, value)` overrides win.
   */
  private async readBaseAttributeSupplier(
    root: string,
    sourcePaths: string[],
    warnings: string[],
  ): Promise<SulfurCubeBaseAttribute[]> {
    const attributesPath = join(root, ATTRIBUTES_SOURCE);
    if (!(await fileExists(attributesPath))) {
      warnings.push(`${ATTRIBUTES_SOURCE} was not found; base attributes omitted.`);
      return [];
    }
    sourcePaths.push(ATTRIBUTES_SOURCE);
    const registry = await this.readAttributeRegistry(attributesPath);

    // name → override value (undefined means "use the attribute default"), in first-seen builder order.
    const order: string[] = [];
    const overrides = new Map<string, number | undefined>();
    for (const { source, method } of ATTRIBUTE_BUILDERS) {
      const body = await this.readBuilderBody(root, source, method);
      if (body === undefined) {
        warnings.push(`${method}() was not found in ${source}; base attributes may be incomplete.`);
        continue;
      }
      if (!sourcePaths.includes(source)) {
        sourcePaths.push(source);
      }
      for (const match of body.matchAll(/\.add\(\s*Attributes\.(\w+)\s*(?:,\s*([-\d.]+)F?)?\s*\)/g)) {
        const name = match[1]!.toLowerCase();
        if (!overrides.has(name)) {
          order.push(name);
        }
        overrides.set(name, match[2] !== undefined ? Number(match[2]) : overrides.get(name));
      }
    }

    const attributes: SulfurCubeBaseAttribute[] = [];
    for (const name of order) {
      const range = registry.get(name);
      if (!range) {
        warnings.push(`Attribute ${name} in the supplier was not found in Attributes.java.`);
        continue;
      }
      const override = overrides.get(name);
      const base = override ?? range.default;
      attributes.push({
        attribute: `minecraft:${name}`,
        base,
        min: range.min,
        max: range.max,
        attributeDefault: range.default,
        overridden: base !== range.default,
        ...(name === "max_health" ? { note: "Overridden at spawn to 4 × size (8 for a full cube, 4 for a baby)." } : {}),
      });
    }

    return attributes;
  }

  /** Parses every `register("name", new *Attribute("attribute.name.name", default, min, max))` in Attributes.java. */
  private async readAttributeRegistry(
    attributesPath: string,
  ): Promise<Map<string, { default: number; min: number; max: number }>> {
    const source = await readFile(attributesPath, "utf8");
    const registry = new Map<string, { default: number; min: number; max: number }>();
    const pattern = /"(\w+)",\s*new \w+Attribute\("attribute\.name\.\1",\s*([-\d.]+)F?,\s*([-\d.]+)F?,\s*([-\d.]+)F?/g;
    for (const match of source.matchAll(pattern)) {
      registry.set(match[1]!, { default: Number(match[2]), min: Number(match[3]), max: Number(match[4]) });
    }
    return registry;
  }

  /** Returns the text of a builder method's return expression (up to the first `;`), or undefined. */
  private async readBuilderBody(root: string, source: string, method: string): Promise<string | undefined> {
    const path = join(root, source);
    if (!(await fileExists(path))) {
      return undefined;
    }
    const text = await readFile(path, "utf8");
    const start = text.indexOf(`${method}()`);
    if (start < 0) {
      return undefined;
    }
    const end = text.indexOf(";", start);
    return end < 0 ? text.slice(start) : text.slice(start, end);
  }

  private async readHotDamageType(root: string, sourcePaths: string[]): Promise<SulfurCubeHotDamageType | undefined> {
    const path = join(root, HOT_DAMAGE_TYPE);
    if (!(await fileExists(path))) {
      return undefined;
    }
    sourcePaths.push(HOT_DAMAGE_TYPE);
    try {
      const raw = await readJsonFile<{
        effects?: string;
        exhaustion?: number;
        scaling?: string;
        message_id?: string;
      }>(path);
      return {
        id: "minecraft:sulfur_cube_hot",
        effects: raw.effects,
        exhaustion: raw.exhaustion,
        scaling: raw.scaling,
        messageId: raw.message_id,
      };
    } catch {
      return undefined;
    }
  }

  private async readSimpleTagValues(root: string, relativePath: string, warnings: string[]): Promise<string[]> {
    const path = join(root, relativePath);
    if (!(await fileExists(path))) {
      return [];
    }
    try {
      const raw = await readJsonFile<{ values?: unknown[] }>(path);
      if (!Array.isArray(raw.values)) {
        return [];
      }
      return raw.values
        .map((value) => (typeof value === "string" ? value : isRecord(value) && typeof value.id === "string" ? value.id : ""))
        .filter((value) => value.length > 0 && !value.startsWith("#"))
        .map(normalizeId)
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      warnings.push(`Could not read tag ${relativePath}: ${(error as Error).message}.`);
      return [];
    }
  }

  private async readEntityTextures(root: string): Promise<string[]> {
    const dir = join(root, ENTITY_TEXTURE_DIR);
    if (!(await fileExists(dir))) {
      return [];
    }
    // Exported textures live under images/<path-below-assets/minecraft/textures>, servable at /assets/<imagePath>.
    const imagePrefix = `images/${ENTITY_TEXTURE_DIR.replace("assets/minecraft/textures/", "")}`;
    try {
      return (await readdir(dir))
        .filter((name) => name.endsWith(".png"))
        .map((name) => `${imagePrefix}/${name}`)
        .sort((left, right) => left.localeCompare(right));
    } catch {
      return [];
    }
  }

  private async readArchetypeOrder(root: string, sourcePaths: string[]): Promise<string[]> {
    const path = join(root, ARCHETYPES_SOURCE);
    if (!(await fileExists(path))) {
      return [];
    }
    const source = await readFile(path, "utf8");
    const order: string[] = [];
    for (const match of source.matchAll(/createKey\(Identifier\.withDefaultNamespace\("([^"]+)"\)\)/g)) {
      if (match[1]) {
        order.push(match[1]);
      }
    }
    if (order.length > 0) {
      sourcePaths.push(ARCHETYPES_SOURCE);
    }
    return order;
  }

  private nameFor(id: string): string {
    const path = stripNamespace(id);
    return this.displayNames.get(`block.minecraft.${path}`) ?? this.displayNames.get(`item.minecraft.${path}`) ?? titleCase(path);
  }

  private async loadLang(root: string): Promise<Map<string, string>> {
    const path = join(root, LANG_PATH);
    if (!(await fileExists(path))) {
      return new Map();
    }
    try {
      const raw = await readJsonFile<Record<string, string>>(path);
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  }

  private behaviorModel(): string[] {
    return [
      "A full-size cube swallows one block-item at a time: a player right-clicks it with a swallowable item, it walks over matching dropped items, or a dispenser inserts one.",
      "The swallowed block is worn in the BODY equipment slot; swallowing a new block ejects the previous one and swaps the cube's behavior to the new block's archetype.",
      "Which archetype applies is decided by which #minecraft:sulfur_cube_archetype/* item tag contains the swallowed block; that archetype's attribute modifiers, knockback, sounds, buoyancy, and any explosion/contact damage are applied while the block is held.",
      "While holding a block the cube stops wandering (its AI goals are removed and speed is set to 0) and is instead pushed around by players and mobs; knockback scales with (1 - knockback_resistance).",
      "A cube holding a block is immune to the damage types in #minecraft:sulfur_cube_with_block_immune_to, can breathe underwater, and cannot freeze, but is still knocked back by those sources.",
      "Shears eject the held block and start a 100-tick pickup cooldown; a bucket scoops the whole cube into a Bucket of Sulfur Cube that remembers its contents.",
      "Only full-size cubes swallow blocks; babies instead eat #minecraft:sulfur_cube_food (slime_ball) to grow, and a killed full cube splits into 2 babies.",
    ];
  }
}

function intConst(source: string, symbol: string): number | undefined {
  const match = source.match(new RegExp(`static\\s+final\\s+int\\s+${symbol}\\s*=\\s*(\\d+)\\s*;`));
  return match ? Number(match[1]) : undefined;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeId(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}

function stripNamespace(value: string): string {
  const withoutHash = value.startsWith("#") ? value.slice(1) : value;
  const colon = withoutHash.indexOf(":");
  return colon >= 0 ? withoutHash.slice(colon + 1) : withoutHash;
}

function titleCase(value: string): string {
  return value
    .split(/[_/]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
