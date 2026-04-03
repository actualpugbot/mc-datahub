import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { createWorkspacePaths } from "../src/core/paths.js";
import { createConsoleLogger } from "../src/core/logger.js";
import { DatasetStore } from "../src/datasets/datasetStore.js";
import type { VersionDataset } from "../src/domain/types.js";
import { decodePng } from "../src/extraction/png.js";

describe("dataset store", () => {
  test("exports texture and mob images alongside the saved dataset", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "mc-datahub-dataset-store-"));
    const store = new DatasetStore(createWorkspacePaths(root), createConsoleLogger(false));
    const archive = new InMemoryArchiveSource({
      "assets/minecraft/textures/block/oak_planks.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "assets/minecraft/textures/entity/allay/allay.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]),
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
      mobImages: [
        {
          id: "minecraft:allay",
          localId: "allay",
          displayName: "Allay",
          imagePath: "mob-images/allay/allay.png",
          sourcePath: "assets/minecraft/textures/entity/allay/allay.png",
          origin: "renderer",
          variants: [
            {
              id: "allay/allay",
              imagePath: "mob-images/allay/allay.png",
              sourcePath: "assets/minecraft/textures/entity/allay/allay.png",
              origin: "renderer",
              role: "base",
            },
          ],
        },
        {
          id: "minecraft:phantom",
          localId: "phantom",
          displayName: "Phantom",
          imagePath: "mob-images/generated/phantom.png",
          origin: "generated",
          variants: [
            {
              id: "generated/phantom",
              imagePath: "mob-images/generated/phantom.png",
              origin: "generated",
              role: "generated",
            },
          ],
        },
      ],
      mobSounds: [],
    };

    await store.saveDataset(dataset, archive);

    const exportedImage = await fs.readFile(join(root, "datasets/25w14a/images/block/oak_planks.png"));
    const exportedMobImage = await fs.readFile(join(root, "datasets/25w14a/mob-images/allay/allay.png"));
    const generatedMobImage = await fs.readFile(join(root, "datasets/25w14a/mob-images/generated/phantom.png"));
    expect(exportedImage.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(exportedMobImage.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true);
    expect(decodePng(generatedMobImage)).toMatchObject({ width: 16, height: 16 });

    const loaded = await store.loadDataset("25w14a");
    expect(loaded.textures[0]?.imagePath).toBe("images/block/oak_planks.png");
    expect(loaded.mobImages[0]?.imagePath).toBe("mob-images/allay/allay.png");
  });
});
