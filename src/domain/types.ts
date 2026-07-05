export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type NewsPostKind = "snapshot" | "release" | "other";
export type MappingProvider = "mojang" | "yarn";

export interface MinecraftNewsPost {
  id: string;
  url: string;
  title: string;
  kind: NewsPostKind;
  versionIds: string[];
  publishedAt?: string;
}

export interface VersionManifestEntry {
  id: string;
  type: string;
  url: string;
  time: string;
  releaseTime: string;
  sha1?: string;
  complianceLevel?: number;
}

export interface VersionManifestResponse {
  latest: {
    release: string;
    snapshot: string;
  };
  versions: VersionManifestEntry[];
}

export interface DownloadDescriptor {
  sha1?: string;
  size?: number;
  url: string;
}

export interface VersionMetadata {
  id: string;
  type: string;
  releaseTime: string;
  time: string;
  downloads: Partial<Record<"client" | "server" | "client_mappings" | "server_mappings", DownloadDescriptor>>;
  assetIndex?: DownloadDescriptor & { id?: string };
  assets?: string;
  javaVersion?: {
    component?: string;
    majorVersion?: number;
  };
}

export interface DownloadedArtifact {
  kind: "client" | "server" | "client_mappings" | "server_mappings";
  path: string;
  url: string;
  sha1?: string;
  bytes?: number;
  downloaded: boolean;
}

export interface MappingArtifact {
  provider: MappingProvider;
  kind: "client" | "server" | "merged";
  format: "proguard" | "tiny-v2";
  path: string;
  url: string;
  sourceArchivePath?: string;
}

export interface VersionArtifacts {
  version: string;
  rootDir: string;
  metadataPath: string;
  downloads: Partial<Record<DownloadedArtifact["kind"], DownloadedArtifact>>;
}

export interface ModelDefinition {
  id: string;
  kind: "block" | "item" | "other";
  parent?: string;
  textureRefs: string[];
  sourcePath: string;
  raw: JsonValue;
}

export interface TextureDefinition {
  id: string;
  kind: "block" | "item" | "entity" | "environment" | "other";
  sourcePath: string;
  imagePath?: string;
  width?: number;
  height?: number;
  animation?: JsonValue;
  atlases?: string[];
  transparency?: "opaque" | "transparent" | "unknown";
}

export interface PaletteDefinition {
  id: string;
  kind: "extracted" | "curated";
  category: string;
  name: string;
  description: string;
  colors: string[];
  sources: string[];
  tags: string[];
}

export interface RecipeResultDefinition {
  item?: string;
  tag?: string;
  count?: number;
}

export interface RecipeDefinition {
  id: string;
  type: string;
  ingredients: string[];
  ingredientTags: string[];
  result?: RecipeResultDefinition;
  sourcePath: string;
  raw: JsonValue;
}

export interface BlockDefinition {
  id: string;
  tags: string[];
  modelRefs: string[];
  textureRefs: string[];
  blockstatePath: string;
  raw: JsonValue;
}

export interface ItemDefinition {
  id: string;
  tags: string[];
  recipeIds: string[];
  modelRef: string;
  clientItemPath?: string;
  textureRefs: string[];
  sourcePath: string;
  raw: JsonValue;
}

export interface ItemFoodStats {
  reference: string;
  consumable?: string;
  nutrition?: number;
  saturationModifier?: number;
  alwaysEdible?: boolean;
}

export interface ItemToolStats {
  kind: "sword" | "pickaxe" | "axe" | "shovel" | "hoe" | "spear";
  material: string;
  durability?: number;
  miningSpeed?: number;
  enchantability?: number;
  attackDamage?: number;
  attackSpeed?: number;
}

export interface ItemArmorStats {
  category: "humanoid" | "wolf" | "horse" | "nautilus";
  material: string;
  type?: "helmet" | "chestplate" | "leggings" | "boots" | "body";
  durability?: number;
  defense?: number;
  enchantability?: number;
  toughness?: number;
  knockbackResistance?: number;
}

export interface ItemStatDefinition {
  id: string;
  sourcePath: string;
  sourceSymbol: string;
  registration: "item" | "block";
  stackSize: number;
  durability?: number;
  rarity: "common" | "uncommon" | "rare" | "epic";
  fireResistant: boolean;
  food?: ItemFoodStats;
  tool?: ItemToolStats;
  armor?: ItemArmorStats;
}

export interface BlockLightEmission {
  kind: "constant" | "lit" | "dynamic";
  value?: number;
  expression?: string;
}

export interface BlockPropertyDefinition {
  id: string;
  sourcePath: string;
  sourceSymbol: string;
  copiedFrom?: string;
  destroyTime?: number;
  explosionResistance?: number;
  requiresCorrectToolForDrops: boolean;
  ignitedByLava: boolean;
  randomTicks: boolean;
  noCollision: boolean;
  replaceable: boolean;
  mapColor?: string;
  instrument?: string;
  soundType?: string;
  pushReaction?: string;
  lightEmission?: BlockLightEmission;
}

