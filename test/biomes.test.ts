import { describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import type { JsonValue, TagDefinition, TranslationEntry } from "../src/domain/types.js";
import { buildBiomes } from "../src/extraction/biomes.js";

describe("biome extraction", () => {
  test("classifies surface, cave, and special biomes for map consumers", async () => {
    const entries: Record<string, string> = {
      "data/minecraft/dimension_type/overworld.json": JSON.stringify({ min_y: -64, height: 384 }),
      "data/minecraft/dimension_type/the_nether.json": JSON.stringify({ min_y: 0, height: 256 }),
      "data/minecraft/dimension_type/the_end.json": JSON.stringify({ min_y: 0, height: 256 }),
    };

    for (const key of ["plains", "deep_dark", "dripstone_caves", "lush_caves", "the_void", "nether_wastes", "the_end"]) {
      entries[`data/minecraft/worldgen/biome/${key}.json`] = JSON.stringify(minimalBiome());
    }
    entries["data/minecraft/worldgen/biome/sulfur_caves.json"] = JSON.stringify({
      ...minimalBiome(),
      effects: {
        grass_color: "#aba64f",
        water_color: "#34bf89",
      },
      attributes: {
        "minecraft:visual/fog_color": "#8cb831",
        "minecraft:visual/sky_color": "#78a7ff",
        "minecraft:visual/water_fog_color": "#17543c",
      },
      features: [[], ["minecraft:rooted_sulfur_spring", "minecraft:sulfur_pool"], [], [], [], [], [], ["minecraft:sulfur_spike"]],
      spawners: {
        monster: [{ type: "minecraft:sulfur_cube", maxCount: 4, minCount: 2, weight: 100 }],
      },
    });

    const biomes = await buildBiomes(Object.keys(entries), new InMemoryArchiveSource(entries), biomeTags(), translations());
    const byKey = new Map(biomes.map((biome) => [biome.key, biome]));
    const caveKeys = biomes.filter((biome) => biome.placement === "underground").map((biome) => biome.key);

    expect(caveKeys).toEqual(["deep_dark", "dripstone_caves", "lush_caves", "sulfur_caves"]);
    for (const key of caveKeys) {
      expect(byKey.get(key)).toMatchObject({
        dimension: "overworld",
        category: "cave",
        requiresY: true,
        vertical: true,
        surfaceClimate: false,
        surfaceMap: false,
        searchable: true,
        yRange: {
          min: -64,
          max: 319,
          sourcePath: "data/minecraft/dimension_type/overworld.json",
        },
      });
    }

    expect(byKey.get("sulfur_caves")).toMatchObject({
      id: "minecraft:sulfur_caves",
      key: "sulfur_caves",
      name: "Sulfur Caves",
      effects: {
        waterColor: "#34bf89",
        waterFogColor: "#17543c",
        fogColor: "#8cb831",
        skyColor: "#78a7ff",
        grassColor: "#aba64f",
      },
      sourcePath: "data/minecraft/worldgen/biome/sulfur_caves.json",
    });
    expect((byKey.get("sulfur_caves")?.raw as { features?: JsonValue[] }).features?.[1]).toContain("minecraft:sulfur_pool");
    expect(JSON.stringify(byKey.get("sulfur_caves")?.raw)).toContain("minecraft:sulfur_cube");

    expect(byKey.get("plains")).toMatchObject({
      placement: "surface",
      requiresY: false,
      surfaceClimate: true,
      surfaceMap: true,
      searchable: true,
    });
    expect(byKey.get("plains")?.yRange).toBeUndefined();

    expect(byKey.get("the_void")).toMatchObject({
      dimension: "end",
      category: "special",
      placement: "special",
      requiresY: false,
      surfaceClimate: false,
      surfaceMap: false,
      searchable: false,
    });
    expect(byKey.get("nether_wastes")?.placement).toBe("nether");
    expect(byKey.get("the_end")?.placement).toBe("end");
  });
});

function minimalBiome(): Record<string, JsonValue> {
  return {
    temperature: 0.8,
    downfall: 0.4,
    has_precipitation: true,
    effects: { water_color: "#3f76e4" },
    attributes: { "minecraft:visual/sky_color": "#78a7ff" },
    features: [],
    spawners: {},
  };
}

function biomeTags(): TagDefinition[] {
  return [
    tag("is_overworld", ["plains", "deep_dark", "dripstone_caves", "lush_caves", "sulfur_caves"]),
    tag("is_nether", ["nether_wastes"]),
    tag("is_end", ["the_end"]),
  ];
}

function tag(id: string, values: string[]): TagDefinition {
  return {
    id: `minecraft:biome/${id}`,
    registry: "worldgen",
    replace: false,
    values: values.map((value) => `minecraft:${value}`),
    sourcePath: `data/minecraft/tags/worldgen/biome/${id}.json`,
    raw: {},
  };
}

function translations(): TranslationEntry[] {
  return [{ key: "biome.minecraft.sulfur_caves", value: "Sulfur Caves" }];
}
