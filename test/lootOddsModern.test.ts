import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildLootOddsDataset, createLootOddsData, evaluateLootTable, type Json } from "../src/extraction/lootOdds/index.js";

// Frozen verbatim raw tables from the 26.4 Snapshot 5 client jar. No local
// extraction or downloads are required to verify the codec migration.
const tables = JSON.parse(readFileSync(new URL("./fixtures/loot/26.4-snapshot-5/entities.json", import.meta.url), "utf8"));
const data = createLootOddsData({ lootTables: tables });
const evaluate = (id: string, looting = 0, killedByPlayer = false) =>
  evaluateLootTable(id, { data, killedByPlayer, enchantmentLevels: { "minecraft:looting": looting } });

describe("modern source loot codecs", () => {
  test("Frostbite stack modifiers change both probability and count across Looting levels", () => {
    const plain = evaluate("minecraft:entities/frostbite");
    const enchanted = evaluate("minecraft:entities/frostbite", 3);
    const flesh = plain.items.find((entry) => entry.itemId === "minecraft:rotten_flesh")!;
    const ice = plain.items.find((entry) => entry.itemId === "minecraft:ice_ball")!;
    expect(flesh.probability).toBeCloseTo(2 / 3, 12);
    expect(flesh.expectedCount).toBeCloseTo(1, 12);
    expect(ice.probability).toBeCloseTo(3 / 4, 12);
    expect(ice.expectedCount).toBeCloseTo(1.5, 12);
    const enchantedIce = enchanted.items.find((entry) => entry.itemId === "minecraft:ice_ball")!;
    expect(enchantedIce.probability).toBeCloseTo(23 / 24, 12);
    expect(enchantedIce.expectedCount).toBeCloseTo(3, 12);
    expect(plain.warnings).toEqual([]);
    expect(enchanted.warnings).toEqual([]);
  });

  test("Blaze rods require a player kill and keep the source count distribution", () => {
    expect(evaluate("minecraft:entities/blaze").items).toEqual([]);
    const player = evaluate("minecraft:entities/blaze", 0, true);
    expect(player.items[0]?.probability).toBeCloseTo(0.5, 12);
    expect(player.items[0]?.expectedCount).toBeCloseTo(0.5, 12);
    expect(evaluate("minecraft:entities/blaze", 3, true).items[0]?.probability).toBeCloseTo(11 / 12, 12);
  });

  test("Zombie player and entity gates are explicit instead of unconditional Lava Chicken drops", () => {
    expect(
      evaluate("minecraft:entities/zombie").items.some((entry) => entry.itemId === "minecraft:music_disc_lava_chicken"),
    ).toBe(false);
    const player = evaluate("minecraft:entities/zombie", 0, true);
    const disc = player.items.find((entry) => entry.itemId === "minecraft:music_disc_lava_chicken")!;
    expect(disc.unresolvedConditions.length).toBeGreaterThan(0);
    expect(player.warnings.some((warning) => warning.includes("unresolved condition minecraft:entity_properties"))).toBe(true);
    const strict = evaluateLootTable("minecraft:entities/zombie", {
      data,
      killedByPlayer: true,
      unresolvedConditionsPass: false,
    });
    expect(strict.items.some((entry) => entry.itemId === "minecraft:music_disc_lava_chicken")).toBe(false);
    // Three equally weighted rare drops share the source 2.5% player-gated roll.
    expect(player.items.find((entry) => entry.itemId === "minecraft:iron_ingot")?.probability).toBeCloseTo(0.025 / 3, 12);
  });

  test("the public sidecar preserves player contexts, Looting differences, and unresolved warnings", () => {
    const dataset = buildLootOddsDataset({ data });
    const blaze = dataset.mobDrops.find((entry) => entry.tableId === "minecraft:entities/blaze")!;
    expect(
      blaze.cells.some((cell) => cell.contexts.some((context) => context.killedByPlayer === false) && cell.items.length === 0),
    ).toBe(true);
    expect(
      blaze.cells.some(
        (cell) =>
          cell.contexts.some((context) => context.killedByPlayer === true) &&
          cell.items.some((entry) => entry.itemId === "minecraft:blaze_rod"),
      ),
    ).toBe(true);
    const zombie = dataset.mobDrops.find((entry) => entry.tableId === "minecraft:entities/zombie")!;
    expect(zombie.warnings.some((warning) => warning.includes("unresolved condition"))).toBe(true);
    expect(dataset.warnings.some((warning) => warning.includes("minecraft:entities/zombie"))).toBe(true);
  });
});

