import { describe, expect, it } from "vitest";
import type { BlockPropertyDefinition } from "../src/domain/types.js";
import {
  buildBlockSounds,
  parseRegistrationTypes,
  parseSetTypeSounds,
  parseSoundOverrideClasses,
  resolveRegistrationType,
} from "../src/extraction/blockSoundsExtractor.js";

/**
 * Doors, trapdoors, buttons, pressure plates, signs and fence gates get their
 * sound from a BlockSetType/WoodType in their constructor, not from Blocks.java.
 * Without this pass every wooden door in the game would play stone.
 */

const SOUND_EVENTS_SOURCE = ["WOOD", "STONE", "METAL"]
  .flatMap((name) =>
    ["BREAK", "STEP", "PLACE", "HIT", "FALL"].map(
      (event) =>
        `   public static final SoundEvent ${name}_${event} = register("block.${name.toLowerCase()}.${event.toLowerCase()}");`,
    ),
  )
  .join("\n");

const SOUND_TYPE_SOURCE = ["WOOD", "STONE", "METAL"]
  .map(
    (name) =>
      `   public static final SoundType ${name} = new SoundType(1.0F, 1.0F, SoundEvents.${name}_BREAK, SoundEvents.${name}_STEP, SoundEvents.${name}_PLACE, SoundEvents.${name}_HIT, SoundEvents.${name}_FALL);`,
  )
  .join("\n");

const BLOCK_SET_TYPE_SOURCE = `
public record BlockSetType(String name, boolean canOpenByHand, SoundType soundType, SoundEvent doorClose) {
   public static final BlockSetType IRON = register(
      new BlockSetType(
         "iron",
         false,
         SoundType.METAL,
         SoundEvents.IRON_DOOR_CLOSE
      )
   );
   public static final BlockSetType OAK = register(new BlockSetType("oak"));
   public static final BlockSetType DARK_OAK = register(new BlockSetType("dark_oak"));
   public static final BlockSetType COPPER = register(new BlockSetType("copper", true, SoundType.COPPER, SoundEvents.COPPER_DOOR_CLOSE));
}
`;

const WOOD_TYPE_SOURCE = `
public record WoodType(String name, BlockSetType setType, SoundType soundType, SoundType hangingSignSoundType) {
   public static final WoodType OAK = register(new WoodType("oak", BlockSetType.OAK));
   public static final WoodType CRIMSON = register(
      new WoodType(
         "crimson",
         BlockSetType.CRIMSON,
         SoundType.NETHER_WOOD,
         SoundType.NETHER_WOOD_HANGING_SIGN,
         SoundEvents.NETHER_WOOD_FENCE_GATE_CLOSE
      )
   );
}
`;

const BLOCKS_SOURCE = `
public class Blocks {
   public static final Block OAK_DOOR = register(
      BlockItemIds.OAK_DOOR,
      p -> new DoorBlock(BlockSetType.OAK, p),
      BlockBehaviour.Properties.of().strength(3.0F)
   );
   public static final Block DARK_OAK_DOOR = register(
      BlockItemIds.DARK_OAK_DOOR,
      p -> new DoorBlock(BlockSetType.DARK_OAK, p),
      BlockBehaviour.Properties.of().strength(3.0F)
   );
   public static final Block IRON_DOOR = register(BlockItemIds.IRON_DOOR, p -> new DoorBlock(BlockSetType.IRON, p), doorProperties());
   public static final Block OAK_HANGING_SIGN = register(BlockItemIds.OAK_HANGING_SIGN, p -> new CeilingHangingSignBlock(WoodType.OAK, p), signProperties());
   public static final Block CRIMSON_SIGN = register(BlockItemIds.CRIMSON_SIGN, p -> new StandingSignBlock(WoodType.CRIMSON, p), signProperties());
   public static final WeatheringCopperCollection<Block> COPPER_DOOR = WeatheringCopperCollection.registerBlocks(
      BlockItemIds.COPPER_DOOR,
      Blocks::register,
      (var0, p) -> new DoorBlock(BlockSetType.COPPER, p),
      (state, p) -> new WeatheringCopperDoorBlock(BlockSetType.COPPER, state, p),
      state -> BlockBehaviour.Properties.of()
   );
   public static final Block LIGHT_WEIGHTED_PRESSURE_PLATE = register(
      BlockItemIds.LIGHT_WEIGHTED_PRESSURE_PLATE,
      p -> new WeightedPressurePlateBlock(15, BlockSetType.IRON, p),
      BlockBehaviour.Properties.of()
   );
   public static final Block PLAIN_STONE = register(BlockItemIds.STONE, Block::new, BlockBehaviour.Properties.of());

   private static BlockBehaviour.Properties doorProperties() {
      return BlockBehaviour.Properties.of();
   }

   private static Block woodenDoorHelper() {
      return new DoorBlock(BlockSetType.OAK, BlockBehaviour.Properties.of());
   }
}
`;

const BLOCK_CLASS_SOURCES = new Map<string, string>([
  ["DoorBlock", "public class DoorBlock extends Block {\n  super(properties.sound(type.soundType()));\n}"],
  ["WeatheringCopperDoorBlock", "public class WeatheringCopperDoorBlock extends DoorBlock implements WeatheringCopper {}"],
  [
    "StandingSignBlock",
    "public class StandingSignBlock extends SignBlock {\n  super(type, properties.sound(type.soundType()));\n}",
  ],
  [
    "CeilingHangingSignBlock",
    "public class CeilingHangingSignBlock extends SignBlock {\n  super(type, properties.sound(type.hangingSignSoundType()));\n}",
  ],
  ["Block", "public class Block extends BlockBehaviour {}"],
]);

