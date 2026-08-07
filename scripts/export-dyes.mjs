import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceVersion = process.argv[2] ?? "26.3-snapshot-7";
const outputPath = process.argv[3] ?? "dyes.json";
const datasetsRoot = "workspace/datasets";
const datasetDirectory = path.join(datasetsRoot, sourceVersion);

const loadJson = async (name) => JSON.parse(await readFile(path.join(datasetDirectory, name), "utf8"));
const byId = (records, id) => records.find((record) => record.id === id);

const [
  banners,
  items,
  itemStats,
  models,
  itemModels,
  itemDisplays,
  textures,
  translationsPayload,
  recipes,
  tags,
  lootTables,
  lootOdds,
  advancements,
] = await Promise.all([
  loadJson("banners.json"),
  loadJson("items.json"),
  loadJson("item-stats.json"),
  loadJson("models.json"),
  loadJson("item-models.json"),
  loadJson("item-displays.json"),
  loadJson("textures.json"),
  loadJson("translations.json"),
  loadJson("recipes.json"),
  loadJson("tags.json"),
  loadJson("loot-tables.json"),
  loadJson("loot-odds.json"),
  loadJson("advancements.json"),
]);

const itemTags = tags.filter((tag) => tag.registry === "item");
const tradeTags = tags.filter(
  (tag) => tag.registry === "villager_trade" && tag.values.some((value) => /_dye(?:_|$)/.test(value)),
);

function recipeUsesItem(recipe, itemId) {
  const rawWithoutResult = { ...recipe.raw };
  delete rawWithoutResult.result;
  return JSON.stringify(rawWithoutResult).includes(`"${itemId}"`);
}

function exactLootOdds(itemId) {
  const matches = [];
  for (const [category, tables] of Object.entries(lootOdds)) {
    if (!Array.isArray(tables)) continue;
    for (const table of tables) {
      if (!Array.isArray(table.cells)) continue;
      const cells = table.cells
        .map((cell) => ({
          contexts: cell.contexts,
          item: cell.items?.find((candidate) => candidate.itemId === itemId),
          warnings: cell.warnings,
        }))
        .filter((cell) => cell.item);
      if (cells.length > 0) {
        matches.push({
          category,
          tableId: table.tableId,
          name: table.name,
          tableType: table.tableType,
          cells,
          warnings: table.warnings,
        });
      }
    }
  }
  return matches;
}

function tradeReferences(dyeItem) {
  const localId = dyeItem.replace(/^minecraft:/, "");
  const references = [];
  for (const tag of tradeTags) {
    for (const value of tag.values.filter(
      (candidate) => candidate.endsWith(`/emerald_${localId}`) || candidate.endsWith(`/${localId}_emerald`),
    )) {
      let direction = "related";
      if (value.includes(`/emerald_${localId}`)) direction = "obtain_dye_for_emerald";
      else if (value.includes(`/${localId}_emerald`)) direction = "sell_dye_for_emerald";
      references.push({
        direction,
        tradeId: value,
        tradeSourcePath: `data/minecraft/villager_trade/${value.replace(/^minecraft:/, "")}.json`,
        listedByTag: tag.id,
        tagSourcePath: tag.sourcePath,
      });
    }
  }
  return references;
}

function recipeUnlocks(recipeIds) {
  if (recipeIds.length === 0) return [];
  return advancements
    .filter((advancement) => recipeIds.some((recipeId) => JSON.stringify(advancement).includes(`"${recipeId}"`)))
    .map((advancement) => ({ id: advancement.id, sourcePath: advancement.sourcePath }));
}

const dyes = banners.colors.map((color) => {
  const itemId = `minecraft:${color.dyeItem}`;
  const modelId = `minecraft:item/${color.dyeItem}`;
  const producingRecipes = recipes.filter((recipe) => recipe.raw?.result?.id === itemId);
  const usingRecipes = recipes.filter((recipe) => recipeUsesItem(recipe, itemId));
  const directLootTables = lootTables.filter((table) => table.itemDrops.includes(itemId));
  const translation = translationsPayload.translations.find((entry) => entry.key === `item.minecraft.${color.dyeItem}`);

  return {
    ...color,
    itemId,
    translation,
    item: byId(items, itemId),
    itemStats: byId(itemStats, itemId),
    model: byId(models, modelId),
    resolvedItemModel: byId(itemModels, modelId),
    itemDisplay: byId(itemDisplays, itemId),
    texture: byId(textures, modelId),
    acquisition: {
      producingRecipes,
      recipeUnlockAdvancements: recipeUnlocks(producingRecipes.map((recipe) => recipe.id)),
      lootTables: directLootTables,
      lootOdds: exactLootOdds(itemId),
      trades: tradeReferences(itemId),
    },
    uses: {
      recipeCount: usingRecipes.length,
      recipes: usingRecipes,
      itemTags: itemTags
        .filter((tag) => tag.values.includes(itemId) || tag.values.includes("#minecraft:dyes"))
        .map((tag) => ({ id: tag.id, sourcePath: tag.sourcePath })),
    },
    locations: {
      consolidatedExport: outputPath,
      bannerColor: `${datasetDirectory}/banners.json#colors[id=${color.id}]`,
      item: `${datasetDirectory}/items.json#id=${itemId}`,
      itemStats: `${datasetDirectory}/item-stats.json#id=${itemId}`,
      model: `${datasetDirectory}/models.json#id=${modelId}`,
      resolvedItemModel: `${datasetDirectory}/item-models.json#id=${modelId}`,
      itemDisplay: `${datasetDirectory}/item-displays.json#id=${itemId}`,
      textureMetadata: `${datasetDirectory}/textures.json#id=${modelId}`,
      textureImage: `${datasetDirectory}/${byId(textures, modelId)?.imagePath}`,
      translation: `${datasetDirectory}/translations.json#key=item.minecraft.${color.dyeItem}`,
      recipes: `${datasetDirectory}/recipes.json`,
      tags: `${datasetDirectory}/tags.json`,
      lootTables: `${datasetDirectory}/loot-tables.json`,
      lootOdds: `${datasetDirectory}/loot-odds.json`,
    },
  };
});