export interface ResourcePackSupportedFormats {
  min?: number;
  max?: number;
}

export interface ResourcePackDefinition {
  packFormat: number;
  description?: string;
  supportedFormats?: ResourcePackSupportedFormats;
}

export interface MobImageVariantDefinition {
  id: string;
  sourcePath?: string;
  imagePath: string;
  origin: "renderer" | "asset-search" | "generated";
  role: "base" | "variant" | "baby" | "overlay" | "generated";
}

export interface MobImageDefinition {
  id: string;
  localId: string;
  displayName: string;
  rendererClass?: string;
  sourcePath?: string;
  imagePath: string;
  origin: MobImageVariantDefinition["origin"];
  variants: MobImageVariantDefinition[];
}

export interface MobSoundVariantDefinition {
  id: string;
  soundPath: string;
  assetPath: string;
  url: string;
  hash: string;
  size: number;
  stream: boolean;
  preload: boolean;
  volume: number;
  pitch: number;
  weight: number;
  attenuationDistance?: number;
}

export interface MobSoundEventDefinition {
  id: string;
  subtitleKey?: string;
  subtitle?: string;
  variants: MobSoundVariantDefinition[];
}

export interface MobSoundDefinition {
  id: string;
  localId: string;
  soundId: string;
  displayName: string;
  translationKey: string;
  category: string;
  mobCategory: string;
  soundEventCount: number;
  soundVariantCount: number;
  soundEvents: MobSoundEventDefinition[];
}

export type MobModelFaceName = "down" | "up" | "west" | "north" | "east" | "south";

export interface MobModelFaceDefinition {
  /** Pixel-space UV rectangle `[u0, v0, u1, v1]` on the layer texture. */
  uv: [number, number, number, number];
  /** Normalized UV rectangle `[u0, v0, u1, v1]` for WebGL/Three.js consumers. */
  normalizedUv: [number, number, number, number];
}

export interface MobModelCubeDefinition {
  name?: string;
  origin: [number, number, number];
  size: [number, number, number];
  deformation: [number, number, number];
  mirror: boolean;
  texOffs: [number, number];
  /** Faces omitted here were invisible in the vanilla addBox visibleSides set. */
  faces: Partial<Record<MobModelFaceName, MobModelFaceDefinition>>;
}

export interface MobModelPartDefinition {
  name: string;
  path: string;
  pivot: [number, number, number];
  rotation: [number, number, number];
  /** Per-axis PartPose scale; omitted when `[1, 1, 1]`. Applies to the part and its subtree. */
  scale?: [number, number, number];
  cubes: MobModelCubeDefinition[];
  children: MobModelPartDefinition[];
}

export interface MobModelLayerDefinition {
  id: string;
  modelClass?: string;
  modelMethod?: string;
  sourcePath?: string;
  textureSize?: [number, number];
  root?: MobModelPartDefinition;
  rawExpression?: string;
  status: "baked" | "partial" | "unresolved";
  warnings: string[];
  /** Which bake strategy produced `root`: executing the transpiled layer code, or statement parsing. */
  bakeStrategy?: "executed" | "parsed";
}

export interface MobModelTextureDefinition {
  id: string;
  sourcePath: string;
  imagePath: string;
}

export interface MobModelDefinition {
  id: string;
  localId: string;
  displayName: string;
  rendererClass?: string;
  modelLayers: string[];
  texturePaths: string[];
  textureAssets: MobModelTextureDefinition[];
  layers: MobModelLayerDefinition[];
}

/** One resolved base attribute on a mob (health, speed, damage, …). */
export interface MobAttributeValue {
  /** Attribute registry key, e.g. `max_health`, `movement_speed`, `attack_damage`. */
  attribute: string;
  /** The Java constant referenced in `createAttributes`, e.g. `MAX_HEALTH`. */
  constant: string;
  /** Resolved base value. */
  value: number;
  /**
   * Where `value` came from:
   * - `mob`: the entity's own `createAttributes()` set an explicit number.
   * - `inherited`: an ancestor builder (`createMonsterAttributes`, …) set the number.
   * - `default`: the attribute was `.add(Attributes.X)` with no number, so the value is the
   *   `RangedAttribute` registry default from `Attributes.java`.
   */
  origin: "mob" | "inherited" | "default";
}

export interface MobDimensionsDefinition {
  /** Adult hitbox width in blocks. */
  width: number;
  /** Adult hitbox height in blocks. */
  height: number;
  /** Eye height in blocks, when the EntityType registration overrides the default. */
  eyeHeight?: number;
}

/** Base experience dropped on death; `variable` marks source-computed (size/baby-scaled) rewards. */
export interface MobExperienceDefinition {
  /** Flat base value when the source assigns a constant `xpReward`. */
  value?: number;
  /** True when the reward is computed at runtime (e.g. slime size, baby multiplier, equipment). */
  variable: boolean;
  /** Human-readable note explaining a variable or inherited reward. */
  note?: string;
}

