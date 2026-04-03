import type { Logger } from "../core/logger.js";
import type {
  BlockDefinition,
  ItemDefinition,
  JsonValue,
  ModelDefinition,
  RecipeDefinition,
  TextureDefinition,
  VersionDataset,
} from "../domain/types.js";
import type { ArchiveSource } from "../archive/archiveSource.js";
import { MergedArchiveSource } from "../archive/archiveSource.js";
import {
  collectBlockModelRefs,
  collectModelTextureRefs,
  idFromAssetPath,
  modelKindFromPath,
  normalizeMinecraftId,
  normalizeRecipe,
  textureKindFromPath,
} from "./normalizers.js";
import { buildPalettes } from "./palettes.js";

const BLOCKSTATE_PREFIX = "assets/minecraft/blockstates/";
const MODEL_PREFIX = "assets/minecraft/models/";
const TEXTURE_PREFIX = "assets/minecraft/textures/";
const RECIPE_PREFIXES = ["data/minecraft/recipe/", "data/minecraft/recipes/"] as const;
const BLOCK_TAG_PREFIX = "data/minecraft/tags/blocks/";
const ITEM_TAG_PREFIX = "data/minecraft/tags/items/";

export class MinecraftDataExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(version: string, sources: ArchiveSource[]): Promise<VersionDataset> {
    const source = new MergedArchiveSource(sources);
    const paths = await source.listPaths();

    const models = await this.readModels(paths, source);
    const textures = this.readTextures(paths);
    const palettes = await buildPalettes(paths, source);
    const recipes = await this.readRecipes(paths, source);
    const blockTags = await this.readTags(paths, source, BLOCK_TAG_PREFIX);
    const itemTags = await this.readTags(paths, source, ITEM_TAG_PREFIX);
    const blocks = await this.readBlocks(paths, source, models, blockTags);
    const items = await this.readItems(paths, source, models, itemTags, recipes);

