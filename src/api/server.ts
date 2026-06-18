import { createServer, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { buildMobSoundExplorerPayload, ApiRequestError } from "./mobSoundExplorer.js";
import {
  renderMobSoundExplorerLandingPage,
  renderMobSoundVersionExplorerPage,
  renderMobSoundWikiExplorerPage,
} from "./mobSoundExplorerPage.js";
import { buildOpenApiDocument } from "./openapi.js";
import { normalizeMinecraftId } from "../extraction/normalizers.js";
import { datasetVersionDir } from "../core/paths.js";
import type { DatasetStore } from "../datasets/datasetStore.js";
import type { DiffEngine } from "../diff/diffEngine.js";
import type { AppConfig } from "../config.js";
import type { VersionDataset } from "../domain/types.js";

export interface ApiServer {
  listen(options: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
  readonly raw: Server;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function buildApiServer(config: AppConfig, datasetStore: DatasetStore, diffEngine: DiffEngine): ApiServer {
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      applyCors(response);
      response.end();
      return;
    }

    if (!request.url || (request.method !== "GET" && request.method !== "HEAD")) {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host ?? `${config.api.host}:${config.api.port}`}`);
    const segments = requestUrl.pathname.split("/").filter(Boolean);

    try {
      if (requestUrl.pathname === "/" || requestUrl.pathname === "") {
        sendJson(response, 200, {
          name: "mc-datahub",
          description: "Normalized Minecraft Java Edition datasets over HTTP.",
          openapi: "/openapi.json",
          versions: "/versions",
          explorer: "/mob-sounds/explorer",
        });
        return;
      }

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
        sendJson(response, 200, buildOpenApiDocument(config));
        return;
      }

      if (segments[0] === "versions" && segments.length >= 2) {
        const version = decodeURIComponent(segments[1] ?? "");

        if (segments.length === 2) {
          const dataset = await datasetStore.loadDataset(version);
          sendJson(response, 200, summarizeDataset(dataset));
          return;
        }

        if (segments.length >= 4 && segments[2] === "assets") {
          await serveAsset(response, request.method === "HEAD", config, version, segments.slice(3));
          return;
        }

        if (segments.length === 4 && segments[2] === "diff") {
          const toVersion = decodeURIComponent(segments[3] ?? "");
          const [from, to] = await Promise.all([datasetStore.loadDataset(version), datasetStore.loadDataset(toVersion)]);
          const diff = diffEngine.compare(from, to);
          if (requestUrl.searchParams.get("summary") === "true") {
            sendJson(response, 200, summarizeDiff(diff));
            return;
          }

          sendJson(response, 200, diff);
          return;
        }

        if (segments.length === 3) {
          const collection = segments[2] ?? "";
          const dataset = await datasetStore.loadDataset(version);

          if (collection === "dataset") {
            sendJson(response, 200, dataset);
            return;
          }

          const resolved = resolveCollection(dataset, collection, requestUrl.searchParams);
          if (resolved) {
            const page = paginate(resolved.entries, requestUrl.searchParams);
            sendJson(response, 200, {
              version,
              total: page.total,
              count: page.count,
              limit: page.limit,
              offset: page.offset,
              [resolved.responseKey]: page.items,
            });
            return;
          }
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

interface ResolvedCollection {
  responseKey: string;
  entries: unknown[];
}

function resolveCollection(dataset: VersionDataset, collection: string, params: URLSearchParams): ResolvedCollection | undefined {
  const id = params.get("id") ?? undefined;
  const query = params.get("q") ?? undefined;

  switch (collection) {
    case "blocks":
      return { responseKey: "blocks", entries: filterById(dataset.blocks, id, query, (entry) => [entry.id]) };
    case "items":
      return { responseKey: "items", entries: filterById(dataset.items, id, query, (entry) => [entry.id]) };
    case "item-stats":
      return { responseKey: "itemStats", entries: filterById(dataset.itemStats, id, query, (entry) => [entry.id]) };
    case "block-properties":
      return {
        responseKey: "blockProperties",
        entries: filterById(dataset.blockProperties, id, query, (entry) => [entry.id]),
      };
    case "recipes":
      return {
        responseKey: "recipes",
        entries: filterById(dataset.recipes, id, query, (entry) => [
          entry.id,
          entry.type,
          ...entry.ingredients,
          entry.result?.item ?? "",
        ]),
      };
    case "models":
      return {
        responseKey: "models",
        entries: filterById(dataset.models, id, query, (entry) => [entry.id, entry.parent ?? "", ...entry.textureRefs]),
      };
    case "textures":
      return { responseKey: "textures", entries: filterById(dataset.textures, id, query, (entry) => [entry.id]) };
    case "enchantments":
      return {
        responseKey: "enchantments",
        entries: filterById(dataset.enchantments, id, query, (entry) => [
          entry.id,
          entry.descriptionKey ?? "",
          entry.supportedItems ?? "",
        ]),
      };
    case "loot-tables":
      return {
        responseKey: "lootTables",
        entries: filterById(dataset.lootTables, id, query, (entry) => [entry.id, entry.type ?? "", ...entry.itemDrops]),
      };
    case "advancements":
      return {
        responseKey: "advancements",
        entries: filterById(dataset.advancements, id, query, (entry) => [entry.id, entry.parent ?? "", entry.titleKey ?? ""]),
      };
    case "tags":
      return { responseKey: "tags", entries: filterTags(dataset.tags, id, query, params.get("registry") ?? undefined) };
    case "translations":
      return {
        responseKey: "translations",
        entries: filterTranslations(dataset.translations, id ?? params.get("key") ?? undefined, query),
      };
    case "palettes":
      return { responseKey: "palettes", entries: filterPalettes(dataset.palettes, id, query) };
    case "mob-images":
      return { responseKey: "mobImages", entries: filterMobImages(dataset.mobImages, id, query) };
    case "mob-sounds":
      return { responseKey: "mobSounds", entries: filterMobSounds(dataset.mobSounds, id, query) };
    default:
      return undefined;
  }
}

function summarizeDataset(dataset: VersionDataset): Record<string, unknown> {
  return {
    version: dataset.version,
    generatedAt: dataset.generatedAt,
    provenance: dataset.provenance,
    resourcePack: dataset.resourcePack,
    counts: {
      blocks: dataset.blocks.length,
      items: dataset.items.length,
      itemStats: dataset.itemStats.length,
      blockProperties: dataset.blockProperties.length,
      recipes: dataset.recipes.length,
      models: dataset.models.length,
      textures: dataset.textures.length,
      enchantments: dataset.enchantments.length,
      tags: dataset.tags.length,
      lootTables: dataset.lootTables.length,
      advancements: dataset.advancements.length,
      translations: dataset.translations.length,
      palettes: dataset.palettes.length,
      mobImages: dataset.mobImages.length,
      mobSounds: dataset.mobSounds.length,
    },
  };
}

function summarizeDiff(diff: ReturnType<DiffEngine["compare"]>): Record<string, unknown> {
  const summarize = (collection: { added: unknown[]; removed: unknown[]; changed: unknown[]; unchangedCount: number }) => ({
    added: collection.added.length,
    removed: collection.removed.length,
    changed: collection.changed.length,
    unchanged: collection.unchangedCount,
  });

  return {
    fromVersion: diff.fromVersion,
    toVersion: diff.toVersion,
    generatedAt: diff.generatedAt,
    summary: {
      blocks: summarize(diff.blocks),
      items: summarize(diff.items),
      itemStats: summarize(diff.itemStats),
      blockProperties: summarize(diff.blockProperties),
      recipes: summarize(diff.recipes),
      models: summarize(diff.models),
      textures: summarize(diff.textures),
      enchantments: summarize(diff.enchantments),
      tags: summarize(diff.tags),
      lootTables: summarize(diff.lootTables),
      advancements: summarize(diff.advancements),
      translations: summarize(diff.translations),
      palettes: summarize(diff.palettes),
      mobImages: summarize(diff.mobImages),
      mobSounds: summarize(diff.mobSounds),
    },
  };
}

async function serveAsset(
  response: ServerResponse,
  headOnly: boolean,
  config: AppConfig,
  version: string,
  pathSegments: string[],
): Promise<void> {
  const datasetDir = resolve(datasetVersionDir(config.workspace, version));
  const relativePath = pathSegments.map((segment) => decodeURIComponent(segment)).join("/");
  const resolvedPath = resolve(datasetDir, relativePath);

  if (resolvedPath !== datasetDir && !resolvedPath.startsWith(datasetDir + sep)) {
    sendJson(response, 403, { error: "Asset path escapes the dataset directory." });
    return;
  }

  try {
    const buffer = await fs.readFile(resolvedPath);
    const contentType = CONTENT_TYPES[extname(resolvedPath).toLowerCase()] ?? "application/octet-stream";
    response.statusCode = 200;
    applyCors(response);
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "public, max-age=86400");
    if (headOnly) {
      response.setHeader("content-length", buffer.byteLength);
      response.end();
      return;
    }

    response.end(buffer);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR")) {
      sendJson(response, 404, { error: "Asset not found" });
      return;
    }

    throw error;
  }
}

interface Page<T> {
  items: T[];
  total: number;
  count: number;
  limit: number | null;
  offset: number;
}

function paginate<T>(entries: T[], params: URLSearchParams): Page<T> {
  const total = entries.length;
  const limitRaw = params.get("limit");
  const offsetRaw = params.get("offset");
  const offset = offsetRaw ? Math.max(0, Number.parseInt(offsetRaw, 10) || 0) : 0;
  const limit = limitRaw !== null ? Math.max(0, Number.parseInt(limitRaw, 10) || 0) : null;
  const items = limit === null ? entries.slice(offset) : entries.slice(offset, offset + limit);
  return { items, total, count: items.length, limit, offset };
}

function filterById<T extends { id: string }>(
  entries: T[],
  id: string | undefined,
  query: string | undefined,
  search: (entry: T) => string[],
): T[] {
  if (id) {
    const normalizedId = normalizeMinecraftId(id);
    return entries.filter((entry) => entry.id === normalizedId);
  }

  if (query) {
    const normalizedQuery = query.toLowerCase();
    return entries.filter((entry) => search(entry).some((value) => value.toLowerCase().includes(normalizedQuery)));
  }

  return entries;
}

function filterTags<T extends { id: string; registry: string; values: string[] }>(
  entries: T[],
  id: string | undefined,
  query: string | undefined,
  registry: string | undefined,
): T[] {
  let filtered = entries;
  if (registry) {
    const normalizedRegistry = registry.toLowerCase();
    filtered = filtered.filter((entry) => entry.registry.toLowerCase() === normalizedRegistry);
  }

  if (id) {
    const normalizedId = normalizeMinecraftId(id);
    return filtered.filter((entry) => entry.id === normalizedId);
  }

  if (query) {
    const normalizedQuery = query.toLowerCase();
    return filtered.filter((entry) =>
      [entry.id, entry.registry, ...entry.values].some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }

  return filtered;
}

function filterTranslations<T extends { key: string; value: string }>(
  entries: T[],
  key: string | undefined,
  query: string | undefined,
): T[] {
  if (key) {
    return entries.filter((entry) => entry.key === key);
  }

  if (query) {
    const normalizedQuery = query.toLowerCase();
    return entries.filter(
      (entry) => entry.key.toLowerCase().includes(normalizedQuery) || entry.value.toLowerCase().includes(normalizedQuery),
    );
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

function applyCors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  response.setHeader("access-control-allow-headers", "*");
  response.setHeader("access-control-max-age", "86400");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  applyCors(response);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendText(response: ServerResponse, statusCode: number, value: string, contentType: string): void {
  response.statusCode = statusCode;
  applyCors(response);
  response.setHeader("content-type", contentType);
  response.end(value);
}
