import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { InMemoryArchiveSource } from "../src/archive/archiveSource.js";
import { FileCache } from "../src/core/cache.js";
import { createConsoleLogger } from "../src/core/logger.js";
import type { DownloadFileResult, HttpClient } from "../src/core/http.js";
import { MobSoundExtractor } from "../src/extraction/mobSoundExtractor.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, (directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("mob sound extractor", () => {
  test("builds mob sound definitions from asset index, sounds manifest, language strings, and entity registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-sound-"));
    tempDirs.add(root);

    const decompiledClientRoot = join(root, "decompiled-client");
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/world/entity/EntityType.java",
      `package net.minecraft.world.entity;

public class EntityType<T extends Entity> {
   public static final EntityType<Allay> ALLAY = register(
      "allay",
      EntityType.Builder.of(Allay::new, MobCategory.CREATURE).sized(0.35F, 0.6F)
   );
   public static final EntityType<Pufferfish> PUFFERFISH = register(
      "pufferfish",
      EntityType.Builder.of(Pufferfish::new, MobCategory.WATER_AMBIENT).sized(0.35F, 0.6F)
   );
   public static final EntityType<Villager> VILLAGER = register(
      "villager",
      EntityType.Builder.of(Villager::new, MobCategory.MISC).sized(0.6F, 1.95F)
   );
   public static final EntityType<ArmorStand> ARMOR_STAND = register(
      "armor_stand",
      EntityType.Builder.of(ArmorStand::new, MobCategory.MISC).sized(0.5F, 1.975F)
   );
}`,
    );

    const assetIndexUrl = "https://example.invalid/assets/30.json";
    const soundsHash = "aa00000000000000000000000000000000000000";
    const langHash = "bb00000000000000000000000000000000000000";
    const ambientHash = "cc00000000000000000000000000000000000000";
    const chirpHash = "dd00000000000000000000000000000000000000";
    const hurtHash = "ee00000000000000000000000000000000000000";
    const flopHash = "ff00000000000000000000000000000000000000";

    const http = createHttpClient({
      [assetIndexUrl]: {
        objects: {
          "minecraft/lang/en_us.json": {
            hash: langHash,
            size: 200,
          },
          "minecraft/sounds.json": {
            hash: soundsHash,
            size: 400,
          },
          "minecraft/sounds/entity/allay/ambient1.ogg": {
            hash: ambientHash,
            size: 12,
          },
          "minecraft/sounds/entity/allay/chirp1.ogg": {
            hash: chirpHash,
            size: 16,
          },
          "minecraft/sounds/entity/allay/hurt1.ogg": {
            hash: hurtHash,
            size: 8,
          },
          "minecraft/sounds/entity/puffer_fish/flop1.ogg": {
            hash: flopHash,
            size: 10,
          },
        },
      },
      [toAssetUrl(soundsHash)]: {
        "entity.allay.ambient": {
          subtitle: "subtitles.entity.allay.ambient",
          sounds: [
            "entity/allay/ambient1",
            {
              name: "entity/allay/chirp1",
              volume: 0.8,
              pitch: 1.2,
              weight: 2,
            },
          ],
        },
        "entity.allay.hurt": {
          sounds: ["entity/allay/hurt1"],
        },
        "entity.allay.idle": {
          sounds: [
            {
              name: "entity.allay.ambient",
              type: "event",
            },
          ],
        },
        "entity.puffer_fish.flop": {
          sounds: ["entity/puffer_fish/flop1"],
        },
      },
      [toAssetUrl(langHash)]: {
        "entity.minecraft.allay": "Allay",
        "entity.minecraft.pufferfish": "Pufferfish",
        "entity.minecraft.villager": "Villager",
        "subtitles.entity.allay.ambient": "Allay chirps",
      },
    });

    const extractor = new MobSoundExtractor(http, new FileCache(join(root, "cache")), createConsoleLogger(false));
    const result = await extractor.extract(
      "26.1.1",
      {
        id: "26.1.1",
        type: "release",
        releaseTime: "2026-04-01T00:00:00.000Z",
        time: "2026-04-01T00:00:00.000Z",
        downloads: {},
        assetIndex: {
          url: assetIndexUrl,
        },
      },
      [
        new InMemoryArchiveSource({
          "pack.mcmeta": JSON.stringify({
            pack: {
              pack_format: 75,
              supported_formats: {
                min_inclusive: 34,
                max_inclusive: 75,
              },
            },
          }),
        }),
      ],
      decompiledClientRoot,
    );

    expect(result.resourcePack).toEqual({
      packFormat: 75,
      supportedFormats: {
        min: 34,
        max: 75,
      },
    });

    expect(result.mobSounds.map((entry) => entry.localId)).toEqual(["allay", "pufferfish", "villager"]);

    expect(result.mobSounds.find((entry) => entry.localId === "allay")).toMatchObject({
      id: "minecraft:allay",
      soundId: "allay",
      displayName: "Allay",
      category: "Creature",
      mobCategory: "CREATURE",
      soundEventCount: 3,
      soundVariantCount: 5,
    });
    expect(result.mobSounds.find((entry) => entry.localId === "allay")?.soundEvents[0]).toMatchObject({
      id: "entity.allay.ambient",
      subtitleKey: "subtitles.entity.allay.ambient",
      subtitle: "Allay chirps",
    });
    expect(result.mobSounds.find((entry) => entry.localId === "allay")?.soundEvents[0]?.variants).toEqual([
      expect.objectContaining({
        id: "entity.allay.ambient#1",
        soundPath: "entity/allay/ambient1",
        assetPath: "minecraft/sounds/entity/allay/ambient1.ogg",
        url: toAssetUrl(ambientHash),
        hash: ambientHash,
        size: 12,
        volume: 1,
        pitch: 1,
        weight: 1,
      }),
      expect.objectContaining({
        id: "entity.allay.ambient#2",
        soundPath: "entity/allay/chirp1",
        assetPath: "minecraft/sounds/entity/allay/chirp1.ogg",
        url: toAssetUrl(chirpHash),
        hash: chirpHash,
        size: 16,
        volume: 0.8,
        pitch: 1.2,
        weight: 2,
      }),
    ]);
    expect(result.mobSounds.find((entry) => entry.localId === "allay")?.soundEvents[2]?.variants).toEqual([
      expect.objectContaining({
        soundPath: "entity/allay/ambient1",
      }),
      expect.objectContaining({
        soundPath: "entity/allay/chirp1",
      }),
    ]);

    expect(result.mobSounds.find((entry) => entry.localId === "pufferfish")).toMatchObject({
      soundId: "puffer_fish",
      soundEventCount: 1,
      soundVariantCount: 1,
    });
    expect(result.mobSounds.find((entry) => entry.localId === "pufferfish")?.soundEvents[0]?.id).toBe("entity.puffer_fish.flop");

    expect(result.mobSounds.find((entry) => entry.localId === "villager")).toMatchObject({
      soundEventCount: 0,
      soundVariantCount: 0,
    });
  });

  test("falls back to shared fish swim sounds when fish ambient events are empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-mob-sound-fish-"));
    tempDirs.add(root);

    const decompiledClientRoot = join(root, "decompiled-client");
    await writeJavaFile(
      decompiledClientRoot,
      "net/minecraft/world/entity/EntityType.java",
      `package net.minecraft.world.entity;

public class EntityType<T extends Entity> {
   public static final EntityType<Cod> COD = register(
      "cod",
      EntityType.Builder.of(Cod::new, MobCategory.WATER_AMBIENT).sized(0.5F, 0.3F)
   );
}`,
    );

    const assetIndexUrl = "https://example.invalid/assets/fish.json";
    const soundsHash = "1100000000000000000000000000000000000000";
    const langHash = "2200000000000000000000000000000000000000";
    const swimHashes = [
      "3300000000000000000000000000000000000000",
      "4400000000000000000000000000000000000000",
      "5500000000000000000000000000000000000000",
    ];

    const http = createHttpClient({
      [assetIndexUrl]: {
        objects: {
          "minecraft/lang/en_us.json": {
            hash: langHash,
            size: 100,
          },
          "minecraft/sounds.json": {
            hash: soundsHash,
            size: 200,
          },
          "minecraft/sounds/entity/fish/swim1.ogg": {
            hash: swimHashes[0],
            size: 11,
          },
          "minecraft/sounds/entity/fish/swim2.ogg": {
            hash: swimHashes[1],
            size: 12,
          },
          "minecraft/sounds/entity/fish/swim3.ogg": {
            hash: swimHashes[2],
            size: 13,
          },
        },
      },
      [toAssetUrl(soundsHash)]: {
        "entity.cod.ambient": {
          sounds: [],
        },
        "entity.cod.death": {
          sounds: [],
        },
        "entity.cod.flop": {
          sounds: [],
        },
        "entity.cod.hurt": {
          sounds: [],
        },
        "entity.fish.swim": {
          subtitle: "subtitles.entity.fish.swim",
          sounds: ["entity/fish/swim1", "entity/fish/swim2", "entity/fish/swim3"],
        },
      },
      [toAssetUrl(langHash)]: {
        "entity.minecraft.cod": "Cod",
        "subtitles.entity.fish.swim": "Splashes",
      },
    });

    const extractor = new MobSoundExtractor(http, new FileCache(join(root, "cache")), createConsoleLogger(false));
    const result = await extractor.extract(
      "26.1.1",
      {
        id: "26.1.1",
        type: "release",
        releaseTime: "2026-04-01T00:00:00.000Z",
        time: "2026-04-01T00:00:00.000Z",
        downloads: {},
        assetIndex: {
          url: assetIndexUrl,
        },
      },
      [new InMemoryArchiveSource({})],
      decompiledClientRoot,
    );

    expect(result.mobSounds).toHaveLength(1);
    expect(result.mobSounds[0]?.localId).toBe("cod");
    expect(result.mobSounds[0]?.soundEvents[0]).toMatchObject({
      id: "entity.cod.ambient",
      subtitleKey: "subtitles.entity.fish.swim",
      subtitle: "Splashes",
      variants: [
        expect.objectContaining({
          soundPath: "entity/fish/swim1",
        }),
        expect.objectContaining({
          soundPath: "entity/fish/swim2",
        }),
        expect.objectContaining({
          soundPath: "entity/fish/swim3",
        }),
      ],
    });
  });
});

function createHttpClient(responses: Record<string, unknown>): HttpClient {
  return {
    async getText(url: string): Promise<string> {
      const value = responses[url];
      if (value === undefined) {
        throw new Error(`Unexpected GET ${url}`);
      }

      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async getJson<T>(url: string): Promise<T> {
      const value = responses[url];
      if (value === undefined) {
        throw new Error(`Unexpected GET ${url}`);
      }

      if (typeof value === "string") {
        return JSON.parse(value) as T;
      }

      return structuredClone(value) as T;
    },
    async downloadFile(_url: string, _outputPath: string): Promise<DownloadFileResult> {
      throw new Error("downloadFile should not be used by the mob sound extractor test");
    },
  };
}

async function writeJavaFile(root: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

function toAssetUrl(hash: string): string {
  return `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`;
}
