import { describe, expect, test, vi } from "vitest";
import { buildRecipeDumpPayload } from "../src/orchestrators/dumpRecipes.js";
import type { VersionDataset } from "../src/domain/types.js";

describe("buildRecipeDumpPayload", () => {
  test("prefers a saved dataset when one exists", async () => {
    const dataset = createDataset("26.1.1");
    const extractDataset = vi.fn<() => Promise<VersionDataset>>();

    const payload = await buildRecipeDumpPayload("26.1.1", {
      loadDataset: async () => dataset,
      extractDataset,
    });

    expect(payload).toEqual({
      version: "26.1.1",
      recipes: dataset.recipes,
      source: "dataset",
    });
    expect(extractDataset).not.toHaveBeenCalled();
  });

  test("falls back to archive extraction when the dataset file is missing", async () => {
    const archiveDataset = createDataset("26.1.1");
    const loadDataset = vi.fn(async () => {
      const error = new Error("missing");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    });
    const extractDataset = vi.fn(async () => archiveDataset);

    const payload = await buildRecipeDumpPayload("26.1.1", {
      loadDataset,
      extractDataset,
    });

    expect(payload).toEqual({
      version: "26.1.1",
      recipes: archiveDataset.recipes,
      source: "archives",
    });
    expect(extractDataset).toHaveBeenCalledOnce();
  });

  test("surfaces non-file errors from dataset loading", async () => {
    const loadDataset = vi.fn(async () => {
      throw new SyntaxError("bad dataset");
    });
    const extractDataset = vi.fn<() => Promise<VersionDataset>>();

    await expect(
      buildRecipeDumpPayload("26.1.1", {
        loadDataset,
        extractDataset,
      }),
    ).rejects.toThrow("bad dataset");
    expect(extractDataset).not.toHaveBeenCalled();
  });
});

function createDataset(version: string): VersionDataset {
  return {
    version,
    generatedAt: "2026-04-01T00:00:00.000Z",
    provenance: {
      sourceArtifacts: ["ZipArchiveSource"],
      extractedFromPaths: ["data/minecraft/recipe/stick.json"],
    },
    blocks: [],
    items: [],
    recipes: [
      {
        id: "minecraft:stick",
        type: "minecraft:crafting_shaped",
        ingredients: ["minecraft:oak_planks"],
        ingredientTags: [],
        result: {
          item: "minecraft:stick",
          count: 4,
        },
        sourcePath: "data/minecraft/recipe/stick.json",
        raw: {
          type: "minecraft:crafting_shaped",
        },
      },
    ],
    textures: [],
    models: [],
    palettes: [],
    itemStats: [],
    blockProperties: [],
  };
}
