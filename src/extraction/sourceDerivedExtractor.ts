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
  params: string[];
  body: string;
}

interface RegistrationHelper {
  expression: string;
  params: string[];
}

interface FoodTemplate {
  nutrition?: number;
  saturationModifier?: number;
  alwaysEdible: boolean;
}

interface DyeColorDefinition {
  name: string;
  mapColor: string;
  terracottaColor: string;
}

interface ReferenceId {
  block?: string;
  item?: string;
}

// Index of the net/minecraft/references id classes, used to resolve `BlockItemIds.X` /
// `BlockIds.X` / `ItemIds.X` symbols back to their registered ids. `singles` maps a
// qualified reference (e.g. "BlockItemIds.STONE") to its block/item ids; `collections`
// maps a color/copper collection reference to the full list of expanded ids.
interface ReferenceIndex {
  singles: Map<string, ReferenceId>;
  collections: Map<string, string[]>;
}

interface SourceContext {
  references: ReferenceIndex;
  dyeColors: DyeColorDefinition[];
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
const DYE_COLOR_PATH = "net/minecraft/world/item/DyeColor.java";
// Reference id classes were introduced in the 26.2 source refactor; older versions
// register blocks/items with inline string-literal ids and omit some of these files.
const REFERENCE_ID_PATHS = [
  "net/minecraft/references/BlockItemIds.java",
  "net/minecraft/references/BlockIds.java",
  "net/minecraft/references/ItemIds.java",
];

// Weathering-copper id prefixes, mirroring WeatheringCopperCollection.PREFIXES. The
// collection expands each base name across four weather states, both unwaxed and waxed.
const COPPER_WEATHERING_PREFIXES = ["", "exposed_", "weathered_", "oxidized_"] as const;
const COPPER_WAXED_PREFIXES = ["waxed_", "waxed_exposed_", "waxed_weathered_", "waxed_oxidized_"] as const;
// WeatheringCopper.WeatherState ordering; the nth state lines up with the nth weathering
// (and waxed) id, so `idIndex % 4` selects the state for the per-state copper switches.
const WEATHER_STATES = ["UNAFFECTED", "EXPOSED", "WEATHERED", "OXIDIZED"] as const;

// Fallback dye-color ordering/map-colors used when DyeColor.java cannot be parsed. The
// order mirrors the ColorCollection record fields so generated ids line up with the source.
const FALLBACK_DYE_COLORS: DyeColorDefinition[] = [
  { name: "white", mapColor: "snow", terracottaColor: "terracotta_white" },
  { name: "orange", mapColor: "color_orange", terracottaColor: "terracotta_orange" },
  { name: "magenta", mapColor: "color_magenta", terracottaColor: "terracotta_magenta" },
  { name: "light_blue", mapColor: "color_light_blue", terracottaColor: "terracotta_light_blue" },
  { name: "yellow", mapColor: "color_yellow", terracottaColor: "terracotta_yellow" },
  { name: "lime", mapColor: "color_light_green", terracottaColor: "terracotta_light_green" },
  { name: "pink", mapColor: "color_pink", terracottaColor: "terracotta_pink" },
  { name: "gray", mapColor: "color_gray", terracottaColor: "terracotta_gray" },
  { name: "light_gray", mapColor: "color_light_gray", terracottaColor: "terracotta_light_gray" },
  { name: "cyan", mapColor: "color_cyan", terracottaColor: "terracotta_cyan" },
  { name: "purple", mapColor: "color_purple", terracottaColor: "terracotta_purple" },
  { name: "blue", mapColor: "color_blue", terracottaColor: "terracotta_blue" },
  { name: "brown", mapColor: "color_brown", terracottaColor: "terracotta_brown" },
  { name: "green", mapColor: "color_green", terracottaColor: "terracotta_green" },
  { name: "red", mapColor: "color_red", terracottaColor: "terracotta_red" },
  { name: "black", mapColor: "color_black", terracottaColor: "terracotta_black" },
];

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
    const context = await this.loadSourceContext(clientRoot);
    const itemStats = await this.extractItemStats(clientRoot, context);
    const blockProperties = await this.extractBlockProperties(clientRoot, context);