/** Loot-table-derived drop summary; full loot logic stays in `loot-tables.json`. */
export interface MobDropSummary {
  /** Loot table id, e.g. `minecraft:entities/cow`. */
  lootTableId: string;
  /** Distinct item ids the table can drop. */
  itemDrops: string[];
  /** Loot functions the table uses, e.g. `minecraft:looting_enchant`, `minecraft:furnace_smelt`. */
  functions: string[];
}

/** Sound-event summary; full variant/asset data stays in `mob-sounds.json`. */
export interface MobSoundSummary {
  /** Number of distinct sound events. */
  eventCount: number;
  /** Sound event ids, e.g. `entity.cow.ambient`, `entity.cow.hurt`. */
  events: string[];
}

/** Representative + variant image paths; full metadata stays in `mob-images.json`. */
export interface MobImageSummary {
  /** Dataset-relative representative image, e.g. `mob-images/cow/cow.png`. */
  imagePath?: string;
  /** All dataset-relative texture-variant image paths. */
  variantImagePaths: string[];
}

/** Behavior classification derived from the entity class hierarchy. */
export type MobHostility = "hostile" | "neutral" | "passive" | "boss" | "unknown";

/**
 * A per-mob profile: source-derived gameplay stats joined with the render/sound/loot/tag data
 * already extracted elsewhere. Heavy collections (full sounds, model geometry, loot logic) are
 * referenced by id/path rather than duplicated, so this stays a lean, consumable "breakdown".
 */
export interface MobProfileDefinition {
  /** Registry id, e.g. `minecraft:cow`. */
  id: string;
  /** Id without the `minecraft:` namespace, e.g. `cow`. */
  localId: string;
  /** en_us display name, e.g. `Cow`. */
  displayName: string;
  /** Spawn/mob category from the EntityType registration, e.g. `CREATURE`, `MONSTER`. */
  mobCategory?: string;
  /** Behavior classification from the class hierarchy (Monster/Enemy → hostile, NeutralMob → neutral, …). */
  hostility: MobHostility;
  /** False when the EntityType is flagged `notInPeaceful()` (despawns on Peaceful difficulty). */
  spawnsInPeaceful?: boolean;
  /** Fire immunity from `EntityType.Builder.fireImmune()`. */
  fireImmune: boolean;
  /** Adult hitbox dimensions from `EntityType.Builder.sized()/eyeHeight()`. */
  dimensions?: MobDimensionsDefinition;
  /** Base experience dropped on death. */
  experience?: MobExperienceDefinition;
  /** Network client tracking range in chunks, from `EntityType.Builder.clientTrackingRange()`. */
  clientTrackingRange?: number;
  /** All resolved base attributes, in source order. */
  attributes: MobAttributeValue[];
  /** Convenience scalar for `max_health`; omitted when the mob has no such attribute. */
  maxHealth?: number;
  /** Convenience scalar for `movement_speed`. */
  movementSpeed?: number;
  /** Convenience scalar for `attack_damage`. */
  attackDamage?: number;
  /** Convenience scalar for `armor`. */
  armor?: number;
  /** Convenience scalar for `knockback_resistance`. */
  knockbackResistance?: number;
  /** Convenience scalar for `follow_range`. */
  followRange?: number;
  /** Loot-table-derived drops, joined from `minecraft:entities/<localId>`. */
  drops?: MobDropSummary;
  /** Sound-event summary; full data in `mob-sounds.json`. */
  sounds?: MobSoundSummary;
  /** Representative + variant image paths; full data in `mob-images.json`. */
  images?: MobImageSummary;
  /** Model layer ids for 3D rendering; full geometry in `mob-models.json`. */
  modelLayerIds: string[];
  /** `entity_type` registry tags this mob belongs to, e.g. `minecraft:followable_friendly_mobs`. */
  tags: string[];
  /** Spawn egg item id when one exists, e.g. `minecraft:cow_spawn_egg`. */
  spawnEgg?: string;
  /** Decompiled entity class this profile was derived from, e.g. `net/minecraft/.../cow/Cow.java`. */
  sourceClass?: string;
  /** Non-fatal extraction gaps, never silently omitted (mirrors the mob-model `warnings` convention). */
  warnings: string[];
}

export type RenderProvenanceKind = "asset" | "generated-report" | "client-source" | "derived" | "fallback";

export interface RenderProvenance {
  kind: RenderProvenanceKind;
  path?: string;
  className?: string;
  method?: string;
  reason?: string;
}

export type BlockRenderLayerKind = "solid" | "cutout" | "cutout_mipped" | "translucent" | "unknown";

export interface BlockstateModelVariant {
  model: string;
  x: number;
  y: number;
  uvlock: boolean;
  weight: number;
  provenance: RenderProvenance;
}

export interface BlockstateMultipartCase {
  when?: JsonValue;
  apply: BlockstateModelVariant[];
  provenance: RenderProvenance;
}

export interface BlockstateRenderDefinition {
  id: string;
  sourcePath: string;
  properties: Record<string, string[]>;
  defaultState?: Record<string, string>;
  variants: Record<string, BlockstateModelVariant[]>;
  multipart: BlockstateMultipartCase[];
  modelRefs: string[];
  raw: JsonValue;
  provenance: RenderProvenance;
}

