import { describe, expect, test } from "vitest";
import type { EnchantmentDefinition, TagDefinition } from "../src/domain/types.js";
import { enrichEnchantments } from "../src/extraction/enchantments.js";

function enchantment(id: string, raw: Record<string, unknown>): EnchantmentDefinition {
  return {
    id: `minecraft:${id}`,
    descriptionKey: `enchantment.minecraft.${id}`,
    slots: [],
    sourcePath: `data/minecraft/enchantment/${id}.json`,
    raw: raw as EnchantmentDefinition["raw"],
  };
}

function tag(registry: string, id: string, values: string[]): TagDefinition {
  return {
    id: `minecraft:${id}`,
    registry,
    replace: false,
    values,
    sourcePath: `data/minecraft/tags/${registry}/${id}.json`,
    raw: { values },
  };
}

const TAGS: TagDefinition[] = [
  tag("item", "swords", ["minecraft:iron_sword", "minecraft:netherite_sword"]),
  tag("item", "spears", ["minecraft:netherite_spear"]),
  tag("item", "enchantable/melee_weapon", ["#minecraft:swords", "#minecraft:spears"]),
  tag("item", "enchantable/sharp_weapon", ["#minecraft:enchantable/melee_weapon", "minecraft:netherite_axe"]),
  tag("enchantment", "exclusive_set/damage", ["minecraft:sharpness", "minecraft:smite"]),
  tag("enchantment", "curse", ["minecraft:binding_curse"]),
  tag("enchantment", "in_enchanting_table", ["minecraft:sharpness", "minecraft:smite"]),
];

const TRANSLATIONS = [
  { key: "enchantment.minecraft.sharpness", value: "Sharpness" },
  { key: "enchantment.minecraft.smite", value: "Smite" },
  { key: "enchantment.minecraft.binding_curse", value: "Curse of Binding" },
];

describe("enchantment enrichment", () => {
  test("resolves items, exclusive sets, costs, display names, and tag memberships", () => {
    const [sharpness] = enrichEnchantments(
      [
        enchantment("sharpness", {
          supported_items: "#minecraft:enchantable/sharp_weapon",
          primary_items: "#minecraft:enchantable/melee_weapon",
          exclusive_set: "#minecraft:exclusive_set/damage",
          min_cost: { base: 1, per_level_above_first: 11 },
          max_cost: { base: 21, per_level_above_first: 11 },
        }),
      ],
      TAGS,
      TRANSLATIONS,
    );

    expect(sharpness?.displayName).toBe("Sharpness");
    expect(sharpness?.supportedItemIds).toEqual([
      "minecraft:iron_sword",
      "minecraft:netherite_axe",
      "minecraft:netherite_spear",
      "minecraft:netherite_sword",
    ]);
    expect(sharpness?.primaryItemIds).toEqual([
      "minecraft:iron_sword",
      "minecraft:netherite_spear",
      "minecraft:netherite_sword",
    ]);
    // The exclusive set contains sharpness itself; self is filtered out.
    expect(sharpness?.exclusiveSetIds).toEqual(["minecraft:smite"]);
    expect(sharpness?.minCost).toEqual({ base: 1, perLevelAboveFirst: 11 });
    expect(sharpness?.maxCost).toEqual({ base: 21, perLevelAboveFirst: 11 });
    expect(sharpness?.tags).toEqual(["minecraft:exclusive_set/damage", "minecraft:in_enchanting_table"]);
  });

  test("handles inline id lists, curse tags, and missing data without inventing fields", () => {
    const [curse] = enrichEnchantments(
      [enchantment("binding_curse", { supported_items: ["minecraft:elytra", "minecraft:carved_pumpkin"] })],
      TAGS,
      TRANSLATIONS,
    );

    expect(curse?.displayName).toBe("Curse of Binding");
    expect(curse?.supportedItemIds).toEqual(["minecraft:carved_pumpkin", "minecraft:elytra"]);
    expect(curse?.primaryItemIds).toBeUndefined();
    expect(curse?.exclusiveSetIds).toBeUndefined();
    expect(curse?.minCost).toBeUndefined();
    expect(curse?.tags).toEqual(["minecraft:curse"]);
  });
});
