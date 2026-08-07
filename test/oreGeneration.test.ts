import { describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import type { BiomeDefinition, JsonValue } from "../src/domain/types.js";
import { buildOreGeneration } from "../src/extraction/oreGeneration.js";

describe("ore generation extraction", () => {
  test("derives the exact triangular Y curve and a bedrock-aware recommendation", async () => {
    const entries: Record<string, string> = {
      "data/minecraft/worldgen/noise_settings/overworld.json": JSON.stringify({
        noise: { min_y: -64, height: 384 },
        surface_rule: {
          type: "minecraft:vertical_gradient",
          random_name: "minecraft:bedrock_floor",
          true_at_and_below: { above_bottom: 0 },
          false_at_and_above: { above_bottom: 5 },
        },
      }),
      "data/minecraft/worldgen/configured_feature/ore_diamond.json": JSON.stringify({
        type: "minecraft:ore",
        config: {
          size: 4,
          discard_chance_on_air_exposure: 0.5,
          targets: [
            {
              target: { tag: "minecraft:stone_ore_replaceables" },
              state: { Name: "minecraft:diamond_ore" },
            },
            {
              target: { tag: "minecraft:deepslate_ore_replaceables" },
              state: { Name: "minecraft:deepslate_diamond_ore" },
            },
          ],
        },
      }),
      "data/minecraft/worldgen/placed_feature/ore_diamond.json": JSON.stringify({
        feature: "minecraft:ore_diamond",
        placement: [
          { type: "minecraft:count", count: 7 },
          {
            type: "minecraft:height_range",
            height: {
              type: "minecraft:trapezoid",
              min_inclusive: { above_bottom: -80 },
              max_inclusive: { above_bottom: 80 },
              plateau: 0,
            },
          },
        ],
      }),
    };
    const source = new InMemoryArchiveSource(entries);
    const dataset = await buildOreGeneration(Object.keys(entries), source, [biome("plains", "ore_diamond")]);

    expect(dataset.warnings).toEqual([]);
    expect(dataset.dimensions[0]).toMatchObject({
      id: "overworld",
      minY: -64,
      maxY: 319,
      bedrockFloorFreeAtOrAbove: -59,
    });
    expect(dataset.features[0]).toMatchObject({
      id: "minecraft:ore_diamond",
      resourceId: "minecraft:diamond",
      veinSize: 4,
      discardChanceOnAirExposure: 0.5,
      configuredAttemptsPerChunk: 7,
      height: { type: "trapezoid", minInclusive: -144, maxInclusive: 16, plateau: 0 },
    });

    const diamond = dataset.ores.find((ore) => ore.id === "minecraft:diamond");
    expect(diamond?.contexts).toHaveLength(1);
    expect(diamond?.contexts[0]).toMatchObject({
      id: "overworld/default",
      bestY: -64,
      bestYRange: { min: -64, max: -64 },
      recommendedY: -59,
      recommendedYRange: { min: -59, max: -59 },
    });
    expect(diamond?.contexts[0]?.curve.find((point) => point.y === -64)?.expectedPlacementsPerChunk).toBeGreaterThan(
      diamond?.contexts[0]?.curve.find((point) => point.y === -59)?.expectedPlacementsPerChunk ?? 0,
    );
  });
});

function biome(key: string, feature: string): BiomeDefinition {
  return {
    id: `minecraft:${key}`,
    key,
    name: "Plains",
    dimension: "overworld",
    category: "plains",
    placement: "surface",
    requiresY: false,
    vertical: false,
    surfaceClimate: true,
    surfaceMap: true,
    searchable: true,
    temperature: 0.8,
    hasPrecipitation: true,
    effects: {},
    tags: [],
    sourcePath: `data/minecraft/worldgen/biome/${key}.json`,
    raw: { features: [[`minecraft:${feature}`]] } satisfies JsonValue,
  };
}
