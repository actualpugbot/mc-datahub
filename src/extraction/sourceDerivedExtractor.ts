import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileExists } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type {
  BlockLightEmission,
  BlockPropertyDefinition,
  ItemArmorStats,
  ItemFoodStats,
  ItemStatDefinition,
  ItemToolStats,
} from "../domain/types.js";
import { normalizeMinecraftId } from "./normalizers.js";

interface StaticDeclaration {
  symbol: string;
  expression: string;
}

interface MethodDeclaration {
  name: string;
  body: string;
}

interface FoodTemplate {
  nutrition?: number;
  saturationModifier?: number;
  alwaysEdible: boolean;
}

interface ToolMaterialStats {
  durability: number;
  speed: number;
  attackDamageBonus: number;
  enchantability: number;
}

type ArmorTypeKey = NonNullable<ItemArmorStats["type"]>;

interface ArmorMaterialStats {
  durabilityMultiplier: number;
  defense: Record<ArmorTypeKey, number>;
  enchantability: number;
  toughness: number;
  knockbackResistance: number;
}

const ITEMS_PATH = "net/minecraft/world/item/Items.java";
const BLOCKS_PATH = "net/minecraft/world/level/block/Blocks.java";
const FOODS_PATH = "net/minecraft/world/food/Foods.java";
const TOOL_MATERIALS_PATH = "net/minecraft/world/item/ToolMaterial.java";
const ARMOR_MATERIALS_PATH = "net/minecraft/world/item/equipment/ArmorMaterials.java";
const ARMOR_TYPES_PATH = "net/minecraft/world/item/equipment/ArmorType.java";

const DEFAULT_ARMOR_DURABILITY: Record<ArmorTypeKey, number> = {
  helmet: 11,
  chestplate: 16,
  leggings: 15,
  boots: 13,
  body: 16,
};

export interface SourceDerivedData {
  itemStats: ItemStatDefinition[];
  blockProperties: BlockPropertyDefinition[];
}

export class DecompiledSourceExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(clientRoot: string): Promise<SourceDerivedData> {
    const itemStats = await this.extractItemStats(clientRoot);
    const blockProperties = await this.extractBlockProperties(clientRoot);

