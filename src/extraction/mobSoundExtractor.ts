import { promises as fs } from "node:fs";
import { join } from "node:path";
import { MergedArchiveSource, type ArchiveSource } from "../archive/archiveSource.js";
import type { FileCache } from "../core/cache.js";
import { fileExists } from "../core/fs.js";
import type { HttpClient } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import type {
  JsonValue,
  MobSoundDefinition,
  MobSoundEventDefinition,
  MobSoundVariantDefinition,
  ResourcePackDefinition,
  VersionMetadata,
} from "../domain/types.js";
import { normalizeMinecraftId } from "./normalizers.js";

const ASSET_DOWNLOAD_BASE_URL = "https://resources.download.minecraft.net";
// Minecraft 26.2 relocated entity registrations from EntityType.java to EntityTypes.java; keep both for older versions.
const ENTITY_TYPE_SOURCE_PATHS = [
  "net/minecraft/world/entity/EntityTypes.java",
  "net/minecraft/world/entity/EntityType.java",
] as const;
const ENTITY_TYPE_IDS_SOURCE_PATH = "net/minecraft/world/entity/EntityTypeIds.java";
const ARCHIVE_LANGUAGE_PATH = "assets/minecraft/lang/en_us.json";
const IMMUTABLE_CACHE_MS = 1000 * 60 * 60 * 24 * 365;

const ALLOWED_MOB_CATEGORIES = new Set([
  "AMBIENT",
  "AXOLOTLS",
  "CREATURE",
  "MONSTER",
  "UNDERGROUND_WATER_CREATURE",
  "WATER_AMBIENT",
  "WATER_CREATURE",
]);
const EXPLICIT_MISC_MOBS = new Set(["iron_golem", "snow_golem", "villager"]);
const FALLBACK_NON_MOB_IDS = new Set([
  "acacia_boat",
  "acacia_chest_boat",
  "area_effect_cloud",
  "armor_stand",
  "arrow",
  "bamboo_chest_raft",
  "bamboo_raft",
  "birch_boat",
  "birch_chest_boat",
  "block_display",
  "boat",
  "breeze_wind_charge",
  "cherry_boat",
  "cherry_chest_boat",
  "chest_boat",
  "command_block_minecart",
  "display",
  "dragon_fireball",
  "egg",
  "end_crystal",
  "ender_pearl",
  "ender_signal",
  "evoker_fangs",
  "experience_bottle",
  "experience_orb",
  "eye_of_ender",
  "falling_block",
  "fireball",
  "firework_rocket",
  "fishing_bobber",
  "glow_item_frame",
  "hopper_minecart",
  "interaction",
  "item",
  "item_display",
  "item_frame",
  "leash_knot",
  "lightning_bolt",
  "llama_spit",
  "mannequin",
  "minecart",
  "oak_boat",
  "oak_chest_boat",
  "painting",
  "player",
  "potion",
  "raft",
  "shulker_bullet",
  "small_fireball",
  "snowball",
  "spectral_arrow",
  "spawner_minecart",
  "spruce_boat",
  "spruce_chest_boat",
  "text_display",
  "tnt",
  "tnt_minecart",
  "trident",
  "wind_charge",
  "wither_skull",
]);
const SHARED_SOUND_EVENT_FALLBACKS = new Map<string, string[]>([
  ["entity.cod.ambient", ["entity.fish.swim"]],
  ["entity.salmon.ambient", ["entity.fish.swim"]],
  ["entity.tropical_fish.ambient", ["entity.fish.swim"]],
]);

interface AssetIndexObject {
  hash: string;
  size: number;
}

interface AssetIndexResponse {
  objects: Record<string, AssetIndexObject>;
}

interface RawSoundEntry {
  attenuation_distance?: number;
  name?: string;
  pitch?: number;
  preload?: boolean;
  stream?: boolean;
  type?: "event" | "sound";
  volume?: number;
  weight?: number;
}

