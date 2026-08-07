import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { createConsoleLogger } from "../src/core/logger.js";
import { FishingMechanicsExtractor } from "../src/extraction/fishingMechanicsExtractor.js";
import type { FishingMechanics } from "../src/domain/types.js";
import {
  buildFishingOddsDataset,
  buildLootOddsDataset,
  loadLootOddsData,
  type FishingOddsDataset,
  type LootOddsCell,
  type LootOddsDataset,
  type LootOddsItem,
  type LootOddsTable,
} from "../src/extraction/lootOdds/index.js";

/**
 * Both inputs live under the gitignored workspace, so this suite only runs where 26.2 has actually
 * been prepared: the dataset sidecars for the loot tables, the decompiled client for the mechanics.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_DIR = join(ROOT, "workspace", "datasets", "26.2");
const CLIENT_ROOT = join(ROOT, "workspace", "versions", "26.2", "decompiled", "client");
const HAS_WORKSPACE =
  existsSync(join(DATASET_DIR, "loot-tables.json")) &&
  existsSync(join(CLIENT_ROOT, "net/minecraft/world/entity/projectile/FishingHook.java"));

/** Loose enough for double-precision accumulation, tight enough to catch a wrong formula. */
const EXACT = 1e-12;

function itemOf(items: LootOddsItem[] | undefined, itemId: string): LootOddsItem {
  const found = items?.find((item) => item.itemId === itemId);
  if (!found) throw new Error(`no item ${itemId} in [${(items ?? []).map((item) => item.itemId).join(", ")}]`);
  return found;
}

function tableOf(tables: LootOddsTable[], name: string): LootOddsTable {
  const found = tables.find((table) => table.name === name);
  if (!found) throw new Error(`no table ${name}`);
  return found;
}

function cellFor(table: LootOddsTable, looting: number, killedByPlayer?: boolean): LootOddsCell {
  const found = table.cells.find((cell) =>
    cell.contexts.some(
      (context) => context.looting === looting && (killedByPlayer === undefined || context.killedByPlayer === killedByPlayer),
    ),
  );
  if (!found) throw new Error(`no cell for looting ${looting} on ${table.tableId}`);
  return found;
}

