import type { Logger } from "../core/logger.js";
import type {
  AdvancementDefinition,
  BlockDefinition,
  EnchantmentDefinition,
  ItemDefinition,
  JsonValue,
  LootTableDefinition,
  ModelDefinition,
  RecipeDefinition,
  TagDefinition,
  TextureDefinition,
  TranslationEntry,
  VersionDataset,
} from "../domain/types.js";
import type { ArchiveSource } from "../archive/archiveSource.js";
import { MergedArchiveSource } from "../archive/archiveSource.js";
import {
  collectBlockModelRefs,
  collectLootFunctions,
  collectLootItemDrops,
  collectModelTextureRefs,
  componentTranslationKey,
  idFromAssetPath,
  modelKindFromPath,
  normalizeMinecraftId,
  normalizeRecipe,
  normalizeTagEntry,
  textureKindFromPath,
} from "./normalizers.js";
import { buildPalettes } from "./palettes.js";
import { buildBanners } from "./banners.js";
import { buildBiomes } from "./biomes.js";

const BLOCKSTATE_PREFIX = "assets/minecraft/blockstates/";
const MODEL_PREFIX = "assets/minecraft/models/";
const TEXTURE_PREFIX = "assets/minecraft/textures/";
const RECIPE_PREFIXES = ["data/minecraft/recipe/", "data/minecraft/recipes/"] as const;
const BLOCK_TAG_PREFIX = "data/minecraft/tags/blocks/";
const ITEM_TAG_PREFIX = "data/minecraft/tags/items/";
const TAGS_PREFIX = "data/minecraft/tags/";
const ENCHANTMENT_PREFIXES = ["data/minecraft/enchantment/", "data/minecraft/enchantments/"] as const;
const LOOT_TABLE_PREFIXES = ["data/minecraft/loot_table/", "data/minecraft/loot_tables/"] as const;
const ADVANCEMENT_PREFIXES = ["data/minecraft/advancement/", "data/minecraft/advancements/"] as const;
const LANG_PREFIX = "assets/minecraft/lang/";

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
    const enchantments = await this.readEnchantments(paths, source);
    const tags = await this.readTagDefinitions(paths, source);
    const lootTables = await this.readLootTables(paths, source);
    const advancements = await this.readAdvancements(paths, source);
    const translations = await this.readTranslations(paths, source);
    const biomes = await buildBiomes(paths, source, tags, translations);
    const banners = buildBanners(translations, paths);

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
      enchantments,
      tags,
      lootTables,
      advancements,
      translations,
      biomes,
      banners,
      mobImages: [],
      mobSounds: [],
      mobModels: [],
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

  private async readEnchantments(paths: string[], source: ArchiveSource): Promise<EnchantmentDefinition[]> {
    const enchantmentPaths = paths.filter(
      (path) => ENCHANTMENT_PREFIXES.some((prefix) => path.startsWith(prefix)) && path.endsWith(".json"),
    );
    const enchantments: EnchantmentDefinition[] = [];

    for (const path of enchantmentPaths) {
      const prefix = ENCHANTMENT_PREFIXES.find((candidate) => path.startsWith(candidate));
      if (!prefix) {
        continue;
      }

      try {
        const raw = await source.readJson<JsonValue>(path);
        if (Array.isArray(raw) || !raw || typeof raw !== "object") {
          continue;
        }

        const descriptionKey = componentTranslationKey(raw.description as JsonValue | undefined);
        enchantments.push({
          id: idFromAssetPath(prefix, path),
          descriptionKey,
          description: typeof raw.description === "string" ? raw.description : undefined,
          supportedItems: typeof raw.supported_items === "string" ? raw.supported_items : undefined,
          primaryItems: typeof raw.primary_items === "string" ? raw.primary_items : undefined,
          maxLevel: typeof raw.max_level === "number" ? raw.max_level : undefined,
          weight: typeof raw.weight === "number" ? raw.weight : undefined,
          anvilCost: typeof raw.anvil_cost === "number" ? raw.anvil_cost : undefined,
          slots: Array.isArray(raw.slots) ? raw.slots.filter((slot): slot is string => typeof slot === "string") : [],
          exclusiveSet: typeof raw.exclusive_set === "string" ? raw.exclusive_set : undefined,
          sourcePath: path,
          raw,
        });
      } catch (error) {
        this.logger.warn(`Skipping malformed enchantment file ${path}: ${(error as Error).message}`);
      }
    }

    return enchantments.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readTagDefinitions(paths: string[], source: ArchiveSource): Promise<TagDefinition[]> {
    const tagPaths = paths.filter((path) => path.startsWith(TAGS_PREFIX) && path.endsWith(".json"));
    const tags: TagDefinition[] = [];

    for (const path of tagPaths) {
      try {
        const raw = await source.readJson<JsonValue>(path);
        if (Array.isArray(raw) || !raw || typeof raw !== "object") {
          continue;
        }

        const remainder = path.slice(TAGS_PREFIX.length, path.length - ".json".length);
        const separatorIndex = remainder.indexOf("/");
        if (separatorIndex <= 0) {
          continue;
        }

        const registry = remainder.slice(0, separatorIndex);
        const tagId = normalizeMinecraftId(remainder.slice(separatorIndex + 1));
        const values = Array.isArray(raw.values)
          ? raw.values.map((value) => normalizeTagEntry(value)).filter((value): value is string => typeof value === "string")
          : [];

        tags.push({
          id: tagId,
          registry,
          replace: raw.replace === true,
          values,
          sourcePath: path,
          raw,
        });
      } catch (error) {
        this.logger.warn(`Skipping malformed tag file ${path}: ${(error as Error).message}`);
      }
    }

    return tags.sort((left, right) => `${left.registry}/${left.id}`.localeCompare(`${right.registry}/${right.id}`));
  }

  private async readLootTables(paths: string[], source: ArchiveSource): Promise<LootTableDefinition[]> {
    const lootPaths = paths.filter(
      (path) => LOOT_TABLE_PREFIXES.some((prefix) => path.startsWith(prefix)) && path.endsWith(".json"),
    );
    const lootTables: LootTableDefinition[] = [];

    for (const path of lootPaths) {
      const prefix = LOOT_TABLE_PREFIXES.find((candidate) => path.startsWith(candidate));
      if (!prefix) {
        continue;
      }

      try {
        const raw = await source.readJson<JsonValue>(path);
        const type = !Array.isArray(raw) && raw && typeof raw === "object" && typeof raw.type === "string" ? raw.type : undefined;
        const poolCount =
          !Array.isArray(raw) && raw && typeof raw === "object" && Array.isArray(raw.pools) ? raw.pools.length : 0;

        lootTables.push({
          id: idFromAssetPath(prefix, path),
          type,
          poolCount,
          itemDrops: collectLootItemDrops(raw),
          functions: collectLootFunctions(raw),
          sourcePath: path,
          raw,
        });
      } catch (error) {
        this.logger.warn(`Skipping malformed loot table file ${path}: ${(error as Error).message}`);
      }
    }

    return lootTables.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readAdvancements(paths: string[], source: ArchiveSource): Promise<AdvancementDefinition[]> {
    const advancementPaths = paths.filter(
      (path) => ADVANCEMENT_PREFIXES.some((prefix) => path.startsWith(prefix)) && path.endsWith(".json"),
    );
    const advancements: AdvancementDefinition[] = [];

    for (const path of advancementPaths) {
      const prefix = ADVANCEMENT_PREFIXES.find((candidate) => path.startsWith(candidate));
      if (!prefix) {
        continue;
      }

      try {
        const raw = await source.readJson<JsonValue>(path);
        if (Array.isArray(raw) || !raw || typeof raw !== "object") {
          continue;
        }

        const display = raw.display && typeof raw.display === "object" && !Array.isArray(raw.display) ? raw.display : undefined;
        const icon =
          display && display.icon && typeof display.icon === "object" && !Array.isArray(display.icon) ? display.icon : undefined;
        const iconItem =
          icon && typeof icon.id === "string"
            ? normalizeMinecraftId(icon.id)
            : icon && typeof icon.item === "string"
              ? normalizeMinecraftId(icon.item)
              : undefined;
        const criteria =
          raw.criteria && typeof raw.criteria === "object" && !Array.isArray(raw.criteria)
            ? Object.keys(raw.criteria).sort()
            : [];

        advancements.push({
          id: idFromAssetPath(prefix, path),
          parent: typeof raw.parent === "string" ? normalizeMinecraftId(raw.parent) : undefined,
          titleKey: display ? componentTranslationKey(display.title as JsonValue | undefined) : undefined,
          descriptionKey: display ? componentTranslationKey(display.description as JsonValue | undefined) : undefined,
          iconItem,
          frame: display && typeof display.frame === "string" ? display.frame : undefined,
          criteria,
          rewards: this.normalizeAdvancementRewards(raw.rewards as JsonValue | undefined),
          sourcePath: path,
          raw,
        });
      } catch (error) {
        this.logger.warn(`Skipping malformed advancement file ${path}: ${(error as Error).message}`);
      }
    }

    return advancements.sort((left, right) => left.id.localeCompare(right.id));
  }

  private normalizeAdvancementRewards(value: JsonValue | undefined): AdvancementDefinition["rewards"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    const toStringArray = (entry: JsonValue | undefined): string[] | undefined =>
      Array.isArray(entry)
        ? entry.filter((item): item is string => typeof item === "string").map((item) => normalizeMinecraftId(item))
        : undefined;

    const rewards: NonNullable<AdvancementDefinition["rewards"]> = {
      recipes: toStringArray(value.recipes),
      loot: toStringArray(value.loot),
      experience: typeof value.experience === "number" ? value.experience : undefined,
      function: typeof value.function === "string" ? normalizeMinecraftId(value.function) : undefined,
    };

    return Object.values(rewards).some((entry) => entry !== undefined) ? rewards : undefined;
  }

  private async readTranslations(paths: string[], source: ArchiveSource): Promise<TranslationEntry[]> {
    const langPath = `${LANG_PREFIX}en_us.json`;
    if (!paths.includes(langPath)) {
      return [];
    }

    try {
      const raw = await source.readJson<JsonValue>(langPath);
      if (Array.isArray(raw) || !raw || typeof raw !== "object") {
        return [];
      }

      const translations: TranslationEntry[] = [];
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") {
          translations.push({ key, value });
        }
      }

      return translations.sort((left, right) => left.key.localeCompare(right.key));
    } catch (error) {
      this.logger.warn(`Skipping malformed language file ${langPath}: ${(error as Error).message}`);
      return [];
    }
  }
}
