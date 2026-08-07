import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import {
  computeFishingOdds,
  createLootOddsData,
  effectiveWeight,
  evaluateLootTable,
  findFishingCell,
  loadLootOddsData,
  type LootOddsData,
  type LootOutcome,
} from "../src/extraction/lootOdds/index.js";

const DATASET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "workspace", "datasets", "26.2");
const HAS_DATASET = existsSync(join(DATASET_DIR, "loot-tables.json"));

/** Loose enough for double-precision accumulation, tight enough to catch a wrong formula. */
const EXACT = 1e-12;

function item(outcomes: LootOutcome[], itemId: string): LootOutcome {
  const found = outcomes.find((outcome) => outcome.itemId === itemId);
  if (!found) throw new Error(`no outcome for ${itemId} in [${outcomes.map((o) => o.itemId).join(", ")}]`);
  return found;
}

function category(categories: Array<{ name: string; probability: number; effectiveWeight: number }>, name: string) {
  const found = categories.find((entry) => entry.name === name);
  if (!found) throw new Error(`no category ${name}`);
  return found;
}

describe("effective weight formula", () => {
  // LootPoolSingletonContainer.EntryBase:
  //   return Math.max(Mth.floor(weight + quality * luck), 0);
  test("floors the sum and clamps at zero", () => {
    expect(effectiveWeight(10, -2, 0)).toBe(10);
    expect(effectiveWeight(10, -2, 3)).toBe(4);
    expect(effectiveWeight(5, 2, 3)).toBe(11);
    expect(effectiveWeight(85, -1, 3)).toBe(82);
    // Luck 5 wipes junk out entirely: floor(10 - 10) = 0, and LootPool keeps only weight > 0.
    expect(effectiveWeight(10, -2, 5)).toBe(0);
    expect(effectiveWeight(10, -2, 9)).toBe(0);
    // Fractional luck floors the whole sum, not `quality * luck` on its own.
    expect(effectiveWeight(10, -2, 0.75)).toBe(8);
    expect(effectiveWeight(10, 3, 0.5)).toBe(11);
  });
});

