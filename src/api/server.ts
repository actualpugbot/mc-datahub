import { createServer, type Server, type ServerResponse } from "node:http";
import { buildMobSoundExplorerPayload, ApiRequestError } from "./mobSoundExplorer.js";
import {
  renderMobSoundExplorerLandingPage,
  renderMobSoundVersionExplorerPage,
  renderMobSoundWikiExplorerPage,
} from "./mobSoundExplorerPage.js";
import { normalizeMinecraftId } from "../extraction/normalizers.js";
import type { DatasetStore } from "../datasets/datasetStore.js";
import type { AppConfig } from "../config.js";

export interface ApiServer {
  listen(options: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
  readonly raw: Server;
}

export function buildApiServer(config: AppConfig, datasetStore: DatasetStore): ApiServer {
  const server = createServer(async (request, response) => {
    if (!request.url || request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host ?? `${config.api.host}:${config.api.port}`}`);
    const segments = requestUrl.pathname.split("/").filter(Boolean);

    try {
      if (requestUrl.pathname === "/mob-sounds/explorer") {
        sendText(response, 200, renderMobSoundExplorerLandingPage(), "text/html; charset=utf-8");
        return;
      }

      if (requestUrl.pathname === "/mob-sounds/explorer/wiki") {
        sendText(response, 200, renderMobSoundWikiExplorerPage(), "text/html; charset=utf-8");
        return;
      }

      if (requestUrl.pathname === "/mob-sounds/explorer/versions") {
        sendText(response, 200, renderMobSoundVersionExplorerPage(), "text/html; charset=utf-8");
        return;
      }

      if (requestUrl.pathname === "/mob-sounds/explorer/data") {
        const payload = await buildMobSoundExplorerPayload(datasetStore, config.workspace, {
          version: requestUrl.searchParams.get("version") ?? undefined,
          compareToVersion: requestUrl.searchParams.get("compareTo") ?? undefined,
        });
        sendJson(response, 200, payload);
        return;
      }

      if (requestUrl.pathname === "/mob-sounds/explorer/wiki/data") {
        const payload = await buildMobSoundExplorerPayload(datasetStore, config.workspace, {
          version: requestUrl.searchParams.get("version") ?? undefined,
          compareToVersion: "",
        });
        sendJson(response, 200, payload);
        return;
      }

      if (requestUrl.pathname === "/mob-sounds/explorer/versions/data") {
        const payload = await buildMobSoundExplorerPayload(datasetStore, config.workspace, {
          version: requestUrl.searchParams.get("version") ?? undefined,
          compareToVersion: requestUrl.searchParams.get("compareTo") ?? undefined,
        });
        sendJson(response, 200, payload);
        return;
      }

      if (requestUrl.pathname === "/health") {
        sendJson(response, 200, { ok: true, timestamp: new Date().toISOString() });
        return;
      }

      if (requestUrl.pathname === "/versions") {
        sendJson(response, 200, { versions: await datasetStore.listVersions() });
        return;
      }

      if (requestUrl.pathname === "/openapi.json") {
        sendJson(response, 200, {
          name: "mc-datahub",
          version: "0.1.0",
          host: `${config.api.host}:${config.api.port}`,
          routes: [
            "GET /health",
            "GET /versions",
            "GET /mob-sounds/explorer",
            "GET /mob-sounds/explorer/wiki",
            "GET /mob-sounds/explorer/wiki/data?version=",
            "GET /mob-sounds/explorer/versions",
            "GET /mob-sounds/explorer/versions/data?version=&compareTo=",
            "GET /mob-sounds/explorer/data?version=&compareTo=",
            "GET /versions/:version/blocks?id=&q=",
            "GET /versions/:version/items?id=&q=",
            "GET /versions/:version/item-stats?id=&q=",
            "GET /versions/:version/block-properties?id=&q=",
            "GET /versions/:version/mob-images?id=&q=",
            "GET /versions/:version/mob-sounds?id=&q=",
            "GET /versions/:version/recipes?id=&q=",
            "GET /versions/:version/palettes?id=&q=",
          ],
        });
        return;
      }

      if (segments[0] === "versions" && segments.length === 3) {
        const version = decodeURIComponent(segments[1] ?? "");
        const collection = segments[2];
        const dataset = await datasetStore.loadDataset(version);
        const id = requestUrl.searchParams.get("id") ?? undefined;
        const query = requestUrl.searchParams.get("q") ?? undefined;

        if (collection === "blocks") {
          sendJson(response, 200, { version, blocks: filterCollection(dataset.blocks, id, query) });
          return;
        }

        if (collection === "items") {
          sendJson(response, 200, { version, items: filterCollection(dataset.items, id, query) });
          return;
        }

        if (collection === "item-stats") {
          sendJson(response, 200, { version, itemStats: filterCollection(dataset.itemStats, id, query) });
          return;
        }

        if (collection === "block-properties") {
          sendJson(response, 200, { version, blockProperties: filterCollection(dataset.blockProperties, id, query) });
          return;
        }

        if (collection === "mob-images") {
          sendJson(response, 200, { version, mobImages: filterMobImages(dataset.mobImages, id, query) });
          return;
        }

        if (collection === "mob-sounds") {
          sendJson(response, 200, { version, mobSounds: filterMobSounds(dataset.mobSounds, id, query) });
          return;
        }

        if (collection === "recipes") {
          sendJson(response, 200, { version, recipes: filterCollection(dataset.recipes, id, query) });
          return;
        }

        if (collection === "palettes") {
          sendJson(response, 200, { version, palettes: filterPalettes(dataset.palettes, id, query) });
          return;
        }
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const statusCode =
        error instanceof ApiRequestError
          ? error.statusCode
          : error && typeof error === "object" && "code" in error && error.code === "ENOENT"
            ? 404
            : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    raw: server,
    listen(options) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function filterCollection<T extends { id: string }>(entries: T[], id?: string, query?: string): T[] {
  if (id) {
    const normalizedId = normalizeMinecraftId(id);
    return entries.filter((entry) => entry.id === normalizedId);
  }

  if (query) {
    const normalizedQuery = query.toLowerCase();
    return entries.filter((entry) => entry.id.toLowerCase().includes(normalizedQuery));
  }

  return entries;
}

function filterMobImages<
  T extends {
    id: string;
    localId: string;
    displayName: string;
    origin: string;
    rendererClass?: string;
  },
>(entries: T[], id?: string, query?: string): T[] {
  if (id) {
    const normalizedId = normalizeMinecraftId(id);
    return entries.filter((entry) => entry.id === normalizedId || normalizeMinecraftId(entry.localId) === normalizedId);
  }

  if (query) {
    const normalizedQuery = query.toLowerCase();
    return entries.filter((entry) =>
      [entry.id, entry.localId, entry.displayName, entry.origin, entry.rendererClass ?? ""].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
    );
  }

  return entries;
}

function filterMobSounds<
  T extends {
    id: string;
    localId: string;
    displayName: string;
    category: string;
    soundId: string;
  },
>(entries: T[], id?: string, query?: string): T[] {
  if (id) {
    const normalizedId = normalizeMinecraftId(id);
    return entries.filter((entry) => entry.id === normalizedId || normalizeMinecraftId(entry.localId) === normalizedId);
  }

  if (query) {
    const normalizedQuery = query.toLowerCase();
    return entries.filter((entry) =>
      [entry.id, entry.localId, entry.displayName, entry.category, entry.soundId].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
    );
  }

  return entries;
}

function filterPalettes<
  T extends {
    id: string;
    name: string;
    category: string;
    description: string;
    tags: string[];
  },
>(entries: T[], id?: string, query?: string): T[] {
  if (id) {
    return entries.filter((entry) => entry.id === id);
  }

  if (query) {
    const normalizedQuery = query.toLowerCase();
    return entries.filter((entry) =>
      [entry.id, entry.name, entry.category, entry.description, ...entry.tags].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      ),
    );
  }

  return entries;
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendText(response: ServerResponse, statusCode: number, value: string, contentType: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  response.end(value);
}
