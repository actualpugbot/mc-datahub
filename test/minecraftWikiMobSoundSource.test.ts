import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileCache } from "../src/core/cache.js";
import { createConsoleLogger } from "../src/core/logger.js";
import type { DownloadFileResult, HttpClient } from "../src/core/http.js";
import type { MinecraftWikiMobSoundSnapshot, MobSoundDefinition } from "../src/domain/types.js";
import {
  MinecraftWikiMobSoundSource,
  buildMinecraftWikiMobSoundAlignment,
} from "../src/extraction/minecraftWikiMobSoundSource.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, (directory) => rm(directory, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("minecraft wiki mob sound source", () => {
  test("fetches category and file inventories from minecraft.wiki", async () => {
    const root = await mkdtemp(join(tmpdir(), "mc-datahub-wiki-mob-sound-"));
    tempDirs.add(root);

    const source = new MinecraftWikiMobSoundSource(
      createHttpClient((url) => {
        const requestUrl = new URL(url);
        const list = requestUrl.searchParams.get("list");
        const generator = requestUrl.searchParams.get("generator");
        const categoryTitle = requestUrl.searchParams.get("cmtitle") ?? requestUrl.searchParams.get("gcmtitle");

        if (list === "categorymembers" && categoryTitle === "Category:Mob sounds") {
          return {
            query: {
              categorymembers: [
                { pageid: 1, ns: 14, title: "Category:Allay sounds" },
                { pageid: 2, ns: 14, title: "Category:Fish sounds" },
              ],
            },
          };
        }

        if (generator === "categorymembers" && categoryTitle === "Category:Allay sounds") {
          return {
            query: {
              pages: {
                "10": {
                  pageid: 10,
                  title: "File:Allay death1.ogg",
                  imageinfo: [
                    {
                      timestamp: "2026-04-01T00:00:00.000Z",
                      size: 1234,
                      duration: 1.5,
                      url: "https://minecraft.wiki/images/Allay_death1.ogg",
                      descriptionurl: "https://minecraft.wiki/w/File:Allay_death1.ogg",
                      mime: "application/ogg",
                    },
                  ],
                },
              },
            },
          };
        }

        if (generator === "categorymembers" && categoryTitle === "Category:Fish sounds") {
          return {
            query: {
              pages: {
                "20": {
                  pageid: 20,
                  title: "File:Fish swim1.ogg",
                  imageinfo: [
                    {
                      timestamp: "2026-04-01T00:00:00.000Z",
                      size: 4321,
                      duration: 1,
                      url: "https://minecraft.wiki/images/Fish_swim1.ogg",
                      descriptionurl: "https://minecraft.wiki/w/File:Fish_swim1.ogg",
                      mime: "application/ogg",
                    },
                  ],
                },
              },
            },
          };
        }

        throw new Error(`Unexpected GET ${url}`);
      }),
      new FileCache(join(root, "cache")),
      createConsoleLogger(false),
      "https://minecraft.wiki/api.php",
    );

    const snapshot = await source.fetchSnapshot();

    expect(snapshot.source).toBe("minecraft.wiki");
    expect(snapshot.categoryCount).toBe(2);
    expect(snapshot.fileCount).toBe(2);
    expect(snapshot.categories).toEqual([
      expect.objectContaining({
        id: "allay",
        displayName: "Allay",
        files: [
          expect.objectContaining({
            fileName: "Allay death1.ogg",
          }),
        ],
      }),
      expect.objectContaining({
        id: "fish",
        displayName: "Fish",
        files: [
          expect.objectContaining({
            fileName: "Fish swim1.ogg",
          }),
        ],
      }),
    ]);
  });

  test("groups local mob sounds against minecraft.wiki categories and reports drift", () => {
    const snapshot: MinecraftWikiMobSoundSnapshot = {
      source: "minecraft.wiki",
      fetchedAt: "2026-04-12T18:00:00.000Z",
      apiUrl: "https://minecraft.wiki/api.php",
      rootCategoryTitle: "Category:Mob sounds",
      categoryCount: 3,
      fileCount: 5,
      categories: [
        createCategory("guardian", "Guardian", ["File:Guardian hurt1.ogg", "File:Elder guardian hurt1.ogg"]),
        createCategory("fish", "Fish", ["File:Fish hurt1.ogg", "File:Fish swim1.ogg"]),
        createCategory("copper_golem", "Copper golem", ["File:Copper golem idle1.ogg"]),
      ],
    };

    const alignment = buildMinecraftWikiMobSoundAlignment(
      [
        createMobSound("guardian", "Guardian", ["mob/guardian/hurt1"]),
        createMobSound("elder_guardian", "Elder Guardian", ["mob/guardian/elder_hit1"]),
        createMobSound("cod", "Cod", ["entity/fish/hurt1"]),
        createMobSound("happy_ghast", "Happy Ghast", ["mob/happy_ghast/ambient1"]),
      ],
      snapshot,
    );

    expect(alignment.matchedCategoryCount).toBe(2);
    expect(alignment.unmatchedWikiCategoryIds).toEqual(["copper_golem"]);
    expect(alignment.unmatchedLocalMobIds).toEqual(["happy_ghast"]);

    expect(alignment.categories.find((category) => category.id === "guardian")).toMatchObject({
      matchType: "grouped",
      coverage: "exact",
      mappedMobIds: ["elder_guardian", "guardian"],
      matchedFileCount: 2,
      unmatchedWikiFileTitles: [],
      unmatchedLocalSoundPaths: [],
    });
    expect(alignment.categories.find((category) => category.id === "fish")).toMatchObject({
      matchType: "grouped",
      coverage: "partial",
      mappedMobIds: ["cod"],
      matchedFileCount: 1,
      unmatchedWikiFileTitles: ["Fish swim1.ogg"],
      unmatchedLocalSoundPaths: [],
    });
  });
});