describe("synthetic loot tables", () => {
  const data = createLootOddsData({
    lootTables: [
      {
        id: "test:coin_flip",
        type: "minecraft:chest",
        raw: {
          pools: [
            {
              rolls: 3,
              entries: [
                { type: "minecraft:item", name: "test:gold", weight: 1 },
                { type: "minecraft:item", name: "test:silver", weight: 3 },
              ],
            },
          ],
        },
      },
      {
        id: "test:alternatives",
        type: "minecraft:block",
        raw: {
          pools: [
            {
              rolls: 1,
              entries: [
                {
                  type: "minecraft:alternatives",
                  children: [
                    {
                      type: "minecraft:item",
                      name: "test:rare",
                      conditions: [{ condition: "minecraft:random_chance", chance: 0.25 }],
                    },
                    { type: "minecraft:item", name: "test:common" },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  });

  test("multi-roll convolution gives exact counts and an exact at-least-one", () => {
    const odds = evaluateLootTable("test:coin_flip", { data });
    const gold = item(odds.items, "test:gold");
    // p = 1/4 per roll, 3 rolls: P(>=1) = 1 - (3/4)^3, E = 3/4.
    expect(gold.probability).toBeCloseTo(1 - 0.75 ** 3, 12);
    expect(gold.expectedCount).toBeCloseTo(0.75, 12);
    expect(gold.probabilityPerRoll).toBeCloseTo(0.25, 12);
    // Exact binomial(3, 1/4) tail.
    expect(gold.countDistribution).toEqual([
      [1, expect.closeTo(3 * 0.25 * 0.75 ** 2, 12)],
      [2, expect.closeTo(3 * 0.25 ** 2 * 0.75, 12)],
      [3, expect.closeTo(0.25 ** 3, 12)],
    ]);
  });

  test("alternatives stops at the first child that expands, so the fallback only fires when the chance fails", () => {
    // AlternativesEntry.compose: `for (entry : entries) if (entry.expand(...)) return true;`
    // A 25% random_chance on the first child means the second child is the only
    // entry in the pool 75% of the time -- never both at once.
    const odds = evaluateLootTable("test:alternatives", { data });
    expect(item(odds.items, "test:rare").probability).toBeCloseTo(0.25, 12);
    expect(item(odds.items, "test:common").probability).toBeCloseTo(0.75, 12);
  });
});

describe.skipIf(!HAS_DATASET)("loot odds against the real 26.2 dataset", () => {
  let data: LootOddsData;

  beforeAll(async () => {
    data = await loadLootOddsData(DATASET_DIR);
  });

  test("fishing at luck 0 in open water is an exact 10 / 5 / 85 split", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 0, inOpenWater: true });

    const pool = odds.pools[0];
    expect(pool?.totalWeight).toBe(100);
    expect(pool?.totalWeightExact).toBe(true);
    expect(pool?.rollsDistribution).toEqual([[1, 1]]);

    expect(category(odds.categories, "junk").probability).toBeCloseTo(0.1, 12);
    expect(category(odds.categories, "treasure").probability).toBeCloseTo(0.05, 12);
    expect(category(odds.categories, "fish").probability).toBeCloseTo(0.85, 12);

    // Everything the table can hand you sums to exactly 1: the pool always drops something.
    const total = odds.items.reduce((sum, outcome) => sum + outcome.probability, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  test("fishing outside open water drops treasure and renormalises junk and fish", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 0, inOpenWater: false });

    // Treasure's `entity_properties` condition fails, so the pool total is 10 + 85 = 95.
    expect(odds.pools[0]?.totalWeight).toBe(95);
    expect(category(odds.categories, "treasure").probability).toBe(0);
    expect(category(odds.categories, "junk").probability).toBeCloseTo(10 / 95, 12);
    expect(category(odds.categories, "fish").probability).toBeCloseTo(85 / 95, 12);

    // No treasure-only item can appear at all.
    expect(odds.items.some((outcome) => outcome.itemId === "minecraft:nautilus_shell")).toBe(false);
    expect(odds.items.some((outcome) => outcome.itemId === "minecraft:enchanted_book")).toBe(false);

    // Cod: 85/95 of the fish table, then 60/100 inside it.
    expect(item(odds.items, "minecraft:cod").probability).toBeCloseTo((85 / 95) * 0.6, 12);
  });

  test("fishing at Luck of the Sea III uses the exact luck-adjusted weights", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 3, inOpenWater: true });

    // max(floor(weight + quality * 3), 0): junk 10-6=4, treasure 5+6=11, fish 85-3=82.
    expect(category(odds.categories, "junk").effectiveWeight).toBe(4);
    expect(category(odds.categories, "treasure").effectiveWeight).toBe(11);
    expect(category(odds.categories, "fish").effectiveWeight).toBe(82);
    expect(odds.pools[0]?.totalWeight).toBe(97);

    expect(category(odds.categories, "junk").probability).toBeCloseTo(4 / 97, 12);
    expect(category(odds.categories, "treasure").probability).toBeCloseTo(11 / 97, 12);
    expect(category(odds.categories, "fish").probability).toBeCloseTo(82 / 97, 12);
  });

  test("junk vanishes entirely once luck reaches 5", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 5, inOpenWater: true });
    // floor(10 - 2*5) = 0, and LootPool.addRandomItem only keeps entries with weight > 0.
    expect(category(odds.categories, "junk").effectiveWeight).toBe(0);
    expect(category(odds.categories, "junk").probability).toBe(0);
    expect(odds.pools[0]?.totalWeight).toBe(95);
    expect(category(odds.categories, "treasure").probability).toBeCloseTo(15 / 95, 12);
  });

  test("the fish subtable weights flow through to per-item odds", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 0, inOpenWater: true });
    // fish subtable: cod 60, salmon 25, pufferfish 13, tropical_fish 2 = 100 total.
    expect(item(odds.items, "minecraft:cod").probability).toBeCloseTo(0.85 * 0.6, 12);
    expect(item(odds.items, "minecraft:salmon").probability).toBeCloseTo(0.85 * 0.25, 12);
    expect(item(odds.items, "minecraft:pufferfish").probability).toBeCloseTo(0.85 * 0.13, 12);
    expect(item(odds.items, "minecraft:tropical_fish").probability).toBeCloseTo(0.85 * 0.02, 12);

    const pufferfish = item(odds.outcomes, "minecraft:pufferfish");
    expect(pufferfish.tablePath).toEqual(["minecraft:gameplay/fishing", "minecraft:gameplay/fishing/fish"]);
    expect(pufferfish.count).toEqual({ min: 1, max: 1, expected: 1 });
  });

  test("the junk table's weightless ink sac still drops ten at a time", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 0, inOpenWater: true });
    // No `weight` field means weight 1 (LootPoolSingletonContainer.DEFAULT_WEIGHT); junk totals 110.
    const inkSac = item(odds.items, "minecraft:ink_sac");
    expect(inkSac.probability).toBeCloseTo(0.1 * (1 / 110), 12);
    expect(inkSac.count).toEqual({ min: 10, max: 10, expected: 10 });
    expect(inkSac.expectedCount).toBeCloseTo(10 * 0.1 * (1 / 110), 12);
  });

  test("treasure books become enchanted books with level-30 enchant metadata", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 0, inOpenWater: true });

    // EnchantmentHelper.enchantItem swaps BOOK for ENCHANTED_BOOK, so `minecraft:book` never drops.
    expect(odds.items.some((outcome) => outcome.itemId === "minecraft:book")).toBe(false);

    const book = item(odds.items, "minecraft:enchanted_book");
    // Treasure has six weightless entries, so each is 1/6 of the 5% treasure slice.
    expect(book.probability).toBeCloseTo(0.05 / 6, 12);

    const enchant = book.enchantments?.[0];
    expect(enchant?.source).toBe("enchant_with_levels");
    expect(enchant?.levels).toEqual({ min: 30, max: 30, expected: 30 });
    expect(enchant?.possibleEnchantments.length).toBeGreaterThan(0);
    // `#minecraft:on_random_loot` folds in `#minecraft:non_treasure` plus the treasure extras.
    expect(enchant?.possibleEnchantments).toContain("minecraft:mending");
    expect(enchant?.possibleEnchantments).toContain("minecraft:luck_of_the_sea");
    expect(enchant?.possibleEnchantments).toContain("minecraft:sharpness");
    expect(enchant?.possibleEnchantments).not.toContain("minecraft:swift_sneak");
  });

  test("set_damage is reported as durability consumed, not the raw inverted field", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 0, inOpenWater: false });
    // Junk rods roll `damage` uniform [0, 0.9); the function keeps that fraction of durability,
    // so the rod comes out 10%-100% used.
    const rod = item(odds.items, "minecraft:fishing_rod");
    expect(rod.damage?.minDamageFraction).toBeCloseTo(0.1, 12);
    expect(rod.damage?.maxDamageFraction).toBeCloseTo(1, 12);
    expect(rod.damage?.maxDurability).toBe(64);
  });

  test("unresolved conditions are surfaced, never silently dropped", () => {
    const odds = evaluateLootTable("minecraft:gameplay/fishing", { data, luck: 0, inOpenWater: true });
    const bamboo = item(odds.items, "minecraft:bamboo");
    // The jungle `location_check` cannot be answered without a biome, so it is
    // treated as passing and flagged.
    expect(bamboo.unresolvedConditions.some((signature) => signature.startsWith("minecraft:location_check"))).toBe(true);
    expect(odds.warnings.some((warning) => warning.includes("minecraft:location_check"))).toBe(true);

    // Pin it down with a biome and the entry disappears.
    const outsideJungle = evaluateLootTable("minecraft:gameplay/fishing", {
      data,
      luck: 0,
      inOpenWater: true,
      biome: "minecraft:plains",
    });
    expect(outsideJungle.items.some((outcome) => outcome.itemId === "minecraft:bamboo")).toBe(false);
    // Junk now totals 100 rather than 110, so lily pads get more common.
    expect(item(outsideJungle.items, "minecraft:lily_pad").probability).toBeCloseTo(0.1 * (17 / 100), 12);
  });

  test("creeper drops model looting exactly, including the rounding at the range endpoints", () => {
    const odds = evaluateLootTable("minecraft:entities/creeper", {
      data,
      killedByPlayer: true,
      enchantmentLevels: { "minecraft:looting": 3 },
    });
    const gunpowder = item(odds.items, "minecraft:gunpowder");

    // set_count uniform 0..2 -> 1/3 each.
    // enchanted_count_increase count uniform [0,1) scaled by level 3 then Math.round'ed:
    // 0 -> 1/6, 1 -> 1/3, 2 -> 1/3, 3 -> 1/6 (endpoints get half weight, they are not 1/4 each).
    const base = [1 / 3, 1 / 3, 1 / 3];
    const bonus = [1 / 6, 1 / 3, 1 / 3, 1 / 6];
    const expected = new Array<number>(6).fill(0);
    for (let a = 0; a < base.length; a += 1) {
      for (let b = 0; b < bonus.length; b += 1) {
        expected[a + b] = (expected[a + b] ?? 0) + (base[a] as number) * (bonus[b] as number);
      }
    }
    expect(gunpowder.probability).toBeCloseTo(1 - (expected[0] as number), 12);
    expect(gunpowder.expectedCount).toBeCloseTo(1 + 1.5, 12);
    for (const [count, probability] of gunpowder.countDistribution) {
      expect(probability).toBeCloseTo(expected[count] as number, 12);
    }

    // The `expand: true` music-disc tag becomes twelve equally weighted entries
    // in the second pool, gated by an unresolved "killed by a skeleton" check.
    const disc = item(odds.items, "minecraft:music_disc_13");
    expect(disc.probability).toBeCloseTo(1 / 12, 12);
    expect(disc.unresolvedConditions.some((signature) => signature.startsWith("minecraft:entity_properties"))).toBe(true);

    // Nothing at all when a skeleton definitely did not do the killing.
    const noSkeleton = evaluateLootTable("minecraft:entities/creeper", {
      data,
      unresolvedConditionsPass: false,
    });
    expect(noSkeleton.items.some((outcome) => outcome.itemId === "minecraft:music_disc_13")).toBe(false);
  });

  test("looting does nothing without the enchantment", () => {
    const odds = evaluateLootTable("minecraft:entities/creeper", { data });
    const gunpowder = item(odds.items, "minecraft:gunpowder");
    expect(gunpowder.expectedCount).toBeCloseTo(1, 12);
    expect(gunpowder.probability).toBeCloseTo(2 / 3, 12);
  });

  test("desert pyramid multi-roll pools convolve to exact counts", () => {
    const odds = evaluateLootTable("minecraft:chests/desert_pyramid", { data });

    // Pool 1: five entries at weight 10 each, exactly 4 rolls, set_count uniform 1..8.
    const sand = item(odds.items, "minecraft:sand");
    expect(sand.poolIndices).toEqual([1]);
    expect(sand.probabilityPerRoll).toBeCloseTo(0.2, 12);
    expect(sand.probability).toBeCloseTo(1 - 0.8 ** 4, 12); // 0.5904
    expect(sand.expectedCount).toBeCloseTo(4 * 0.2 * 4.5, 12); // 3.6
    expect(sand.count.min).toBe(1);
    expect(sand.count.max).toBe(32); // four rolls of up to eight

    // Pool 0: rolls uniform 2..4 over a 247-weight pool, spider eyes at weight 25.
    const spiderEye = item(odds.items, "minecraft:spider_eye");
    const perRoll = 25 / 247;
    const noneInPool = ((1 - perRoll) ** 2 + (1 - perRoll) ** 3 + (1 - perRoll) ** 4) / 3;
    expect(odds.pools[0]?.totalWeight).toBe(247);
    expect(odds.pools[0]?.rolls).toEqual({ min: 2, max: 4, expected: 3 });
    expect(spiderEye.probabilityPerRoll).toBeCloseTo(perRoll, 12);
    expect(spiderEye.probability).toBeCloseTo(1 - noneInPool, 12);
    expect(spiderEye.expectedCount).toBeCloseTo(3 * perRoll * 2, 12);

    // Bones come from both pools; the flattened row combines them correctly
    // (independent across pools, mutually exclusive within a roll).
    const bone = item(odds.items, "minecraft:bone");
    expect(bone.poolIndices).toEqual([0, 1]);
    expect(bone.probabilityPerRoll).toBeUndefined();
    expect(bone.probability).toBeCloseTo(1 - noneInPool * 0.8 ** 4, 12);
    expect(bone.expectedCount).toBeCloseTo(3 * perRoll * 5 + 4 * 0.2 * 4.5, 12);

    // The `minecraft:empty` entry means a roll can produce nothing at all.
    const totalPerRoll = odds.pools[0]?.entries.reduce((sum, entry) => sum + entry.probabilityPerRoll, 0) ?? 0;
    expect(totalPerRoll).toBeCloseTo(1, 12);
    expect(odds.warnings).toEqual([]);
  });

  test("computeFishingOdds covers Bad Luck through Luck of the Sea III and beyond", () => {
    const odds = computeFishingOdds(data);
    expect(odds.luckValues).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(odds.cells).toHaveLength(30);

    const baseline = findFishingCell(odds, 0, true);
    expect(category(baseline?.categories ?? [], "junk").probability).toBeCloseTo(0.1, 12);
    expect(category(baseline?.categories ?? [], "treasure").probability).toBeCloseTo(0.05, 12);
    expect(category(baseline?.categories ?? [], "fish").probability).toBeCloseTo(0.85, 12);

    const lots3 = findFishingCell(odds, 3, true);
    expect(category(lots3?.categories ?? [], "treasure").probability).toBeCloseTo(11 / 97, 12);

    // Bad Luck II: junk floor(10 + 8) = 18, treasure floor(5 - 8) -> 0, fish floor(85 + 4) = 89.
    const unlucky = findFishingCell(odds, -4, true);
    expect(category(unlucky?.categories ?? [], "junk").effectiveWeight).toBe(18);
    expect(category(unlucky?.categories ?? [], "treasure").effectiveWeight).toBe(0);
    expect(category(unlucky?.categories ?? [], "fish").effectiveWeight).toBe(89);
    expect(category(unlucky?.categories ?? [], "junk").probability).toBeCloseTo(18 / 107, 12);

    // Closed water never yields treasure, at any luck.
    for (const cell of odds.cells.filter((entry) => !entry.inOpenWater)) {
      expect(category(cell.categories, "treasure").probability).toBe(0);
      const total = cell.items.reduce((sum, outcome) => sum + outcome.probability, 0);
      expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    }
  });

  test("every fishing cell keeps its probabilities normalised", () => {
    const odds = computeFishingOdds(data, { context: { biome: "minecraft:plains" } });
    for (const cell of odds.cells) {
      const total = cell.categories.reduce((sum, entry) => sum + entry.probability, 0);
      expect(Math.abs(total - 1)).toBeLessThan(EXACT * 1e3);
      expect(cell.warnings).toEqual([]);
    }
  });
});
