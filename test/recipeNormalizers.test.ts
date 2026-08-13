import { describe, expect, test } from "vitest";
import { normalizeRecipe, normalizeRecipeResult } from "../src/extraction/normalizers.js";

describe("recipe normalizers", () => {
  test("normalizes modern result ids and component-bearing outputs", () => {
    expect(
      normalizeRecipeResult({
        id: "minecraft:potion",
        count: 2,
        components: {
          "minecraft:potion_contents": {
            potion: "minecraft:strength",
          },
        },
      }),
    ).toEqual({
      item: "minecraft:potion",
      count: 2,
      components: {
        "minecraft:potion_contents": {
          potion: "minecraft:strength",
        },
      },
    });
  });

  test("keeps legacy result item and tag forms", () => {
    expect(normalizeRecipeResult("stick")).toEqual({ item: "minecraft:stick", count: 1 });
    expect(normalizeRecipeResult({ item: "stick", count: 4 })).toEqual({
      item: "minecraft:stick",
      count: 4,
      components: undefined,
      tag: undefined,
    });
    expect(normalizeRecipeResult({ tag: "planks" })).toEqual({
      item: undefined,
      count: 1,
      components: undefined,
      tag: "minecraft:planks",
    });
    expect(normalizeRecipeResult({})).toBeUndefined();
  });

  test("normalizes string ingredients and alternatives without reading recipe metadata", () => {
    const recipe = normalizeRecipe("minecraft:test", "data/minecraft/recipe/test.json", {
      type: "minecraft:crafting_shapeless",
      group: "not_an_item",
      ingredients: ["minecraft:ink_sac", ["#minecraft:flowers", "minecraft:wither_rose"]],
      result: {
        id: "minecraft:black_dye",
      },
    });

    expect(recipe.ingredients).toEqual(["minecraft:ink_sac", "minecraft:wither_rose"]);
    expect(recipe.ingredientTags).toEqual(["minecraft:flowers"]);
    expect(recipe.result).toEqual({
      item: "minecraft:black_dye",
      tag: undefined,
      count: 1,
      components: undefined,
    });
  });

  test("normalizes declarative special-recipe ingredient fields", () => {
    const recipe = normalizeRecipe("minecraft:firework_star", "data/minecraft/recipe/firework_star.json", {
      type: "minecraft:crafting_special_firework_star",
      dye: "#minecraft:dyes",
      fuel: "minecraft:gunpowder",
      shapes: {
        burst: "minecraft:feather",
        creeper: "#minecraft:skulls",
      },
      trail: "minecraft:diamond",
      twinkle: "minecraft:glowstone_dust",
      result: {
        id: "minecraft:firework_star",
      },
    });

    expect(recipe.ingredients).toEqual([
      "minecraft:diamond",
      "minecraft:feather",
      "minecraft:glowstone_dust",
      "minecraft:gunpowder",
    ]);
    expect(recipe.ingredientTags).toEqual(["minecraft:dyes", "minecraft:skulls"]);
  });

  test("normalizes cooking and smithing ingredient slots", () => {
    const cooking = normalizeRecipe("minecraft:glass", "data/minecraft/recipe/glass.json", {
      type: "minecraft:smelting",
      ingredient: ["minecraft:sand", "#minecraft:smelts_to_glass"],
      result: {
        id: "minecraft:glass",
      },
    });
    const smithing = normalizeRecipe("minecraft:netherite_axe", "data/minecraft/recipe/netherite_axe.json", {
      type: "minecraft:smithing_transform",
      template: "minecraft:netherite_upgrade_smithing_template",
      base: "minecraft:diamond_axe",
      addition: "#minecraft:netherite_tool_materials",
      result: {
        id: "minecraft:netherite_axe",
      },
    });

    expect(cooking.ingredients).toEqual(["minecraft:sand"]);
    expect(cooking.ingredientTags).toEqual(["minecraft:smelts_to_glass"]);
    expect(smithing.ingredients).toEqual(["minecraft:diamond_axe", "minecraft:netherite_upgrade_smithing_template"]);
    expect(smithing.ingredientTags).toEqual(["minecraft:netherite_tool_materials"]);
  });

  test("normalizes brewing input, reagent, and output without treating potion contents as an item", () => {
    const recipe = normalizeRecipe("minecraft:strength", "data/minecraft/recipe/brewing/strength.json", {
      type: "minecraft:brewing",
      input: {
        item: "minecraft:potion",
        potion_contents: {
          potions: "minecraft:awkward",
        },
      },
      reagent: {
        item: "minecraft:blaze_powder",
      },
      output: {
        id: "minecraft:potion",
        components: {
          "minecraft:potion_contents": {
            potion: "minecraft:strength",
          },
        },
      },
    });

    expect(recipe.ingredients).toEqual(["minecraft:blaze_powder", "minecraft:potion"]);
    expect(recipe.ingredientTags).toEqual([]);
    expect(recipe.result).toMatchObject({
      item: "minecraft:potion",
      count: 1,
      components: {
        "minecraft:potion_contents": {
          potion: "minecraft:strength",
        },
      },
    });
  });
});