describe.runIf(HAS_WORKSPACE)("odds datasets (26.2)", () => {
  let fishing: FishingOddsDataset;
  let loot: LootOddsDataset;
  let mechanics: FishingMechanics;

  beforeAll(async () => {
    const data = await loadLootOddsData(DATASET_DIR);
    const extracted = await new FishingMechanicsExtractor(createConsoleLogger(false)).extract(CLIENT_ROOT);
    expect(extracted).toBeDefined();
    mechanics = extracted as FishingMechanics;
    fishing = buildFishingOddsDataset({ data, mechanics });
    loot = buildLootOddsDataset({ data });
  });

  describe("fishing category odds", () => {
    test("a bare rod in open water is the vanilla 85 / 10 / 5 split", () => {
      const cell = fishing.oddsGrid.cells.find((entry) => entry.luck === 0 && entry.inOpenWater);
      const byName = new Map(cell?.categories.map((category) => [category.name, category]));
      expect(byName.get("fish")?.probability).toBeCloseTo(0.85, 12);
      expect(byName.get("junk")?.probability).toBeCloseTo(0.1, 12);
      expect(byName.get("treasure")?.probability).toBeCloseTo(0.05, 12);
      expect(byName.get("fish")?.effectiveWeight).toBe(85);
      expect(byName.get("junk")?.effectiveWeight).toBe(10);
      expect(byName.get("treasure")?.effectiveWeight).toBe(5);
    });

    test("Luck of the Sea III reweights the pool to 82 / 4 / 11 out of 97", () => {
      const cell = fishing.oddsGrid.cells.find((entry) => entry.luck === 3 && entry.inOpenWater);
      const byName = new Map(cell?.categories.map((category) => [category.name, category]));
      // max(floor(weight + quality * luck), 0): fish 85-3, junk 10-6, treasure 5+6.
      expect(byName.get("fish")?.effectiveWeight).toBe(82);
      expect(byName.get("junk")?.effectiveWeight).toBe(4);
      expect(byName.get("treasure")?.effectiveWeight).toBe(11);
      expect(byName.get("fish")?.probability).toBeCloseTo(82 / 97, 12);
      expect(byName.get("junk")?.probability).toBeCloseTo(4 / 97, 12);
      expect(byName.get("treasure")?.probability).toBeCloseTo(11 / 97, 12);
      // The published percentages a guide renders.
      expect(((byName.get("fish")?.probability ?? 0) * 100).toFixed(3)).toBe("84.536");
      expect(((byName.get("junk")?.probability ?? 0) * 100).toFixed(3)).toBe("4.124");
      expect(((byName.get("treasure")?.probability ?? 0) * 100).toFixed(3)).toBe("11.340");
    });

    test("closed water zeroes treasure and re-normalises over the remaining 95 weight", () => {
      const cell = fishing.oddsGrid.cells.find((entry) => entry.luck === 0 && !entry.inOpenWater);
      const byName = new Map(cell?.categories.map((category) => [category.name, category]));
      // The entry stays in the pool with its weight intact; its condition just never passes.
      expect(byName.get("treasure")?.effectiveWeight).toBe(5);
      expect(byName.get("treasure")?.probability).toBe(0);
      expect(byName.get("junk")?.probability).toBeCloseTo(10 / 95, 12);
      expect(byName.get("fish")?.probability).toBeCloseTo(85 / 95, 12);
      const total = (cell?.categories ?? []).reduce((sum, category) => sum + category.probability, 0);
      expect(total).toBeCloseTo(1, 12);
    });
  });

  test("treasure carries the enchanting metadata a guide needs", () => {
    const cell = fishing.oddsGrid.cells.find((entry) => entry.luck === 0 && entry.inOpenWater);
    const book = itemOf(cell?.items, "minecraft:enchanted_book");
    // 5% treasure, one of six treasure entries.
    expect(book.probability).toBeCloseTo(0.05 / 6, 12);
    const roll = book.enchantments?.[0];
    expect(roll?.source).toBe("enchant_with_levels");
    expect(roll?.levels).toEqual({ min: 30, max: 30, expected: 30 });
    expect(roll?.possibleEnchantments).toContain("minecraft:mending");
    expect(book.displayName).toBe("Enchanted Book");
  });

  test("the timing model pins the unenchanted, fair-weather cycle", () => {
    const row = fishing.timing.rows.find((entry) => entry.lureLevel === 0 && entry.combination === "clearSkyVisible");
    // Wait roll averages 350 ticks and never re-rolls, plus the tick that sets it.
    expect(row?.expectedWaitTicks).toBe(351);
    expect(row?.expectedApproachTicks).toBe(50);
    expect(row?.expectedCycleSeconds).toBe(20.05);
    expect(row?.expectedCatchesPerHour).toBe(179.55);
    expect(fishing.timing.expectedXpPerCatch).toBe(3.5);

    // Lure III discards every roll of 300 ticks or less: 201 of the 501 outcomes.
    const lure3 = fishing.timing.rows.find((entry) => entry.lureLevel === 3 && entry.combination === "clearSkyVisible");
    expect(lure3?.rerollChance).toBeCloseTo(201 / 501, 6);
    expect(lure3?.expectedCycleSeconds).toBeLessThan(row?.expectedCycleSeconds ?? 0);

    // An obstructed sky halves the countdown rate, so everything takes twice as long.
    const covered = fishing.timing.rows.find((entry) => entry.lureLevel === 0 && entry.combination === "clearSkyObstructed");
    expect(covered?.expectedApproachTicks).toBe(100);
    expect(covered?.expectedCycleSeconds).toBe(40.05);
  });

  test("every scenario points at the grid cell it claims", () => {
    expect(fishing.scenarios.length).toBeGreaterThan(0);
    for (const scenario of fishing.scenarios) {
      const cell = fishing.oddsGrid.cells[scenario.gridIndex];
      expect(cell).toBeDefined();
      expect(cell?.luck).toBe(scenario.luck);
      expect(cell?.inOpenWater).toBe(scenario.inOpenWater);
      expect(scenario.categories).toEqual(cell?.categories);
    }

    const bare = fishing.scenarios.find((scenario) => scenario.id === "no_enchants_open_water");
    expect(bare?.luck).toBe(0);
    const enchanted = fishing.scenarios.find((scenario) => scenario.id === "lots_3_luck_1_open_water");
    expect(enchanted?.luck).toBe(4);
    expect(enchanted?.lotsLevel).toBe(3);
    expect(enchanted?.luckPotionLevel).toBe(1);
    expect(enchanted?.luckPotionAmplifier).toBe(0);
  });

  test("the mechanics block still parses cleanly, warnings and all", () => {
    expect(mechanics.warnings).toEqual([]);
    expect(fishing.timing.warnings).toEqual([]);
    // The approach timer shares the wait countdown's decrement, which the timing model relies on.
    expect(mechanics.hookWindow.approachDecrementVariable).toBe(mechanics.waitTime.countdownVariable);
    expect(mechanics.hookWindow.nibbleDecrementPerTick).toBe(1);
  });

  test("bartering is reported per gold ingot", () => {
    const obsidian = loot.bartering.items.find((item) => item.itemId === "minecraft:crying_obsidian");
    if (!obsidian) throw new Error("no crying obsidian in the bartering section");
    expect(obsidian.probability).toBeCloseTo(0.085288, 6);
    expect(obsidian.expectedCountPerIngot).toBeCloseTo(0.170576, 6);
    expect(obsidian.expectedIngotsPerItem).toBeCloseTo(1 / obsidian.expectedCountPerIngot, 3);
    // Bartering always hands back exactly one stack, so the per-item probabilities sum to one.
    const total = loot.bartering.items.reduce((sum, item) => sum + item.probability, 0);
    expect(total).toBeCloseTo(1, 9);
  });

  test("a chest reports the probability of at least one, plus the count summary", () => {
    const chest = tableOf(loot.chests, "spawn_bonus_chest");
    const axe = itemOf(chest.cells[0]?.items, "minecraft:wooden_axe");
    expect(axe.probability).toBeCloseTo(0.75, 12);
    expect(axe.count).toEqual({ min: 1, max: 1, expected: 1 });

    const apple = itemOf(chest.cells[0]?.items, "minecraft:apple");
    expect(apple.count.min).toBe(1);
    expect(apple.count.max).toBe(6);
    // Expected count is unconditional; the count summary is conditioned on the item dropping at all.
    expect(apple.expectedCount).toBeCloseTo(apple.probability * apple.count.expected, 9);
  });

  test("looting raises mob drops, and player kills unlock the gated pools", () => {
    const zombie = tableOf(loot.mobDrops, "zombie");
    const looting0 = itemOf(cellFor(zombie, 0, false).items, "minecraft:rotten_flesh");
    const looting3 = itemOf(cellFor(zombie, 3, false).items, "minecraft:rotten_flesh");
    // set_count uniform 0..2 plus enchanted_count_increase uniform 0..1 per level.
    expect(looting0.expectedCount).toBeCloseTo(1, 12);
    expect(looting3.expectedCount).toBeCloseTo(2.5, 12);
    expect(looting3.probability).toBeGreaterThan(looting0.probability);

    // The iron ingot pool is behind minecraft:killed_by_player, so it only exists in the player cell.
    expect(cellFor(zombie, 0, false).items.some((item) => item.itemId === "minecraft:iron_ingot")).toBe(false);
    expect(itemOf(cellFor(zombie, 0, true).items, "minecraft:iron_ingot").probability).toBeGreaterThan(0);

    // A table the flag cannot change publishes contexts without it rather than duplicating cells.
    const bat = tableOf(loot.mobDrops, "bat");
    expect(bat.cells.every((cell) => cell.contexts.every((context) => context.killedByPlayer === undefined))).toBe(true);
  });

  test("every published row is a real probability with a display name", () => {
    const sections: LootOddsTable[] = [...loot.archaeology, ...loot.gifts, ...loot.mobDrops, ...loot.chests];
    let checked = 0;

    const sweep = (items: LootOddsItem[], where: string) => {
      for (const item of items) {
        expect(item.probability, `${where} ${item.itemId} probability`).toBeGreaterThanOrEqual(0);
        expect(item.probability, `${where} ${item.itemId} probability`).toBeLessThanOrEqual(1 + EXACT);
        expect(item.expectedCount, `${where} ${item.itemId} expectedCount`).toBeGreaterThanOrEqual(0);
        expect(item.count.min, `${where} ${item.itemId} count`).toBeLessThanOrEqual(item.count.max);
        expect(item.displayName.length, `${where} ${item.itemId} displayName`).toBeGreaterThan(0);
        checked += 1;
      }
    };

    for (const table of sections) {
      for (const cell of table.cells) sweep(cell.items, table.tableId);
    }
    sweep(loot.bartering.items, loot.bartering.tableId);
    for (const cell of fishing.oddsGrid.cells) sweep(cell.items as LootOddsItem[], "fishing");

    expect(checked).toBeGreaterThan(1000);
  });

  test("the sections cover what the pipeline promises", () => {
    expect(loot.fishing.tableId).toBe("minecraft:gameplay/fishing");
    expect(loot.lootingLevels).toEqual([0, 1, 2, 3]);
    expect(loot.archaeology.length).toBeGreaterThan(0);
    expect(loot.chests.length).toBeGreaterThan(0);
    expect(loot.mobDrops.length).toBeGreaterThan(0);
    // Fishing keeps its own file, so it must not leak into the gifts section.
    expect(loot.gifts.some((table) => table.tableId.startsWith("minecraft:gameplay/fishing"))).toBe(false);
    expect(loot.gifts.some((table) => table.name === "cat_morning_gift")).toBe(true);
    expect(loot.gifts.some((table) => table.name === "sniffer_digging")).toBe(true);
    expect(loot.gifts.some((table) => table.name === "armorer_gift")).toBe(true);
  });
});
