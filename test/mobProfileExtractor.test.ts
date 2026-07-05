import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import {
  MobProfileExtractor,
  extractBalanced,
  extractMethodBody,
  parseAttributeDefaults,
  parseBuilderReturn,
  parseEntityRegistrations,
  parseJavaNumber,
} from "../src/extraction/mobProfileExtractor.js";
import type {
  EntityRenderDefinition,
  ItemDefinition,
  LootTableDefinition,
  MobImageDefinition,
  MobSoundDefinition,
  TagDefinition,
  TranslationEntry,
} from "../src/domain/types.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, (directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.clear();
});

async function writeJava(root: string, relPath: string, content: string): Promise<void> {
  const path = join(root, relPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** Write a minimal but representative decompiled entity tree: base builders, two mobs, registrations. */
async function writeFixtureTree(root: string): Promise<void> {
  const base = "net/minecraft/world/entity";
  await writeJava(
    root,
    `${base}/ai/attributes/Attributes.java`,
    `package net.minecraft.world.entity.ai.attributes;
public final class Attributes {
  public static final Holder<Attribute> ARMOR = register("armor", new RangedAttribute("attribute.name.armor", 0.0, 0.0, 30.0));
  public static final Holder<Attribute> ATTACK_DAMAGE = register("attack_damage", new RangedAttribute("attribute.name.attack_damage", 2.0, 0.0, 2048.0));
  public static final Holder<Attribute> FOLLOW_RANGE = register("follow_range", new RangedAttribute("attribute.name.follow_range", 32.0, 0.0, 2048.0));
  public static final Holder<Attribute> KNOCKBACK_RESISTANCE = register("knockback_resistance", new RangedAttribute("attribute.name.knockback_resistance", 0.0, -2.0, 1.0));
  public static final Holder<Attribute> MAX_HEALTH = register("max_health", new RangedAttribute("attribute.name.max_health", 20.0, 1.0, 1024.0));
  public static final Holder<Attribute> MOVEMENT_SPEED = register("movement_speed", new RangedAttribute("attribute.name.movement_speed", 0.7, 0.0, 1024.0));
  public static final Holder<Attribute> TEMPT_RANGE = register("tempt_range", new RangedAttribute("attribute.name.tempt_range", 10.0, 0.0, 2048.0));
}`,
  );
  await writeJava(
    root,
    `${base}/LivingEntity.java`,
    `package net.minecraft.world.entity;
public abstract class LivingEntity extends Entity {
  public static AttributeSupplier.Builder createLivingAttributes() {
    return AttributeSupplier.builder()
      .add(Attributes.MAX_HEALTH)
      .add(Attributes.KNOCKBACK_RESISTANCE)
      .add(Attributes.MOVEMENT_SPEED)
      .add(Attributes.ARMOR);
  }
}`,
  );
  await writeJava(
    root,
    `${base}/Mob.java`,
    `package net.minecraft.world.entity;
public abstract class Mob extends LivingEntity {
  public static AttributeSupplier.Builder createMobAttributes() {
    return LivingEntity.createLivingAttributes().add(Attributes.FOLLOW_RANGE, 16.0);
  }
}`,
  );
  await writeJava(
    root,
    `${base}/PathfinderMob.java`,
    `package net.minecraft.world.entity;
public abstract class PathfinderMob extends Mob {}`,
  );
  await writeJava(
    root,
    `${base}/AgeableMob.java`,
    `package net.minecraft.world.entity;
public abstract class AgeableMob extends PathfinderMob {}`,
  );
  await writeJava(
    root,
    `${base}/monster/Monster.java`,
    `package net.minecraft.world.entity.monster;
public abstract class Monster extends PathfinderMob implements Enemy {
  protected Monster(EntityType<? extends Monster> type, Level level) {
    super(type, level);
    this.xpReward = 5;
  }
  public static AttributeSupplier.Builder createMonsterAttributes() {
    return Mob.createMobAttributes().add(Attributes.ATTACK_DAMAGE);
  }
}`,
  );
  await writeJava(
    root,
    `${base}/animal/Animal.java`,
    `package net.minecraft.world.entity.animal;
public abstract class Animal extends AgeableMob {
  public static AttributeSupplier.Builder createAnimalAttributes() {
    return Mob.createMobAttributes().add(Attributes.TEMPT_RANGE, 10.0);
  }
}`,
  );
  // Cow: explicit health/speed override; note createAttributes lives on the parent AbstractCow.
  await writeJava(
    root,
    `${base}/animal/cow/AbstractCow.java`,
    `package net.minecraft.world.entity.animal.cow;
public abstract class AbstractCow extends Animal {
  public static AttributeSupplier.Builder createAttributes() {
    return Animal.createAnimalAttributes().add(Attributes.MAX_HEALTH, 10.0).add(Attributes.MOVEMENT_SPEED, 0.2F);
  }
}`,
  );
  await writeJava(
    root,
    `${base}/animal/cow/Cow.java`,
    `package net.minecraft.world.entity.animal.cow;
public class Cow extends AbstractCow {}`,
  );
  await writeJava(
    root,
    `${base}/monster/Creeper.java`,
    `package net.minecraft.world.entity.monster;
public class Creeper extends Monster {
  public static AttributeSupplier.Builder createAttributes() {
    return Monster.createMonsterAttributes().add(Attributes.MOVEMENT_SPEED, 0.25);
  }
}`,
  );
  await writeJava(
    root,
    `${base}/EntityTypeIds.java`,
    `package net.minecraft.world.entity;
public class EntityTypeIds {
  public static final ResourceKey<EntityType<?>> COW = create("cow");
  public static final ResourceKey<EntityType<?>> CREEPER = create("creeper");
}`,
  );
  await writeJava(
    root,
    `${base}/EntityTypes.java`,
    `package net.minecraft.world.entity;
public class EntityTypes {
  public static final EntityType<Cow> COW = register(
    EntityTypeIds.COW,
    EntityType.Builder.of(Cow::new, MobCategory.CREATURE).sized(0.9F, 1.4F).eyeHeight(1.3F).clientTrackingRange(10)
  );
  public static final EntityType<Creeper> CREEPER = register(
    EntityTypeIds.CREEPER,
    EntityType.Builder.of(Creeper::new, MobCategory.MONSTER).sized(0.6F, 1.7F).clientTrackingRange(8).notInPeaceful()
  );
}`,
  );
  await writeJava(
    root,
    `${base}/ai/attributes/DefaultAttributes.java`,
    `package net.minecraft.world.entity.ai.attributes;
public class DefaultAttributes {
  private static final Map<EntityType<?>, AttributeSupplier> SUPPLIERS = ImmutableMap.builder()
    .put(EntityTypes.COW, Cow.createAttributes().build())
    .put(EntityTypes.CREEPER, Creeper.createAttributes().build())
    .build();
}`,
  );
}

function fixtureInputs() {
  const entities: EntityRenderDefinition[] = [
    {
      id: "minecraft:cow",
      displayName: "Cow",
      rendererId: "minecraft:cow",
      modelLayerIds: ["cow", "cow_baby"],
      variantLayerIds: [],
      textureAssets: [],
      source: { kind: "client-source", className: "CowRenderer", path: "x" },
    },
    {
      id: "minecraft:creeper",
      displayName: "Creeper",
      rendererId: "minecraft:creeper",
      modelLayerIds: ["creeper"],
      variantLayerIds: [],
      textureAssets: [],
      source: { kind: "client-source", className: "CreeperRenderer", path: "x" },
    },
  ];
  const lootTables: LootTableDefinition[] = [
    {
      id: "minecraft:entities/cow",
      poolCount: 2,
      itemDrops: ["minecraft:beef", "minecraft:leather"],
      functions: ["minecraft:furnace_smelt"],
      sourcePath: "x",
      raw: {},
    },
    {
      id: "minecraft:entities/creeper",
      poolCount: 1,
      itemDrops: ["minecraft:gunpowder"],
      functions: [],
      sourcePath: "x",
      raw: {},
    },
  ];
  const mobSounds: MobSoundDefinition[] = [
    {
      id: "minecraft:cow",
      localId: "cow",
      soundId: "cow",
      displayName: "Cow",
      translationKey: "entity.minecraft.cow",
      category: "Creature",
      mobCategory: "CREATURE",
      soundEventCount: 2,
      soundVariantCount: 2,
      soundEvents: [
        { id: "entity.cow.ambient", variants: [] },
        { id: "entity.cow.hurt", variants: [] },
      ],
    },
  ];
  const mobImages: MobImageDefinition[] = [
    {
      id: "minecraft:cow",
      localId: "cow",
      displayName: "Cow",
      imagePath: "mob-images/cow/cow.png",
      origin: "renderer",
      variants: [{ id: "cow/cow", imagePath: "mob-images/cow/cow.png", origin: "renderer", role: "base", sourcePath: "x" }],
    },
  ];
  const tags: TagDefinition[] = [
    {
      id: "minecraft:followable_friendly_mobs",
      registry: "entity_type",
      replace: false,
      values: ["minecraft:cow"],
      sourcePath: "x",
      raw: {},
    },
    {
      id: "minecraft:sensitive_to_smite",
      registry: "entity_type",
      replace: false,
      values: ["minecraft:zombie"],
      sourcePath: "x",
      raw: {},
    },
  ];
  const items: ItemDefinition[] = [
    { id: "minecraft:cow_spawn_egg" } as ItemDefinition,
    { id: "minecraft:diamond" } as ItemDefinition,
  ];
  const translations: TranslationEntry[] = [
    { key: "entity.minecraft.cow", value: "Cow" },
    { key: "entity.minecraft.creeper", value: "Creeper" },
  ];
  return { entities, lootTables, mobSounds, mobImages, mobModels: [], translations, tags, items };
}

describe("mob profile extractor", () => {
  test("derives stats through the attribute inheritance chain and aggregates render/loot/sound data", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-profile-"));
    tempDirs.add(root);
    await writeFixtureTree(root);

    const extractor = new MobProfileExtractor(createConsoleLogger(false));
    const profiles = await extractor.extract(root, fixtureInputs());
    const byId = (id: string) => profiles.find((p) => p.id === id)!;

    const cow = byId("minecraft:cow");
    expect(cow.displayName).toBe("Cow");
    expect(cow.mobCategory).toBe("CREATURE");
    expect(cow.hostility).toBe("passive");
    expect(cow.spawnsInPeaceful).toBe(true);
    expect(cow.fireImmune).toBe(false);
    // Explicit overrides win; inherited FOLLOW_RANGE(16) resolves through Mob; ATTACK_DAMAGE is absent for a passive mob.
    expect(cow.maxHealth).toBe(10);
    expect(cow.movementSpeed).toBe(0.2);
    expect(cow.followRange).toBe(16);
    expect(cow.attackDamage).toBeUndefined();
    expect(cow.dimensions).toEqual({ width: 0.9, height: 1.4, eyeHeight: 1.3 });
    expect(cow.clientTrackingRange).toBe(10);
    expect(cow.drops?.itemDrops).toEqual(["minecraft:beef", "minecraft:leather"]);
    expect(cow.sounds?.events).toEqual(["entity.cow.ambient", "entity.cow.hurt"]);
    expect(cow.images?.imagePath).toBe("mob-images/cow/cow.png");
    expect(cow.modelLayerIds).toEqual(["cow", "cow_baby"]);
    expect(cow.tags).toEqual(["minecraft:followable_friendly_mobs"]);
    expect(cow.spawnEgg).toBe("minecraft:cow_spawn_egg");
    expect(cow.sourceClass).toContain("Cow.java");
    expect(cow.warnings).toEqual([]);
    // max_health should be marked as a mob-level override, not a registry default.
    expect(cow.attributes.find((a) => a.constant === "MAX_HEALTH")?.origin).toBe("mob");

    const creeper = byId("minecraft:creeper");
    expect(creeper.hostility).toBe("hostile");
    expect(creeper.spawnsInPeaceful).toBe(false);
    expect(creeper.maxHealth).toBe(20); // inherited registry default via LivingEntity
    expect(creeper.movementSpeed).toBe(0.25);
    expect(creeper.attackDamage).toBe(2); // bare .add(ATTACK_DAMAGE) → registry default
    expect(creeper.experience).toEqual({ value: 5, variable: false, note: expect.stringContaining("Monster") });
    expect(creeper.spawnEgg).toBeUndefined(); // no creeper_spawn_egg in the fixture item list
  });

  test("emits aggregation-only profiles when no decompiled source is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-profile-empty-"));
    tempDirs.add(root);

    const extractor = new MobProfileExtractor(createConsoleLogger(false));
    const profiles = await extractor.extract(root, fixtureInputs());
    const cow = profiles.find((p) => p.id === "minecraft:cow")!;
    expect(cow.attributes).toEqual([]);
    expect(cow.maxHealth).toBeUndefined();
    expect(cow.drops?.itemDrops).toEqual(["minecraft:beef", "minecraft:leather"]);
    expect(cow.warnings.length).toBeGreaterThan(0);
  });
});

