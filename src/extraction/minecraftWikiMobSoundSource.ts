import type { FileCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import type {
  MinecraftWikiMobSoundAlignment,
  MinecraftWikiMobSoundCategory,
  MinecraftWikiMobSoundCategoryAlignment,
  MinecraftWikiMobSoundFile,
  MinecraftWikiMobSoundSnapshot,
  MobSoundDefinition,
  MobSoundVariantDefinition,
} from "../domain/types.js";

const DEFAULT_MINECRAFT_WIKI_API_URL = "https://minecraft.wiki/api.php";
const MINECRAFT_WIKI_PAGE_BASE_URL = "https://minecraft.wiki/w/";
const ROOT_CATEGORY_TITLE = "Category:Mob sounds";
const API_CACHE_MS = 1000 * 60 * 60 * 24;

const WIKI_CATEGORY_ALIASES = new Map<string, string>([
  ["cod", "fish"],
  ["elder_guardian", "guardian"],
  ["endermite", "silverfish"],
  ["salmon", "fish"],
  ["tropical_fish", "fish"],
]);

interface MediaWikiContinue {
  continue?: string;
  cmcontinue?: string;
  gcmcontinue?: string;
}

interface MediaWikiCategoryMember {
  pageid: number;
  ns: number;
  title: string;
}

interface MediaWikiImageInfo {
  descriptionurl?: string;
  duration?: number;
  mime?: string;
  size?: number;
  timestamp?: string;
  url?: string;
}

interface MediaWikiFilePage {
  pageid: number;
  title: string;
  imageinfo?: MediaWikiImageInfo[];
}

interface MediaWikiCategoryMembersResponse {
  continue?: MediaWikiContinue;
  query?: {
    categorymembers?: MediaWikiCategoryMember[];
    pages?: Record<string, MediaWikiFilePage>;
  };
}

export class MinecraftWikiMobSoundSource {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: FileCache,
    private readonly logger: Logger,
    private readonly apiUrl = DEFAULT_MINECRAFT_WIKI_API_URL,
  ) {}

  async fetchSnapshot(): Promise<MinecraftWikiMobSoundSnapshot> {
    const fetchedAt = new Date().toISOString();
    const categoryMembers = await this.fetchRootCategoryMembers();
    const categories: MinecraftWikiMobSoundCategory[] = [];

    for (const member of categoryMembers
      .map((categoryMember) => ({
        id: toCategoryId(categoryMember.title),
        pageId: categoryMember.pageid,
        title: categoryMember.title,
        displayName: toCategoryDisplayName(categoryMember.title),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName))) {
      categories.push({
        ...member,
        url: toWikiPageUrl(member.title),
        files: await this.fetchCategoryFiles(member.title),
      });
    }

    const fileCount = categories.reduce((count, category) => count + category.files.length, 0);

    this.logger.debug(`Fetched ${categories.length} minecraft.wiki mob sound categories with ${fileCount} files.`);
    return {
      source: "minecraft.wiki",
      fetchedAt,
      apiUrl: this.apiUrl,
      rootCategoryTitle: ROOT_CATEGORY_TITLE,
      categoryCount: categories.length,
      fileCount,
      categories,
    };
  }

  private async fetchRootCategoryMembers(): Promise<MediaWikiCategoryMember[]> {
    const members: MediaWikiCategoryMember[] = [];
    let continueToken: string | undefined;

    do {
      const params = new URLSearchParams({
        action: "query",
        list: "categorymembers",
        cmlimit: "500",
        cmtitle: ROOT_CATEGORY_TITLE,
        cmtype: "subcat",
        format: "json",
      });
      if (continueToken) {
        params.set("cmcontinue", continueToken);
      }

      const response = await this.loadApiJson<MediaWikiCategoryMembersResponse>(params);
      members.push(...(response.query?.categorymembers ?? []));
      continueToken = response.continue?.cmcontinue;
    } while (continueToken);

    return members;
  }

  private async fetchCategoryFiles(categoryTitle: string): Promise<MinecraftWikiMobSoundFile[]> {
    const pages: MediaWikiFilePage[] = [];
    let continueToken: string | undefined;

    do {
      const params = new URLSearchParams({
        action: "query",
        gcmlimit: "500",
        gcmtitle: categoryTitle,
        gcmtype: "file",
        generator: "categorymembers",
        format: "json",
        iiprop: "url|mime|size|timestamp",
        prop: "imageinfo",
      });
      if (continueToken) {
        params.set("gcmcontinue", continueToken);
      }

      const response = await this.loadApiJson<MediaWikiCategoryMembersResponse>(params);
      pages.push(...Object.values(response.query?.pages ?? {}));
      continueToken = response.continue?.gcmcontinue;
    } while (continueToken);

    return pages
      .map((page) => {
        const imageInfo = page.imageinfo?.[0];
        const fileName = page.title.replace(/^File:/, "");

        return {
          pageId: page.pageid,
          title: page.title,
          fileName,
          url: imageInfo?.url ?? toWikiPageUrl(page.title),
          descriptionUrl: imageInfo?.descriptionurl ?? toWikiPageUrl(page.title),
          mime: imageInfo?.mime,
          size: imageInfo?.size,
          durationSeconds: typeof imageInfo?.duration === "number" ? imageInfo.duration : undefined,
          updatedAt: imageInfo?.timestamp,
        } satisfies MinecraftWikiMobSoundFile;
      })
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
  }

  private async loadApiJson<T>(params: URLSearchParams): Promise<T> {
    const url = new URL(this.apiUrl);
    for (const [key, value] of params.entries()) {
      url.searchParams.set(key, value);
    }

    return this.cache.remember(`minecraft-wiki:${url.toString()}`, API_CACHE_MS, () => this.http.getJson<T>(url.toString()));
  }
}

export function buildMinecraftWikiMobSoundAlignment(
  mobSounds: MobSoundDefinition[],
  snapshot: MinecraftWikiMobSoundSnapshot,
): MinecraftWikiMobSoundAlignment {
  const categoriesById = new Map(snapshot.categories.map((category) => [category.id, category]));
  const mobsById = new Map(mobSounds.map((mobSound) => [mobSound.localId, mobSound]));
  const mappedMobIdsByCategory = new Map<string, string[]>();

  for (const mobSound of mobSounds) {
    const categoryId = resolveWikiCategoryId(mobSound.localId, categoriesById);
    if (!categoryId) {
      continue;
    }

    const mappedMobIds = mappedMobIdsByCategory.get(categoryId) ?? [];
    mappedMobIds.push(mobSound.localId);
    mappedMobIdsByCategory.set(categoryId, Array.from(new Set(mappedMobIds)).sort());
  }

  const categories = snapshot.categories.map((category) =>
    buildCategoryAlignment(category, mappedMobIdsByCategory.get(category.id) ?? [], mobsById),
  );
  const unmatchedWikiCategoryIds = categories
    .filter((category) => category.matchType === "wiki-only")
    .map((category) => category.id)
    .sort();
  const localOnlyMobs = mobSounds
    .filter((mobSound) => !resolveWikiCategoryId(mobSound.localId, categoriesById))
    .map((mobSound) => ({
      id: mobSound.localId,
      displayName: mobSound.displayName,
      soundEventCount: mobSound.soundEventCount,
      soundVariantCount: mobSound.soundVariantCount,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  return {
    source: "minecraft.wiki",
    fetchedAt: snapshot.fetchedAt,
    categoryCount: snapshot.categoryCount,
    fileCount: snapshot.fileCount,
    matchedCategoryCount: categories.filter((category) => category.matchType !== "wiki-only").length,
    exactCategoryCount: categories.filter((category) => category.coverage === "exact").length,
    partialCategoryCount: categories.filter((category) => category.coverage === "partial").length,
    wikiOnlyCategoryCount: unmatchedWikiCategoryIds.length,
    unmatchedWikiCategoryIds,
    unmatchedLocalMobIds: localOnlyMobs.map((mob) => mob.id),
    localOnlyMobs,
    categories,
  };
}

function buildCategoryAlignment(
  category: MinecraftWikiMobSoundCategory,
  mappedMobIds: string[],
  mobsById: Map<string, MobSoundDefinition>,
): MinecraftWikiMobSoundCategoryAlignment {
  const mappedMobs = mappedMobIds
    .map((mobId) => mobsById.get(mobId))
    .filter((mob): mob is MobSoundDefinition => Boolean(mob))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const localVariants = collectUniqueVariants(mappedMobs);
  const localComparisonKeys = new Set(localVariants.map((variant) => variant.comparisonKey));
  const wikiFilesByComparisonKey = new Map<string, MinecraftWikiMobSoundFile[]>();

  for (const file of category.files) {
    const comparisonKey = toWikiFileComparisonKey(file.fileName, category.displayName);
    const filesForKey = wikiFilesByComparisonKey.get(comparisonKey) ?? [];
    filesForKey.push(file);
    wikiFilesByComparisonKey.set(comparisonKey, filesForKey);
  }

  const unmatchedWikiFileTitles = category.files
    .filter((file) => !localComparisonKeys.has(toWikiFileComparisonKey(file.fileName, category.displayName)))
    .map((file) => file.fileName)
    .sort();
  const unmatchedLocalSoundPaths = localVariants
    .filter((variant) => !wikiFilesByComparisonKey.has(variant.comparisonKey))
    .map((variant) => variant.soundPath)
    .sort();
  const matchedFileCount = category.files.length - unmatchedWikiFileTitles.length;
  const matchType =
    mappedMobIds.length === 0 ? "wiki-only" : mappedMobIds.length === 1 && mappedMobIds[0] === category.id ? "direct" : "grouped";
  const coverage =
    matchType === "wiki-only"
      ? "wiki-only"
      : unmatchedWikiFileTitles.length === 0 && unmatchedLocalSoundPaths.length === 0
        ? "exact"
        : "partial";

  return {
    id: category.id,
    title: category.title,
    displayName: category.displayName,
    url: category.url,
    wikiFileCount: category.files.length,
    mappedMobIds: mappedMobs.map((mob) => mob.localId),
    mappedMobDisplayNames: mappedMobs.map((mob) => mob.displayName),
    matchType,
    coverage,
    matchedFileCount,
    unmatchedWikiFileTitles,
    unmatchedLocalSoundPaths,
  };
}

function collectUniqueVariants(mobSounds: MobSoundDefinition[]): Array<{ comparisonKey: string; soundPath: string }> {
  const variantsBySoundPath = new Map<string, MobSoundVariantDefinition>();

  for (const mobSound of mobSounds) {
    for (const soundEvent of mobSound.soundEvents) {
      for (const variant of soundEvent.variants) {
        if (!variantsBySoundPath.has(variant.soundPath)) {
          variantsBySoundPath.set(variant.soundPath, variant);
        }
      }
    }
  }

  return Array.from(variantsBySoundPath.values())
    .map((variant) => ({
      comparisonKey: toLocalSoundComparisonKey(variant.soundPath),
      soundPath: variant.soundPath,
    }))
    .sort((left, right) => left.soundPath.localeCompare(right.soundPath));
}

function resolveWikiCategoryId(localId: string, categoriesById: Map<string, MinecraftWikiMobSoundCategory>): string | undefined {
  if (categoriesById.has(localId)) {
    return localId;
  }

  const alias = WIKI_CATEGORY_ALIASES.get(localId);
  if (alias && categoriesById.has(alias)) {
    return alias;
  }

  return undefined;
}

function toCategoryId(title: string): string {
  return title
    .replace(/^Category:/, "")
    .replace(/ sounds$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toCategoryDisplayName(title: string): string {
  return title.replace(/^Category:/, "").replace(/ sounds$/, "");
}

function toWikiPageUrl(title: string): string {
  return `${MINECRAFT_WIKI_PAGE_BASE_URL}${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function toWikiFileComparisonKey(fileName: string, categoryDisplayName: string): string {
  return stripCategoryLabel(normalizeComparisonKey(fileName.replace(/\.ogg$/i, "")), categoryDisplayName);
}

function toLocalSoundComparisonKey(soundPath: string): string {
  return normalizeComparisonKey(soundPath.split("/").pop() ?? soundPath);
}

function normalizeComparisonKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^file:/, "")
    .replace(/\.ogg$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\bhit(?=\d|\b)/g, "hurt")
    .replace(/\bkill(?=\d|\b)/g, "death")
    .replace(/\bsay(?=\d|\b)/g, "idle")
    .replace(/\bje\d*\b/g, " ")
    .replace(/\bbe\d*\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCategoryLabel(value: string, categoryDisplayName: string): string {
  const normalizedCategory = normalizeComparisonKey(categoryDisplayName);
  const categoryTokens = new Set(normalizedCategory.split(" ").filter(Boolean));
  const compactCategory = normalizedCategory.replace(/ /g, "");
  const stripped = value
    .split(" ")
    .filter((token) => token !== compactCategory && !categoryTokens.has(token))
    .join(" ")
    .trim();

  return stripped || value;
}