function createHttpClient(resolver: (url: string) => unknown): HttpClient {
  return {
    async getText(url: string): Promise<string> {
      const value = resolver(url);
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async getJson<T>(url: string): Promise<T> {
      const value = resolver(url);
      if (typeof value === "string") {
        return JSON.parse(value) as T;
      }

      return structuredClone(value) as T;
    },
    async downloadFile(_url: string, _outputPath: string): Promise<DownloadFileResult> {
      throw new Error("downloadFile should not be used by the minecraft.wiki mob sound source test");
    },
  };
}

function createCategory(id: string, displayName: string, fileTitles: string[]) {
  return {
    id,
    pageId: 1,
    title: `Category:${displayName} sounds`,
    displayName,
    url: `https://minecraft.wiki/w/Category:${displayName.replace(/ /g, "_")}_sounds`,
    files: fileTitles.map((title, index) => ({
      pageId: index + 1,
      title,
      fileName: title.replace(/^File:/, ""),
      url: `https://minecraft.wiki/images/${title.replace(/^File:/, "").replace(/ /g, "_")}`,
      descriptionUrl: `https://minecraft.wiki/w/${title.replace(/ /g, "_")}`,
      mime: "application/ogg",
      size: 1000,
      durationSeconds: 1,
      updatedAt: "2026-04-12T18:00:00.000Z",
    })),
  };
}

function createMobSound(localId: string, displayName: string, soundPaths: string[]): MobSoundDefinition {
  return {
    id: `minecraft:${localId}`,
    localId,
    soundId: localId,
    displayName,
    translationKey: `entity.minecraft.${localId}`,
    category: "Test",
    mobCategory: "TEST",
    soundEventCount: soundPaths.length,
    soundVariantCount: soundPaths.length,
    soundEvents: soundPaths.map((soundPath, index) => ({
      id: `${localId}.event.${index + 1}`,
      variants: [
        {
          id: `${localId}.event.${index + 1}#1`,
          soundPath,
          assetPath: `minecraft/sounds/${soundPath}.ogg`,
          url: `https://resources.download.minecraft.net/example/${localId}/${index + 1}`,
          hash: `${localId}-${index + 1}`,
          size: 10,
          stream: false,
          preload: false,
          volume: 1,
          pitch: 1,
          weight: 1,
        },
      ],
    })),
  };
}
