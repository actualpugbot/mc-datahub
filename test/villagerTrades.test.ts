import { describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { buildVillagerTrades } from "../src/extraction/villagerTrades.js";

describe("villager trade extraction", () => {
  test("joins nested tags, trade sets, offers, names, and selection odds", async () => {
    const entries = {
      "data/minecraft/villager_trade/smith/1/coal_emerald.json": JSON.stringify({
        wants: { id: "minecraft:coal", count: 15 },
        gives: { id: "minecraft:emerald" },
        max_uses: 16,
        xp: 2,
        reputation_discount: 0.05,
      }),
      "data/minecraft/villager_trade/armorer/1/emerald_iron_helmet.json": JSON.stringify({
        wants: { id: "minecraft:emerald", count: 5 },
        gives: { id: "minecraft:iron_helmet" },
        max_uses: 12,
      }),
      "data/minecraft/tags/villager_trade/common_smith/level_1.json": JSON.stringify({
        values: ["minecraft:smith/1/coal_emerald"],
      }),
      "data/minecraft/tags/villager_trade/armorer/level_1.json": JSON.stringify({
        values: ["#minecraft:common_smith/level_1", "minecraft:armorer/1/emerald_iron_helmet"],
      }),
      "data/minecraft/trade_set/armorer/level_1.json": JSON.stringify({
        amount: 1,
        trades: "#minecraft:armorer/level_1",
      }),
    };
    const source = new InMemoryArchiveSource(entries);
    const result = await buildVillagerTrades(Object.keys(entries), source, [
      { key: "item.minecraft.coal", value: "Coal" },
      { key: "item.minecraft.emerald", value: "Emerald" },
      { key: "item.minecraft.iron_helmet", value: "Iron Helmet" },
    ]);

    expect(result?.warnings).toEqual([]);
    expect(result?.trades).toHaveLength(2);
    expect(result?.pools[0]).toMatchObject({
      profession: "armorer",
      level: 1,
      amount: 1,
      tradeIds: ["minecraft:smith/1/coal_emerald", "minecraft:armorer/1/emerald_iron_helmet"],
      selectionChance: 0.5,
    });
    expect(result?.trades.find((trade) => trade.id.endsWith("coal_emerald"))).toMatchObject({
      wants: { name: "Coal", count: 15 },
      gives: { name: "Emerald", count: 1 },
      maxUses: 16,
      villagerXp: 2,
    });
  });

  test("marks enchanted-book pricing as dynamic and keeps the second input", async () => {
    const entries = {
      "data/minecraft/villager_trade/librarian/1/book.json": JSON.stringify({
        wants: { id: "minecraft:emerald", count: 0 },
        additional_wants: { id: "minecraft:book" },
        gives: { id: "minecraft:enchanted_book" },
        given_item_modifiers: [{ function: "minecraft:enchant_randomly", include_additional_cost_component: true }],
      }),
      "data/minecraft/tags/villager_trade/librarian/level_1.json": JSON.stringify({
        values: ["minecraft:librarian/1/book"],
      }),
      "data/minecraft/trade_set/librarian/level_1.json": JSON.stringify({
        amount: 2,
        trades: "#minecraft:librarian/level_1",
      }),
    };
    const source = new InMemoryArchiveSource(entries);
    const result = await buildVillagerTrades(Object.keys(entries), source, []);
    expect(result?.trades[0]).toMatchObject({
      dynamicPrice: true,
      wants: { id: "minecraft:emerald", count: 0 },
      additionalWants: { id: "minecraft:book", count: 1 },
      modifierFunctions: ["enchant_randomly"],
    });
    expect(result?.pools[0]?.selectionChance).toBe(1);
  });
});