export interface RenderModelFace {
  texture?: string;
  resolvedTextureId?: string;
  uv?: [number, number, number, number];
  rotation: number;
  cullface?: string;
  tintIndex?: number;
}

export interface RenderModelElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: JsonValue;
  shade?: boolean;
  faces: Partial<Record<"down" | "up" | "north" | "south" | "west" | "east", RenderModelFace>>;
}

export interface ResolvedRenderModel {
  id: string;
  kind: "block" | "item" | "other";
  sourcePath: string;
  parent?: string;
  parentChain: string[];
  textures: Record<string, string>;
  unresolvedTextures: string[];
  elements: RenderModelElement[];
  display?: JsonValue;
  ambientOcclusion?: boolean;
  guiLight?: string;
  raw: JsonValue;
  provenance: RenderProvenance;
}

export interface ClientItemRenderDefinition {
  id: string;
  displayName: string;
  sourcePath: string;
  modelRef?: string;
  renderKind: "generated_flat_item" | "block_model_gui" | "handheld_item" | "special_renderer" | "composite" | "unknown";
  textureLayers: string[];
  overrides: JsonValue[];
  predicates: string[];
  displayTransforms: Record<string, JsonValue>;
  guiDescriptor: JsonValue;
  specialRendererKinds: string[];
  raw: JsonValue;
  provenance: RenderProvenance;
}

export interface TextureRenderDefinition {
  id: string;
  sourcePath: string;
  imagePath: string;
  width?: number;
  height?: number;
  animation?: JsonValue;
  atlases: string[];
  kind: "block" | "item" | "entity" | "environment" | "other";
  transparency: "opaque" | "transparent" | "unknown";
  provenance: RenderProvenance;
}

export interface AtlasRenderDefinition {
  id: string;
  sourcePath: string;
  sources: JsonValue[];
  raw: JsonValue;
  provenance: RenderProvenance;
}

export interface RenderLayerDefinition {
  id: string;
  layer: BlockRenderLayerKind;
  blocks: string[];
  source: RenderProvenance;
}

export interface TintDefinition {
  id: string;
  target: "block" | "item";
  tintType: string;
  indices: number[];
  source: RenderProvenance;
  fallback?: string;
}

export interface EntityRendererDefinition {
  id: string;
  displayName: string;
  rendererClass?: string;
  sourcePath?: string;
  modelLayers: string[];
  textureAssets: MobModelTextureDefinition[];
  variantTextures: Record<string, string>;
  overlays: string[];
  source: RenderProvenance;
}

export interface EntityRenderDefinition {
  id: string;
  displayName: string;
  rendererId: string;
  modelLayerIds: string[];
  defaultAdultLayer?: string;
  babyLayer?: string;
  variantLayerIds: string[];
  textureAssets: MobModelTextureDefinition[];
  source: RenderProvenance;
}

export interface SpecialRendererDefinition {
  id: string;
  target: "block" | "item" | "block_entity" | "entity";
  rendererKind: string;
  sourceClass?: string;
  sourceMethod?: string;
  sourcePath?: string;
  textures: string[];
  modelLayerIds: string[];
  geometrySource?: string;
  fallbackStrategy?: string;
  source: RenderProvenance;
}

export interface RenderValidationIssue {
  code: string;
  message: string;
  id?: string;
  sourcePath?: string;
  severity: "error" | "warning";
}

export interface RenderValidationReport {
  generatedAt: string;
  status: "passed" | "failed";
  fixtureIds: string[];
  counts: Record<string, number>;
  issues: RenderValidationIssue[];
}

export interface MinecraftRenderDataset {
  version: string;
  generatedAt: string;
  blocks: BlockDefinition[];
  blockstates: BlockstateRenderDefinition[];
  blockModels: ResolvedRenderModel[];
  itemModels: ResolvedRenderModel[];
  itemDisplays: ClientItemRenderDefinition[];
  textures: TextureRenderDefinition[];
  atlases: AtlasRenderDefinition[];
  renderLayers: RenderLayerDefinition[];
  tints: TintDefinition[];
  entities: EntityRenderDefinition[];
  entityModels: MobModelDefinition[];
  entityRenderers: EntityRendererDefinition[];
  specialRenderers: SpecialRendererDefinition[];
  validation?: RenderValidationReport;
}
export interface MinecraftWikiMobSoundFile {
  pageId: number;
  title: string;
  fileName: string;
  url: string;
  descriptionUrl: string;
  mime?: string;
  size?: number;
  durationSeconds?: number;
  updatedAt?: string;
}

export interface MinecraftWikiMobSoundCategory {
  id: string;
  pageId: number;
  title: string;
  displayName: string;
  url: string;
  files: MinecraftWikiMobSoundFile[];
}

export interface MinecraftWikiMobSoundSnapshot {
  source: "minecraft.wiki";
  fetchedAt: string;
  apiUrl: string;
  rootCategoryTitle: string;
  categoryCount: number;
  fileCount: number;
  categories: MinecraftWikiMobSoundCategory[];
}

