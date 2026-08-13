import type { JsonValue, ModelDefinition, RecipeDefinition, RecipeResultDefinition } from "../domain/types.js";

export function normalizeMinecraftId(value: string): string {
  if (!value) {
    return value;
  }

  if (value.startsWith("#")) {
    return normalizeMinecraftId(value.slice(1));
  }

  return value.includes(":") ? value : `minecraft:${value}`;
}

export function idFromAssetPath(prefix: string, path: string): string {
  return normalizeMinecraftId(path.slice(prefix.length).replace(/\.(json|png)$/i, ""));
}

export function collectBlockModelRefs(raw: JsonValue): string[] {
  const refs = new Set<string>();

  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (value && typeof value === "object") {
      const model = value.model;
      if (typeof model === "string") {
        refs.add(normalizeMinecraftId(model));
      }

      for (const entry of Object.values(value)) {
        visit(entry);
      }
    }
  };

  visit(raw);
  return Array.from(refs).sort();
}

export function collectModelTextureRefs(raw: JsonValue): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }

  const textures = raw.textures;
  if (!textures || typeof textures !== "object" || Array.isArray(textures)) {
    return [];
  }

  const refs = new Set<string>();
  for (const textureValue of Object.values(textures)) {
    if (typeof textureValue !== "string" || textureValue.startsWith("#")) {
      continue;
    }

    refs.add(normalizeMinecraftId(textureValue));
  }

  return Array.from(refs).sort();
}

export function normalizeRecipeResult(value: JsonValue | undefined): RecipeResultDefinition | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return { item: normalizeMinecraftId(value), count: 1 };
  }

  if (!Array.isArray(value) && typeof value === "object") {
    const itemId = typeof value.item === "string" ? value.item : typeof value.id === "string" ? value.id : undefined;
    const item = itemId ? normalizeMinecraftId(itemId) : undefined;
    const tag = typeof value.tag === "string" ? normalizeMinecraftId(value.tag) : undefined;
    const count = typeof value.count === "number" ? value.count : 1;
    const components =
      value.components && typeof value.components === "object" && !Array.isArray(value.components) ? value.components : undefined;

    if (!item && !tag) {
      return undefined;
    }

    return {
      item,
      tag,
      count,
      components,
    };
  }

  return undefined;
}

// The recipe codec uses named slots instead of one shared ingredient property.
// Limit traversal to those slots so metadata such as type, group, category, and
// the symbols in a shaped recipe's pattern cannot be mistaken for item ids.
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

export function normalizeRecipe(id: string, sourcePath: string, raw: JsonValue): RecipeDefinition {
  const ingredients = new Set<string>();
  const ingredientTags = new Set<string>();

  const collectIngredients = (value: JsonValue): void => {
    if (typeof value === "string") {
      if (value.startsWith("#")) {
        ingredientTags.add(normalizeMinecraftId(value));
      } else {
        ingredients.add(normalizeMinecraftId(value));
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        collectIngredients(entry);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const itemId = typeof value.item === "string" ? value.item : typeof value.id === "string" ? value.id : undefined;
    if (itemId) {
      ingredients.add(normalizeMinecraftId(itemId));
    }

    if (typeof value.tag === "string") {
      ingredientTags.add(normalizeMinecraftId(value.tag));
    }

    if (itemId || typeof value.tag === "string") {
      return;
    }

    for (const entry of Object.values(value)) {
      collectIngredients(entry);
    }
  };

  const recipe = !Array.isArray(raw) && raw && typeof raw === "object" ? raw : undefined;
  for (const field of RECIPE_INGREDIENT_FIELDS) {
    const value = recipe?.[field];
    if (value !== undefined) {
      collectIngredients(value);
    }
  }

  const type = recipe && typeof recipe.type === "string" ? recipe.type : "unknown";
  const result = normalizeRecipeResult(recipe?.result ?? recipe?.output);

  return {
    id,
    type,
    ingredients: Array.from(ingredients).sort(),
    ingredientTags: Array.from(ingredientTags).sort(),
    result,
    sourcePath,
    raw,
  };
}

export function ensureTagNamespace(value: string): string {
  if (value.startsWith("#")) {
    const inner = value.slice(1);
    return `#${inner.includes(":") ? inner : `minecraft:${inner}`}`;
  }

  return value.includes(":") ? value : `minecraft:${value}`;
}

export function normalizeTagEntry(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    return ensureTagNamespace(value);
  }

  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string") {
    return ensureTagNamespace(value.id);
  }

  return undefined;
}

export function componentTranslationKey(value: JsonValue | undefined): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return typeof value.translate === "string" ? value.translate : undefined;
}

export function collectLootItemDrops(raw: JsonValue): string[] {
  const drops = new Set<string>();

  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const type = typeof value.type === "string" ? value.type : undefined;
    if ((type === "minecraft:item" || type === "item") && typeof value.name === "string") {
      drops.add(normalizeMinecraftId(value.name));
    }

    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };

  visit(raw);
  return Array.from(drops).sort();
}

export function collectLootFunctions(raw: JsonValue): string[] {
  const functions = new Set<string>();

  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    if (typeof value.function === "string") {
      functions.add(normalizeMinecraftId(value.function));
    }

    for (const entry of Object.values(value)) {
      visit(entry);
    }
  };

  visit(raw);
  return Array.from(functions).sort();
}

export function modelKindFromPath(path: string): ModelDefinition["kind"] {
  if (path.includes("/models/block/")) {
    return "block";
  }

  if (path.includes("/models/item/")) {
    return "item";
  }

  return "other";
}

export function textureKindFromPath(path: string): "block" | "item" | "entity" | "environment" | "other" {
  if (path.includes("/textures/block/")) {
    return "block";
  }

  if (path.includes("/textures/item/")) {
    return "item";
  }

  if (path.includes("/textures/entity/")) {
    return "entity";
  }

  if (path.includes("/textures/environment/") || path.includes("/textures/colormap/")) {
    return "environment";
  }

  return "other";
}