const availableVersions = [];
for (const version of (await readdir(datasetsRoot)).sort()) {
  const directory = path.join(datasetsRoot, version);
  if (!(await stat(directory)).isDirectory()) continue;
  const files = new Set(await readdir(directory));
  availableVersions.push({
    version,
    datasetDirectory: directory,
    combinedDataset: files.has("dataset.json") ? `${directory}/dataset.json` : null,
    banners: files.has("banners.json") ? `${directory}/banners.json` : null,
    items: files.has("items.json") ? `${directory}/items.json` : null,
    recipes: files.has("recipes.json") ? `${directory}/recipes.json` : null,
    tags: files.has("tags.json") ? `${directory}/tags.json` : null,
    lootTables: files.has("loot-tables.json") ? `${directory}/loot-tables.json` : null,
    lootOdds: files.has("loot-odds.json") ? `${directory}/loot-odds.json` : null,
  });
}

const dyeTag = tags.find((tag) => tag.id === "minecraft:dyes" && tag.registry === "item");
const behaviorTags = tags.filter(
  (tag) => tag.registry === "item" && (tag.values.includes("#minecraft:dyes") || tag.id === "minecraft:cauldron_can_remove_dye"),
);

const output = {
  schema: "mc-datahub/dyes-export/v1",
  sourceVersion,
  sourceGeneratedAt: banners.generatedAt,
  exportedAt: new Date().toISOString(),
  summary: {
    dyeCount: dyes.length,
    producingRecipeCount: dyes.reduce((sum, dye) => sum + dye.acquisition.producingRecipes.length, 0),
    recipesUsingDyesCount: new Set(dyes.flatMap((dye) => dye.uses.recipes.map((recipe) => recipe.id))).size,
    lootTableCount: new Set(dyes.flatMap((dye) => dye.acquisition.lootTables.map((table) => table.id))).size,
    dyeTradeReferenceCount: dyes.reduce((sum, dye) => sum + dye.acquisition.trades.length, 0),
  },
  whereToFindThisData: {
    consolidatedExport: outputPath,
    latestDatasetDirectory: datasetDirectory,
    combinedDataset: `${datasetDirectory}/dataset.json#banners.colors`,
    standaloneCollections: {
      colors: `${datasetDirectory}/banners.json#colors`,
      items: `${datasetDirectory}/items.json`,
      itemStats: `${datasetDirectory}/item-stats.json`,
      models: `${datasetDirectory}/models.json`,
      resolvedItemModels: `${datasetDirectory}/item-models.json`,
      itemDisplays: `${datasetDirectory}/item-displays.json`,
      textures: `${datasetDirectory}/textures.json`,
      translations: `${datasetDirectory}/translations.json`,
      recipes: `${datasetDirectory}/recipes.json`,
      tags: `${datasetDirectory}/tags.json`,
      lootTables: `${datasetDirectory}/loot-tables.json`,
      lootOdds: `${datasetDirectory}/loot-odds.json`,
      advancements: `${datasetDirectory}/advancements.json`,
    },
    apiQueries: {
      fullDataset: `/versions/${sourceVersion}/dataset`,
      items: `/versions/${sourceVersion}/items?q=_dye`,
      itemStats: `/versions/${sourceVersion}/item-stats?q=_dye`,
      recipes: `/versions/${sourceVersion}/recipes?q=_dye`,
      models: `/versions/${sourceVersion}/models?q=_dye`,
      textures: `/versions/${sourceVersion}/textures?q=_dye`,
      tags: `/versions/${sourceVersion}/tags?q=dye`,
      lootTables: `/versions/${sourceVersion}/loot-tables?q=_dye`,
      translations: `/versions/${sourceVersion}/translations?q=dye`,
      textureAssetPattern: `/versions/${sourceVersion}/assets/images/item/{color}_dye.png`,
      note: "Banner colors are currently available through the full dataset endpoint, not a dedicated banners collection endpoint.",
    },
    availableVersions,
  },
  canonicalDyeTag: dyeTag,
  relatedBehaviorTags: behaviorTags,
  dyeRelatedTradeTags: tradeTags,
  dyes,
};

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath} with ${dyes.length} dyes.`);