export interface MinecraftWikiMobSoundLocalOnlyMob {
  id: string;
  displayName: string;
  soundEventCount: number;
  soundVariantCount: number;
}

export interface MinecraftWikiMobSoundCategoryAlignment {
  id: string;
  title: string;
  displayName: string;
  url: string;
  wikiFileCount: number;
  mappedMobIds: string[];
  mappedMobDisplayNames: string[];
  matchType: "direct" | "grouped" | "wiki-only";
  coverage: "exact" | "partial" | "wiki-only";
  matchedFileCount: number;
  unmatchedWikiFileTitles: string[];
  unmatchedLocalSoundPaths: string[];
}

export interface MinecraftWikiMobSoundAlignment {
  source: "minecraft.wiki";
  fetchedAt: string;
  snapshotRelativePath?: string;
  categoryCount: number;
  fileCount: number;
  matchedCategoryCount: number;
  exactCategoryCount: number;
  partialCategoryCount: number;
  wikiOnlyCategoryCount: number;
  unmatchedWikiCategoryIds: string[];
  unmatchedLocalMobIds: string[];
  localOnlyMobs: MinecraftWikiMobSoundLocalOnlyMob[];
  categories: MinecraftWikiMobSoundCategoryAlignment[];
}

/** Linear level-cost formula used by min_cost/max_cost in enchantment definitions. */
export interface EnchantmentCostFormula {
  base: number;
  perLevelAboveFirst: number;
}

export interface EnchantmentDefinition {
  id: string;
  descriptionKey?: string;
  description?: string;
  /** en_us display name resolved from `descriptionKey`. */
  displayName?: string;
  supportedItems?: string;
  primaryItems?: string;
  /** Concrete item ids after recursively resolving `supported_items` (tag refs included). */
  supportedItemIds?: string[];
  /** Concrete item ids after recursively resolving `primary_items` (tag refs included). */
  primaryItemIds?: string[];
  maxLevel?: number;
  weight?: number;
  anvilCost?: number;
  /** Enchanting-table minimum cost formula (`min_cost`). */
  minCost?: EnchantmentCostFormula;
  /** Enchanting-table maximum cost formula (`max_cost`). */
  maxCost?: EnchantmentCostFormula;
  slots: string[];
  exclusiveSet?: string;
  /** Enchantment ids this one cannot coexist with, resolved from `exclusive_set`. */
  exclusiveSetIds?: string[];
  /** Enchantment-registry tags containing this enchantment (curse, treasure, in_enchanting_table, …). */
  tags?: string[];
  sourcePath: string;
  raw: JsonValue;
}

/** A `numerator / denominator` ratio parsed from decompiled source arithmetic. */
export interface AnvilFraction {
  numerator: number;
  denominator: number;
}

/** One bracket of the player XP curve: XP needed to pass a level within [minLevel, nextBracket). */
export interface AnvilXpBracket {
  minLevel: number;
  base: number;
  perLevelAboveMin: number;
}

/**
 * Anvil combine/repair mechanics derived from decompiled client source
 * (AnvilMenu.java and Player.java). Every field is optional because it is
 * parsed from source text; missing fields carry a warning instead of a guess.
 */
export interface AnvilMechanicsDefinition {
  /** Base cost seeded into every anvil operation (COST_BASE). */
  costBase?: number;
  /** Levels added per repair material consumed (COST_REPAIR_MATERIAL). */
  costRepairMaterial?: number;
  /** Levels added for repairing by sacrificing a same-type item (COST_REPAIR_SACRIFICE). */
  costRepairSacrifice?: number;
  /** Levels added per incompatible enchantment on the sacrifice (COST_INCOMPATIBLE_PENALTY). */
  costIncompatiblePenalty?: number;
  /** Flat cost of renaming (COST_RENAME). */
  costRename?: number;
  /** Maximum item name length accepted by the anvil (MAX_NAME_LENGTH). */
  maxNameLength?: number;
  /** Total cost at/above which the anvil shows "Too Expensive" in survival. */
  tooExpensiveThreshold?: number;
  /** Cost a rename-only operation is clamped to so it never becomes too expensive. */
  renameOnlyCostClamp?: number;
  /** Cost forced when enchanting a stack of more than one item. */
  stackedItemCost?: number;
  /** Prior-work update: repairCost' = multiplier * repairCost + addend (2c + 1 → penalty 2^n - 1). */
  priorWorkFormula?: { multiplier: number; addend: number };
  /** Durability restored per repair material, as a fraction of max damage (1/4). */
  materialRepairFraction?: AnvilFraction;
  /** Bonus durability granted when combining two damageable items (12/100 of max damage). */
  sacrificeRepairBonus?: AnvilFraction;
  /** Book fee: per-level anvil cost is divided by `divisor` (min `minimum`) when the sacrifice is a book. */
  bookCostFee?: { divisor: number; minimum: number };
  /** Chance the anvil degrades one stage after use. */
  anvilBreakChance?: number;
  /** Player.getXpNeededForNextLevel brackets, lowest minLevel first. */
  xpPerLevelBrackets?: AnvilXpBracket[];
  /** Decompiled source files the mechanics were parsed from. */
  sourcePaths: string[];
  /** Parse gaps: fields that could not be derived from source, with the reason. */
  warnings: string[];
}