function property(id: string, symbol: string, implementationClass: string, soundType?: string): BlockPropertyDefinition {
  return {
    id,
    sourcePath: "net/minecraft/world/level/block/Blocks.java",
    sourceSymbol: symbol,
    implementationClass,
    requiresCorrectToolForDrops: false,
    ignitedByLava: false,
    randomTicks: false,
    noCollision: false,
    replaceable: false,
    ...(soundType ? { soundType } : {}),
  };
}

describe("parseSetTypeSounds", () => {
  it("falls back to WOOD for the short BlockSetType constructor", () => {
    const table = parseSetTypeSounds(BLOCK_SET_TYPE_SOURCE, "BlockSetType");
    expect(table.get("OAK")?.soundType).toBe("wood");
    expect(table.get("IRON")?.soundType).toBe("metal");
    expect(table.get("COPPER")?.soundType).toBe("copper");
  });

  it("reads both WoodType sound types in order, with the short-constructor defaults", () => {
    const table = parseSetTypeSounds(WOOD_TYPE_SOURCE, "WoodType");
    expect(table.get("OAK")).toEqual({ soundType: "wood", hangingSignSoundType: "hanging_sign" });
    expect(table.get("CRIMSON")).toEqual({
      soundType: "nether_wood",
      hangingSignSoundType: "nether_wood_hanging_sign",
    });
  });
});

describe("parseSoundOverrideClasses", () => {
  it("finds the overriding classes and inherits through subclasses", () => {
    const classes = parseSoundOverrideClasses(BLOCK_CLASS_SOURCES);
    expect(classes.get("DoorBlock")).toBe("soundType");
    expect(classes.get("WeatheringCopperDoorBlock")).toBe("soundType");
    expect(classes.get("CeilingHangingSignBlock")).toBe("hangingSignSoundType");
    expect(classes.has("Block")).toBe(false);
  });
});

describe("resolveRegistrationType", () => {
  const registrations = parseRegistrationTypes(BLOCKS_SOURCE);

  it("never lets OAK_DOOR claim DARK_OAK_DOOR", () => {
    expect(resolveRegistrationType("OAK_DOOR", registrations)?.constant).toBe("OAK");
    expect(resolveRegistrationType("DARK_OAK_DOOR", registrations)?.constant).toBe("DARK_OAK");
  });

  it("resolves every weathered and waxed member of a copper collection", () => {
    for (const symbol of ["COPPER_DOOR", "EXPOSED_COPPER_DOOR", "WAXED_OXIDIZED_COPPER_DOOR"]) {
      expect(resolveRegistrationType(symbol, registrations)?.constant).toBe("COPPER");
    }
    // A prefix that is not a weathering stage does not match.
    expect(resolveRegistrationType("SHINY_COPPER_DOOR", registrations)).toBeUndefined();
  });

  it("finds the set type when it is not the first constructor argument", () => {
    expect(resolveRegistrationType("LIGHT_WEIGHTED_PRESSURE_PLATE", registrations)?.constant).toBe("IRON");
  });

  it("does not let a helper method after the last constant lend it a type", () => {
    expect(resolveRegistrationType("PLAIN_STONE", registrations)).toBeUndefined();
  });
});

describe("buildBlockSounds with set types", () => {
  const properties = [
    property("minecraft:oak_door", "OAK_DOOR", "DoorBlock"),
    property("minecraft:iron_door", "IRON_DOOR", "DoorBlock"),
    property("minecraft:exposed_copper_door", "EXPOSED_COPPER_DOOR", "DoorBlock"),
    property("minecraft:crimson_sign", "CRIMSON_SIGN", "StandingSignBlock"),
    // Declares stone in its properties, and has no overriding class.
    property("minecraft:stone", "PLAIN_STONE", "Block", "stone"),
    // Overriding class, but no registration to read a type from.
    property("minecraft:mystery_door", "MYSTERY_DOOR", "DoorBlock"),
  ];
  const result = buildBlockSounds(
    "26.3",
    SOUND_TYPE_SOURCE,
    SOUND_EVENTS_SOURCE,
    properties,
    properties.map((entry) => entry.id),
    {
      blockSetTypeSource: BLOCK_SET_TYPE_SOURCE,
      woodTypeSource: WOOD_TYPE_SOURCE,
      blocksSource: BLOCKS_SOURCE,
      blockClassSources: BLOCK_CLASS_SOURCES,
    },
  );

  it("gives a wooden door the wood sound instead of the stone default", () => {
    expect(result.dataset.blocks["minecraft:oak_door"]).toBe("wood");
    expect(result.dataset.blocks["minecraft:iron_door"]).toBe("metal");
  });

  it("follows copper collection members to their set type", () => {
    expect(result.setTypeOverrides).toContain("minecraft:exposed_copper_door");
  });

  it("reports a resolved type that is missing from SoundType.java instead of guessing", () => {
    // `nether_wood` and `copper` are not in this miniature table.
    expect(result.unknownSoundTypes).toEqual(expect.arrayContaining(["minecraft:crimson_sign", "minecraft:exposed_copper_door"]));
  });

  it("leaves blocks without an overriding class alone", () => {
    expect(result.dataset.blocks["minecraft:stone"]).toBe("stone");
    expect(result.setTypeOverrides).not.toContain("minecraft:stone");
  });

  it("reports an overriding block it could not resolve", () => {
    expect(result.unresolvedSetTypes).toEqual(["minecraft:mystery_door"]);
  });
});