interface RawSoundEvent {
  replace?: boolean;
  sounds?: Array<string | RawSoundEntry>;
  subtitle?: string;
}

type SoundManifest = Record<string, RawSoundEvent>;
type LanguageMap = Record<string, string>;

interface MobRegistration {
  localId: string;
  mobCategory: string;
}

interface MobSoundExtractionResult {
  mobSounds: MobSoundDefinition[];
  resourcePack?: ResourcePackDefinition;
}

export class MobSoundExtractor {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: FileCache,
    private readonly logger: Logger,
  ) {}

  async extract(
    version: string,
    metadata: VersionMetadata,
    sources: ArchiveSource[],
    decompiledClientRoot: string,
  ): Promise<MobSoundExtractionResult> {
    const archive = new MergedArchiveSource(sources);
    const assetIndex = await this.loadAssetIndex(metadata);
    const [soundManifest, languageMap, resourcePack] = await Promise.all([
      this.loadSoundManifest(assetIndex),
      this.loadLanguageMap(assetIndex, archive),
      this.loadResourcePackDefinition(archive, assetIndex, decompiledClientRoot),
    ]);
    const eventsByNormalizedSoundId = this.groupEntityEventsByNormalizedId(soundManifest);
    const soundIdsByNormalizedId = this.groupSoundIdsByNormalizedId(soundManifest);
    const registrations = await this.loadMobRegistrations(decompiledClientRoot, languageMap, soundManifest);

    const mobSounds = registrations
      .map((registration) =>
        this.buildMobSoundDefinition(registration, eventsByNormalizedSoundId, soundIdsByNormalizedId, soundManifest, languageMap, assetIndex),
      )
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    this.logger.debug(`Resolved ${mobSounds.length} mob sound definitions for ${version}.`);
    return {
      mobSounds,
      resourcePack,
    };
  }

  private async loadAssetIndex(metadata: VersionMetadata): Promise<AssetIndexResponse> {
    const assetIndexUrl = metadata.assetIndex?.url;
    if (!assetIndexUrl) {
      return { objects: {} };
    }

    return this.cache.remember(`asset-index:${assetIndexUrl}`, IMMUTABLE_CACHE_MS, () =>
      this.http.getJson<AssetIndexResponse>(assetIndexUrl),
    );
  }

  private async loadSoundManifest(assetIndex: AssetIndexResponse): Promise<SoundManifest> {
    return (await this.loadJsonAsset<SoundManifest>(assetIndex, "minecraft/sounds.json")) ?? {};
  }

  private async loadLanguageMap(assetIndex: AssetIndexResponse, archive: ArchiveSource): Promise<LanguageMap> {
    const jsonLanguageMap = await this.loadJsonAsset<LanguageMap>(assetIndex, "minecraft/lang/en_us.json");
    if (jsonLanguageMap) {
      return jsonLanguageMap;
    }

    // Minecraft 26.2+ ships en_us.json inside the client JAR instead of the asset index.
    const archiveLanguageMap = await this.tryReadJson(archive, ARCHIVE_LANGUAGE_PATH);
    if (archiveLanguageMap && !Array.isArray(archiveLanguageMap) && typeof archiveLanguageMap === "object") {
      return archiveLanguageMap as LanguageMap;
    }

    const legacyLanguage = await this.loadTextAsset(assetIndex, "minecraft/lang/en_us.lang");
    if (!legacyLanguage) {
      return {};
    }

    const languageMap: LanguageMap = {};
    for (const line of legacyLanguage.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      languageMap[trimmed.slice(0, separatorIndex)] = trimmed.slice(separatorIndex + 1);
    }

    return languageMap;
  }

  private async loadResourcePackDefinition(
    archive: ArchiveSource,
    assetIndex: AssetIndexResponse,
    decompiledClientRoot: string,
  ): Promise<ResourcePackDefinition | undefined> {
    const raw =
      (await this.tryReadJson(archive, "pack.mcmeta")) ?? (await this.loadJsonAsset<JsonValue>(assetIndex, "pack.mcmeta"));
    if (raw && !Array.isArray(raw) && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const pack = record.pack;
      if (pack && !Array.isArray(pack) && typeof pack === "object") {
        const packRecord = pack as Record<string, unknown>;
        const packFormat = typeof packRecord.pack_format === "number" ? packRecord.pack_format : undefined;
        const supportedFormats = this.parseSupportedFormats(packRecord.supported_formats);
        if (packFormat !== undefined || supportedFormats) {
          return {
            packFormat: packFormat ?? supportedFormats?.max ?? supportedFormats?.min ?? 0,
            description: typeof packRecord.description === "string" ? packRecord.description : undefined,
            supportedFormats,
          };
        }
      }
    }

    return this.loadResourcePackDefinitionFromVersionJson(decompiledClientRoot);
  }

  private parseSupportedFormats(value: unknown): ResourcePackDefinition["supportedFormats"] {
    if (typeof value === "number") {
      return { min: value, max: value };
    }

    if (Array.isArray(value)) {
      const numericValues = value.filter((entry): entry is number => typeof entry === "number");
      if (numericValues.length === 0) {
        return undefined;
      }

      return {
        min: Math.min(...numericValues),
        max: Math.max(...numericValues),
      };
    }

    if (!value || typeof value !== "object") {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const min =
      typeof record.min_inclusive === "number"
        ? record.min_inclusive
        : typeof record.min === "number"
          ? record.min
          : undefined;
    const max =
      typeof record.max_inclusive === "number"
        ? record.max_inclusive
        : typeof record.max === "number"
          ? record.max
          : undefined;
    if (min === undefined && max === undefined) {
      return undefined;
    }

    return { min, max };
  }

  private async loadMobRegistrations(
    decompiledClientRoot: string,
    languageMap: LanguageMap,
    soundManifest: SoundManifest,
  ): Promise<MobRegistration[]> {
    const parsed = await this.parseEntityTypeRegistrations(decompiledClientRoot);
    if (parsed.length > 0) {
      return parsed;
    }

    return this.deriveFallbackRegistrations(languageMap, soundManifest);
  }

  private async parseEntityTypeRegistrations(decompiledClientRoot: string): Promise<MobRegistration[]> {
    const idsByConstant = await this.loadEntityTypeIds(decompiledClientRoot);

    for (const candidatePath of ENTITY_TYPE_SOURCE_PATHS) {
      const sourcePath = join(decompiledClientRoot, candidatePath);
      if (!(await fileExists(sourcePath))) {
        continue;
      }

      const source = await fs.readFile(sourcePath, "utf8");
      const registrations = this.parseRegistrationsFromSource(source, idsByConstant);
      if (registrations.length > 0) {
        return registrations;
      }
    }

    return [];
  }

  private parseRegistrationsFromSource(source: string, idsByConstant: Map<string, string>): MobRegistration[] {
    const registrations: MobRegistration[] = [];
    // The first register() argument is either a string literal ("allay") or, since 26.2, an EntityTypeIds constant.
    const registrationPattern =
      /public static final EntityType<[^>]+>\s+[A-Z0-9_]+\s*=\s*register\(\s*([^,]+?)\s*,([\s\S]*?)\n\s*\);\n/g;

    for (const match of source.matchAll(registrationPattern)) {
      const localId = this.resolveRegistrationId(match[1] ?? "", idsByConstant);
      const registrationBody = match[2] ?? "";
      const mobCategoryMatch = registrationBody.match(/MobCategory\.([A-Z_]+)/);
      const mobCategory = mobCategoryMatch?.[1];
      if (!localId || !mobCategory) {
        continue;
      }

      if (!ALLOWED_MOB_CATEGORIES.has(mobCategory) && !EXPLICIT_MISC_MOBS.has(localId)) {
        continue;
      }

      registrations.push({ localId, mobCategory });
    }

    return registrations.sort((left, right) => left.localId.localeCompare(right.localId));
  }

  private resolveRegistrationId(rawId: string, idsByConstant: Map<string, string>): string | undefined {
    const trimmed = rawId.trim();
    const stringLiteralMatch = trimmed.match(/^"([^"]+)"$/);
    if (stringLiteralMatch) {
      return stringLiteralMatch[1];
    }

    // 26.2+ references a constant (e.g. EntityTypeIds.ALLAY); resolve it via EntityTypeIds.create("allay").
    const constantName = trimmed.split(".").pop();
    if (!constantName || !/^[A-Z0-9_]+$/.test(constantName)) {
      return undefined;
    }

    return idsByConstant.get(constantName) ?? constantName.toLowerCase();
  }

  private async loadEntityTypeIds(decompiledClientRoot: string): Promise<Map<string, string>> {
    const sourcePath = join(decompiledClientRoot, ENTITY_TYPE_IDS_SOURCE_PATH);
    if (!(await fileExists(sourcePath))) {
      return new Map();
    }

    const source = await fs.readFile(sourcePath, "utf8");
    const idsByConstant = new Map<string, string>();
    const idPattern = /\b([A-Z0-9_]+)\s*=\s*create\(\s*"([^"]+)"\s*\)/g;
    for (const match of source.matchAll(idPattern)) {
      const constantName = match[1];
      const id = match[2];
      if (constantName && id) {
        idsByConstant.set(constantName, id);
      }
    }

    return idsByConstant;
  }

  private deriveFallbackRegistrations(languageMap: LanguageMap, soundManifest: SoundManifest): MobRegistration[] {
    const registrations = new Map<string, MobRegistration>();
    const localizedEntityIds = Object.keys(languageMap)
      .filter((key) => key.startsWith("entity.minecraft."))
      .map((key) => key.slice("entity.minecraft.".length));
    const localizedEntityIdsByNormalized = new Map(localizedEntityIds.map((localId) => [normalizeLookupId(localId), localId]));

    for (const soundEventId of Object.keys(soundManifest)) {
      if (!soundEventId.startsWith("entity.")) {
        continue;
      }

      const soundId = soundEventId.split(".")[1] ?? "";
      const localId = localizedEntityIdsByNormalized.get(normalizeLookupId(soundId));
      if (!localId || FALLBACK_NON_MOB_IDS.has(localId)) {
        continue;
      }

      registrations.set(localId, {
        localId,
        mobCategory: "UNKNOWN",
      });
    }

    return Array.from(registrations.values()).sort((left, right) => left.localId.localeCompare(right.localId));
  }

  private groupEntityEventsByNormalizedId(soundManifest: SoundManifest): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const eventId of Object.keys(soundManifest).sort()) {
      if (!eventId.startsWith("entity.")) {
        continue;
      }

      const soundId = eventId.split(".")[1] ?? "";
      const normalizedSoundId = normalizeLookupId(soundId);
      const existing = grouped.get(normalizedSoundId) ?? [];
      existing.push(eventId);
      grouped.set(normalizedSoundId, existing);
    }

    return grouped;
  }

  private groupSoundIdsByNormalizedId(soundManifest: SoundManifest): Map<string, string> {
    const grouped = new Map<string, string>();
    for (const eventId of Object.keys(soundManifest)) {
      if (!eventId.startsWith("entity.")) {
        continue;
      }

      const soundId = eventId.split(".")[1] ?? "";
      const normalizedSoundId = normalizeLookupId(soundId);
      if (!grouped.has(normalizedSoundId)) {
        grouped.set(normalizedSoundId, soundId);
      }
    }

    return grouped;
  }

  private buildMobSoundDefinition(
    registration: MobRegistration,
    eventsByNormalizedSoundId: Map<string, string[]>,
    soundIdsByNormalizedId: Map<string, string>,
    soundManifest: SoundManifest,
    languageMap: LanguageMap,
    assetIndex: AssetIndexResponse,
  ): MobSoundDefinition {
    const normalizedId = normalizeLookupId(registration.localId);
    const soundEventIds = eventsByNormalizedSoundId.get(normalizedId) ?? [];
    const soundId = soundIdsByNormalizedId.get(normalizedId) ?? registration.localId;
    const translationKey = `entity.minecraft.${registration.localId}`;
    const displayName = languageMap[translationKey] ?? humanizeIdentifier(registration.localId);
    const soundEvents = soundEventIds.map((eventId) => this.buildSoundEvent(eventId, soundManifest, languageMap, assetIndex));
    const soundVariantCount = soundEvents.reduce((count, eventDefinition) => count + eventDefinition.variants.length, 0);

    return {
      id: normalizeMinecraftId(registration.localId),
      localId: registration.localId,
      soundId,
      displayName,
      translationKey,
      category: humanizeIdentifier(registration.mobCategory),
      mobCategory: registration.mobCategory,
      soundEventCount: soundEvents.length,
      soundVariantCount,
      soundEvents,
    };
  }

  private buildSoundEvent(
    eventId: string,
    soundManifest: SoundManifest,
    languageMap: LanguageMap,
    assetIndex: AssetIndexResponse,
  ): MobSoundEventDefinition {
    const rawEvent = soundManifest[eventId] ?? {};
    const variants = this.resolveSoundVariants(eventId, soundManifest, assetIndex, new Set<string>());
    const subtitleKey = rawEvent.subtitle ?? this.resolveFallbackSubtitleKey(eventId, soundManifest, new Set<string>());

    return {
      id: eventId,
      subtitleKey,
      subtitle: subtitleKey ? languageMap[subtitleKey] : undefined,
      variants,
    };
  }

  private resolveSoundVariants(
    eventId: string,
    soundManifest: SoundManifest,
    assetIndex: AssetIndexResponse,
    visitedEvents: Set<string>,
  ): MobSoundVariantDefinition[] {
    if (visitedEvents.has(eventId)) {
      return [];
    }

    visitedEvents.add(eventId);
    const rawEvent = soundManifest[eventId];
    if (!rawEvent?.sounds?.length) {
      return this.resolveFallbackSoundVariants(eventId, soundManifest, assetIndex, visitedEvents);
    }

    const variants: MobSoundVariantDefinition[] = [];
    for (const soundEntry of rawEvent.sounds) {
      if (typeof soundEntry === "string") {
        const variant = this.toVariantDefinition(eventId, variants.length, soundEntry, {}, assetIndex);
        if (variant) {
          variants.push(variant);
        }
        continue;
      }

      if (!soundEntry || typeof soundEntry !== "object") {
        continue;
      }

      if (soundEntry.type === "event") {
        if (typeof soundEntry.name !== "string") {
          continue;
        }

        variants.push(...this.resolveSoundVariants(soundEntry.name, soundManifest, assetIndex, new Set(visitedEvents)));
        continue;
      }

      if (typeof soundEntry.name !== "string") {
        continue;
      }

      const variant = this.toVariantDefinition(eventId, variants.length, soundEntry.name, soundEntry, assetIndex);
      if (variant) {
        variants.push(variant);
      }
    }

    if (variants.length === 0) {
      variants.push(...this.resolveFallbackSoundVariants(eventId, soundManifest, assetIndex, visitedEvents));
    }

    return variants;
  }

  private resolveFallbackSubtitleKey(
    eventId: string,
    soundManifest: SoundManifest,
    visitedEvents: Set<string>,
  ): string | undefined {
    if (visitedEvents.has(eventId)) {
      return undefined;
    }

    visitedEvents.add(eventId);
    const subtitleKey = soundManifest[eventId]?.subtitle;
    if (subtitleKey) {
      return subtitleKey;
    }

    for (const fallbackEventId of SHARED_SOUND_EVENT_FALLBACKS.get(eventId) ?? []) {
      const fallbackSubtitleKey = this.resolveFallbackSubtitleKey(fallbackEventId, soundManifest, new Set(visitedEvents));
      if (fallbackSubtitleKey) {
        return fallbackSubtitleKey;
      }
    }

    return undefined;
  }

  private resolveFallbackSoundVariants(
    eventId: string,
    soundManifest: SoundManifest,
    assetIndex: AssetIndexResponse,
    visitedEvents: Set<string>,
  ): MobSoundVariantDefinition[] {
    const variants: MobSoundVariantDefinition[] = [];

    for (const fallbackEventId of SHARED_SOUND_EVENT_FALLBACKS.get(eventId) ?? []) {
      variants.push(...this.resolveSoundVariants(fallbackEventId, soundManifest, assetIndex, new Set(visitedEvents)));
    }

    return variants;
  }

  private toVariantDefinition(
    eventId: string,
    index: number,
    rawSoundPath: string,
    soundEntry: RawSoundEntry,
    assetIndex: AssetIndexResponse,
  ): MobSoundVariantDefinition | undefined {
    const soundPath = stripMinecraftNamespace(rawSoundPath).replace(/\.ogg$/i, "");
    const assetPath = `minecraft/sounds/${soundPath}.ogg`;
    const asset = assetIndex.objects[assetPath];
    if (!asset) {
      this.logger.debug(`Skipping sound variant without asset index entry: ${assetPath}`);
      return undefined;
    }

    return {
      id: `${eventId}#${index + 1}`,
      soundPath,
      assetPath,
      url: toAssetDownloadUrl(asset.hash),
      hash: asset.hash,
      size: asset.size,
      stream: soundEntry.stream ?? false,
      preload: soundEntry.preload ?? false,
      volume: soundEntry.volume ?? 1,
      pitch: soundEntry.pitch ?? 1,
      weight: soundEntry.weight ?? 1,
      attenuationDistance: soundEntry.attenuation_distance,
    };
  }

  private async loadJsonAsset<T>(assetIndex: AssetIndexResponse, assetPath: string): Promise<T | undefined> {
    const asset = assetIndex.objects[assetPath];
    if (!asset) {
      return undefined;
    }

    return this.cache.remember(`asset-json:${asset.hash}`, IMMUTABLE_CACHE_MS, () => this.http.getJson<T>(toAssetDownloadUrl(asset.hash)));
  }

  private async loadTextAsset(assetIndex: AssetIndexResponse, assetPath: string): Promise<string | undefined> {
    const asset = assetIndex.objects[assetPath];
    if (!asset) {
      return undefined;
    }

    return this.cache.remember(`asset-text:${asset.hash}`, IMMUTABLE_CACHE_MS, () => this.http.getText(toAssetDownloadUrl(asset.hash)));
  }

  private async tryReadJson(source: ArchiveSource, path: string): Promise<JsonValue | undefined> {
    try {
      return await source.readJson<JsonValue>(path);
    } catch {
      return undefined;
    }
  }

  private async loadResourcePackDefinitionFromVersionJson(
    decompiledClientRoot: string,
  ): Promise<ResourcePackDefinition | undefined> {
    const versionJsonPath = join(decompiledClientRoot, "version.json");
    if (!(await fileExists(versionJsonPath))) {
      return undefined;
    }

    const raw = JSON.parse(await fs.readFile(versionJsonPath, "utf8")) as {
      pack_version?: {
        resource_major?: number;
      };
    };
    const packFormat = raw.pack_version?.resource_major;
    if (typeof packFormat !== "number") {
      return undefined;
    }

    return {
      packFormat,
    };
  }
}

function humanizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeLookupId(value: string): string {
  return stripMinecraftNamespace(value).replace(/_/g, "").toLowerCase();
}

function stripMinecraftNamespace(value: string): string {
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}

function toAssetDownloadUrl(hash: string): string {
  return `${ASSET_DOWNLOAD_BASE_URL}/${hash.slice(0, 2)}/${hash}`;
}