describe("mob profile parsers", () => {
  test("parseAttributeDefaults reads RangedAttribute defaults", () => {
    const defaults = parseAttributeDefaults(
      `public static final Holder<Attribute> MAX_HEALTH = register("max_health", new RangedAttribute("attribute.name.max_health", 20.0, 1.0, 1024.0).setSyncable(true));`,
    );
    expect(defaults.get("MAX_HEALTH")).toBe(20);
  });

  test("parseBuilderReturn handles qualified bases, bare inherited statics, and computed values", () => {
    const qualified = parseBuilderReturn("return Animal.createAnimalAttributes().add(Attributes.MAX_HEALTH, 10.0);");
    expect(qualified.base).toEqual({ owner: "Animal", method: "createAnimalAttributes" });
    expect(qualified.adds).toEqual([{ constant: "MAX_HEALTH", value: 10, computed: false }]);

    const bare = parseBuilderReturn("return createBaseChestedHorseAttributes();");
    expect(bare.base).toEqual({ method: "createBaseChestedHorseAttributes" });

    const root = parseBuilderReturn("return AttributeSupplier.builder().add(Attributes.MAX_HEALTH);");
    expect(root.base).toBeUndefined();
    expect(root.adds).toEqual([{ constant: "MAX_HEALTH", value: undefined, computed: false }]);

    const computed = parseBuilderReturn(
      "return Animal.createAnimalAttributes().add(Attributes.MAX_HEALTH, generateRandomMaxHealth(this.random));",
    );
    expect(computed.adds[0]).toMatchObject({ constant: "MAX_HEALTH", computed: true });
  });

  test("parseEntityRegistrations captures category, dimensions, and peaceful flag", () => {
    const source = `register(
      EntityTypeIds.CREEPER,
      EntityType.Builder.of(Creeper::new, MobCategory.MONSTER).sized(0.6F, 1.7F).clientTrackingRange(8).notInPeaceful()
    )`;
    const registrations = parseEntityRegistrations(source, new Map([["CREEPER", "creeper"]]));
    const creeper = registrations.get("creeper");
    expect(creeper).toMatchObject({
      className: "Creeper",
      mobCategory: "MONSTER",
      width: 0.6,
      height: 1.7,
      clientTrackingRange: 8,
      fireImmune: false,
      spawnsInPeaceful: false,
    });
  });

  test("parseJavaNumber strips type suffixes and extractBalanced/extractMethodBody scope bodies", () => {
    expect(parseJavaNumber("0.23F")).toBeCloseTo(0.23);
    expect(parseJavaNumber("128L")).toBe(128);
    expect(parseJavaNumber("not-a-number")).toBeUndefined();
    expect(extractBalanced("of(a, b(c))", 2, "(", ")")).toBe("a, b(c)");
    expect(
      extractMethodBody("public static AttributeSupplier.Builder createAttributes() { return X; }", "createAttributes"),
    ).toBe(" return X; ");
  });
});
