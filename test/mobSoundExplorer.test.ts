import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ApiServer } from "../src/api/server.js";
import { buildApiServer } from "../src/api/server.js";
import { buildMobSoundExplorerPayload } from "../src/api/mobSoundExplorer.js";
import { loadConfig } from "../src/config.js";
import { createConsoleLogger } from "../src/core/logger.js";
import { DatasetStore } from "../src/datasets/datasetStore.js";
import type {
  MinecraftWikiMobSoundAlignment,
  MobSoundDefinition,
  VersionDataset,
} from "../src/domain/types.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
  tempDirs.clear();
});

describe("mob sound explorer", () => {
  test("builds combined extracted, wiki, and version diff payloads", async () => {
    const setup = await createFixtureProject();

    const payload = await buildMobSoundExplorerPayload(setup.store, setup.config.workspace, {
      version: "2.0",
      compareToVersion: "1.0",
    });

    expect(payload.version).toBe("2.0");
    expect(payload.compareToVersion).toBe("1.0");
    expect(payload.summary.mobCount).toBe(2);
    expect(payload.summary.diff).toMatchObject({
      addedMobCount: 1,
      removedMobCount: 1,
      changedMobCount: 1,
      unchangedMobCount: 0,
      addedSoundVariantCount: 2,
      removedSoundVariantCount: 1,
    });
    expect(payload.localOnlyMobs.map((mob) => mob.id)).toEqual(["breeze"]);
    expect(payload.wikiOnlyCategories.map((category) => category.id)).toEqual(["creaking"]);

    const allay = payload.rows.find((row) => row.id === "allay");
    expect(allay?.status).toBe("changed");
    expect(allay?.diff?.addedSoundPaths).toEqual(["mob/allay/death1"]);
    expect(allay?.wiki?.files.map((file) => file.fileName)).toEqual(["Allay ambient1.ogg", "Allay death1.ogg"]);

    const breeze = payload.rows.find((row) => row.id === "breeze");
    expect(breeze?.status).toBe("added");
    expect(breeze?.wiki).toBeUndefined();

    const ghast = payload.rows.find((row) => row.id === "ghast");
    expect(ghast?.status).toBe("removed");
    expect(ghast?.current).toBeUndefined();
    expect(ghast?.compareTo?.displayName).toBe("Ghast");
  });

  test("serves the split explorer pages and their JSON payloads", async () => {
    const setup = await createFixtureProject();
    const server = buildApiServer(setup.config, setup.store);

    const landingResponse = await issueRequest(server, "/mob-sounds/explorer");
    expect(landingResponse.statusCode).toBe(200);
    expect(landingResponse.headers["content-type"]).toContain("text/html");
    expect(landingResponse.body).toContain("Mob Sound Explorer");
    expect(landingResponse.body).toContain("/mob-sounds/explorer/wiki");
    expect(landingResponse.body).toContain("/mob-sounds/explorer/versions");

    const wikiPageResponse = await issueRequest(server, "/mob-sounds/explorer/wiki");
    expect(wikiPageResponse.statusCode).toBe(200);
    expect(wikiPageResponse.headers["content-type"]).toContain("text/html");
    expect(wikiPageResponse.body).toContain("Mob Sound Wiki Explorer");

    const versionPageResponse = await issueRequest(server, "/mob-sounds/explorer/versions");
    expect(versionPageResponse.statusCode).toBe(200);
    expect(versionPageResponse.headers["content-type"]).toContain("text/html");
    expect(versionPageResponse.body).toContain("Mob Sound Version Explorer");

    const wikiDataResponse = await issueRequest(server, "/mob-sounds/explorer/wiki/data?version=2.0");
    expect(wikiDataResponse.statusCode).toBe(200);
    expect(wikiDataResponse.headers["content-type"]).toContain("application/json");
    const wikiPayload = JSON.parse(wikiDataResponse.body) as Awaited<ReturnType<typeof buildMobSoundExplorerPayload>>;
    expect(wikiPayload.version).toBe("2.0");
    expect(wikiPayload.compareToVersion).toBeUndefined();
    expect(wikiPayload.rows.map((row) => row.id)).toEqual(["allay", "breeze"]);

    const versionDataResponse = await issueRequest(server, "/mob-sounds/explorer/versions/data?version=2.0&compareTo=1.0");
    expect(versionDataResponse.statusCode).toBe(200);
    expect(versionDataResponse.headers["content-type"]).toContain("application/json");
    const versionPayload = JSON.parse(versionDataResponse.body) as Awaited<ReturnType<typeof buildMobSoundExplorerPayload>>;
    expect(versionPayload.version).toBe("2.0");
    expect(versionPayload.compareToVersion).toBe("1.0");
    expect(versionPayload.rows.map((row) => row.id)).toEqual(["allay", "breeze", "ghast"]);
  });
});