/** A block/item a Sulfur Cube can swallow, with its display name resolved from en_us when available. */
export interface SulfurCubeBlock {
  id: string;
  name: string;
}

/** One entity-attribute modifier a cube gains while wearing an archetype's block, exactly as in the archetype JSON. */
export interface SulfurCubeAttributeModifier {
  attribute: string;
  amount: number;
  operation: string;
  id: string;
}

/**
 * Human-oriented behavior numbers, mirroring the game's `archetype(speed, bounce, friction, drag)`
 * helper. These are the effective attribute values a cube adopts (base bounciness/knockback are 0,
 * base friction/air-drag are 1, so the modifier value is the effective value).
 */
export interface SulfurCubeBehavior {
  /** Game helper "speed" = -knockback_resistance. Higher = shoved further/faster when hit or bumped into. */
  mobility: number;
  /** Effective bounciness attribute, 0..1. Higher = bounces more. */
  bounciness: number;
  /** Effective friction_modifier. Lower = slipperier (slides), higher = grippy/sticky. */
  friction: number;
  /** Effective air_drag_modifier. Lower = keeps momentum and travels further; higher = damps quickly. */
  airDrag: number;
}

/** The TNT-like explosion an explosive archetype produces when primed. */
export interface SulfurCubeExplosion {
  power: number;
  causesFire: boolean;
  /** Fuse length in ticks once primed. */
  fuse: number;
}

/** Contact damage a cube deals to entities it touches while wearing a block (e.g. the hot archetype). */
export interface SulfurCubeContactDamage {
  damageType: string;
  amount: number;
  attributeToSource: boolean;
}

/** Per-archetype knockback the cube imparts when a player walks into it or it is hit. */
export interface SulfurCubeKnockback {
  horizontalPower: number;
  verticalPower: number;
}

/** Per-archetype hit/push sounds and push-sound gating. */
export interface SulfurCubeSound {
  hit: string;
  push: string;
  pushCooldownSeconds: number;
  pushImpulseThreshold: number;
}

/**
 * One Sulfur Cube archetype: the behavior profile a cube takes on while it has swallowed a matching
 * block, plus the fully-resolved list of blocks that select it.
 */
export interface SulfurCubeArchetypeDefinition {
  /** Namespaced archetype id, e.g. "minecraft:regular". */
  id: string;
  /** Bare archetype key, e.g. "regular". */
  key: string;
  displayName: string;
  behavior: SulfurCubeBehavior;
  /** Raw attribute modifiers exactly as declared in the archetype JSON (unrounded for provenance). */
  attributeModifiers: SulfurCubeAttributeModifier[];
  /** Floats on water/lava while holding a block. */
  buoyant: boolean;
  explosive: boolean;
  dealsContactDamage: boolean;
  explosion?: SulfurCubeExplosion;
  contactDamage?: SulfurCubeContactDamage;
  knockback: SulfurCubeKnockback;
  sound: SulfurCubeSound;
  /** The item tag whose members select this archetype (e.g. "#minecraft:sulfur_cube_archetype/regular"). */
  itemsTag: string;
  /** Nested tag references kept from the archetype's item tag for provenance. */
  blockTags: string[];
  blocks: SulfurCubeBlock[];
  blockCount: number;
  sourcePath: string;
}

/** One attribute in the Sulfur Cube's base attribute supplier, resolved to its base value and clamp range. */
export interface SulfurCubeBaseAttribute {
  attribute: string;
  /** Base value the entity's AttributeSupplier declares for this attribute. */
  base: number;
  min: number;
  max: number;
  /** The attribute registry's own default base value. */
  attributeDefault: number;
  /** True when the entity's supplier sets a base other than the registry default. */
  overridden: boolean;
  /** Extra provenance, e.g. a runtime override not visible in the static supplier. */
  note?: string;
}

/** Static, block-independent facts about the Sulfur Cube entity. */
export interface SulfurCubeEntityMeta {
  id: string;
  displayName: string;
  spawnBiome?: string;
  fullSize: number;
  babySize: number;
  /** maxHealth = healthPerSize * size (full cube and baby). */
  healthPerSize?: number;
  temptRange?: number;
  splitCount?: number;
  /** Ticks a cube ignores nearby items after being sheared. */
  pickupTimerTicks?: number;
  experienceReward?: { min: number; max: number };
  bucketItem: string;
  spawnEggItem: string;
  contentComponent: string;
  particle: string;
  /** Items that feed a baby cube / are used for breeding. */
  foodItems: string[];
  /** Item tag of everything a cube can swallow. */
  swallowableTag: string;
  shearable: boolean;
  bucketable: boolean;
  /** Dataset-relative served entity texture paths (fetch at `/versions/:v/assets/<path>`). */
  textures: string[];
}

