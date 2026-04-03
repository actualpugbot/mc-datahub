import { promises as fs } from "node:fs";
import { join } from "node:path";
import { MergedArchiveSource, type ArchiveSource } from "../archive/archiveSource.js";
import { fileExists } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import type { MobImageDefinition, MobImageVariantDefinition, MobSoundDefinition } from "../domain/types.js";

const ENTITY_RENDERERS_SOURCE_PATH = "net/minecraft/client/renderer/entity/EntityRenderers.java";
const ENTITY_RENDERER_SOURCE_DIR = "net/minecraft/client/renderer/entity";
const ENTITY_TEXTURE_PREFIX = "assets/minecraft/textures/entity/";
const RENDERER_TEXTURE_PATTERN = /textures\/entity\/[a-z0-9_./-]+\.png/gi;
const REGISTER_METHOD_REFERENCE_PATTERN = /register\(\s*EntityType\.([A-Z0-9_]+)\s*,\s*([A-Za-z0-9_$.]+)::new/g;
const REGISTER_LAMBDA_PATTERN = /register\(\s*EntityType\.([A-Z0-9_]+)\s*,\s*context\s*->\s*new\s+([A-Za-z0-9_$.]+)/g;
const FALLBACK_EXCLUDED_PREFIXES = ["banner/", "bed/", "boat/", "chest/", "equipment/", "shield/", "signs/"] as const;
const BASE_VARIANT_TOKENS = new Set(["default", "normal", "temperate"]);
const OVERLAY_TOKENS = new Set([
  "angry",
  "armor",
  "beam",
  "bioluminescent",
  "charging",
  "crackiness",
  "decor",
  "eyes",
  "exploding",
  "fireball",
  "fur",
  "glow",
  "glowing",
  "harness",
  "heart",
  "invulnerable",
  "layer",
  "markings",
  "nectar",
  "outer",
  "overlay",
  "pattern",
  "pulsating",
  "saddle",
  "sleep",
  "spots",
  "undercoat",
  "wind",
  "wool",
]);
const VARIANT_LIMIT = 24;

interface RankedTextureCandidate {
  sourcePath?: string;
  imagePath: string;
  origin: MobImageVariantDefinition["origin"];
  role: MobImageVariantDefinition["role"];
  score: number;
}

export class MobImageExtractor {
  constructor(private readonly logger: Logger) {}

  async extract(
    mobs: MobSoundDefinition[],
    sources: ArchiveSource[],
    decompiledClientRoot: string,
  ): Promise<MobImageDefinition[]> {
    if (mobs.length === 0) {
      return [];
    }

    const archive = new MergedArchiveSource(sources);
    const entityTexturePaths = (await archive.listPaths()).filter(
      (path) => path.startsWith(ENTITY_TEXTURE_PREFIX) && path.endsWith(".png"),
    );
    const entityTexturePathSet = new Set(entityTexturePaths);
    const rendererClassesByMob = await this.loadRendererClassesByMob(decompiledClientRoot);
    const mobImages: MobImageDefinition[] = [];

    for (const mob of mobs) {
      const rendererClass = rendererClassesByMob.get(mob.localId);
      const rendererCandidates = rendererClass
        ? await this.collectRendererTextureCandidates(rendererClass, decompiledClientRoot, mob.localId, entityTexturePathSet)
        : [];
      const candidates =
        rendererCandidates.length > 0
          ? rendererCandidates
          : this.findFallbackTextureCandidates(mob.localId, entityTexturePaths);
      const variants =
        candidates.length > 0
          ? candidates.map((candidate) => this.toVariantDefinition(candidate))
          : [this.createGeneratedVariant(mob.localId)];
      const primary = variants[0] ?? this.createGeneratedVariant(mob.localId);

      if (primary.origin === "generated") {
        this.logger.warn(`Fell back to a generated placeholder mob image for ${mob.localId}.`);
      }

      mobImages.push({
        id: mob.id,
        localId: mob.localId,
        displayName: mob.displayName,
        rendererClass,
        sourcePath: primary.sourcePath,
        imagePath: primary.imagePath,
        origin: primary.origin,
        variants,
      });
    }

    this.logger.debug(`Resolved ${mobImages.length} mob image definitions.`);
    return mobImages.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  private async loadRendererClassesByMob(decompiledClientRoot: string): Promise<Map<string, string>> {
    const sourcePath = join(decompiledClientRoot, ENTITY_RENDERERS_SOURCE_PATH);
    if (!(await fileExists(sourcePath))) {
      return new Map();
    }

    const source = await fs.readFile(sourcePath, "utf8");
    const rendererClassesByMob = new Map<string, string>();

    for (const pattern of [REGISTER_METHOD_REFERENCE_PATTERN, REGISTER_LAMBDA_PATTERN]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const entityType = match[1];
        const rendererClass = match[2];
        if (!entityType || !rendererClass) {
          continue;
        }

        rendererClassesByMob.set(entityType.toLowerCase(), rendererClass);
      }
    }

    return rendererClassesByMob;
  }

  private async collectRendererTextureCandidates(
    rendererClass: string,
    decompiledClientRoot: string,
    localId: string,
    entityTexturePathSet: Set<string>,
  ): Promise<RankedTextureCandidate[]> {
    const sourcePaths = new Set<string>();
    await this.collectRendererTexturePaths(rendererClass, decompiledClientRoot, entityTexturePathSet, sourcePaths, new Set<string>());

    return this.rankTextureCandidates(
      localId,
      Array.from(sourcePaths),
      "renderer",
      (relativePath) => !isFallbackExcluded(relativePath),
    );
  }

  private async collectRendererTexturePaths(
    rendererClass: string,
    decompiledClientRoot: string,
    entityTexturePathSet: Set<string>,
    sourcePaths: Set<string>,
    visitedClasses: Set<string>,
  ): Promise<void> {
    const topLevelRendererClass = rendererClass.split(".")[0] ?? rendererClass;
    if (visitedClasses.has(topLevelRendererClass)) {
      return;
    }

    visitedClasses.add(topLevelRendererClass);
    const rendererSourcePath = join(decompiledClientRoot, ENTITY_RENDERER_SOURCE_DIR, `${topLevelRendererClass}.java`);
    if (!(await fileExists(rendererSourcePath))) {
      return;
    }

    const source = await fs.readFile(rendererSourcePath, "utf8");
    RENDERER_TEXTURE_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(RENDERER_TEXTURE_PATTERN)) {
      const texturePath = match[0];
      if (!texturePath) {
        continue;
      }

      const sourcePath = `${ENTITY_TEXTURE_PREFIX}${texturePath.slice("textures/entity/".length)}`;
      if (entityTexturePathSet.has(sourcePath)) {
        sourcePaths.add(sourcePath);
      }
    }

    const superclass = this.parseSuperclassName(source);
    if (superclass) {
      await this.collectRendererTexturePaths(superclass, decompiledClientRoot, entityTexturePathSet, sourcePaths, visitedClasses);
    }
  }

  private parseSuperclassName(source: string): string | undefined {
    const match = source.match(/\b(?:class|record)\s+[A-Za-z0-9_$]+(?:<[^>{]+>)?\s+extends\s+([A-Za-z0-9_$.]+)/);
    return match?.[1]?.split(".").pop();
  }

  private findFallbackTextureCandidates(localId: string, entityTexturePaths: string[]): RankedTextureCandidate[] {
    return this.rankTextureCandidates(localId, entityTexturePaths, "asset-search", (relativePath) => !isFallbackExcluded(relativePath));
  }

  private rankTextureCandidates(
    localId: string,
    sourcePaths: string[],
    origin: Exclude<MobImageVariantDefinition["origin"], "generated">,
    includePath: (relativePath: string) => boolean,
  ): RankedTextureCandidate[] {
    const candidates: RankedTextureCandidate[] = [];

    for (const sourcePath of sourcePaths) {
      const relativePath = sourcePath.slice(ENTITY_TEXTURE_PREFIX.length);
      if (!includePath(relativePath)) {
        continue;
      }

      const role = classifyTextureRole(localId, relativePath);
      const score = scoreTextureCandidate(localId, relativePath, role, origin);
      if (score <= 0) {
        continue;
      }

      candidates.push({
        sourcePath,
        imagePath: toMobImagePath(relativePath),
        origin,
        role,
        score,
      });
    }

    candidates.sort((left, right) => right.score - left.score || left.imagePath.localeCompare(right.imagePath));

    return candidates.slice(0, VARIANT_LIMIT);
  }

  private toVariantDefinition(candidate: RankedTextureCandidate): MobImageVariantDefinition {
    return {
      id: candidate.imagePath.replace(/^mob-images\//, "").replace(/\.png$/i, ""),
      sourcePath: candidate.sourcePath,
      imagePath: candidate.imagePath,
      origin: candidate.origin,
      role: candidate.role,
    };
  }

  private createGeneratedVariant(localId: string): MobImageVariantDefinition {
    return {
      id: `generated/${localId}`,
      imagePath: `mob-images/generated/${localId}.png`,
      origin: "generated",
      role: "generated",
    };
  }
}

function toMobImagePath(relativePath: string): string {
  return `mob-images/${relativePath}`;
}

function isFallbackExcluded(relativePath: string): boolean {
  return FALLBACK_EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function classifyTextureRole(localId: string, relativePath: string): MobImageVariantDefinition["role"] {
  const basename = relativePath.replace(/\.png$/i, "").split("/").pop() ?? relativePath;
  const basenameTokens = tokenize(basename);
  const searchTerms = buildSearchTerms(localId);

  if (basenameTokens.some((token) => OVERLAY_TOKENS.has(token))) {
    return "overlay";
  }

  if (basenameTokens.includes("baby")) {
    return "baby";
  }

  if (
    searchTerms.has(basename) ||
    basename.startsWith(`${localId}_`) ||
    basename.endsWith(`_${localId}`) ||
    basenameTokens.some((token) => BASE_VARIANT_TOKENS.has(token))
  ) {
    return "base";
  }

  return "variant";
}

function scoreTextureCandidate(
  localId: string,
  relativePath: string,
  role: MobImageVariantDefinition["role"],
  origin: Exclude<MobImageVariantDefinition["origin"], "generated">,
): number {
  const withoutExtension = relativePath.replace(/\.png$/i, "");
  const basename = withoutExtension.split("/").pop() ?? withoutExtension;
  const collapsedPath = withoutExtension.replace(/[\/_]/g, "");
  const pathTokens = tokenize(withoutExtension);
  const mobTokens = tokenize(localId);
  const searchTerms = buildSearchTerms(localId);
  let matched = false;
  let score = origin === "renderer" ? 200 : 0;
  score += role === "base" ? 320 : role === "variant" ? 240 : role === "baby" ? 140 : 20;

  if (searchTerms.has(basename)) {
    matched = true;
    score += 240;
  }

  if (basename === localId) {
    matched = true;
    score += 160;
  }

  if (basename.startsWith(`${localId}_`) || basename.endsWith(`_${localId}`)) {
    matched = true;
    score += 120;
  }

  for (const term of searchTerms) {
    const collapsedTerm = term.replace(/_/g, "");
    if (collapsedTerm.length > 0 && collapsedPath.includes(collapsedTerm)) {
      matched = true;
      score += 90;
    }
  }

  const overlap = overlapCount(mobTokens, pathTokens);
  if (overlap > 0) {
    matched = true;
  }
  score += overlap * 50;

  if (!matched && origin !== "renderer") {
    return 0;
  }

  if (pathTokens.some((token) => BASE_VARIANT_TOKENS.has(token))) {
    score += 40;
  }

  if (pathTokens.some((token) => OVERLAY_TOKENS.has(token))) {
    score -= 140;
  }

  return score;
}

function buildSearchTerms(localId: string): Set<string> {
  const tokens = tokenize(localId);
  const terms = new Set<string>([localId, localId.replace(/_/g, "")]);

  if (tokens.length > 1) {
    terms.add(tokens.join("_"));
    terms.add(tokens.join(""));
    terms.add([...tokens].reverse().join("_"));
    terms.add([...tokens].reverse().join(""));
  }

  return terms;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function overlapCount(left: string[], right: string[]): number {
  const rightTokens = new Set(right);
  return left.reduce((count, token) => count + (rightTokens.has(token) ? 1 : 0), 0);
}