async function createFixtureProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), "mc-datahub-explorer-"));
  tempDirs.add(projectRoot);

  const config = loadConfig(projectRoot);
  const logger = createConsoleLogger(false);
  const store = new DatasetStore(config.workspace, logger);

  const baselineDataset = createDataset("1.0", [
    createMob("allay", "Allay", [{ id: "entity.allay.ambient", paths: ["mob/allay/ambient1"] }]),
    createMob("ghast", "Ghast", [{ id: "entity.ghast.ambient", paths: ["mob/ghast/ambient1"] }]),
  ]);
  await store.saveDataset(baselineDataset);

  const currentDataset = createDataset("2.0", [
    createMob("allay", "Allay", [
      { id: "entity.allay.ambient", paths: ["mob/allay/ambient1"] },
      { id: "entity.allay.death", paths: ["mob/allay/death1"] },
    ]),
    createMob("breeze", "Breeze", [{ id: "entity.breeze.idle", paths: ["mob/breeze/idle1"] }]),
  ]);

  const savedSnapshot = await store.saveMobSoundMinecraftWikiSnapshot("2.0", {
    source: "minecraft.wiki",
    fetchedAt: "2026-04-12T20:00:00.000Z",
    apiUrl: "https://minecraft.wiki/api.php",
    rootCategoryTitle: "Category:Mob sounds",
    categoryCount: 2,
    fileCount: 3,
    categories: [
      {
        id: "allay",
        pageId: 1,
        title: "Category:Allay sounds",
        displayName: "Allay",
        url: "https://minecraft.wiki/w/Category%3AAllay_sounds",
        files: [
          createWikiFile("Allay ambient1.ogg", 11),
          createWikiFile("Allay death1.ogg", 12),
        ],
      },
      {
        id: "creaking",
        pageId: 2,
        title: "Category:Creaking sounds",
        displayName: "Creaking",
        url: "https://minecraft.wiki/w/Category%3ACreaking_sounds",
        files: [createWikiFile("Creaking idle1.ogg", 21)],
      },
    ],
  });

  const alignment: MinecraftWikiMobSoundAlignment = {
    source: "minecraft.wiki",
    fetchedAt: "2026-04-12T20:00:00.000Z",
    snapshotRelativePath: savedSnapshot.relativePath,
    categoryCount: 2,
    fileCount: 3,
    matchedCategoryCount: 1,
    exactCategoryCount: 1,
    partialCategoryCount: 0,
    wikiOnlyCategoryCount: 1,
    unmatchedWikiCategoryIds: ["creaking"],
    unmatchedLocalMobIds: ["breeze"],
    localOnlyMobs: [
      {
        id: "breeze",
        displayName: "Breeze",
        soundEventCount: 1,
        soundVariantCount: 1,
      },
    ],
    categories: [
      {
        id: "allay",
        title: "Category:Allay sounds",
        displayName: "Allay",
        url: "https://minecraft.wiki/w/Category%3AAllay_sounds",
        wikiFileCount: 2,
        mappedMobIds: ["allay"],
        mappedMobDisplayNames: ["Allay"],
        matchType: "direct",
        coverage: "exact",
        matchedFileCount: 2,
        unmatchedWikiFileTitles: [],
        unmatchedLocalSoundPaths: [],
      },
      {
        id: "creaking",
        title: "Category:Creaking sounds",
        displayName: "Creaking",
        url: "https://minecraft.wiki/w/Category%3ACreaking_sounds",
        wikiFileCount: 1,
        mappedMobIds: [],
        mappedMobDisplayNames: [],
        matchType: "wiki-only",
        coverage: "wiki-only",
        matchedFileCount: 0,
        unmatchedWikiFileTitles: ["Creaking idle1.ogg"],
        unmatchedLocalSoundPaths: [],
      },
    ],
  };

  currentDataset.mobSoundMinecraftWiki = alignment;
  await store.saveDataset(currentDataset);

  return { projectRoot, config, store };
}

function createDataset(version: string, mobSounds: MobSoundDefinition[]): VersionDataset {
  return {
    version,
    generatedAt: "2026-04-12T20:00:00.000Z",
    provenance: {
      sourceArtifacts: [],
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
    mobImages: [],
    mobSounds,
  };
}

function createMob(
  localId: string,
  displayName: string,
  soundEvents: Array<{ id: string; paths: string[] }>,
): MobSoundDefinition {
  return {
    id: `minecraft:${localId}`,
    localId,
    soundId: localId,
    displayName,
    translationKey: `entity.minecraft.${localId}`,
    category: "Creature",
    mobCategory: "CREATURE",
    soundEventCount: soundEvents.length,
    soundVariantCount: soundEvents.reduce((count, soundEvent) => count + soundEvent.paths.length, 0),
    soundEvents: soundEvents.map((soundEvent) => ({
      id: soundEvent.id,
      subtitleKey: `subtitles.${soundEvent.id}`,
      subtitle: `${displayName} ${soundEvent.id}`,
      variants: soundEvent.paths.map((soundPath, index) => ({
        id: `${soundEvent.id}#${index + 1}`,
        soundPath,
        assetPath: `minecraft/sounds/${soundPath}.ogg`,
        url: `https://resources.download.minecraft.net/${localId}/${index + 1}.ogg`,
        hash: `${localId}-${index + 1}`,
        size: 1024 + index,
        stream: false,
        preload: false,
        volume: 1,
        pitch: 1,
        weight: 1,
      })),
    })),
  };
}

function createWikiFile(fileName: string, pageId: number) {
  return {
    pageId,
    title: `File:${fileName}`,
    fileName,
    url: `https://minecraft.wiki/images/${encodeURIComponent(fileName)}`,
    descriptionUrl: `https://minecraft.wiki/w/File:${encodeURIComponent(fileName)}`,
    size: 2048,
    durationSeconds: 2,
  };
}

async function issueRequest(server: ApiServer, url: string) {
  return new Promise<{ statusCode: number; headers: Record<string, string>; body: string }>((resolve) => {
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      end(value?: string) {
        resolve({
          statusCode: this.statusCode,
          headers,
          body: value ?? "",
        });
      },
    };

    server.raw.emit(
      "request",
      {
        url,
        method: "GET",
        headers: {
          host: "test.local",
        },
      },
      response,
    );
  });
}