/** The bespoke damage type the hot archetype applies on contact. */
export interface SulfurCubeHotDamageType {
  id: string;
  effects?: string;
  exhaustion?: number;
  scaling?: string;
  messageId?: string;
}

/**
 * Source-derived Sulfur Cube dataset: how a cube behaves depending on the block it has swallowed.
 * Derived from the data-driven archetype registry, the archetype/swallowable item tags, the hot
 * damage type, and a handful of constants parsed from the entity source. Optional/warn on gaps.
 */
export interface SulfurCubeDataset {
  entity: SulfurCubeEntityMeta;
  /** Factual notes on how swallowing and the resulting behavior swap work. */
  behaviorModel: string[];
  /** The cube's complete base attribute supplier: every attribute it has, with base value and clamp range. */
  baseAttributes: SulfurCubeBaseAttribute[];
  /** Damage types a cube becomes immune to while wearing any block. */
  immunitiesWhenHoldingBlock: string[];
  hotDamageType?: SulfurCubeHotDamageType;
  archetypes: SulfurCubeArchetypeDefinition[];
  /** Reverse lookup: swallowable block/item id → archetype key. */
  blockIndex: Record<string, string>;
  sourcePaths: string[];
  warnings: string[];
}

export interface TagDefinition {
  id: string;
  registry: string;
  replace: boolean;
  values: string[];
  sourcePath: string;
  raw: JsonValue;
}

export interface LootTableDefinition {
  id: string;
  type?: string;
  poolCount: number;
  itemDrops: string[];
  functions: string[];
  sourcePath: string;
  raw: JsonValue;
}

export interface AdvancementRewardsDefinition {
  recipes?: string[];
  loot?: string[];
  experience?: number;
  function?: string;
}

export interface AdvancementDefinition {
  id: string;
  parent?: string;
  titleKey?: string;
  descriptionKey?: string;
  iconItem?: string;
  frame?: string;
  criteria: string[];
  rewards?: AdvancementRewardsDefinition;
  sourcePath: string;
  raw: JsonValue;
}

export interface TranslationEntry {
  key: string;
  value: string;
}

/** Hex colors a biome publishes through its client-side visual effects. */
export interface BiomeEffectColors {
  waterColor?: string;
  waterFogColor?: string;
  fogColor?: string;
  skyColor?: string;
  grassColor?: string;
  foliageColor?: string;
}

export type BiomePlacement = "surface" | "underground" | "special" | "nether" | "end";

export interface BiomeYRange {
  /** Inclusive minimum build Y from the source dimension type. */
  min: number;
  /** Inclusive maximum build Y from the source dimension type. */
  max: number;
  /** Source JSON used to derive this broad dimension envelope. */
  sourcePath: string;
}

export interface BiomeDefinition {
  /** Namespaced id, e.g. `minecraft:plains`. */
  id: string;
  /** Bare key, e.g. `plains`. */
  key: string;
  /** Localized display name from `en_us` (falls back to a humanized key). */
  name: string;
  /** Dimension the biome generates in, derived from worldgen biome tags. */
  dimension: "overworld" | "nether" | "end" | "unknown";
  /** Coarse grouping (ocean, river, forest, mountain, …) for legends/filters. */
  category: string;
  /** Stable consumer-facing placement bucket for map/search UIs. */
  placement: BiomePlacement;
  /** True when correct lookup requires an X/Y/Z sample rather than X/Z only. */
  requiresY: boolean;
  /** Alias for requiresY kept explicit for non-TypeScript consumers. */
  vertical: boolean;
  /** Broad source-derived Y envelope when the biome is vertical. */
  yRange?: BiomeYRange;
  /** True when the biome belongs to normal overworld surface climate lookup. */
  surfaceClimate: boolean;
  /** True when a surface-only 2D X/Z biome map should emit this biome. */
  surfaceMap: boolean;
  /** False for registry/special biomes that should be hidden from normal biome search. */
  searchable: boolean;
  temperature: number;
  downfall?: number;
  hasPrecipitation: boolean;
  effects: BiomeEffectColors;
  /** `worldgen/biome` tag ids this biome belongs to (e.g. `minecraft:is_forest`). */
  tags: string[];
  sourcePath: string;
  raw: JsonValue;
}

/** A dye color as it applies to banners (base color + pattern tint). */
export interface BannerColorDefinition {
  /** Bare dye id, e.g. `light_blue`. */
  id: string;
  /** Localized display name from `color.minecraft.<id>` (e.g. "Light Blue"). */
  label: string;
  /** `DyeColor.getTextureDiffuseColor()` split into 8-bit channels. */
  rgb: [number, number, number];
  /** Same color as `#rrggbb`. */
  hex: string;
  /** Legacy 0–15 dye id (white=0 … black=15) used by pre-1.20.5 banner NBT. */
  legacyId: number;
  /** Dye item id, e.g. `light_blue_dye`. */
  dyeItem: string;
  /** Colored banner item id, e.g. `light_blue_banner`. */
  bannerItem: string;
}

