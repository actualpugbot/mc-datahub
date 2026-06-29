import type { AppConfig } from "../config.js";

const COLLECTIONS: Array<{ slug: string; key: string; summary: string }> = [
  { slug: "blocks", key: "blocks", summary: "Block ids, tags, blockstate/model references, and texture references." },
  { slug: "items", key: "items", summary: "Item ids, tags, recipe links, model references, and texture references." },
  { slug: "item-stats", key: "itemStats", summary: "Source-derived stack size, durability, food, rarity, and tool/armor stats." },
  {
    slug: "block-properties",
    key: "blockProperties",
    summary: "Source-derived destroy time, resistance, light emission, and behavior flags.",
  },
  { slug: "recipes", key: "recipes", summary: "Normalized vanilla recipe data." },
  { slug: "models", key: "models", summary: "Model parent chains and texture references." },
  { slug: "textures", key: "textures", summary: "Texture metadata; pixels are served under /assets." },
  { slug: "enchantments", key: "enchantments", summary: "Data-driven enchantment definitions." },
  { slug: "tags", key: "tags", summary: "Registry tags (block, item, fluid, entity_type, …) and their values." },
  { slug: "loot-tables", key: "lootTables", summary: "Loot tables with derived item drops and functions." },
  { slug: "advancements", key: "advancements", summary: "Advancement tree with criteria, display keys, and rewards." },
  { slug: "translations", key: "translations", summary: "en_us language entries (display names)." },
  {
    slug: "biomes",
    key: "biomes",
    summary: "Biome definitions: display name, dimension, category, temperature, effect colors, and tags.",
  },
  { slug: "mob-images", key: "mobImages", summary: "Mob image metadata; pixels are served under /assets." },
  { slug: "mob-sounds", key: "mobSounds", summary: "Mob sound metadata and variant references." },
  { slug: "palettes", key: "palettes", summary: "Extracted and curated color palettes." },
];

function collectionResponseSchema(itemsKey: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      version: { type: "string" },
      total: { type: "integer", description: "Total entries before pagination." },
      count: { type: "integer", description: "Entries returned in this response." },
      limit: { type: ["integer", "null"], description: "Applied limit, or null when unbounded." },
      offset: { type: "integer" },
      [itemsKey]: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["version", "total", "count", "offset", itemsKey],
  };
}

/**
 * Builds a real OpenAPI 3.1 document describing the read-only dataset API. Returned as a plain
 * object so it can be served directly as JSON and consumed by Swagger UI, codegen, and Codex agents.
 */
export function buildOpenApiDocument(config: AppConfig): Record<string, unknown> {
  const versionParam = {
    name: "version",
    in: "path",
    required: true,
    description: "Minecraft version id with a processed dataset (see GET /versions).",
    schema: { type: "string" },
  };
  const idParam = {
    name: "id",
    in: "query",
    required: false,
    description: "Exact id match (namespace is added automatically when omitted).",
    schema: { type: "string" },
  };
  const queryParam = {
    name: "q",
    in: "query",
    required: false,
    description: "Case-insensitive substring search across the collection's text fields.",
    schema: { type: "string" },
  };
  const limitParam = {
    name: "limit",
    in: "query",
    required: false,
    description: "Maximum number of entries to return. Omit for all.",
    schema: { type: "integer", minimum: 0 },
  };
  const offsetParam = {
    name: "offset",
    in: "query",
    required: false,
    description: "Number of entries to skip before applying the limit.",
    schema: { type: "integer", minimum: 0 },
  };

  const paths: Record<string, unknown> = {
    "/health": {
      get: {
        summary: "Liveness probe.",
        responses: { "200": { description: "Service is up." } },
      },
    },
    "/versions": {
      get: {
        summary: "List versions that have a processed dataset.",
        responses: { "200": { description: "Version list." } },
      },
    },
    "/openapi.json": {
      get: { summary: "This OpenAPI document.", responses: { "200": { description: "OpenAPI 3.1 document." } } },
    },
    "/versions/{version}": {
      get: {
        summary: "Dataset summary: per-collection counts, provenance, and generation time.",
        parameters: [versionParam],
        responses: { "200": { description: "Summary." }, "404": { description: "Unknown version." } },
      },
    },
    "/versions/{version}/dataset": {
      get: {
        summary: "The full combined dataset (every collection in one response).",
        parameters: [versionParam],
        responses: { "200": { description: "Combined dataset." }, "404": { description: "Unknown version." } },
      },
    },
    "/versions/{version}/diff/{toVersion}": {
      get: {
        summary: "Structured diff between two processed versions.",
        parameters: [
          versionParam,
          { name: "toVersion", in: "path", required: true, schema: { type: "string" } },
          {
            name: "summary",
            in: "query",
            required: false,
            description: "When true, return only per-collection added/removed/changed counts.",
            schema: { type: "boolean" },
          },
        ],
        responses: { "200": { description: "Diff." }, "404": { description: "Unknown version." } },
      },
    },
    "/versions/{version}/assets/{path}": {
      get: {
        summary: "Serve an extracted binary asset (texture/mob PNG, dumped .ogg) by its dataset-relative path.",
        parameters: [
          versionParam,
          {
            name: "path",
            in: "path",
            required: true,
            description: "Dataset-relative path, e.g. images/block/oak_planks.png or mob-images/allay/allay.png.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Raw asset bytes." },
          "404": { description: "Asset not found." },
        },
      },
    },
  };

  for (const collection of COLLECTIONS) {
    const parameters = [versionParam, idParam, queryParam, limitParam, offsetParam];
    if (collection.slug === "tags") {
      parameters.splice(1, 0, {
        name: "registry",
        in: "query",
        required: false,
        description: "Filter tags by registry (block, item, fluid, entity_type, …).",
        schema: { type: "string" },
      });
    }

    paths[`/versions/{version}/${collection.slug}`] = {
      get: {
        summary: collection.summary,
        parameters,
        responses: {
          "200": {
            description: "Filtered, paginated collection.",
            content: { "application/json": { schema: collectionResponseSchema(collection.key) } },
          },
          "404": { description: "Unknown version." },
        },
      },
    };
  }

  paths["/mob-sounds/explorer"] = {
    get: { summary: "HTML landing page for the mob sound explorer.", responses: { "200": { description: "HTML." } } },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "mc-datahub",
      version: "0.1.0",
      description:
        "Read-only HTTP API exposing normalized Minecraft Java Edition datasets extracted by mc-datahub. " +
        "Every collection supports id/q filtering and limit/offset pagination; binary assets are served under /assets.",
    },
    servers: [{ url: `http://${config.api.host}:${config.api.port}` }],
    paths,
  };
}
