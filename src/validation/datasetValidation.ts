import type {
  DatasetValidationIssue,
  DatasetValidationReport,
  JsonValue,
  TagDefinition,
  VersionDataset,
} from "../domain/types.js";
import { normalizeMinecraftId } from "../extraction/normalizers.js";

const RECIPE_INGREDIENT_FIELDS = [
  "ingredient",
  "ingredients",
  "key",
  "template",
  "base",
  "addition",
  "input",
  "reagent",
  "back",
  "front",
  "left",
  "right",
  "dye",
  "target",
  "material",
  "source",
  "banner",
  "fuel",
  "shell",
  "star",
  "shapes",
  "trail",
  "twinkle",
  "map",
] as const;

export function validateDataset(dataset: VersionDataset): DatasetValidationReport {
  const issues: DatasetValidationIssue[] = [];
  const itemById = new Map(dataset.items.map((item) => [item.id, item]));
  const recipeById = new Map(dataset.recipes.map((recipe) => [recipe.id, recipe]));
  let concreteRecipeOutputs = 0;
  let declaredIngredientRecipes = 0;

  for (const recipe of dataset.recipes) {
    const raw = asObject(recipe.raw);
    const rawResult = raw?.result ?? raw?.output;
    const expectedResult = concreteResult(rawResult);
    if (expectedResult) {
      concreteRecipeOutputs += 1;
      if (
        recipe.result?.item !== expectedResult.item ||
        recipe.result?.tag !== expectedResult.tag ||
        (recipe.result?.count ?? 1) !== expectedResult.count
      ) {
        issues.push({
          code: "invalid_normalized_recipe_result",
          severity: "error",
          collection: "recipes",
          id: recipe.id,
          sourcePath: recipe.sourcePath,
          message: `${recipe.id} declares a concrete raw result that is missing or incorrect after normalization.`,
        });
      }
    }

    if (raw && RECIPE_INGREDIENT_FIELDS.some((field) => raw[field] !== undefined)) {
      declaredIngredientRecipes += 1;
      if (recipe.ingredients.length === 0 && recipe.ingredientTags.length === 0) {
        issues.push({
          code: "missing_normalized_recipe_ingredients",
          severity: "error",
          collection: "recipes",
          id: recipe.id,
          sourcePath: recipe.sourcePath,
          message: `${recipe.id} declares ingredient fields but has no normalized item or tag inputs.`,
        });
      }
    }

    if (recipe.result?.item) {
      const outputItem = itemById.get(recipe.result.item);
      if (outputItem && !outputItem.recipeIds.includes(recipe.id)) {
        issues.push({
          code: "missing_item_recipe_link",
          severity: "error",
          collection: "items",
          id: outputItem.id,
          sourcePath: outputItem.sourcePath,
          message: `${outputItem.id} is produced by ${recipe.id} but does not link back to that recipe.`,
        });
      }
    }
  }

  for (const item of dataset.items) {
    for (const recipeId of item.recipeIds) {
      const recipe = recipeById.get(recipeId);
      if (!recipe || recipe.result?.item !== item.id) {
        issues.push({
          code: "stale_item_recipe_link",
          severity: "error",
          collection: "items",
          id: item.id,
          sourcePath: item.sourcePath,
          message: `${item.id} links to ${recipeId}, which does not produce that item.`,
        });
      }
    }
  }

  validateTagMembership("block", dataset.tags, dataset.blocks, issues);
  validateTagMembership("item", dataset.tags, dataset.items, issues);

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return {
    version: dataset.version,
    generatedAt: new Date().toISOString(),
    status: errorCount === 0 ? "passed" : "failed",
    counts: {
      recipes: dataset.recipes.length,
      concreteRecipeOutputs,
      normalizedRecipeOutputs: dataset.recipes.filter((recipe) => recipe.result?.item || recipe.result?.tag).length,
      declaredIngredientRecipes,
      normalizedIngredientRecipes: dataset.recipes.filter(
        (recipe) => recipe.ingredients.length > 0 || recipe.ingredientTags.length > 0,
      ).length,
      items: dataset.items.length,
      itemsWithTags: dataset.items.filter((item) => item.tags.length > 0).length,
      itemRecipeLinks: dataset.items.reduce((total, item) => total + item.recipeIds.length, 0),
      blocks: dataset.blocks.length,
      blocksWithTags: dataset.blocks.filter((block) => block.tags.length > 0).length,
      issues: issues.length,
      errors: errorCount,
      warnings: warningCount,
    },
    issues: issues.sort((left, right) =>
      `${left.code}:${left.collection}:${left.id ?? ""}`.localeCompare(`${right.code}:${right.collection}:${right.id ?? ""}`),
    ),
  };
}