    return {
      itemStats,
      blockProperties,
    };
  }

  private async extractItemStats(clientRoot: string): Promise<ItemStatDefinition[]> {
    const itemsPath = join(clientRoot, ITEMS_PATH);
    if (!(await fileExists(itemsPath))) {
      this.logger.debug(`Skipping item source analysis; ${itemsPath} was not found.`);
      return [];
    }

    const [itemsSource, foodsSource, toolMaterialsSource, armorMaterialsSource, armorTypesSource] = await Promise.all([
      readFile(itemsPath, "utf8"),
      this.readOptional(join(clientRoot, FOODS_PATH)),
      this.readOptional(join(clientRoot, TOOL_MATERIALS_PATH)),
      this.readOptional(join(clientRoot, ARMOR_MATERIALS_PATH)),
      this.readOptional(join(clientRoot, ARMOR_TYPES_PATH)),
    ]);

    const foods = foodsSource ? parseFoods(foodsSource) : new Map<string, FoodTemplate>();
    const toolMaterials = toolMaterialsSource ? parseToolMaterials(toolMaterialsSource) : new Map<string, ToolMaterialStats>();
    const armorDurability = armorTypesSource ? parseArmorDurability(armorTypesSource) : DEFAULT_ARMOR_DURABILITY;
    const armorMaterials = armorMaterialsSource
      ? parseArmorMaterials(armorMaterialsSource)
      : new Map<string, ArmorMaterialStats>();

    return parseStaticDeclarations(itemsSource, "Item")
      .map((declaration) => toItemStatDefinition(declaration, ITEMS_PATH, foods, toolMaterials, armorMaterials, armorDurability))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async extractBlockProperties(clientRoot: string): Promise<BlockPropertyDefinition[]> {
    const blocksPath = join(clientRoot, BLOCKS_PATH);
    if (!(await fileExists(blocksPath))) {
      this.logger.debug(`Skipping block source analysis; ${blocksPath} was not found.`);
      return [];
    }

    const blocksSource = await readFile(blocksPath, "utf8");
    const methods = parseMethods(blocksSource);
    const registrationHelpers = new Map<string, string>();
    const propertyHelpers = new Map<string, string>();

    for (const method of methods) {
      const registrationProperties = extractRegisterProperties(method.body);
      if (registrationProperties) {
        registrationHelpers.set(method.name, registrationProperties);
      }

      const propertyReturn = extractPropertiesReturn(method.body);
      if (propertyReturn) {
        propertyHelpers.set(method.name, propertyReturn);
      }
    }

    return parseStaticDeclarations(blocksSource, "Block")
      .map((declaration) => toBlockPropertyDefinition(declaration, BLOCKS_PATH, registrationHelpers, propertyHelpers))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readOptional(path: string): Promise<string | undefined> {
    if (!(await fileExists(path))) {
      return undefined;
    }

    return readFile(path, "utf8");
  }
}

function toItemStatDefinition(
  declaration: StaticDeclaration,
  sourcePath: string,
  foods: Map<string, FoodTemplate>,
  toolMaterials: Map<string, ToolMaterialStats>,
  armorMaterials: Map<string, ArmorMaterialStats>,
  armorDurability: Record<ArmorTypeKey, number>,
): ItemStatDefinition {
  const outerCall = parseTopLevelCall(declaration.expression);
  const registration = outerCall?.name === "registerBlock" ? "block" : "item";
  const id = normalizeMinecraftId(resolveExplicitId(outerCall?.args[0]) ?? constantToId(declaration.symbol));
  const propertiesExpression = extractItemPropertiesExpression(outerCall);
  const normalizedProperties = propertiesExpression ? collapseWhitespace(propertiesExpression) : "";
  const tool = resolveItemToolStats(declaration.expression, normalizedProperties, toolMaterials);
  const armor = resolveItemArmorStats(normalizedProperties, armorMaterials, armorDurability);
  const explicitDurability = parseLastNumericCall(normalizedProperties, "durability");
  const stackSizeOverride = parseLastIntegerCall(normalizedProperties, "stacksTo");
  const inferredDurability = explicitDurability ?? tool?.durability ?? armor?.durability;
  const food = resolveItemFoodStats(normalizedProperties, foods);

  return {
    id,
    sourcePath,
    sourceSymbol: declaration.symbol,
    registration,
    stackSize: stackSizeOverride ?? (inferredDurability !== undefined ? 1 : 64),
    durability: inferredDurability,
    rarity: parseRarity(normalizedProperties) ?? "common",
    fireResistant: normalizedProperties.includes(".fireResistant()"),
    food,
    tool,
    armor,
  };
}

function toBlockPropertyDefinition(
  declaration: StaticDeclaration,
  sourcePath: string,
  registrationHelpers: Map<string, string>,
  propertyHelpers: Map<string, string>,
): BlockPropertyDefinition {
  const outerCall = parseTopLevelCall(declaration.expression);
  const id = normalizeMinecraftId(resolveExplicitId(outerCall?.args[0]) ?? constantToId(declaration.symbol));
  const basePropertiesExpression = resolveBlockPropertiesExpression(declaration.expression, registrationHelpers);
  const normalizedProperties = basePropertiesExpression
    ? expandBlockPropertiesExpression(collapseWhitespace(basePropertiesExpression), propertyHelpers)
    : "";
  const strengthValues = findLastCallArguments(normalizedProperties, "strength");
  const destroyTimeFromStrength = strengthValues ? parseJavaNumber(strengthValues[0]) : undefined;
  const explosionResistanceFromStrength =
    strengthValues && strengthValues.length > 1 ? parseJavaNumber(strengthValues[1]) : destroyTimeFromStrength;
  const copiedFrom = resolveCopiedFrom(normalizedProperties);

  return {
    id,
    sourcePath,
    sourceSymbol: declaration.symbol,
    copiedFrom,
    destroyTime: parseLastNumericCall(normalizedProperties, "destroyTime") ?? destroyTimeFromStrength ?? resolveInstabreakDestroyTime(normalizedProperties),
    explosionResistance:
      parseLastNumericCall(normalizedProperties, "explosionResistance") ?? explosionResistanceFromStrength,
    requiresCorrectToolForDrops: normalizedProperties.includes(".requiresCorrectToolForDrops()"),
    ignitedByLava: normalizedProperties.includes(".ignitedByLava()"),
    randomTicks: normalizedProperties.includes(".randomTicks()"),
    noCollision: normalizedProperties.includes(".noCollision()"),
    replaceable: normalizedProperties.includes(".replaceable()"),
    mapColor: normalizeReferenceValue(findLastCallArguments(normalizedProperties, "mapColor")?.[0]),
    instrument: normalizeReferenceValue(findLastCallArguments(normalizedProperties, "instrument")?.[0]),
    soundType: normalizeReferenceValue(findLastCallArguments(normalizedProperties, "sound")?.[0]),
    pushReaction: normalizeReferenceValue(findLastCallArguments(normalizedProperties, "pushReaction")?.[0]),
    lightEmission: resolveLightEmission(normalizedProperties),
  };
}

function resolveItemToolStats(
  fullExpression: string,
  propertiesExpression: string,
  toolMaterials: Map<string, ToolMaterialStats>,
): ItemToolStats | undefined {
  const propertyTool = resolvePropertyToolStats(propertiesExpression, toolMaterials);
  if (propertyTool) {
    return propertyTool;
  }

  const constructorTool = resolveConstructorToolStats(fullExpression, toolMaterials);
  if (constructorTool) {
    return constructorTool;
  }

  return undefined;
}

function resolvePropertyToolStats(
  propertiesExpression: string,
  toolMaterials: Map<string, ToolMaterialStats>,
): ItemToolStats | undefined {
  const simpleToolKinds: ItemToolStats["kind"][] = ["sword", "pickaxe", "axe", "shovel", "hoe"];
  for (const kind of simpleToolKinds) {
    const argumentsList = findLastCallArguments(propertiesExpression, kind);
    if (!argumentsList || argumentsList.length < 3) {
      continue;
    }

    const materialName = normalizeReferenceValue(argumentsList[0]);
    if (!materialName) {
      continue;
    }

    const material = toolMaterials.get(materialName);
    const attackBaseline = parseJavaNumber(argumentsList[1]);
    const attackSpeed = parseJavaNumber(argumentsList[2]);
    return {
      kind,
      material: materialName,
      durability: material?.durability,
      miningSpeed: material?.speed,
      enchantability: material?.enchantability,
      attackDamage: attackBaseline !== undefined ? attackBaseline + (material?.attackDamageBonus ?? 0) : undefined,
      attackSpeed,
    };
  }

  const spearArguments = findLastCallArguments(propertiesExpression, "spear");
  if (spearArguments && spearArguments.length >= 2) {
    const materialName = normalizeReferenceValue(spearArguments[0]);
    if (materialName) {
      const material = toolMaterials.get(materialName);
      const attackDuration = parseJavaNumber(spearArguments[1]);
      return {
        kind: "spear",
        material: materialName,
        durability: material?.durability,
        miningSpeed: material?.speed,
        enchantability: material?.enchantability,
        attackDamage: material?.attackDamageBonus,
        attackSpeed: attackDuration !== undefined ? 1 / attackDuration - 4 : undefined,
      };
    }
  }

  return undefined;
}

function resolveConstructorToolStats(
  fullExpression: string,
  toolMaterials: Map<string, ToolMaterialStats>,
): ItemToolStats | undefined {
  const constructorKinds = new Map<string, Exclude<ItemToolStats["kind"], "sword" | "pickaxe" | "spear">>([
    ["AxeItem", "axe"],
    ["ShovelItem", "shovel"],
    ["HoeItem", "hoe"],
  ]);

  for (const [constructorName, kind] of constructorKinds) {
    const argumentsList = findConstructorArguments(fullExpression, constructorName);
    if (!argumentsList || argumentsList.length < 3) {
      continue;
    }

    const materialName = normalizeReferenceValue(argumentsList[0]);
    if (!materialName) {
      continue;
    }

    const material = toolMaterials.get(materialName);
    const attackBaseline = parseJavaNumber(argumentsList[1]);
    const attackSpeed = parseJavaNumber(argumentsList[2]);
    return {
      kind,
      material: materialName,
      durability: material?.durability,
      miningSpeed: material?.speed,
      enchantability: material?.enchantability,
      attackDamage: attackBaseline !== undefined ? attackBaseline + (material?.attackDamageBonus ?? 0) : undefined,
      attackSpeed,
    };
  }

  return undefined;
}

function resolveItemArmorStats(
  propertiesExpression: string,
  armorMaterials: Map<string, ArmorMaterialStats>,
  armorDurability: Record<ArmorTypeKey, number>,
): ItemArmorStats | undefined {
  const humanoidArguments = findLastCallArguments(propertiesExpression, "humanoidArmor");
  if (humanoidArguments && humanoidArguments.length >= 2) {
    const materialName = normalizeReferenceValue(humanoidArguments[0]);
    const armorType = normalizeReferenceValue(humanoidArguments[1]) as ArmorTypeKey | undefined;
    const material = materialName ? armorMaterials.get(materialName) : undefined;
    if (materialName && armorType) {
      return {
        category: "humanoid",
        material: materialName,
        type: armorType,
        durability: material ? material.durabilityMultiplier * armorDurability[armorType] : undefined,
        defense: material?.defense[armorType],
        enchantability: material?.enchantability,
        toughness: material?.toughness,
        knockbackResistance: material?.knockbackResistance,
      };
    }
  }

  const simpleArmorKinds: Array<["wolfArmor" | "horseArmor" | "nautilusArmor", ItemArmorStats["category"]]> = [
    ["wolfArmor", "wolf"],
    ["horseArmor", "horse"],
    ["nautilusArmor", "nautilus"],
  ];
  for (const [callName, category] of simpleArmorKinds) {
    const argumentsList = findLastCallArguments(propertiesExpression, callName);
    if (!argumentsList || argumentsList.length === 0) {
      continue;
    }

    const materialName = normalizeReferenceValue(argumentsList[0]);
    const material = materialName ? armorMaterials.get(materialName) : undefined;
    if (!materialName) {
      continue;
    }

    const durability =
      category === "wolf" && material?.durabilityMultiplier !== undefined
        ? material.durabilityMultiplier * armorDurability.body
        : undefined;
    const enchantability = category === "wolf" ? material?.enchantability : undefined;
    return {
      category,
      material: materialName,
      type: "body",
      durability,
      defense: material?.defense.body,
      enchantability,
      toughness: material?.toughness,
      knockbackResistance: material?.knockbackResistance,
    };
  }

  return undefined;
}

function resolveItemFoodStats(
  propertiesExpression: string,
  foods: Map<string, FoodTemplate>,
): ItemFoodStats | undefined {
  const argumentsList = findLastCallArguments(propertiesExpression, "food");
  if (!argumentsList || argumentsList.length === 0) {
    return undefined;
  }

  const foodReference = normalizeReferenceValue(argumentsList[0]);
  if (!foodReference) {
    return undefined;
  }

  const template = foods.get(foodReference);
  return {
    reference: foodReference,
    consumable: normalizeReferenceValue(argumentsList[1]),
    nutrition: template?.nutrition,
    saturationModifier: template?.saturationModifier,
    alwaysEdible: template?.alwaysEdible,
  };
}

function resolveBlockPropertiesExpression(expression: string, registrationHelpers: Map<string, string>): string | undefined {
  const call = parseTopLevelCall(expression);
  if (!call) {
    return undefined;
  }

  if (call.name === "register") {
    return call.args.at(-1);
  }

  return registrationHelpers.get(call.name);
}

function expandBlockPropertiesExpression(expression: string, propertyHelpers: Map<string, string>, depth = 0): string {
  if (depth >= 4) {
    return expression;
  }

  const call = parseTopLevelCall(expression);
  if (!call) {
    return expression;
  }

  const helperExpression = propertyHelpers.get(call.name);
  if (!helperExpression) {
    return expression;
  }

  const openIndex = expression.indexOf("(");
  if (openIndex < 0) {
    return expression;
  }

  const closeIndex = findMatchingParen(expression, openIndex);
  if (closeIndex < 0) {
    return expression;
  }

  const suffix = expression.slice(closeIndex + 1);
  return expandBlockPropertiesExpression(collapseWhitespace(`${helperExpression}${suffix}`), propertyHelpers, depth + 1);
}

function resolveLightEmission(expression: string): BlockLightEmission | undefined {
  const argumentsList = findLastCallArguments(expression, "lightLevel");
  if (!argumentsList || argumentsList.length === 0) {
    return undefined;
  }

  const raw = argumentsList[0]?.trim();
  if (!raw) {
    return undefined;
  }

  const lambdaConstant = raw.match(/->\s*(-?\d+(?:\.\d+)?)F?$/);
  if (lambdaConstant) {
    return {
      kind: "constant",
      value: parseJavaNumber(lambdaConstant[1]),
    };
  }

  const litConstant = raw.match(/^litBlockEmission\((.+)\)$/);
  if (litConstant) {
    return {
      kind: "lit",
      value: parseJavaNumber(litConstant[1]),
      expression: collapseWhitespace(raw),
    };
  }

  return {
    kind: "dynamic",
    expression: collapseWhitespace(raw),
  };
}

function resolveInstabreakDestroyTime(expression: string): number | undefined {
  return expression.includes(".instabreak()") ? 0 : undefined;
}

function resolveCopiedFrom(expression: string): string | undefined {
  const copiedFrom = findLastCallArguments(expression, "ofLegacyCopy")?.[0] ?? findLastCallArguments(expression, "ofFullCopy")?.[0];
  const normalized = normalizeReferenceValue(copiedFrom);
  return normalized ? normalizeMinecraftId(normalized) : undefined;
}

function parseFoods(source: string): Map<string, FoodTemplate> {
  const declarations = parseStaticDeclarations(source, "FoodProperties");
  const foods = new Map<string, FoodTemplate>();

  for (const declaration of declarations) {
    const expandedExpression = declaration.expression.replace(/stew\((\d+)\)/g, (_match, nutrition: string) => {
      return `new FoodProperties.Builder().nutrition(${nutrition}).saturationModifier(0.6F)`;
    });

    foods.set(constantToId(declaration.symbol), {
      nutrition: parseLastIntegerCall(expandedExpression, "nutrition"),
      saturationModifier: parseLastNumericCall(expandedExpression, "saturationModifier"),
      alwaysEdible: expandedExpression.includes(".alwaysEdible()"),
    });
  }

  return foods;
}

function parseToolMaterials(source: string): Map<string, ToolMaterialStats> {
  const declarations = parseStaticDeclarations(source, "ToolMaterial");
  const materials = new Map<string, ToolMaterialStats>();

  for (const declaration of declarations) {
    const call = parseTopLevelCall(declaration.expression.replace(/^new\s+/, ""));
    if (!call || call.name !== "ToolMaterial" || call.args.length < 5) {
      continue;
    }

    const durability = parseJavaInteger(call.args[1]);
    const speed = parseJavaNumber(call.args[2]);
    const attackDamageBonus = parseJavaNumber(call.args[3]);
    const enchantability = parseJavaInteger(call.args[4]);
    if (
      durability === undefined ||
      speed === undefined ||
      attackDamageBonus === undefined ||
      enchantability === undefined
    ) {
      continue;
    }

    materials.set(constantToId(declaration.symbol), {
      durability,
      speed,
      attackDamageBonus,
      enchantability,
    });
  }

  return materials;
}

function parseArmorDurability(source: string): Record<ArmorTypeKey, number> {
  const values: Partial<Record<ArmorTypeKey, number>> = {};
  const pattern = /^\s*(HELMET|CHESTPLATE|LEGGINGS|BOOTS|BODY)\([^,]+,\s*(\d+),/gm;

  for (const match of source.matchAll(pattern)) {
    const key = constantToId(match[1] ?? "") as ArmorTypeKey;
    const value = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isNaN(value)) {
      values[key] = value;
    }
  }

  return {
    helmet: values.helmet ?? DEFAULT_ARMOR_DURABILITY.helmet,
    chestplate: values.chestplate ?? DEFAULT_ARMOR_DURABILITY.chestplate,
    leggings: values.leggings ?? DEFAULT_ARMOR_DURABILITY.leggings,
    boots: values.boots ?? DEFAULT_ARMOR_DURABILITY.boots,
    body: values.body ?? DEFAULT_ARMOR_DURABILITY.body,
  };
}

function parseArmorMaterials(source: string): Map<string, ArmorMaterialStats> {
  const declarations = parseAssignments(source, "ArmorMaterial");
  const materials = new Map<string, ArmorMaterialStats>();

  for (const declaration of declarations) {
    const call = parseTopLevelCall(declaration.expression.replace(/^new\s+/, ""));
    if (!call || call.name !== "ArmorMaterial" || call.args.length < 6) {
      continue;
    }

    const durabilityMultiplier = parseJavaInteger(call.args[0]);
    const defenseArguments = extractMakeDefenseArguments(call.args[1]);
    const enchantability = parseJavaInteger(call.args[2]);
    const toughness = parseJavaNumber(call.args[4]);
    const knockbackResistance = parseJavaNumber(call.args[5]);
    if (
      durabilityMultiplier === undefined ||
      !defenseArguments ||
      enchantability === undefined ||
      toughness === undefined ||
      knockbackResistance === undefined
    ) {
      continue;
    }

    materials.set(constantToId(declaration.symbol), {
      durabilityMultiplier,
      defense: {
        boots: defenseArguments.boots,
        leggings: defenseArguments.leggings,
        chestplate: defenseArguments.chestplate,
        helmet: defenseArguments.helmet,
        body: defenseArguments.body,
      },
      enchantability,
      toughness,
      knockbackResistance,
    });
  }

  return materials;
}

function extractMakeDefenseArguments(
  expression: string | undefined,
): Record<ArmorTypeKey, number> | undefined {
  if (!expression) {
    return undefined;
  }

  const call = parseTopLevelCall(expression.replace(/^new\s+/, ""));
  if (!call || call.name !== "makeDefense" || call.args.length < 5) {
    return undefined;
  }

  const boots = parseJavaInteger(call.args[0]);
  const leggings = parseJavaInteger(call.args[1]);
  const chestplate = parseJavaInteger(call.args[2]);
  const helmet = parseJavaInteger(call.args[3]);
  const body = parseJavaInteger(call.args[4]);
  if (
    boots === undefined ||
    leggings === undefined ||
    chestplate === undefined ||
    helmet === undefined ||
    body === undefined
  ) {
    return undefined;
  }

  return { boots, leggings, chestplate, helmet, body };
}

function extractItemPropertiesExpression(call: ParsedCall | undefined): string | undefined {
  if (!call) {
    return undefined;
  }

  if (call.name === "registerItem") {
    for (let index = call.args.length - 1; index >= 0; index -= 1) {
      const argument = call.args[index];
      if (argument && argument.includes("Item.Properties")) {
        return argument;
      }
    }
  }

  if (call.name === "registerBlock") {
    const lastArgument = call.args.at(-1);
    if (lastArgument?.includes("Item.Properties")) {
      return lastArgument;
    }

    const secondArgument = call.args[1];
    if (secondArgument?.startsWith("p -> p.")) {
      return secondArgument;
    }
  }

  return undefined;
}

function extractRegisterProperties(body: string): string | undefined {
  const match = body.match(/return\s+register\(([\s\S]+?)\);\s*$/);
  if (!match) {
    return undefined;
  }

  const call = parseTopLevelCall(`register(${match[1] ?? ""})`);
  return call?.args.at(-1);
}

function extractPropertiesReturn(body: string): string | undefined {
  const match = body.match(/return\s+((?:BlockBehaviour\.Properties|[a-zA-Z_][a-zA-Z0-9_]*)[\s\S]+?);\s*$/);
  if (!match) {
    return undefined;
  }

  const expression = collapseWhitespace(match[1] ?? "");
  if (!expression.includes("Properties")) {
    return undefined;
  }

  return expression;
}

function parseMethods(source: string): MethodDeclaration[] {
  const methods: MethodDeclaration[] = [];
  const pattern = /private static [^{]+ (\w+)\([^)]*\)\s*\{/g;

  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const openBraceIndex = source.indexOf("{", match.index ?? 0);
    if (!name || openBraceIndex < 0) {
      continue;
    }

    const closeBraceIndex = findMatchingBrace(source, openBraceIndex);
    if (closeBraceIndex < 0) {
      continue;
    }

    methods.push({
      name,
      body: source.slice(openBraceIndex + 1, closeBraceIndex).trim(),
    });
  }

  return methods;
}

function parseStaticDeclarations(source: string, typeName: string): StaticDeclaration[] {
  return parseAssignments(source, `public static final ${typeName}`);
}

function parseAssignments(source: string, prefix: string): StaticDeclaration[] {
  const declarations: StaticDeclaration[] = [];
  const pattern = new RegExp(`${escapeRegExp(prefix)}\\s+([A-Z0-9_]+)\\s*=\\s*`, "g");

  for (const match of source.matchAll(pattern)) {
    const symbol = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = findStatementEnd(source, start);
    if (!symbol || end < 0) {
      continue;
    }

    declarations.push({
      symbol,
      expression: collapseWhitespace(source.slice(start, end)),
    });
  }

  return declarations;
}

interface ParsedCall {
  name: string;
  args: string[];
}

function parseTopLevelCall(expression: string): ParsedCall | undefined {
  const normalized = collapseWhitespace(expression);
  const openIndex = normalized.indexOf("(");
  if (openIndex < 0) {
    return undefined;
  }

  const closeIndex = findMatchingParen(normalized, openIndex);
  if (closeIndex < 0) {
    return undefined;
  }

  return {
    name: normalized.slice(0, openIndex).trim().replace(/^new\s+/, ""),
    args: splitTopLevelArgs(normalized.slice(openIndex + 1, closeIndex)),
  };
}

function findStatementEnd(source: string, start: number): number {
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === stringQuote) {
        inString = false;
        stringQuote = "";
      }

      continue;
    }

    if (character === '"' || character === "'") {
      inString = true;
      stringQuote = character;
      continue;
    }

    if (character === "(") {
      parentheses += 1;
      continue;
    }

    if (character === ")") {
      parentheses -= 1;
      continue;
    }

    if (character === "{") {
      braces += 1;
      continue;
    }

    if (character === "}") {
      braces -= 1;
      continue;
    }

    if (character === "[") {
      brackets += 1;
      continue;
    }

    if (character === "]") {
      brackets -= 1;
      continue;
    }

    if (character === ";" && parentheses === 0 && braces === 0 && brackets === 0) {
      return index;
    }
  }

  return -1;
}

