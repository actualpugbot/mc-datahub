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
