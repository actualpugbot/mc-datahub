import { describe, expect, it } from "vitest";
import type { BlockPropertyDefinition } from "../src/domain/types.js";
import {
  DEFAULT_SOUND_TYPE,
  buildBlockSounds,
  parseSoundEventIds,
  parseSoundTypes,
  parseBlockSoundSetData,
  playbackPitch,
  playbackVolume,
} from "../src/extraction/blockSoundsExtractor.js";

/** Shaped exactly like the decompiler's output, including the line wrapping. */
const SOUND_EVENTS_SOURCE = `
package net.minecraft.sounds;

public class SoundEvents {
   public static final SoundEvent WOOD_BREAK = register("block.wood.break");
   public static final SoundEvent WOOD_STEP = register("block.wood.step");
   public static final SoundEvent WOOD_PLACE = register("block.wood.place");
   public static final SoundEvent WOOD_HIT = register("block.wood.hit");
   public static final SoundEvent WOOD_FALL = register("block.wood.fall");
   public static final SoundEvent STONE_BREAK = register("block.stone.break");
   public static final SoundEvent STONE_STEP = register("block.stone.step");
   public static final SoundEvent STONE_PLACE = register("block.stone.place");
   public static final SoundEvent STONE_HIT = register("block.stone.hit");
   public static final SoundEvent STONE_FALL = register("block.stone.fall");
   public static final SoundEvent METAL_BREAK = register("block.metal.break");
   public static final SoundEvent METAL_STEP = register("block.metal.step");
   public static final SoundEvent METAL_PLACE = register("block.metal.place");
   public static final SoundEvent METAL_HIT = register("block.metal.hit");
   public static final SoundEvent METAL_FALL = register("block.metal.fall");
   public static final SoundEvent LILY_PAD_PLACE = register("block.lily_pad.place");
   public static final SoundEvent BIG_DRIPLEAF_BREAK = register("block.big_dripleaf.break");
   public static final SoundEvent BIG_DRIPLEAF_STEP = register("block.big_dripleaf.step");
   public static final SoundEvent BIG_DRIPLEAF_HIT = register("block.big_dripleaf.hit");
   public static final SoundEvent BIG_DRIPLEAF_FALL = register("block.big_dripleaf.fall");
}
`;

const SOUND_TYPE_SOURCE = `
package net.minecraft.world.level.block;

public class SoundType {
   public static final SoundType WOOD = new SoundType(
      1.0F, 1.0F, SoundEvents.WOOD_BREAK, SoundEvents.WOOD_STEP, SoundEvents.WOOD_PLACE, SoundEvents.WOOD_HIT, SoundEvents.WOOD_FALL
   );
   public static final SoundType STONE = new SoundType(
      1.0F, 1.0F, SoundEvents.STONE_BREAK, SoundEvents.STONE_STEP, SoundEvents.STONE_PLACE, SoundEvents.STONE_HIT, SoundEvents.STONE_FALL
   );
   public static final SoundType METAL = new SoundType(
      1.0F, 1.5F, SoundEvents.METAL_BREAK, SoundEvents.METAL_STEP, SoundEvents.METAL_PLACE, SoundEvents.METAL_HIT, SoundEvents.METAL_FALL
   );
   public static final SoundType LILY_PAD = new SoundType(
      1.0F,
      1.0F,
      SoundEvents.BIG_DRIPLEAF_BREAK,
      SoundEvents.BIG_DRIPLEAF_STEP,
      SoundEvents.LILY_PAD_PLACE,
      SoundEvents.BIG_DRIPLEAF_HIT,
      SoundEvents.BIG_DRIPLEAF_FALL
   );

   public float getVolume() {
      return this.volume;
   }
}
`;

function blockProperty(id: string, soundType?: string): BlockPropertyDefinition {
  return {
    id,
    sourcePath: "net/minecraft/world/level/block/Blocks.java",
    sourceSymbol: id,
    requiresCorrectToolForDrops: false,
    ignitedByLava: false,
    randomTicks: false,
    noCollision: false,
    replaceable: false,
    ...(soundType ? { soundType } : {}),
  };
}

describe("parseSoundEventIds", () => {
  it("maps every constant to the id the game registers", () => {
    const ids = parseSoundEventIds(SOUND_EVENTS_SOURCE);
    expect(ids.get("WOOD_PLACE")).toBe("block.wood.place");
    expect(ids.get("LILY_PAD_PLACE")).toBe("block.lily_pad.place");
    expect(ids.size).toBe(20);
  });
});

describe("block sound set data-pack resources", () => {
  it("uses actual event ids, volume and pitch, while preserving absent sounds", () => {
    const { soundTypes, skipped } = parseBlockSoundSetData([
      {
        path: "data/minecraft/block_sound_set/lily_pad.json",
        raw: {
          break_sound: "minecraft:block.big_dripleaf.break",
          place_sound: "minecraft:block.lily_pad.place",
          pitch: 1.5,
        },
      },
      {
        path: "data/minecraft/block_sound_set/dried_ghast.json",
        raw: { break_sound: "minecraft:block.dried_ghast.break" },
      },
    ]);
    expect(skipped).toEqual([]);
    expect(soundTypes[1]?.break?.event).toBe("block.big_dripleaf.break");
    expect(soundTypes[1]?.place?.pitch).toBeCloseTo(1.2);
    expect(soundTypes[0]?.place).toBeUndefined();
  });
});