function splitTopLevelArgs(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === stringQuote) {
        inString = false;
        stringQuote = "";
      }

      continue;
    }

    if (character === '"' || character === "'") {
      inString = true;
      stringQuote = character;
      continue;
    }

    if (character === "(") {
      parentheses += 1;
      continue;
    }

    if (character === ")") {
      parentheses -= 1;
      continue;
    }

    if (character === "{") {
      braces += 1;
      continue;
    }

    if (character === "}") {
      braces -= 1;
      continue;
    }

    if (character === "[") {
      brackets += 1;
      continue;
    }

    if (character === "]") {
      brackets -= 1;
      continue;
    }

    if (character === "," && parentheses === 0 && braces === 0 && brackets === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  const lastPart = value.slice(start).trim();
  if (lastPart) {
    parts.push(lastPart);
  }

  return parts;
}

function findMatchingParen(value: string, openIndex: number): number {
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let depth = 0;

  for (let index = openIndex; index < value.length; index += 1) {
    const character = value[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === stringQuote) {
        inString = false;
        stringQuote = "";
      }

      continue;
    }

    if (character === '"' || character === "'") {
      inString = true;
      stringQuote = character;
      continue;
    }

    if (character === "(") {
      depth += 1;
      continue;
    }

    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findMatchingBrace(value: string, openIndex: number): number {
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let depth = 0;

  for (let index = openIndex; index < value.length; index += 1) {
    const character = value[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === stringQuote) {
        inString = false;
        stringQuote = "";
      }

      continue;
    }

    if (character === '"' || character === "'") {
      inString = true;
      stringQuote = character;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findCallArguments(expression: string, callName: string): string[][] {
  const argumentsList: string[][] = [];
  const pattern = new RegExp(`\\b${escapeRegExp(callName)}\\(`, "g");

  for (const match of expression.matchAll(pattern)) {
    const openIndex = expression.indexOf("(", match.index);
    if (openIndex < 0) {
      continue;
    }

    const closeIndex = findMatchingParen(expression, openIndex);
    if (closeIndex < 0) {
      continue;
    }

    argumentsList.push(splitTopLevelArgs(expression.slice(openIndex + 1, closeIndex)));
  }

  return argumentsList;
}

function findLastCallArguments(expression: string, callName: string): string[] | undefined {
  const matches = findCallArguments(expression, callName);
  return matches.at(-1);
}

function findConstructorArguments(expression: string, constructorName: string): string[] | undefined {
  const matches = findCallArguments(expression, constructorName);
  return matches.at(-1);
}

function parseLastNumericCall(expression: string, callName: string): number | undefined {
  const argument = findLastCallArguments(expression, callName)?.[0];
  return parseJavaNumber(argument);
}

function parseLastIntegerCall(expression: string, callName: string): number | undefined {
  const argument = findLastCallArguments(expression, callName)?.[0];
  return parseJavaInteger(argument);
}

function parseJavaNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = collapseWhitespace(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return undefined;
  }

  return Number.parseFloat(match[0]);
}

function parseJavaInteger(value: string | undefined): number | undefined {
  const parsed = parseJavaNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function parseRarity(expression: string): ItemStatDefinition["rarity"] | undefined {
  const rarity = normalizeReferenceValue(findLastCallArguments(expression, "rarity")?.[0]);
  if (!rarity || !["common", "uncommon", "rare", "epic"].includes(rarity)) {
    return undefined;
  }

  return rarity as ItemStatDefinition["rarity"];
}

function resolveExplicitId(argument: string | undefined): string | undefined {
  if (!argument) {
    return undefined;
  }

  const trimmed = argument.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  return undefined;
}

function normalizeReferenceValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = collapseWhitespace(value)
    .replace(/^new\s+/, "")
    .replace(/^p\s*->\s*p\./, "")
    .trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  const identifierMatch = trimmed.match(/([A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)$/);
  if (!identifierMatch) {
    return undefined;
  }

  return constantToId(identifierMatch[1] ?? "");
}

function constantToId(value: string): string {
  return value.toLowerCase();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