/** A banner overlay pattern (the loom layers stacked over a base color). */
export interface BannerPatternDefinition {
  /** Registry/pattern id, e.g. `stripe_bottom`. */
  id: string;
  /** Texture file basename under `entity/banner/` (matches `id`). */
  assetId: string;
  /** Dataset-relative texture path, e.g. `images/entity/banner/stripe_bottom.png`. */
  texturePath: string;
  /** Heraldic display name (e.g. "Saltire"), the color word stripped from `en_us`. */
  label: string;
  /** Legacy 2-letter NBT code (e.g. `bs`); absent for patterns added after 1.20.4. */
  legacyCode?: string;
  /** Whether the pattern needs a banner-pattern item in the loom (not just dye). */
  requiresItem: boolean;
  /** The banner-pattern item id when `requiresItem`, e.g. `creeper_banner_pattern`. */
  patternItem?: string;
}

/** Everything the banner designer needs: the overlay catalog + dye colors. */
export interface BannerDataset {
  patterns: BannerPatternDefinition[];
  colors: BannerColorDefinition[];
}

export interface VersionDataset {
  version: string;
  generatedAt: string;
  provenance: {
    sourceArtifacts: string[];
    extractedFromPaths: string[];
    mappingProvider?: MappingProvider;
  };
  blocks: BlockDefinition[];
  items: ItemDefinition[];
  recipes: RecipeDefinition[];
  textures: TextureDefinition[];
  models: ModelDefinition[];
  palettes: PaletteDefinition[];
  itemStats: ItemStatDefinition[];
  blockProperties: BlockPropertyDefinition[];
  enchantments: EnchantmentDefinition[];
  tags: TagDefinition[];
  lootTables: LootTableDefinition[];
  advancements: AdvancementDefinition[];
  translations: TranslationEntry[];
  biomes: BiomeDefinition[];
  mobImages: MobImageDefinition[];
  mobModels: MobModelDefinition[];
  /** Baked LayerDefinitions geometry for block entities without data-driven block models (chest, shulker box, conduit, banner, decorated pot, bell). Optional so older datasets still load. */
  blockEntityModels?: MobModelDefinition[];
  mobSounds: MobSoundDefinition[];
  /** Source-derived per-mob profiles (stats + aggregated render/sound/loot/tag data). Optional so older datasets still load. */
  mobProfiles?: MobProfileDefinition[];
  /** Source-derived anvil combine/repair mechanics. Optional so older datasets still load. */
  anvilMechanics?: AnvilMechanicsDefinition;
  /** Source-derived Sulfur Cube archetypes and the blocks that select them. Optional so older datasets still load. */
  sulfurCube?: SulfurCubeDataset;
  /** Banner pattern catalog + dye colors. Optional so older datasets still load. */
  banners?: BannerDataset;
  renderData?: MinecraftRenderDataset;
  mobSoundMinecraftWiki?: MinecraftWikiMobSoundAlignment;
  resourcePack?: ResourcePackDefinition;
}

export interface CollectionChange<T> {
  id: string;
  before: T;
  after: T;
}

export interface CollectionDiff<T> {
  added: T[];
  removed: T[];
  changed: CollectionChange<T>[];
  unchangedCount: number;
}

export interface VersionDiff {
  fromVersion: string;
  toVersion: string;
  generatedAt: string;
  blocks: CollectionDiff<BlockDefinition>;
  items: CollectionDiff<ItemDefinition>;
  recipes: CollectionDiff<RecipeDefinition>;
  textures: CollectionDiff<TextureDefinition>;
  models: CollectionDiff<ModelDefinition>;
  palettes: CollectionDiff<PaletteDefinition>;
  itemStats: CollectionDiff<ItemStatDefinition>;
  blockProperties: CollectionDiff<BlockPropertyDefinition>;
  enchantments: CollectionDiff<EnchantmentDefinition>;
  tags: CollectionDiff<TagDefinition>;
  lootTables: CollectionDiff<LootTableDefinition>;
  advancements: CollectionDiff<AdvancementDefinition>;
  translations: CollectionDiff<TranslationEntry>;
  biomes: CollectionDiff<BiomeDefinition>;
  mobImages: CollectionDiff<MobImageDefinition>;
  mobModels: CollectionDiff<MobModelDefinition>;
  mobSounds: CollectionDiff<MobSoundDefinition>;
  mobProfiles: CollectionDiff<MobProfileDefinition>;
}

export interface ToolStepResult {
  status: "done" | "skipped" | "failed";
  inputPath?: string;
  outputPath?: string;
  command?: string;
  reason?: string;
}

export interface DecompileReport {
  version: string;
  mappingProvider: MappingProvider;
  generatedAt: string;
  client: ToolStepResult;
  server: ToolStepResult;
}

export interface StoredState {
  processedNewsPosts: Record<string, { processedAt: string; versions: string[] }>;
  processedVersions: Record<
    string,
    {
      processedAt: string;
      fingerprint: string;
      datasetPath: string;
      metadataPath: string;
    }
  >;
}
