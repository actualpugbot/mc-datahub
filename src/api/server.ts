import { createServer, type Server, type ServerResponse } from "node:http";
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
            "GET /versions/:version/blocks?id=&q=",
            "GET /versions/:version/items?id=&q=",
            "GET /versions/:version/item-stats?id=&q=",
            "GET /versions/:version/block-properties?id=&q=",
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
        error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? 404 : 500;
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
