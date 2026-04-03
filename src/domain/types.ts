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
  kind: "block" | "item" | "other";
  sourcePath: string;
  imagePath?: string;
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
  mobSounds: MobSoundDefinition[];
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
