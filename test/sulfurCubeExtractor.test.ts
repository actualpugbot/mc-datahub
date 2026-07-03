import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import { SulfurCubeExtractor } from "../src/extraction/sulfurCubeExtractor.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  tempDirs.clear();
});

async function createTempClientRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sulfur-cube-"));
  tempDirs.add(root);
  return root;
}

async function writeFileAt(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

const REGULAR_ARCHETYPE = JSON.stringify({
  items: "#minecraft:sulfur_cube_archetype/regular",
  attribute_modifiers: [
    {
      amount: -1.0,
      attribute: "minecraft:knockback_resistance",
      id: "minecraft:regular_add_knockback_resistance",
      operation: "add_value",
    },
    { amount: 0.5, attribute: "minecraft:bounciness", id: "minecraft:regular_add_bounciness", operation: "add_value" },
    {
      amount: -0.7,
      attribute: "minecraft:friction_modifier",
      id: "minecraft:regular_mul_friction_modifier",
      operation: "add_multiplied_total",
    },
    {
      amount: -0.9,
      attribute: "minecraft:air_drag_modifier",
      id: "minecraft:regular_mul_air_drag_modifier",
      operation: "add_multiplied_total",
    },
  ],
  buoyant: true,
  knockback_modifiers: { horizontal_power: 0.4125, vertical_power: 0.09 },
  sound_settings: {
    hit_sound: "minecraft:entity.sulfur_cube.regular.hit",
    push_sound: "minecraft:entity.sulfur_cube.regular.push",
    push_sound_cooldown: 0.5,
    push_sound_impulse_threshold: 0.2,
  },
});

const EXPLOSIVE_ARCHETYPE = JSON.stringify({
  items: "#minecraft:sulfur_cube_archetype/explosive",
  attribute_modifiers: [
    {
      amount: -1.0,
      attribute: "minecraft:knockback_resistance",
      id: "minecraft:explosive_add_knockback_resistance",
      operation: "add_value",
    },
    { amount: 0.5, attribute: "minecraft:bounciness", id: "minecraft:explosive_add_bounciness", operation: "add_value" },
    {
      amount: -0.7,
      attribute: "minecraft:friction_modifier",
      id: "minecraft:explosive_mul_friction_modifier",
      operation: "add_multiplied_total",
    },
    {
      amount: -0.7,
      attribute: "minecraft:air_drag_modifier",
      id: "minecraft:explosive_mul_air_drag_modifier",
      operation: "add_multiplied_total",
    },
  ],
  buoyant: true,
  explosion: { causes_fire: false, fuse: 120, power: 3 },
  knockback_modifiers: { horizontal_power: 0.4125, vertical_power: 0.09 },
  sound_settings: {
    hit_sound: "minecraft:entity.sulfur_cube.explosive.hit",
    push_sound: "minecraft:entity.sulfur_cube.explosive.push",
    push_sound_cooldown: 0.7,
    push_sound_impulse_threshold: 0.1,
  },
});

const ARCHETYPES_SOURCE = `package net.minecraft.world.entity;
public class SulfurCubeArchetypes {
   public static final ResourceKey<SulfurCubeArchetype> REGULAR = createKey(Identifier.withDefaultNamespace("regular"));
   public static final ResourceKey<SulfurCubeArchetype> EXPLOSIVE = createKey(Identifier.withDefaultNamespace("explosive"));
}`;

const ENTITY_SOURCE = `package net.minecraft.world.entity.monster.cubemob;
public class SulfurCube extends AbstractCubeMob {
   public static final int SPLIT_COUNT = 2;
   public static final int MAX_SIZE = 2;
   public static final int MIN_SIZE = 1;
   public static final int PICKUP_TIMER_DURATION = 100;
   protected void setcubeMobHealth(final int actualSize) {
      this.getAttribute(Attributes.MAX_HEALTH).setBaseValue(4 * actualSize);
   }
   public static AttributeSupplier.Builder createSulfurCubeAttributes() {
      return Mob.createMobAttributes().add(Attributes.TEMPT_RANGE, 8.0);
   }
   protected int getBaseExperienceReward(final ServerLevel level) {
      return this.isBaby() ? 0 : 1 + this.random.nextInt(2);
   }
}`;

const ATTRIBUTES_SOURCE = `package net.minecraft.world.entity.ai.attributes;
public class Attributes {
   public static final Holder<Attribute> AIR_DRAG_MODIFIER = register(
      "air_drag_modifier", new RangedAttribute("attribute.name.air_drag_modifier", 1.0, 0.0, 2048.0).setSyncable(true)
   );
   public static final Holder<Attribute> BOUNCINESS = register("bounciness", new RangedAttribute("attribute.name.bounciness", 0.0, 0.0, 1.0).setSyncable(true));
   public static final Holder<Attribute> EXPLOSION_KNOCKBACK_RESISTANCE = register(
      "explosion_knockback_resistance", new RangedAttribute("attribute.name.explosion_knockback_resistance", 0.0, 0.0, 1.0).setSyncable(true)
   );
   public static final Holder<Attribute> FRICTION_MODIFIER = register(
      "friction_modifier", new RangedAttribute("attribute.name.friction_modifier", 1.0, 0.0, 2048.0).setSyncable(true)
   );
   public static final Holder<Attribute> KNOCKBACK_RESISTANCE = register(
      "knockback_resistance", new RangedAttribute("attribute.name.knockback_resistance", 0.0, -2.0, 1.0)
   );
   public static final Holder<Attribute> MAX_HEALTH = register(
      "max_health", new RangedAttribute("attribute.name.max_health", 20.0, 1.0, 1024.0).setSyncable(true)
   );
   public static final Holder<Attribute> FOLLOW_RANGE = register("follow_range", new RangedAttribute("attribute.name.follow_range", 32.0, 0.0, 2048.0));
   public static final Holder<Attribute> TEMPT_RANGE = register("tempt_range", new RangedAttribute("attribute.name.tempt_range", 10.0, 0.0, 2048.0));
}`;

const LIVING_ENTITY_SOURCE = `package net.minecraft.world.entity;
public abstract class LivingEntity extends Entity {
   public static AttributeSupplier.Builder createLivingAttributes() {
      return AttributeSupplier.builder()
         .add(Attributes.MAX_HEALTH)
         .add(Attributes.KNOCKBACK_RESISTANCE)
         .add(Attributes.EXPLOSION_KNOCKBACK_RESISTANCE)
         .add(Attributes.BOUNCINESS)
         .add(Attributes.AIR_DRAG_MODIFIER)
         .add(Attributes.FRICTION_MODIFIER);
   }
}`;

const MOB_SOURCE = `package net.minecraft.world.entity;
public abstract class Mob extends LivingEntity {
   public static AttributeSupplier.Builder createMobAttributes() {
      return LivingEntity.createLivingAttributes().add(Attributes.FOLLOW_RANGE, 16.0);
   }
}`;

async function writeFixture(root: string): Promise<void> {
  await writeFileAt(root, "data/minecraft/sulfur_cube_archetype/regular.json", REGULAR_ARCHETYPE);
  await writeFileAt(root, "data/minecraft/sulfur_cube_archetype/explosive.json", EXPLOSIVE_ARCHETYPE);
  // regular's tag mixes a concrete block and a nested tag that must be expanded recursively.
  await writeFileAt(
    root,
    "data/minecraft/tags/item/sulfur_cube_archetype/regular.json",
    JSON.stringify({ values: ["minecraft:dirt", "#minecraft:concrete_powders"] }),
  );
  await writeFileAt(
    root,
    "data/minecraft/tags/item/concrete_powders.json",
    JSON.stringify({ values: ["minecraft:white_concrete_powder", "minecraft:black_concrete_powder"] }),
  );
  await writeFileAt(
    root,
    "data/minecraft/tags/item/sulfur_cube_archetype/explosive.json",
    JSON.stringify({ values: ["minecraft:tnt"] }),
  );
  await writeFileAt(root, "data/minecraft/tags/item/sulfur_cube_swallowable.json", JSON.stringify({ values: [] }));
  await writeFileAt(root, "data/minecraft/tags/item/sulfur_cube_food.json", JSON.stringify({ values: ["minecraft:slime_ball"] }));
  await writeFileAt(
    root,
    "data/minecraft/tags/damage_type/sulfur_cube_with_block_immune_to.json",
    JSON.stringify({ values: ["minecraft:fall", "minecraft:arrow", "#minecraft:is_explosion"] }),
  );
  await writeFileAt(
    root,
    "data/minecraft/damage_type/sulfur_cube_hot.json",
    JSON.stringify({
      effects: "burning",
      exhaustion: 0.1,
      message_id: "sulfurCubeHot",
      scaling: "when_caused_by_living_non_player",
    }),
  );
  await writeFileAt(root, "data/minecraft/worldgen/biome/sulfur_caves.json", JSON.stringify({ spawners: {} }));
  await writeFileAt(
    root,
    "assets/minecraft/lang/en_us.json",
    JSON.stringify({ "entity.minecraft.sulfur_cube": "Sulfur Cube", "block.minecraft.dirt": "Dirt" }),
  );
  await writeFileAt(root, "net/minecraft/world/entity/SulfurCubeArchetypes.java", ARCHETYPES_SOURCE);
  await writeFileAt(root, "net/minecraft/world/entity/monster/cubemob/SulfurCube.java", ENTITY_SOURCE);
  await writeFileAt(root, "net/minecraft/world/entity/ai/attributes/Attributes.java", ATTRIBUTES_SOURCE);
  await writeFileAt(root, "net/minecraft/world/entity/LivingEntity.java", LIVING_ENTITY_SOURCE);
  await writeFileAt(root, "net/minecraft/world/entity/Mob.java", MOB_SOURCE);
}

describe("sulfur cube extractor", () => {
  test("resolves archetypes, nested block tags, behavior numbers, and entity constants", async () => {
    const root = await createTempClientRoot();
    await writeFixture(root);

    const dataset = await new SulfurCubeExtractor(createConsoleLogger(false)).extract(root);
    expect(dataset).toBeDefined();

    // Registry order from SulfurCubeArchetypes.java: regular before explosive.
    expect(dataset?.archetypes.map((a) => a.key)).toEqual(["regular", "explosive"]);

    const regular = dataset?.archetypes.find((a) => a.key === "regular");
    expect(regular?.displayName).toBe("Regular");
    expect(regular?.buoyant).toBe(true);
    expect(regular?.explosive).toBe(false);
    // add_value(knockback_resistance) = -1 → mobility 1; friction/airDrag = modifier + 1.
    expect(regular?.behavior).toEqual({ mobility: 1, bounciness: 0.5, friction: 0.3, airDrag: 0.1 });
    // Nested #concrete_powders expands; blocks are sorted and named from en_us with a titlecase fallback.
    expect(regular?.blocks).toEqual([
      { id: "minecraft:black_concrete_powder", name: "Black Concrete Powder" },
      { id: "minecraft:dirt", name: "Dirt" },
      { id: "minecraft:white_concrete_powder", name: "White Concrete Powder" },
    ]);
    expect(regular?.blockTags).toEqual(["#minecraft:concrete_powders"]);

    const explosive = dataset?.archetypes.find((a) => a.key === "explosive");
    expect(explosive?.explosive).toBe(true);
    expect(explosive?.explosion).toEqual({ power: 3, causesFire: false, fuse: 120 });
    expect(explosive?.blocks).toEqual([{ id: "minecraft:tnt", name: "Tnt" }]);

    // Reverse index maps every swallowable block to its archetype.
    expect(dataset?.blockIndex["minecraft:dirt"]).toBe("regular");
    expect(dataset?.blockIndex["minecraft:tnt"]).toBe("explosive");

    // Entity constants parsed from source.
    expect(dataset?.entity.displayName).toBe("Sulfur Cube");
    expect(dataset?.entity.spawnBiome).toBe("minecraft:sulfur_caves");
    expect(dataset?.entity.splitCount).toBe(2);
    expect(dataset?.entity.pickupTimerTicks).toBe(100);
    expect(dataset?.entity.healthPerSize).toBe(4);
    expect(dataset?.entity.temptRange).toBe(8);
    expect(dataset?.entity.experienceReward).toEqual({ min: 1, max: 2 });
    expect(dataset?.entity.foodItems).toEqual(["minecraft:slime_ball"]);

    // Full base attribute supplier resolved from the builder chain (living → mob → sulfur cube).
    const baseByAttr = new Map(dataset?.baseAttributes.map((a) => [a.attribute, a]));
    // Builder order is preserved: living attributes, then follow_range (mob), then tempt_range (cube).
    expect(dataset?.baseAttributes.map((a) => a.attribute)).toEqual([
      "minecraft:max_health",
      "minecraft:knockback_resistance",
      "minecraft:explosion_knockback_resistance",
      "minecraft:bounciness",
      "minecraft:air_drag_modifier",
      "minecraft:friction_modifier",
      "minecraft:follow_range",
      "minecraft:tempt_range",
    ]);
    expect(baseByAttr.get("minecraft:bounciness")).toMatchObject({ base: 0, min: 0, max: 1, overridden: false });
    // follow_range and tempt_range are overridden from their registry defaults by the builder chain.
    expect(baseByAttr.get("minecraft:follow_range")).toMatchObject({ base: 16, attributeDefault: 32, overridden: true });
    expect(baseByAttr.get("minecraft:tempt_range")).toMatchObject({ base: 8, attributeDefault: 10, overridden: true });
    // max_health carries the runtime 4×size override as a note.
    expect(baseByAttr.get("minecraft:max_health")?.note).toContain("4 × size");

    expect(dataset?.immunitiesWhenHoldingBlock).toEqual(["minecraft:arrow", "minecraft:fall"]);
    expect(dataset?.hotDamageType?.id).toBe("minecraft:sulfur_cube_hot");
    expect(dataset?.hotDamageType?.effects).toBe("burning");
    expect(dataset?.warnings).toEqual([]);
  });

  test("returns undefined when the archetype registry is absent", async () => {
    const root = await createTempClientRoot();
    expect(await new SulfurCubeExtractor(createConsoleLogger(false)).extract(root)).toBeUndefined();
  });
});
