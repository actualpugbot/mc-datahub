import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const currentVersion = "26.3-snapshot-7";
const lastCompleteVersion = "26.2";
const currentDir = join(root, "workspace", "datasets", currentVersion);
const completeDir = join(root, "workspace", "datasets", lastCompleteVersion);
const worldgenRoot = join(root, "workspace", "versions", currentVersion, "decompiled", "client", "data", "minecraft", "worldgen");

const familyDefinitions = [
  ["dark_oak", "Dark Oak", "overworld", "minecraft:dark_oak_log"],
  ["pale_oak", "Pale Oak", "overworld", "minecraft:pale_oak_log"],
  ["poplar", "Poplar", "overworld", "minecraft:poplar_log"],
  ["mangrove", "Mangrove", "overworld", "minecraft:mangrove_log"],
  ["crimson", "Crimson", "nether", "minecraft:crimson_stem"],
  ["warped", "Warped", "nether", "minecraft:warped_stem"],
  ["spruce", "Spruce", "overworld", "minecraft:spruce_log"],
  ["birch", "Birch", "overworld", "minecraft:birch_log"],
  ["jungle", "Jungle", "overworld", "minecraft:jungle_log"],
  ["acacia", "Acacia", "overworld", "minecraft:acacia_log"],
  ["cherry", "Cherry", "overworld", "minecraft:cherry_log"],
  ["bamboo", "Bamboo", "bamboo", "minecraft:bamboo"],
  ["oak", "Oak", "overworld", "minecraft:oak_log"],
].map(([family, displayName, category, marker]) => ({ family, displayName, category, marker }));

const [currentTrees, completeTrees, biomesRoot, items, blocks, recipes, tags, translationsRoot] = await Promise.all([
  json(join(currentDir, "tree-features.json")),
  json(join(completeDir, "tree-features.json")),
  json(join(currentDir, "biomes.json")),
  json(join(currentDir, "items.json")),
  json(join(currentDir, "blocks.json")),
  json(join(currentDir, "recipes.json")),
  json(join(currentDir, "tags.json")),
  json(join(currentDir, "translations.json")),
]);

const biomes = biomesRoot.biomes ?? biomesRoot;
const translations = translationsRoot.translations ?? translationsRoot;
const names = new Map(translations.map((entry) => [entry.key, entry.value]));
const blockIds = new Set(blocks.map((block) => block.id));
const currentByFamily = new Map(currentTrees.families.map((family) => [family.family, family]));
const completeByFamily = new Map(completeTrees.families.map((family) => [family.family, family]));
const graphCache = new Map();

const ownedItems = new Map(familyDefinitions.map(({ family }) => [family, []]));
for (const item of items) {
  const family = owner(item.id);
  if (family) ownedItems.get(family).push(item.id);
}

const ownedRecipes = new Map(familyDefinitions.map(({ family }) => [family, []]));
for (const recipe of recipes) {
  const family = owner(recipe.id);
  if (family) ownedRecipes.get(family).push(recipe);
}

const locations = await deriveLocations(biomes);
const woodTypes = familyDefinitions
  .map(({ family, displayName, category }) => {
    const current = currentByFamily.get(family);
    const lastComplete = completeByFamily.get(family);
    const familyItems = ownedItems.get(family).sort();
    const inferredBlocks = familyItems
      .filter((id) => blockIds.has(id))
      .map((id) => ({ id, name: displayNameFor("block", id), role: inferRole(id, family) }));
    return {
      family,
      displayName,
      category: current?.category ?? category,
      currentTreeData: current ?? null,
      currentBlocks: current?.blocks ?? inferredBlocks,
      currentItems: familyItems,
      currentRecipes: ownedRecipes.get(family).sort((a, b) => a.id.localeCompare(b.id)),
      naturalGeneration: locations.get(family) ?? [],
      lastCompleteTreeData: lastComplete ?? null,
      lastCompleteFeatureShapes: lastComplete ? relevantCompleteFeatures(lastComplete) : [],
    };
  })
  .sort((a, b) => a.family.localeCompare(b.family));

const relevantTagObjects = tags.filter((tag) => {
  const text = JSON.stringify(tag);
  return (
    familyDefinitions.some(({ family }) => text.includes(`${family}_`)) || /minecraft:(logs|planks|wooden_|saplings)/.test(text)
  );
});