    return {
      version,
      generatedAt: new Date().toISOString(),
      provenance: {
        sourceArtifacts: sources.map((entry) => entry.constructor.name),
        extractedFromPaths: paths,
      },
      blocks,
      items,
      recipes,
      textures,
      models,
      palettes,
      itemStats: [],
      blockProperties: [],
      mobSounds: [],
    };
  }

  private async readModels(paths: string[], source: ArchiveSource): Promise<ModelDefinition[]> {
    const modelPaths = paths.filter((path) => path.startsWith(MODEL_PREFIX) && path.endsWith(".json"));
    const models: ModelDefinition[] = [];

    for (const path of modelPaths) {
      const raw = await source.readJson<JsonValue>(path);
      const id = idFromAssetPath(MODEL_PREFIX, path);
      const parent =
        !Array.isArray(raw) && raw && typeof raw === "object" && typeof raw.parent === "string"
          ? normalizeMinecraftId(raw.parent)
          : undefined;
      models.push({
        id,
        kind: modelKindFromPath(path),
        parent,
        textureRefs: collectModelTextureRefs(raw),
        sourcePath: path,
        raw,
      });
    }

    return models.sort((left, right) => left.id.localeCompare(right.id));
  }

  private readTextures(paths: string[]): TextureDefinition[] {
    return paths
      .filter((path) => path.startsWith(TEXTURE_PREFIX) && path.endsWith(".png"))
      .map((path) => ({
        id: idFromAssetPath(TEXTURE_PREFIX, path),
        kind: textureKindFromPath(path),
        sourcePath: path,
        imagePath: `images/${path.slice(TEXTURE_PREFIX.length)}`,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readRecipes(paths: string[], source: ArchiveSource): Promise<RecipeDefinition[]> {
    const recipePaths = paths.filter(
      (path) => RECIPE_PREFIXES.some((prefix) => path.startsWith(prefix)) && path.endsWith(".json"),
    );
    const recipes: RecipeDefinition[] = [];

    for (const path of recipePaths) {
      const raw = await source.readJson<JsonValue>(path);
      const prefix = RECIPE_PREFIXES.find((candidate) => path.startsWith(candidate));
      if (!prefix) {
        continue;
      }

      recipes.push(normalizeRecipe(idFromAssetPath(prefix, path), path, raw));
    }

    return recipes.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readTags(paths: string[], source: ArchiveSource, prefix: string): Promise<Map<string, string[]>> {
    const tagPaths = paths.filter((path) => path.startsWith(prefix) && path.endsWith(".json"));
    const tagMap = new Map<string, string[]>();

    for (const path of tagPaths) {
      try {
        const raw = await source.readJson<JsonValue>(path);
        if (Array.isArray(raw) || !raw || typeof raw !== "object" || !Array.isArray(raw.values)) {
          continue;
        }

        const tagId = idFromAssetPath(prefix, path);
        for (const value of raw.values) {
          if (typeof value === "string" && !value.startsWith("#")) {
            const normalized = normalizeMinecraftId(value);
            const existing = tagMap.get(normalized) ?? [];
            existing.push(tagId);
            tagMap.set(normalized, existing);
          }
        }
      } catch (error) {
        this.logger.warn(`Skipping malformed tag file ${path}: ${(error as Error).message}`);
      }
    }

    for (const [key, values] of tagMap.entries()) {
      tagMap.set(
        key,
        Array.from(new Set(values)).sort((left, right) => left.localeCompare(right)),
      );
    }

    return tagMap;
  }

  private async readBlocks(
    paths: string[],
    source: ArchiveSource,
    models: ModelDefinition[],
    blockTags: Map<string, string[]>,
  ): Promise<BlockDefinition[]> {
    const blockstatePaths = paths.filter((path) => path.startsWith(BLOCKSTATE_PREFIX) && path.endsWith(".json"));
    const modelMap = new Map(models.map((model) => [model.id, model]));
    const blocks: BlockDefinition[] = [];

    for (const path of blockstatePaths) {
      const raw = await source.readJson<JsonValue>(path);
      const id = idFromAssetPath(BLOCKSTATE_PREFIX, path);
      const modelRefs = collectBlockModelRefs(raw);
      const textureRefs = new Set<string>();

      for (const modelRef of modelRefs) {
        this.collectModelTextures(modelRef, modelMap, textureRefs, new Set<string>());
      }

      blocks.push({
        id,
        tags: blockTags.get(id) ?? [],
        modelRefs,
        textureRefs: Array.from(textureRefs).sort(),
        blockstatePath: path,
        raw,
      });
    }

    return blocks.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readItems(
    paths: string[],
    source: ArchiveSource,
    models: ModelDefinition[],
    itemTags: Map<string, string[]>,
    recipes: RecipeDefinition[],
  ): Promise<ItemDefinition[]> {
    const itemModelPaths = paths.filter((path) => path.startsWith(`${MODEL_PREFIX}item/`) && path.endsWith(".json"));
    const modelsById = new Map(models.map((model) => [model.id, model]));
    const recipesByResult = new Map<string, string[]>();

    for (const recipe of recipes) {
      if (!recipe.result?.item) {
        continue;
      }

      const existing = recipesByResult.get(recipe.result.item) ?? [];
      existing.push(recipe.id);
      recipesByResult.set(recipe.result.item, existing);
    }

    const items: ItemDefinition[] = [];
    for (const path of itemModelPaths) {
      const relativeId = path.slice(`${MODEL_PREFIX}item/`.length).replace(/\.json$/i, "");
      if (relativeId === "generated" || relativeId === "handheld" || relativeId.startsWith("template_")) {
        continue;
      }

      const raw = await source.readJson<JsonValue>(path);
      const id = idFromAssetPath(`${MODEL_PREFIX}item/`, path);
      const namespacedId = normalizeMinecraftId(id);
      const textureRefs = new Set<string>();
      const modelRef = normalizeMinecraftId(`item/${id.replace(/^minecraft:/, "")}`);
      this.collectModelTextures(modelRef, modelsById, textureRefs, new Set<string>());

      items.push({
        id: namespacedId,
        tags: itemTags.get(namespacedId) ?? [],
        recipeIds: (recipesByResult.get(namespacedId) ?? []).sort(),
        modelRef,
        textureRefs: Array.from(textureRefs).sort(),
        sourcePath: path,
        raw,
      });
    }

    return items.sort((left, right) => left.id.localeCompare(right.id));
  }

  private collectModelTextures(
    modelId: string,
    modelMap: Map<string, ModelDefinition>,
    textureRefs: Set<string>,
    visited: Set<string>,
  ): void {
    if (visited.has(modelId)) {
      return;
    }

    visited.add(modelId);
    const model = modelMap.get(modelId);
    if (!model) {
      return;
    }

    for (const textureRef of model.textureRefs) {
      textureRefs.add(textureRef);
    }

    if (model.parent) {
      this.collectModelTextures(model.parent, modelMap, textureRefs, visited);
    }
  }
}