describe("parseSoundTypes", () => {
  const ids = parseSoundEventIds(SOUND_EVENTS_SOURCE);
  const { soundTypes, skipped } = parseSoundTypes(SOUND_TYPE_SOURCE, ids);
  const byId = new Map(soundTypes.map((soundType) => [soundType.id, soundType]));

  it("reads every constant, including the ones wrapped over many lines", () => {
    expect(skipped).toEqual([]);
    expect([...byId.keys()].sort()).toEqual(["lily_pad", "metal", "stone", "wood"]);
  });

  it("reads the event id from the source instead of deriving it from the name", () => {
    // The whole reason this is parsed rather than inferred: LILY_PAD places a
    // lily pad sound but breaks like a big dripleaf.
    const lilyPad = byId.get("lily_pad");
    expect(lilyPad?.place?.event).toBe("block.lily_pad.place");
    expect(lilyPad?.break?.event).toBe("block.big_dripleaf.break");
  });

  it("keeps the constructor argument order straight", () => {
    const wood = byId.get("wood");
    expect(wood?.break?.event).toBe("block.wood.break");
    expect(wood?.step).toBe("block.wood.step");
    expect(wood?.place?.event).toBe("block.wood.place");
    expect(wood?.hit).toBe("block.wood.hit");
    expect(wood?.fall).toBe("block.wood.fall");
  });

  it("works out the volume and pitch the game actually plays", () => {
    // BlockItem.place: (volume + 1) / 2 and pitch * 0.8.
    const stone = byId.get("stone");
    expect(stone?.volume).toBe(1);
    expect(stone?.place?.volume).toBeCloseTo(1, 6);
    expect(stone?.place?.pitch).toBeCloseTo(0.8, 6);

    const metal = byId.get("metal");
    expect(metal?.pitch).toBe(1.5);
    expect(metal?.place?.pitch).toBeCloseTo(1.2, 6);
  });

  it("skips a constant whose shape it does not recognise, rather than guessing", () => {
    const broken = `
      public static final SoundType ODD = new SoundType(1.0F, 1.0F, SoundEvents.WOOD_BREAK);
    `;
    const result = parseSoundTypes(broken, ids);
    expect(result.soundTypes).toEqual([]);
    expect(result.skipped).toEqual(["ODD"]);
  });

  it("skips a constant referencing an event it cannot resolve", () => {
    const unknown = `
      public static final SoundType ODD = new SoundType(
        1.0F, 1.0F, SoundEvents.NOPE_BREAK, SoundEvents.NOPE_STEP, SoundEvents.NOPE_PLACE, SoundEvents.NOPE_HIT, SoundEvents.NOPE_FALL
      );
    `;
    const result = parseSoundTypes(unknown, ids);
    expect(result.soundTypes).toEqual([]);
    expect(result.skipped).toEqual(["ODD"]);
  });
});

describe("playback formulas", () => {
  it("match the values read out of BlockItem.place", () => {
    expect(playbackVolume(1)).toBe(1);
    // ANVIL is the quiet one: 0.3 -> 0.65.
    expect(playbackVolume(0.3)).toBeCloseTo(0.65, 6);
    expect(playbackPitch(1)).toBeCloseTo(0.8, 6);
    expect(playbackPitch(1.5)).toBeCloseTo(1.2, 6);
  });
});

describe("buildBlockSounds", () => {
  const blockIds = [
    "minecraft:oak_planks",
    "minecraft:stone",
    "minecraft:iron_block",
    "minecraft:lily_pad",
    "minecraft:mystery_block",
  ];
  const properties = [
    blockProperty("minecraft:oak_planks", "wood"),
    blockProperty("minecraft:stone", "stone"),
    blockProperty("minecraft:iron_block", "metal"),
    blockProperty("minecraft:lily_pad", "lily_pad"),
    // No `.sound(...)` call at all.
    blockProperty("minecraft:mystery_block"),
  ];
  const result = buildBlockSounds("26.3", SOUND_TYPE_SOURCE, SOUND_EVENTS_SOURCE, properties, blockIds);

  it("covers every registered block, not just the ones that set a sound", () => {
    expect(Object.keys(result.dataset.blocks).sort()).toEqual([...blockIds].sort());
    expect(result.skippedSoundTypes).toEqual([]);
    expect(result.unknownSoundTypes).toEqual([]);
  });

  it("defaults a block with no declared sound to stone, the way the game does", () => {
    // BlockBehaviour.Properties initialises soundType to SoundType.STONE.
    expect(result.dataset.blocks["minecraft:mystery_block"]).toBe(DEFAULT_SOUND_TYPE);
    expect(result.defaultedBlocks).toEqual(["minecraft:mystery_block"]);
  });

  it("maps declared sound types through", () => {
    expect(result.dataset.blocks["minecraft:oak_planks"]).toBe("wood");
    expect(result.dataset.blocks["minecraft:iron_block"]).toBe("metal");
    expect(result.dataset.blocks["minecraft:lily_pad"]).toBe("lily_pad");
  });

  it("reports a sound type it cannot resolve instead of substituting silently", () => {
    const odd = buildBlockSounds(
      "26.3",
      SOUND_TYPE_SOURCE,
      SOUND_EVENTS_SOURCE,
      [blockProperty("minecraft:weird", "not_a_real_type")],
      ["minecraft:weird"],
    );
    expect(odd.unknownSoundTypes).toEqual(["minecraft:weird"]);
    // Still answerable, so a consumer never gets an undefined sound.
    expect(odd.dataset.blocks["minecraft:weird"]).toBe(DEFAULT_SOUND_TYPE);
  });

  it("sorts blocks and sound types so the file diffs cleanly between versions", () => {
    const keys = Object.keys(result.dataset.blocks);
    expect(keys).toEqual([...keys].sort());
    const ids = result.dataset.soundTypes.map((soundType) => soundType.id);
    expect(ids).toEqual([...ids].sort());
  });
});