const output = {
  metadata: {
    currentVersion,
    lastCompleteTreeExtractionVersion: lastCompleteVersion,
    scope:
      "Vanilla, family-specific wood blocks/items/recipes/tags and naturally generated biome locations stored by mc-datahub.",
    locationMethod:
      "Biome placed-feature references were recursively resolved through current placed_feature, feature, and configured_feature JSON; a family is reported when its trunk/stem/bamboo block occurs in the resolved graph.",
    caveats: [
      "26.3-snapshot-6 tree-features extraction is incomplete after a worldgen schema change; its warnings are retained verbatim.",
      "Poplar exists in 26.3-snapshot-6 but not in the last complete 26.2 tree extraction, so its lastCompleteTreeData is null.",
      "lastCompleteTreeData and lastCompleteFeatureShapes describe 26.2 and are not represented as current snapshot facts.",
      "Natural locations cover biome world generation, not structures, loot, villager trades, or player crafting.",
    ],
    sourceFiles: [
      `workspace/datasets/${currentVersion}/tree-features.json`,
      `workspace/datasets/${currentVersion}/biomes.json`,
      `workspace/datasets/${currentVersion}/blocks.json`,
      `workspace/datasets/${currentVersion}/items.json`,
      `workspace/datasets/${currentVersion}/recipes.json`,
      `workspace/datasets/${currentVersion}/tags.json`,
      `workspace/datasets/${currentVersion}/translations.json`,
      `workspace/versions/${currentVersion}/decompiled/client/data/minecraft/worldgen`,
      `workspace/datasets/${lastCompleteVersion}/tree-features.json`,
    ],
  },
  currentGrowthMechanics: currentTrees.growth,
  currentTreeExtractionWarnings: currentTrees.warnings,
  woodTypes,
  woodRelatedTags: relevantTagObjects,
};

await writeFile(join(root, "wood-data.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");

function owner(id) {
  const path = id.replace(/^minecraft:/, "");
  for (const { family } of familyDefinitions) {
    if (path.includes(family)) return family;
  }
  return undefined;
}

function displayNameFor(kind, id) {
  const path = id.replace(/^minecraft:/, "");
  return (
    names.get(`${kind}.minecraft.${path}`) ??
    path
      .split("_")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function inferRole(id, family) {
  const path = id.replace(/^minecraft:/, "");
  if (path === `${family}_sapling`) return "sapling";
  if (path === `${family}_fungus`) return "fungus";
  if (path.endsWith("_leaves")) return "leaves";
  if (path === `${family}_log` || path === `${family}_stem`) return "log_or_stem";
  if (path === `stripped_${family}_log` || path === `stripped_${family}_stem`) return "stripped_log_or_stem";
  if (path === `${family}_wood` || path === `${family}_hyphae`) return "wood_or_hyphae";
  if (path === `stripped_${family}_wood` || path === `stripped_${family}_hyphae`) return "stripped_wood_or_hyphae";
  return path.replace(`${family}_`, "");
}

function relevantCompleteFeatures(family) {
  const ids = new Set();
  const grower = family.grower ?? {};
  for (const key of ["tree", "secondaryTree", "megaTree", "secondaryMegaTree", "flowers", "secondaryFlowers"]) {
    if (grower[key]) ids.add(grower[key]);
  }
  for (const fungus of family.fungus?.features ?? []) ids.add(fungus);
  return completeTrees.features.filter((feature) => ids.has(feature.id));
}

async function deriveLocations(allBiomes) {
  const result = new Map(familyDefinitions.map(({ family }) => [family, []]));
  for (const biome of allBiomes) {
    const roots = flatten(biome.raw?.features ?? []).filter(
      (value) => typeof value === "string" && value.startsWith("minecraft:"),
    );
    const evidence = new Map(familyDefinitions.map(({ family }) => [family, []]));
    for (const rootFeature of roots) {
      const graphText = await resolveGraph(rootFeature);
      for (const { family, marker } of familyDefinitions) {
        if (graphText.includes(`"${marker}"`)) evidence.get(family).push(rootFeature);
      }
    }
    for (const { family } of familyDefinitions) {
      const matching = [...new Set(evidence.get(family))].sort();
      if (matching.length === 0) continue;
      result.get(family).push({
        biome: biome.id,
        name: biome.name,
        dimension: biome.dimension,
        category: biome.category,
        placement: biome.placement,
        biomeTags: biome.tags,
        evidencePlacedFeatures: matching,
      });
    }
  }
  for (const entries of result.values()) entries.sort((a, b) => a.biome.localeCompare(b.biome));
  return result;
}

async function resolveGraph(rootId) {
  if (graphCache.has(rootId)) return graphCache.get(rootId);
  const visited = new Set();
  const documents = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const matches = await loadWorldgen(id);
    for (const document of matches) {
      const text = JSON.stringify(document);
      documents.push(text);
      for (const reference of strings(document)) {
        if (reference.startsWith("minecraft:") && !visited.has(reference)) queue.push(reference);
      }
    }
  }
  const text = documents.join("\n");
  graphCache.set(rootId, text);
  return text;
}

async function loadWorldgen(id) {
  const key = id.replace(/^minecraft:/, "");
  const matches = [];
  for (const registry of ["placed_feature", "feature", "configured_feature"]) {
    const path = join(worldgenRoot, registry, `${key}.json`);
    try {
      await access(path);
      matches.push(await json(path));
    } catch {
      continue;
    }
  }
  return matches;
}

function strings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, output);
  return output;
}

function flatten(value, output = []) {
  for (const item of value) {
    if (Array.isArray(item)) flatten(item, output);
    else output.push(item);
  }
  return output;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