function synthetic(raw: Record<string, Json>) {
  return createLootOddsData({ lootTables: [{ id: "test:modern", raw }] });
}

describe("modern codec placement and unsupported values", () => {
  test("table, pool, and entry modifiers run in vanilla order and function conditions gate them", () => {
    const raw: Record<string, Json> = {
      modifier: { type: "minecraft:set_count", count: 5, add: true },
      pools: [
        {
          rolls: 1,
          modifier: { type: "minecraft:set_count", count: 3, add: true },
          entries: [
            {
              type: "minecraft:item",
              name: "test:gem",
              condition: { type: "minecraft:random_chance", chance: 1 },
              modifier: [
                { type: "minecraft:set_count", count: 2 },
                { type: "minecraft:set_count", count: 100, condition: { type: "minecraft:killed_by_player" } },
              ],
            },
          ],
        },
      ],
    };
    expect(evaluateLootTable("test:modern", { data: synthetic(raw) }).items[0]?.expectedCount).toBe(10);
    expect(evaluateLootTable("test:modern", { data: synthetic(raw), killedByPlayer: true }).items[0]?.expectedCount).toBe(108);
  });

  test("single conditions and condition lists remain compatible with the old discriminants", () => {
    for (const condition of [
      { type: "minecraft:random_chance", chance: 0.25 },
      [{ type: "minecraft:random_chance", chance: 0.25 }],
      [{ condition: "minecraft:random_chance", chance: 0.25 }],
    ] satisfies Json[]) {
      const result = evaluateLootTable("test:modern", {
        data: synthetic({
          pools: [
            {
              rolls: 1,
              condition,
              entries: [{ type: "minecraft:item", name: "test:gem" }],
            },
          ],
        }),
      });
      expect(result.items[0]?.probability).toBeCloseTo(0.25, 12);
    }
  });

  test("unsupported modern conditions and modifiers surface warnings through the public sidecar", () => {
    const unknown = synthetic({
      pools: [
        {
          rolls: 1,
          entries: [
            {
              type: "minecraft:item",
              name: "test:gem",
              condition: { type: "test:unknown_gate" },
              modifier: { type: "test:unknown_modifier" },
            },
          ],
        },
      ],
    });
    const result = evaluateLootTable("test:modern", { data: unknown });
    expect(result.warnings.some((warning) => warning.includes("test:unknown_gate"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("test:unknown_modifier"))).toBe(true);
    expect(result.items[0]?.unresolvedConditions.length).toBeGreaterThan(0);
    const strict = evaluateLootTable("test:modern", { data: unknown, unresolvedConditionsPass: false });
    expect(strict.items).toEqual([]);
    expect(strict.warnings.some((warning) => warning.includes("test:unknown_gate"))).toBe(true);
  });
});

test("sidecar context collapsing cannot discard a player-gated unsupported modifier warning", () => {
  const data = createLootOddsData({
    lootTables: [
      {
        id: "minecraft:entities/test_warning",
        raw: {
          pools: [
            {
              rolls: 1,
              entries: [
                {
                  type: "minecraft:item",
                  name: "test:gem",
                  modifier: { type: "test:unknown_modifier", condition: { type: "minecraft:killed_by_player" } },
                },
              ],
            },
          ],
        },
      },
    ],
  });
  const sidecar = buildLootOddsDataset({ data });
  const table = sidecar.mobDrops[0]!;
  expect(sidecar.warnings.some((warning) => warning.includes("test:unknown_modifier"))).toBe(true);
  expect(
    table.cells.some(
      (cell) =>
        cell.contexts.some((context) => context.killedByPlayer === true) &&
        cell.warnings.some((warning) => warning.includes("test:unknown_modifier")),
    ),
  ).toBe(true);
  expect(
    table.cells.some((cell) => cell.contexts.some((context) => context.killedByPlayer === false) && cell.warnings.length === 0),
  ).toBe(true);
});
