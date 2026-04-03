import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { createWorkspacePaths } from "../src/core/paths.js";
import { createConsoleLogger } from "../src/core/logger.js";
import { DatasetStore } from "../src/datasets/datasetStore.js";
import type { VersionDataset } from "../src/domain/types.js";

describe("dataset store", () => {
  test("exports texture images alongside the saved dataset", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "mc-datahub-dataset-store-"));
    const store = new DatasetStore(createWorkspacePaths(root), createConsoleLogger(false));
    const archive = new InMemoryArchiveSource({
      "assets/minecraft/textures/block/oak_planks.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    const dataset: VersionDataset = {
      version: "25w14a",
      generatedAt: "2026-04-02T00:00:00.000Z",
      provenance: {
        sourceArtifacts: ["InMemoryArchiveSource"],
        extractedFromPaths: ["assets/minecraft/textures/block/oak_planks.png"],
      },
      blocks: [],
      items: [],
      recipes: [],
      textures: [
        {
          id: "minecraft:block/oak_planks",
          kind: "block",
          sourcePath: "assets/minecraft/textures/block/oak_planks.png",
          imagePath: "images/block/oak_planks.png",
        },
      ],
      models: [],
      palettes: [],
      itemStats: [],
      blockProperties: [],
    };

    await store.saveDataset(dataset, archive);

    const exportedImage = await fs.readFile(join(root, "datasets/25w14a/images/block/oak_planks.png"));
    expect(exportedImage.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);

    const loaded = await store.loadDataset("25w14a");
    expect(loaded.textures[0]?.imagePath).toBe("images/block/oak_planks.png");
  });
});
