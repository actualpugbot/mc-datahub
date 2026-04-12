import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { buildMobAudioDumpPayload, dumpMobAudioFiles, type MobAudioDumpDataset } from "../src/orchestrators/dumpMobAudio.js";

describe("buildMobAudioDumpPayload", () => {
  test("prefers a saved dataset when one exists", async () => {
    const dataset = createDataset("26.1.1");
    const extract = vi.fn<() => Promise<MobAudioDumpDataset>>();

    const payload = await buildMobAudioDumpPayload("26.1.1", {
      load: async () => dataset,
      extract,
    });

    expect(payload).toEqual({
      version: "26.1.1",
      mobSounds: dataset.mobSounds,
      source: "dataset",
    });
    expect(extract).not.toHaveBeenCalled();
  });

  test("falls back to archive extraction when the dataset file is missing", async () => {
    const archiveDataset = createDataset("26.1.1");
    const load = vi.fn(async () => {
      const error = new Error("missing");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    });
    const extract = vi.fn(async () => archiveDataset);

    const payload = await buildMobAudioDumpPayload("26.1.1", {
      load,
      extract,
    });

    expect(payload).toEqual({
      version: "26.1.1",
      mobSounds: archiveDataset.mobSounds,
      source: "archives",
    });
    expect(extract).toHaveBeenCalledOnce();
  });

  test("surfaces non-file errors from dataset loading", async () => {
    const load = vi.fn(async () => {
      throw new SyntaxError("bad dataset");
    });
    const extract = vi.fn<() => Promise<MobAudioDumpDataset>>();

    await expect(
      buildMobAudioDumpPayload("26.1.1", {
        load,
        extract,
      }),
    ).rejects.toThrow("bad dataset");
    expect(extract).not.toHaveBeenCalled();
  });
});

describe("dumpMobAudioFiles", () => {
  test("downloads each unique sound asset once", async () => {
    const outputDirectory = "/tmp/mc-datahub-mob-audio";
    const downloader = {
      downloadFile: vi
        .fn()
        .mockImplementationOnce(async (url: string, outputPath: string, options?: { expectedSha1?: string }) => ({
          path: outputPath,
          downloaded: true,
          bytes: 12,
          sha1: options?.expectedSha1 ?? "missing",
        }))
        .mockImplementationOnce(async (url: string, outputPath: string, options?: { expectedSha1?: string }) => ({
          path: outputPath,
          downloaded: false,
          bytes: 16,
          sha1: options?.expectedSha1 ?? "missing",
        })),
    };

    const result = await dumpMobAudioFiles(
      {
        version: "26.1.1",
        source: "dataset",
        mobSounds: [
          {
            id: "minecraft:allay",
            localId: "allay",
            soundId: "allay",
            displayName: "Allay",
            translationKey: "entity.minecraft.allay",
            category: "Creature",
            mobCategory: "CREATURE",
            soundEventCount: 2,
            soundVariantCount: 3,
            soundEvents: [
              {
                id: "entity.allay.ambient",
                variants: [
                  {
                    id: "entity.allay.ambient#1",
                    soundPath: "entity/allay/ambient1",
                    assetPath: "minecraft/sounds/entity/allay/ambient1.ogg",
                    url: "https://example.invalid/entity/allay/ambient1.ogg",
                    hash: "ambient-hash",
                    size: 12,
                    stream: false,
                    preload: false,
                    volume: 1,
                    pitch: 1,
                    weight: 1,
                  },
                  {
                    id: "entity.allay.ambient#2",
                    soundPath: "entity/allay/chirp1",
                    assetPath: "minecraft/sounds/entity/allay/chirp1.ogg",
                    url: "https://example.invalid/entity/allay/chirp1.ogg",
                    hash: "chirp-hash",
                    size: 16,
                    stream: false,
                    preload: false,
                    volume: 1,
                    pitch: 1,
                    weight: 1,
                  },
                ],
              },
              {
                id: "entity.allay.idle",
                variants: [
                  {
                    id: "entity.allay.idle#1",
                    soundPath: "entity/allay/ambient1",
                    assetPath: "minecraft/sounds/entity/allay/ambient1.ogg",
                    url: "https://example.invalid/entity/allay/ambient1.ogg",
                    hash: "ambient-hash",
                    size: 12,
                    stream: false,
                    preload: false,
                    volume: 1,
                    pitch: 1,
                    weight: 1,
                  },
                ],
              },
            ],
          },
        ],
      },
      outputDirectory,
      downloader,
    );

    expect(downloader.downloadFile).toHaveBeenCalledTimes(2);
    expect(downloader.downloadFile).toHaveBeenNthCalledWith(
      1,
      "https://example.invalid/entity/allay/ambient1.ogg",
      join(outputDirectory, "entity/allay/ambient1.ogg"),
      { expectedSha1: "ambient-hash" },
    );
    expect(downloader.downloadFile).toHaveBeenNthCalledWith(
      2,
      "https://example.invalid/entity/allay/chirp1.ogg",
      join(outputDirectory, "entity/allay/chirp1.ogg"),
      { expectedSha1: "chirp-hash" },
    );
    expect(result).toEqual({
      version: "26.1.1",
      source: "dataset",
      outputDirectory,
      mobCount: 1,
      soundEventCount: 2,
      soundVariantCount: 3,
      fileCount: 2,
      downloadedCount: 1,
      reusedCount: 1,
      totalBytes: 28,
    });
  });
});

function createDataset(version: string): MobAudioDumpDataset {
  return {
    version,
    mobSounds: [
      {
        id: "minecraft:allay",
        localId: "allay",
        soundId: "allay",
        displayName: "Allay",
        translationKey: "entity.minecraft.allay",
        category: "Creature",
        mobCategory: "CREATURE",
        soundEventCount: 1,
        soundVariantCount: 1,
        soundEvents: [
          {
            id: "entity.allay.ambient",
            variants: [
              {
                id: "entity.allay.ambient#1",
                soundPath: "entity/allay/ambient1",
                assetPath: "minecraft/sounds/entity/allay/ambient1.ogg",
                url: "https://example.invalid/entity/allay/ambient1.ogg",
                hash: "ambient-hash",
                size: 12,
                stream: false,
                preload: false,
                volume: 1,
                pitch: 1,
                weight: 1,
              },
            ],
          },
        ],
      },
    ],
  };
}