    return {
      itemStats,
      blockProperties,
    };
  }

  private async loadSourceContext(clientRoot: string): Promise<SourceContext> {
    const referenceSources = await Promise.all(
      REFERENCE_ID_PATHS.map(async (relativePath) => ({
        className: relativePath.slice(relativePath.lastIndexOf("/") + 1).replace(/\.java$/, ""),
        source: await this.readOptional(join(clientRoot, relativePath)),
      })),
    );
    const dyeSource = await this.readOptional(join(clientRoot, DYE_COLOR_PATH));
    const dyeColors = dyeSource ? parseDyeColors(dyeSource) : FALLBACK_DYE_COLORS;
    const references = buildReferenceIndex(referenceSources, dyeColors);

    return { references, dyeColors };
  }

  private async extractItemStats(clientRoot: string, context: SourceContext): Promise<ItemStatDefinition[]> {
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

    const stats = new Map<string, ItemStatDefinition>();
    for (const declaration of parseStaticDeclarations(itemsSource, "Item")) {
      const definition = toItemStatDefinition(
        declaration,
        ITEMS_PATH,
        foods,
        toolMaterials,
        armorMaterials,
        context,
        armorDurability,
      );
      stats.set(definition.id, definition);
    }

    for (const definition of expandItemCollections(itemsSource, foods, toolMaterials, armorMaterials, context, armorDurability)) {
      // Single declarations win over collection expansions if they ever collide.
      if (!stats.has(definition.id)) {
        stats.set(definition.id, definition);
      }
    }

    return Array.from(stats.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  private async extractBlockProperties(clientRoot: string, context: SourceContext): Promise<BlockPropertyDefinition[]> {
    const blocksPath = join(clientRoot, BLOCKS_PATH);
    if (!(await fileExists(blocksPath))) {
      this.logger.debug(`Skipping block source analysis; ${blocksPath} was not found.`);
      return [];
    }

    const blocksSource = await readFile(blocksPath, "utf8");
    const methods = parseMethods(blocksSource);
    const registrationHelpers = new Map<string, RegistrationHelper>();
    const propertyHelpers = new Map<string, string>();

    for (const method of methods) {
      const registrationProperties = extractRegisterProperties(method.body);
      if (registrationProperties) {
        registrationHelpers.set(method.name, { expression: registrationProperties, params: method.params });
      }

      const propertyReturn = extractPropertiesReturn(method.body);
      if (propertyReturn) {
        propertyHelpers.set(method.name, propertyReturn);
      }
    }

    const properties = new Map<string, BlockPropertyDefinition>();
    for (const declaration of parseStaticDeclarations(blocksSource, "Block")) {
      const definition = toBlockPropertyDefinition(declaration, BLOCKS_PATH, registrationHelpers, propertyHelpers, context);
      properties.set(definition.id, definition);
    }

    for (const definition of expandBlockCollections(blocksSource, propertyHelpers, context)) {
      // Single declarations win over collection expansions if they ever collide.
      if (!properties.has(definition.id)) {
        properties.set(definition.id, definition);
      }
    }

    // Blocks declared via ofFullCopy/ofLegacyCopy inherit the source block's physical
    // properties; fill those in once every block (incl. copy sources) has been parsed.
    resolveCopyInheritance(properties);

    return Array.from(properties.values()).sort((left, right) => left.id.localeCompare(right.id));
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
  context: SourceContext,
  armorDurability: Record<ArmorTypeKey, number>,
): ItemStatDefinition {
  const outerCall = parseTopLevelCall(declaration.expression);
  const registration = outerCall?.name === "registerBlock" ? "block" : "item";
  const id = normalizeMinecraftId(
    resolveExplicitId(outerCall?.args[0]) ??
      resolveReferenceId(outerCall?.args[0], "item", context.references) ??
      constantToId(declaration.symbol),
  );
  const propertiesExpression = extractItemPropertiesExpression(outerCall);
  const normalizedProperties = propertiesExpression ? collapseWhitespace(propertiesExpression) : "";

  return buildItemStat({
    id,
    sourcePath,
    sourceSymbol: declaration.symbol,
    registration,
    fullExpression: declaration.expression,
    normalizedProperties,
    foods,
    toolMaterials,
    armorMaterials,
    armorDurability,
  });
}

interface ItemStatInput {
  id: string;
  sourcePath: string;
  sourceSymbol: string;
  registration: ItemStatDefinition["registration"];
  fullExpression: string;
  normalizedProperties: string;
  foods: Map<string, FoodTemplate>;
  toolMaterials: Map<string, ToolMaterialStats>;
  armorMaterials: Map<string, ArmorMaterialStats>;
  armorDurability: Record<ArmorTypeKey, number>;
}

function buildItemStat(input: ItemStatInput): ItemStatDefinition {
  const { normalizedProperties } = input;
  const tool = resolveItemToolStats(input.fullExpression, normalizedProperties, input.toolMaterials);
  const armor = resolveItemArmorStats(normalizedProperties, input.armorMaterials, input.armorDurability);
  const explicitDurability = parseLastNumericCall(normalizedProperties, "durability");
  const stackSizeOverride = parseLastIntegerCall(normalizedProperties, "stacksTo");
  const inferredDurability = explicitDurability ?? tool?.durability ?? armor?.durability;
  const food = resolveItemFoodStats(normalizedProperties, input.foods);

  return {
    id: input.id,
    sourcePath: input.sourcePath,
    sourceSymbol: input.sourceSymbol,
    registration: input.registration,
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
  registrationHelpers: Map<string, RegistrationHelper>,
  propertyHelpers: Map<string, string>,
  context: SourceContext,
): BlockPropertyDefinition {
  const outerCall = parseTopLevelCall(declaration.expression);
  const id = normalizeMinecraftId(
    resolveExplicitId(outerCall?.args[0]) ??
      resolveReferenceId(outerCall?.args[0], "block", context.references) ??
      constantToId(declaration.symbol),
  );
  const basePropertiesExpression = resolveBlockPropertiesExpression(declaration.expression, registrationHelpers);
  const normalizedProperties = basePropertiesExpression
    ? expandBlockPropertiesExpression(collapseWhitespace(basePropertiesExpression), propertyHelpers)
    : "";

  return buildBlockProperty(id, declaration.symbol, sourcePath, normalizedProperties);
}

function buildBlockProperty(
  id: string,
  sourceSymbol: string,
  sourcePath: string,
  normalizedProperties: string,
): BlockPropertyDefinition {
  const strengthValues = findLastCallArguments(normalizedProperties, "strength");
  const destroyTimeFromStrength = strengthValues ? parseJavaNumber(strengthValues[0]) : undefined;
  const explosionResistanceFromStrength =
    strengthValues && strengthValues.length > 1 ? parseJavaNumber(strengthValues[1]) : destroyTimeFromStrength;
  const copiedFrom = resolveCopiedFrom(normalizedProperties);

  return {
    id,
    sourcePath,
    sourceSymbol,
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

// `BlockBehaviour.Properties.of{Full,Legacy}Copy(SOURCE)` clones the source block's
// physical properties and the registration may then override individual fields. The
// per-block parser records `copiedFrom` and whatever fields the block sets explicitly;
// this pass fills the remaining fields from the (recursively resolved) source block so
// copy-based blocks (slabs, stairs, walls, cut copper, candle cakes, ...) report the same
// destroyTime/explosionResistance/sound/tool requirements as the block they copy.
function resolveCopyInheritance(properties: Map<string, BlockPropertyDefinition>): void {
  const resolved = new Set<string>();
  const resolving = new Set<string>();

  const resolve = (definition: BlockPropertyDefinition): void => {
    if (resolved.has(definition.id) || resolving.has(definition.id)) {
      return;
    }

    resolving.add(definition.id);
    const source = definition.copiedFrom ? properties.get(definition.copiedFrom) : undefined;
    if (source && source.id !== definition.id) {
      resolve(source);
      inheritBlockProperties(definition, source);
    }

    resolving.delete(definition.id);
    resolved.add(definition.id);
  };

  for (const definition of properties.values()) {
    resolve(definition);
  }
}

function inheritBlockProperties(target: BlockPropertyDefinition, source: BlockPropertyDefinition): void {
  // Optional fields: an explicit override on the block wins, otherwise inherit the source.
  target.destroyTime ??= source.destroyTime;
  target.explosionResistance ??= source.explosionResistance;
  target.mapColor ??= source.mapColor;
  target.instrument ??= source.instrument;
  target.soundType ??= source.soundType;
  target.pushReaction ??= source.pushReaction;
  target.lightEmission ??= source.lightEmission;
  // Boolean flags can only be turned on in the chain (there is no `.flag(false)`), so a
  // false on the block means "not set here" and should inherit the copied value.
  target.requiresCorrectToolForDrops ||= source.requiresCorrectToolForDrops;
  target.ignitedByLava ||= source.ignitedByLava;
  target.randomTicks ||= source.randomTicks;
  target.noCollision ||= source.noCollision;
  target.replaceable ||= source.replaceable;
}

// --- 26.2 reference-id and collection support -------------------------------
//
// Minecraft 26.2 reorganized how blocks/items are registered: ids moved from inline
// string literals to `BlockItemIds.X` / `BlockIds.X` / `ItemIds.X` references, and the
// 16-color and weathering-copper variant families are now registered through
// ColorCollection / WeatheringCopperCollection factories instead of one explicit
// declaration each. The helpers below recover those families while leaving the
// string-literal path used by older versions untouched.

function buildReferenceIndex(
  sources: Array<{ className: string; source: string | undefined }>,
  dyeColors: DyeColorDefinition[],
): ReferenceIndex {
  const index: ReferenceIndex = { singles: new Map(), collections: new Map() };
  const byStateConstants = new Map<string, string[]>();

  // ByState constants (e.g. COPPER_BLOCK_SPECIAL_NAMES) drive the irregular copper ids.
  const byStatePattern =
    /(?:public|private) static final WeatheringCopperCollection\.ByState<String>\s+([A-Z0-9_]+)\s*=\s*new WeatheringCopperCollection\.ByState<>\(([^)]*)\)/g;
  for (const { source } of sources) {
    if (!source) {
      continue;
    }

    for (const match of source.matchAll(byStatePattern)) {
      const name = match[1];
      const strings = parseStringLiterals(match[2] ?? "");
      if (name && strings.length >= 4) {
        byStateConstants.set(name, strings);
      }
    }
  }

  for (const { className, source } of sources) {
    if (!source) {
      continue;
    }

    for (const declaration of parseReferenceDeclarations(source)) {
      const collectionIds = resolveReferenceCollectionExpression(declaration.expression, byStateConstants, dyeColors);
      if (collectionIds && collectionIds.length > 0) {
        index.collections.set(`${className}.${declaration.symbol}`, collectionIds);
        continue;
      }

      const single = resolveReferenceSingleExpression(declaration.expression, className);
      if (single) {
        index.singles.set(`${className}.${declaration.symbol}`, single);
      }
    }
  }

  return index;
}

function parseReferenceDeclarations(source: string): StaticDeclaration[] {
  const declarations: StaticDeclaration[] = [];
  const pattern = /public static final [^=;]+?\b([A-Z][A-Z0-9_]*)\s*=\s*/g;

  for (const match of source.matchAll(pattern)) {
    const symbol = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = findStatementEnd(source, start);
    if (!symbol || end < 0) {
      continue;
    }

    declarations.push({ symbol, expression: collapseWhitespace(source.slice(start, end)) });
  }

  return declarations;
}

function resolveReferenceCollectionExpression(
  expression: string,
  byStateConstants: Map<string, string[]>,
  dyeColors: DyeColorDefinition[],
): string[] | undefined {
  const colorMatch =
    expression.match(/createSimpleColored\(\s*"([^"]+)"/) ??
    expression.match(/prefixWithColor\(\s*ColorCollection\.create\(\s*"([^"]+)"/);
  if (colorMatch?.[1]) {
    return colorIdExpand(colorMatch[1], dyeColors);
  }

  const copperMatch =
    expression.match(/createSimpleCopper\(\s*"([^"]+)"/) ??
    expression.match(/prefixWithState\(\s*WeatheringCopperCollection\.create\(\s*"([^"]+)"/);
  if (copperMatch?.[1]) {
    return copperIdExpand([copperMatch[1], copperMatch[1], copperMatch[1], copperMatch[1]]);
  }

  if (expression.includes("prefixWithState")) {
    const sameMatch = expression.match(/\.same\(\s*([A-Z0-9_]+)\s*\)/);
    const byState = sameMatch?.[1] ? byStateConstants.get(sameMatch[1]) : undefined;
    if (byState && byState.length >= 4) {
      return copperIdExpand(byState);
    }
  }

  return undefined;
}

function resolveReferenceSingleExpression(expression: string, className: string): ReferenceId | undefined {
  const blockItemMatch = expression.match(/BlockItemId\.create\(\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?/);
  if (blockItemMatch?.[1]) {
    return { block: blockItemMatch[1], item: blockItemMatch[2] ?? blockItemMatch[1] };
  }

  const createMatch = expression.match(/\bcreate\(\s*"([^"]+)"/);
  if (createMatch?.[1]) {
    return className === "ItemIds" ? { item: createMatch[1] } : { block: createMatch[1] };
  }

  return undefined;
}

function resolveReferenceId(
  expression: string | undefined,
  kind: "block" | "item",
  references: ReferenceIndex,
): string | undefined {
  if (!expression) {
    return undefined;
  }

  const normalized = collapseWhitespace(expression);
  let effectiveKind = kind;
  if (/\.item\(\)\s*$/.test(normalized)) {
    effectiveKind = "item";
  } else if (/\.block\(\)\s*$/.test(normalized)) {
    effectiveKind = "block";
  }

  const match = normalized.match(/\b(BlockItemIds|BlockIds|ItemIds)\.([A-Z][A-Z0-9_]*)/);
  if (!match) {
    return undefined;
  }

  const entry = references.singles.get(`${match[1]}.${match[2]}`);
  if (!entry) {
    return undefined;
  }

  return effectiveKind === "item" ? entry.item ?? entry.block : entry.block ?? entry.item;
}

function resolveReferenceCollectionIds(expression: string | undefined, references: ReferenceIndex): string[] | undefined {
  if (!expression) {
    return undefined;
  }

  const match = collapseWhitespace(expression).match(/\b(BlockItemIds|BlockIds|ItemIds)\.([A-Z][A-Z0-9_]*)/);
  if (!match) {
    return undefined;
  }

  return references.collections.get(`${match[1]}.${match[2]}`);
}

function colorIdExpand(base: string, dyeColors: DyeColorDefinition[]): string[] {
  return dyeColors.map((color) => `${color.name}_${base}`);
}

function copperIdExpand(byState: string[]): string[] {
  const ids: string[] = [];
  for (const prefixes of [COPPER_WEATHERING_PREFIXES, COPPER_WAXED_PREFIXES]) {
    prefixes.forEach((prefix, index) => {
      const base = byState[index] ?? byState[0] ?? "";
      ids.push(`${prefix}${base}`);
    });
  }

  return ids;
}

function expandBlockCollections(
  blocksSource: string,
  propertyHelpers: Map<string, string>,
  context: SourceContext,
): BlockPropertyDefinition[] {
  const declarations = [
    ...parseAssignments(blocksSource, "public static final ColorCollection<Block>"),
    ...parseAssignments(blocksSource, "public static final WeatheringCopperCollection<Block>"),
  ];

  // First pass: map each collection's Java symbol to its expanded id list. Some copper
  // families copy their properties from another collection (e.g. cut_copper from
  // copper_block) via `ofFullCopy(COPPER_BLOCK.weathering().pick(state))`, so the second
  // pass needs every collection's ids available regardless of declaration order.
  const collections = new Map<string, { call: ParsedCall; ids: string[]; isColor: boolean }>();
  for (const declaration of declarations) {
    const call = parseTopLevelCall(declaration.expression);
    if (!call || !call.name.endsWith(".registerBlocks")) {
      continue;
    }

    const ids = resolveReferenceCollectionIds(call.args[0], context.references);
    if (!ids || ids.length === 0) {
      continue;
    }

    collections.set(declaration.symbol, { call, ids, isColor: call.name.startsWith("ColorCollection") });
  }

  const collectionIdsBySymbol = new Map(Array.from(collections, ([symbol, entry]) => [symbol, entry.ids]));
  // Weathering-copper "full" families (copper_block) carry per-state map colors via a
  // `switch (state)` expression; the door/grate/bulb/chest/... families reference them
  // through `COPPER_BLOCK.weathering().pick(state).defaultMapColor()`. Resolve the source
  // map colors once so those references can be substituted per variant.
  const copperMapColorsBySymbol = computeCopperMapColors(collections);
  const definitions: BlockPropertyDefinition[] = [];

  for (const { call, ids, isColor } of collections.values()) {
    const propertiesLambda = call.args.at(-1);
    if (!propertiesLambda) {
      continue;
    }

    const lambdaBody = stripLambdaParameter(propertiesLambda);
    ids.forEach((id, index) => {
      const propertiesExpression = isColor
        ? substituteDyeColor(lambdaBody, context.dyeColors[index])
        : substituteWeatherState(lambdaBody, index % WEATHER_STATES.length, copperMapColorsBySymbol);
      const normalizedProperties = expandBlockPropertiesExpression(collapseWhitespace(propertiesExpression), propertyHelpers);
      const definition = buildBlockProperty(normalizeMinecraftId(id), symbolFromId(id), BLOCKS_PATH, normalizedProperties);
      if (!definition.copiedFrom) {
        definition.copiedFrom = resolveCollectionCopiedFrom(lambdaBody, index, collectionIdsBySymbol);
      }

      definitions.push(definition);
    });
  }

  return definitions;
}

// Resolves each weathering-copper collection whose map color is an inline `switch (state)`
// (in practice copper_block) to its four MapColor literals, one per weather state.
function computeCopperMapColors(
  collections: Map<string, { call: ParsedCall; ids: string[]; isColor: boolean }>,
): Map<string, string[]> {
  const mapColorsBySymbol = new Map<string, string[]>();

  for (const [symbol, { call, isColor }] of collections) {
    const propertiesLambda = call.args.at(-1);
    if (isColor || !propertiesLambda) {
      continue;
    }

    const lambdaBody = stripLambdaParameter(propertiesLambda);
    const literals: string[] = [];
    for (const state of WEATHER_STATES) {
      const resolved = inlineLocalVariables(replaceWeatherSwitches(lambdaBody, state));
      const mapColor = findLastCallArguments(resolved, "mapColor")?.[0]?.trim();
      if (mapColor && /^MapColor\.[A-Z0-9_]+$/.test(mapColor)) {
        literals.push(mapColor);
      }
    }

    if (literals.length === WEATHER_STATES.length) {
      mapColorsBySymbol.set(symbol, literals);
    }
  }

  return mapColorsBySymbol;
}

// Specializes a weathering-copper property lambda to a single weather state: replaces
// `switch (state) { ... }` branches (map color, instrument, light level), inlines the
// decompiler temporaries they are assigned to, and resolves
// `COLLECTION.weathering()/.waxed().pick(state).defaultMapColor()` to the source family's
// per-state map color literal.
function substituteWeatherState(
  lambdaBody: string,
  stateIndex: number,
  copperMapColorsBySymbol: Map<string, string[]>,
): string {
  let result = inlineLocalVariables(replaceWeatherSwitches(lambdaBody, WEATHER_STATES[stateIndex] ?? "UNAFFECTED"));
  result = result.replace(
    /[A-Za-z0-9_]+\s*->\s*([A-Z0-9_]+)\.(?:weathering|waxed)\(\)\.pick\([^)]*\)\.defaultMapColor\(\)/g,
    (match, symbol: string) => copperMapColorsBySymbol.get(symbol)?.[stateIndex] ?? match,
  );
  return result;
}

function replaceWeatherSwitches(body: string, stateLabel: string): string {
  let result = body;
  let searchFrom = 0;
  let guard = 0;

  while (guard++ < 20) {
    const switchIndex = result.indexOf("switch", searchFrom);
    if (switchIndex < 0) {
      break;
    }

    const parenOpen = result.indexOf("(", switchIndex);
    const parenClose = parenOpen >= 0 ? findMatchingParen(result, parenOpen) : -1;
    const braceOpen = parenClose >= 0 ? result.indexOf("{", parenClose) : -1;
    const braceClose = braceOpen >= 0 ? findMatchingBrace(result, braceOpen) : -1;
    if (braceClose < 0) {
      searchFrom = switchIndex + "switch".length;
      continue;
    }

    const switchBody = result.slice(braceOpen + 1, braceClose);
    if (!switchBody.includes("UNAFFECTED")) {
      // Not a weather-state switch; leave it untouched.
      searchFrom = braceClose + 1;
      continue;
    }

    const caseMatch = switchBody.match(new RegExp(`case\\s+${stateLabel}\\s*->\\s*([^;]+)`));
    const value = caseMatch?.[1]?.trim() ?? "";
    result = result.slice(0, switchIndex) + value + result.slice(braceClose + 1);
    searchFrom = switchIndex + value.length;
  }

  return result;
}

function inlineLocalVariables(body: string): string {
  const assignments = new Map<string, string>();
  const pattern = /\b[A-Z][\w.]*\s+(var\w+)\s*=\s*([^;]+);/g;
  for (const match of body.matchAll(pattern)) {
    if (match[1] && match[2]) {
      assignments.set(match[1], match[2].trim());
    }
  }

  if (assignments.size === 0) {
    return body;
  }

  let result = body;
  for (const [name, value] of assignments) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }

  return result;
}

// Resolves `of{Full,Legacy}Copy(COLLECTION.weathering()/.waxed().pick(state))` to the
// concrete id the variant copies from, mirroring how 26.1.1 recorded copiedFrom for the
// per-state copper families (e.g. waxed_oxidized_cut_copper -> oxidized_copper).
function resolveCollectionCopiedFrom(
  lambdaBody: string,
  variantIndex: number,
  collectionIdsBySymbol: Map<string, string[]>,
): string | undefined {
  const match = lambdaBody.match(/of(?:Full|Legacy)Copy\(\s*([A-Z0-9_]+)\.(weathering|waxed)\(\)\.pick\(/);
  if (!match?.[1]) {
    return undefined;
  }

  const ids = collectionIdsBySymbol.get(match[1]);
  if (!ids) {
    return undefined;
  }

  const stateCount = COPPER_WEATHERING_PREFIXES.length;
  const offset = match[2] === "waxed" ? stateCount : 0;
  const picked = ids[offset + (variantIndex % stateCount)];
  return picked ? normalizeMinecraftId(picked) : undefined;
}

function expandItemCollections(
  itemsSource: string,
  foods: Map<string, FoodTemplate>,
  toolMaterials: Map<string, ToolMaterialStats>,
  armorMaterials: Map<string, ArmorMaterialStats>,
  context: SourceContext,
  armorDurability: Record<ArmorTypeKey, number>,
): ItemStatDefinition[] {
  const declarations = [
    ...parseAssignments(itemsSource, "public static final ColorCollection<Item>"),
    ...parseAssignments(itemsSource, "public static final WeatheringCopperCollection<Item>"),
  ];
  const definitions: ItemStatDefinition[] = [];

  for (const declaration of declarations) {
    const call = parseTopLevelCall(declaration.expression);
    if (!call) {
      continue;
    }

    const method = call.name.split(".").at(-1) ?? "";
    if (method !== "registerBlockItems" && method !== "registerItems") {
      continue;
    }

    const ids = resolveReferenceCollectionIds(call.args[0], context.references);
    if (!ids || ids.length === 0) {
      continue;
    }

    const factory = call.args.at(-1) ?? "";
    const normalizedProperties = extractCollectionItemProperties(factory);
    // registerBlockItems and WeatheringCopperCollection.registerItems(ids, blocks, factory)
    // both produce block items; ColorCollection.registerItems(ids, factory) produces items.
    const registration: ItemStatDefinition["registration"] =
      method === "registerBlockItems" || call.args.length >= 3 ? "block" : "item";

    for (const id of ids) {
      definitions.push(
        buildItemStat({
          id: normalizeMinecraftId(id),
          sourcePath: ITEMS_PATH,
          sourceSymbol: symbolFromId(id),
          registration,
          fullExpression: factory,
          normalizedProperties,
          foods,
          toolMaterials,
          armorMaterials,
          armorDurability,
        }),
      );
    }
  }

  return definitions;
}

function extractCollectionItemProperties(factory: string): string {
  const normalized = collapseWhitespace(factory);
  for (const callName of ["registerBlock", "registerItem"]) {
    const argumentsList = findLastCallArguments(normalized, callName);
    const propertiesArgument = argumentsList?.find((argument) => argument.includes("Item.Properties"));
    if (propertiesArgument) {
      return collapseWhitespace(propertiesArgument);
    }
  }

  return "";
}

function stripLambdaParameter(expression: string): string {
  const normalized = collapseWhitespace(expression);
  const match = normalized.match(/^(?:\([^)]*\)|[A-Za-z0-9_]+)\s*->\s*([\s\S]+)$/);
  return match?.[1] ?? normalized;
}

function substituteDyeColor(expression: string, color: DyeColorDefinition | undefined): string {
  if (!color) {
    return expression;
  }

  return expression
    .replace(/color\.getMapColor\(\)/g, `MapColor.${color.mapColor.toUpperCase()}`)
    .replace(/color\.getTerracottaColor\(\)/g, `MapColor.${color.terracottaColor.toUpperCase()}`);
}

function symbolFromId(id: string): string {
  return id.toUpperCase();
}

function parseDyeColors(source: string): DyeColorDefinition[] {
  const colors: DyeColorDefinition[] = [];
  // WHITE(0, "white", 16383998, MapColor.SNOW, MapColor.TERRACOTTA_WHITE, ...)
  const pattern =
    /^\s*[A-Z][A-Z0-9_]*\(\s*\d+\s*,\s*"([^"]+)"\s*,\s*-?\d+\s*,\s*MapColor\.([A-Z0-9_]+)\s*,\s*MapColor\.([A-Z0-9_]+)/gm;

  for (const match of source.matchAll(pattern)) {
    if (match[1] && match[2] && match[3]) {
      colors.push({
        name: match[1],
        mapColor: constantToId(match[2]),
        terracottaColor: constantToId(match[3]),
      });
    }
  }

  return colors.length === FALLBACK_DYE_COLORS.length ? colors : FALLBACK_DYE_COLORS;
}

function parseStringLiterals(value: string): string[] {
  return Array.from(value.matchAll(/"([^"]*)"/g), (match) => match[1] ?? "");
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

function resolveBlockPropertiesExpression(
  expression: string,
  registrationHelpers: Map<string, RegistrationHelper>,
): string | undefined {
  const call = parseTopLevelCall(expression);
  if (!call) {
    return undefined;
  }

  if (call.name === "register") {
    return call.args.at(-1);
  }

  const helper = registrationHelpers.get(call.name);
  if (!helper) {
    return undefined;
  }

  // Substitute the helper's parameters with the call's arguments so copy sources passed
  // positionally (e.g. registerSlab(id, ACACIA_PLANKS) -> ofLegacyCopy(base)) resolve to
  // the real block rather than the literal parameter name.
  return substituteHelperParameters(helper.expression, helper.params, call.args);
}

function substituteHelperParameters(expression: string, params: string[], args: string[]): string {
  let result = expression;
  params.forEach((param, index) => {
    const argument = args[index];
    if (param && argument) {
      result = result.replace(new RegExp(`\\b${escapeRegExp(param)}\\b`, "g"), argument);
    }
  });

  return result;
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
  const pattern = /private static [^{]+ (\w+)\(([^)]*)\)\s*\{/g;

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
      params: parseParameterNames(match[2] ?? ""),
      body: source.slice(openBraceIndex + 1, closeBraceIndex).trim(),
    });
  }

  return methods;
}

function parseParameterNames(parameterList: string): string[] {
  return splitTopLevelArgs(parameterList).map((parameter) => parameter.trim().match(/(\w+)\s*$/)?.[1] ?? "");
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

  const identifier = constantToId(identifierMatch[1] ?? "");
  // Statement-body lambdas (e.g. the per-state copper switch) reference decompiler
  // temporaries like `var10001`/`var1x` instead of a concrete constant; treat those as
  // unresolved rather than leaking the synthetic name as a value.
  if (/^var\d/.test(identifier)) {
    return undefined;
  }

  return identifier;
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