function concreteResult(value: JsonValue | undefined): { item?: string; tag?: string; count: number } | undefined {
  if (typeof value === "string") {
    return { item: normalizeMinecraftId(value), count: 1 };
  }
  const object = asObject(value);
  if (!object) {
    return undefined;
  }

  const itemId = typeof object.item === "string" ? object.item : typeof object.id === "string" ? object.id : undefined;
  const tagId = typeof object.tag === "string" ? object.tag : undefined;
  if (!itemId && !tagId) {
    return undefined;
  }
  return {
    item: itemId ? normalizeMinecraftId(itemId) : undefined,
    tag: tagId ? normalizeMinecraftId(tagId) : undefined,
    count: typeof object.count === "number" ? object.count : 1,
  };
}

function validateTagMembership(
  registry: "block" | "item",
  tags: TagDefinition[],
  records: Array<{ id: string; tags: string[]; sourcePath?: string; blockstatePath?: string }>,
  issues: DatasetValidationIssue[],
): void {
  const definitions = new Map<string, string[]>();
  for (const tag of tags.filter((entry) => entry.registry === registry || entry.registry === `${registry}s`)) {
    const existing = tag.replace ? [] : (definitions.get(tag.id) ?? []);
    definitions.set(tag.id, Array.from(new Set([...existing, ...tag.values])));
  }

  const resolved = new Map<string, Set<string>>();
  const resolve = (tagId: string, visiting: Set<string>): Set<string> => {
    const cached = resolved.get(tagId);
    if (cached) return cached;
    if (visiting.has(tagId)) return new Set();

    const nextVisiting = new Set(visiting);
    nextVisiting.add(tagId);
    const members = new Set<string>();
    for (const value of definitions.get(tagId) ?? []) {
      if (value.startsWith("#")) {
        for (const member of resolve(normalizeMinecraftId(value.slice(1)), nextVisiting)) members.add(member);
      } else {
        members.add(normalizeMinecraftId(value));
      }
    }
    resolved.set(tagId, members);
    return members;
  };

  const expectedByRecord = new Map<string, Set<string>>();
  for (const tagId of definitions.keys()) {
    for (const member of resolve(tagId, new Set())) {
      const expected = expectedByRecord.get(member) ?? new Set<string>();
      expected.add(tagId);
      expectedByRecord.set(member, expected);
    }
  }

  for (const record of records) {
    const expected = expectedByRecord.get(record.id) ?? new Set<string>();
    const actual = new Set(record.tags);
    for (const tagId of expected) {
      if (!actual.has(tagId)) {
        issues.push({
          code: "missing_normalized_tag_membership",
          severity: "error",
          collection: registry === "block" ? "blocks" : "items",
          id: record.id,
          sourcePath: record.sourcePath ?? record.blockstatePath,
          message: `${record.id} belongs to #${tagId} but its normalized tag membership is missing.`,
        });
      }
    }
    for (const tagId of actual) {
      if (!expected.has(tagId)) {
        issues.push({
          code: "stale_normalized_tag_membership",
          severity: "error",
          collection: registry === "block" ? "blocks" : "items",
          id: record.id,
          sourcePath: record.sourcePath ?? record.blockstatePath,
          message: `${record.id} lists #${tagId}, but that tag does not resolve back to the record.`,
        });
      }
    }
  }
}

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
