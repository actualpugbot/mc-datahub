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
  faces: Record<MobModelFaceName, MobModelFaceDefinition>;
}

export interface MobModelPartDefinition {
  name: string;
  path: string;
  pivot: [number, number, number];
  rotation: [number, number, number];
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

export interface EnchantmentDefinition {
  id: string;
  descriptionKey?: string;
  description?: string;
  supportedItems?: string;
  primaryItems?: string;
  maxLevel?: number;
  weight?: number;
  anvilCost?: number;
  slots: string[];
  exclusiveSet?: string;
  sourcePath: string;
  raw: JsonValue;
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
