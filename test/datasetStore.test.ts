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
      enchantments: [],
      tags: [],
      lootTables: [],
      advancements: [],
      translations: [],
      biomes: [],
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
      mobModels: [
        {
          id: "minecraft:allay",
          localId: "allay",
          displayName: "Allay",
          modelLayers: ["allay"],
          texturePaths: ["assets/minecraft/textures/entity/allay/allay.png"],
          textureAssets: [],
          layers: [],
        },
      ],
      mobSounds: [],
      mobSoundMinecraftWiki: {
        source: "minecraft.wiki",
        fetchedAt: "2026-04-12T18:00:00.000Z",
        categoryCount: 1,
        fileCount: 1,
        matchedCategoryCount: 1,
        exactCategoryCount: 1,
        partialCategoryCount: 0,
        wikiOnlyCategoryCount: 0,
        unmatchedWikiCategoryIds: [],
        unmatchedLocalMobIds: [],
        localOnlyMobs: [],
        categories: [
          {
            id: "allay",
            title: "Category:Allay sounds",
            displayName: "Allay",
            url: "https://minecraft.wiki/w/Category:Allay_sounds",
            wikiFileCount: 1,
            mappedMobIds: ["allay"],
            mappedMobDisplayNames: ["Allay"],
            matchType: "direct",
            coverage: "exact",
            matchedFileCount: 1,
            unmatchedWikiFileTitles: [],
            unmatchedLocalSoundPaths: [],
          },
        ],
      },
    };

    await store.saveDataset(dataset, archive);

    const exportedImage = await fs.readFile(join(root, "datasets/25w14a/images/block/oak_planks.png"));
    const exportedMobModelTexture = await fs.readFile(join(root, "datasets/25w14a/images/entity/allay/allay.png"));
    const exportedMobImage = await fs.readFile(join(root, "datasets/25w14a/mob-images/allay/allay.png"));
    const generatedMobImage = await fs.readFile(join(root, "datasets/25w14a/mob-images/generated/phantom.png"));
    const exportedMobSoundWiki = JSON.parse(
      await fs.readFile(join(root, "datasets/25w14a/mob-sounds-minecraft-wiki.json"), "utf8"),
    ) as VersionDataset["mobSoundMinecraftWiki"];
    expect(exportedImage.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(exportedMobModelTexture.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true);
    expect(exportedMobImage.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true);
    expect(decodePng(generatedMobImage)).toMatchObject({ width: 16, height: 16 });
    expect(exportedMobSoundWiki?.categories[0]?.id).toBe("allay");

    const loaded = await store.loadDataset("25w14a");
    expect(loaded.textures[0]?.imagePath).toBe("images/block/oak_planks.png");
    expect(loaded.mobModels[0]?.textureAssets[0]?.imagePath).toBe("images/entity/allay/allay.png");
    expect(loaded.mobImages[0]?.imagePath).toBe("mob-images/allay/allay.png");
    expect(loaded.mobSoundMinecraftWiki?.categories[0]?.id).toBe("allay");
  });

  test("loads biome and banner sidecars for legacy dataset json files", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "mc-datahub-dataset-store-sidecars-"));
    const store = new DatasetStore(createWorkspacePaths(root), createConsoleLogger(false));
    const directory = join(root, "datasets/25w15a");
    await fs.mkdir(directory, { recursive: true });

    const legacyDataset = {
      version: "25w15a",
      generatedAt: "2026-04-09T00:00:00.000Z",
      provenance: {
        sourceArtifacts: ["legacy"],
        extractedFromPaths: [],
      },
      blocks: [],
      items: [],
      recipes: [],
      textures: [],
      models: [],
      palettes: [],
      itemStats: [],
      blockProperties: [],
      enchantments: [],
      tags: [],
      lootTables: [],
      advancements: [],
      translations: [],
      mobImages: [],
      mobModels: [],
      mobSounds: [],
    } satisfies Omit<VersionDataset, "biomes">;

    await fs.writeFile(join(directory, "dataset.json"), JSON.stringify(legacyDataset), "utf8");
    await fs.writeFile(
      join(directory, "biomes.json"),
      JSON.stringify({
        version: "25w15a",
        generatedAt: "2026-04-09T00:00:00.000Z",
        biomes: [
          {
            id: "minecraft:plains",
            key: "plains",
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
            downfall: 0.4,
            hasPrecipitation: true,
            effects: { waterColor: "#3f76e4" },
            tags: ["is_overworld"],
            sourcePath: "data/minecraft/worldgen/biome/plains.json",
            raw: {},
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      join(directory, "banners.json"),
      JSON.stringify({
        version: "25w15a",
        generatedAt: "2026-04-09T00:00:00.000Z",
        patterns: [
          {
            id: "stripe_bottom",
            assetId: "stripe_bottom",
            texturePath: "images/entity/banner/stripe_bottom.png",
            label: "Base",
            legacyCode: "bs",
            requiresItem: false,
          },
        ],
        colors: [
          {
            id: "white",
            label: "White",
            rgb: [249, 255, 254],
            hex: "#f9fffe",
            legacyId: 0,
            dyeItem: "white_dye",
            bannerItem: "white_banner",
          },
        ],
      }),
      "utf8",
    );

    const loaded = await store.loadDataset("25w15a");

    expect(loaded.biomes.map((biome) => biome.id)).toEqual(["minecraft:plains"]);
    expect(loaded.banners?.patterns.map((pattern) => pattern.id)).toEqual(["stripe_bottom"]);
    expect(loaded.banners?.colors.map((color) => color.id)).toEqual(["white"]);
  });

  test("saves minecraft.wiki mob sound snapshots with timestamped paths", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "mc-datahub-dataset-store-wiki-"));
    const store = new DatasetStore(createWorkspacePaths(root), createConsoleLogger(false));

    const saved = await store.saveMobSoundMinecraftWikiSnapshot("25w14a", {
      source: "minecraft.wiki",
      fetchedAt: "2026-04-12T18:00:00.000Z",
      apiUrl: "https://minecraft.wiki/api.php",
      rootCategoryTitle: "Category:Mob sounds",
      categoryCount: 1,
      fileCount: 1,
      categories: [
        {
          id: "allay",
          pageId: 1,
          title: "Category:Allay sounds",
          displayName: "Allay",
          url: "https://minecraft.wiki/w/Category:Allay_sounds",
          files: [
            {
              pageId: 2,
              title: "File:Allay death1.ogg",
              fileName: "Allay death1.ogg",
              url: "https://minecraft.wiki/images/Allay_death1.ogg",
              descriptionUrl: "https://minecraft.wiki/w/File:Allay_death1.ogg",
            },
          ],
        },
      ],
    });

    expect(saved.relativePath).toBe("sources/minecraft-wiki/mob-sounds-20260412T180000Z.json");
    expect(await store.hasMobSoundMinecraftWikiArtifacts("25w14a")).toBe(false);
    expect(JSON.parse(await fs.readFile(saved.path, "utf8"))).toMatchObject({
      source: "minecraft.wiki",
      categoryCount: 1,
    });
  });
});
