import type { ArchiveSource } from "../archive/archiveSource.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ensureDir, fileExists, readJsonFile, writeBufferFile, writeJsonFile } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import { datasetVersionDir, type WorkspacePaths } from "../core/paths.js";
import { encodePng, type RgbColor } from "../extraction/png.js";
import type {
  AdvancementDefinition,
  BlockPropertyDefinition,
  EnchantmentDefinition,
  ItemStatDefinition,
  LootTableDefinition,
  MinecraftWikiMobSoundAlignment,
  MinecraftWikiMobSoundSnapshot,
  MobImageDefinition,
  MobSoundDefinition,
  PaletteDefinition,
  ResourcePackDefinition,
  TagDefinition,
  TextureDefinition,
  TranslationEntry,
  VersionDataset,
  VersionDiff,
} from "../domain/types.js";

export class DatasetStore {
  constructor(
    private readonly paths: WorkspacePaths,
    private readonly logger: Logger,
  ) {}

  async saveDataset(dataset: VersionDataset, source?: ArchiveSource): Promise<string> {
    const directory = datasetVersionDir(this.paths, dataset.version);
    await ensureDir(directory);
    for (const texture of dataset.textures) {
      texture.imagePath ??= `images/${texture.sourcePath.slice("assets/minecraft/textures/".length)}`;
    }

    if (source) {
      await this.exportTextureImages(directory, dataset.textures, source);
      await this.exportMobImages(directory, dataset.mobImages, source);
    }

    await Promise.all([
      writeJsonFile(join(directory, "dataset.json"), dataset),
      writeJsonFile(join(directory, "blocks.json"), dataset.blocks),
      writeJsonFile(join(directory, "items.json"), dataset.items),
      writeJsonFile(join(directory, "item-stats.json"), dataset.itemStats),
      writeJsonFile(join(directory, "block-properties.json"), dataset.blockProperties),
      writeJsonFile(join(directory, "recipes.json"), dataset.recipes),
      writeJsonFile(join(directory, "textures.json"), dataset.textures),
      writeJsonFile(join(directory, "models.json"), dataset.models),
      writeJsonFile(join(directory, "palettes.json"), dataset.palettes),
      writeJsonFile(join(directory, "enchantments.json"), dataset.enchantments),
      writeJsonFile(join(directory, "tags.json"), dataset.tags),
      writeJsonFile(join(directory, "loot-tables.json"), dataset.lootTables),
      writeJsonFile(join(directory, "advancements.json"), dataset.advancements),
      writeJsonFile(join(directory, "translations.json"), {
        version: dataset.version,
        generatedAt: dataset.generatedAt,
        translations: dataset.translations,
      }),
      writeJsonFile(join(directory, "mob-images.json"), {
        version: dataset.version,
        generatedAt: dataset.generatedAt,
        mobs: dataset.mobImages,
      }),
      writeJsonFile(join(directory, "mob-sounds.json"), {
        version: dataset.version,
        generatedAt: dataset.generatedAt,
        resourcePack: dataset.resourcePack,
        minecraftWiki: dataset.mobSoundMinecraftWiki,
        mobs: dataset.mobSounds,
      }),
      ...(dataset.mobSoundMinecraftWiki
        ? [writeJsonFile(join(directory, "mob-sounds-minecraft-wiki.json"), dataset.mobSoundMinecraftWiki)]
        : []),
    ]);

    this.logger.debug(`Saved dataset for ${dataset.version} to ${directory}.`);
    return join(directory, "dataset.json");
  }

  async loadDataset(version: string): Promise<VersionDataset> {
    const dataset = await readJsonFile<
      VersionDataset & {
        palettes?: PaletteDefinition[];
        itemStats?: ItemStatDefinition[];
        blockProperties?: BlockPropertyDefinition[];
        enchantments?: EnchantmentDefinition[];
        tags?: TagDefinition[];
        lootTables?: LootTableDefinition[];
        advancements?: AdvancementDefinition[];
        translations?: TranslationEntry[];
        mobImages?: MobImageDefinition[];
        mobSounds?: MobSoundDefinition[];
        mobSoundMinecraftWiki?: MinecraftWikiMobSoundAlignment;
        resourcePack?: ResourcePackDefinition;
      }
    >(join(datasetVersionDir(this.paths, version), "dataset.json"));

    return {
      ...dataset,
      textures: dataset.textures.map((texture) => ({
        ...texture,
        imagePath: texture.imagePath ?? `images/${texture.sourcePath.slice("assets/minecraft/textures/".length)}`,
      })),
      palettes: dataset.palettes ?? [],
      itemStats: dataset.itemStats ?? [],
      blockProperties: dataset.blockProperties ?? [],
      enchantments: dataset.enchantments ?? [],
      tags: dataset.tags ?? [],
      lootTables: dataset.lootTables ?? [],
      advancements: dataset.advancements ?? [],
      translations: dataset.translations ?? [],
      mobImages: dataset.mobImages ?? [],
      mobSounds: dataset.mobSounds ?? [],
      mobSoundMinecraftWiki: dataset.mobSoundMinecraftWiki,
      resourcePack: dataset.resourcePack,
    };
  }

  async listVersions(): Promise<string[]> {
    await ensureDir(this.paths.datasetsDir);
    const entries = await fs.readdir(this.paths.datasetsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async saveDiff(diff: VersionDiff): Promise<string> {
    await ensureDir(this.paths.diffsDir);
    const outputPath = join(this.paths.diffsDir, `${diff.fromVersion}__${diff.toVersion}.json`);
    await writeJsonFile(outputPath, diff);
    return outputPath;
  }

  async saveMobSoundMinecraftWikiSnapshot(
    version: string,
    snapshot: MinecraftWikiMobSoundSnapshot,
  ): Promise<{ path: string; relativePath: string }> {
    const relativePath = join("sources", "minecraft-wiki", `mob-sounds-${toTimestampPathSegment(snapshot.fetchedAt)}.json`);
    const outputPath = join(datasetVersionDir(this.paths, version), relativePath);
    await writeJsonFile(outputPath, snapshot);
    return {
      path: outputPath,
      relativePath,
    };
  }

  async hasMobSoundMinecraftWikiArtifacts(version: string): Promise<boolean> {
    const directory = datasetVersionDir(this.paths, version);
    if (!(await fileExists(join(directory, "mob-sounds-minecraft-wiki.json")))) {
      return false;
    }

    const snapshotDirectory = join(directory, "sources", "minecraft-wiki");
    if (!(await fileExists(snapshotDirectory))) {
      return false;
    }

    const entries = await fs.readdir(snapshotDirectory, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && /^mob-sounds-.*\.json$/i.test(entry.name));
  }

  private async exportTextureImages(directory: string, textures: TextureDefinition[], source: ArchiveSource): Promise<void> {
    for (const texture of textures) {
      const imagePath = texture.imagePath ?? `images/${texture.sourcePath.slice("assets/minecraft/textures/".length)}`;
      texture.imagePath = imagePath;
      const buffer = await source.readBuffer(texture.sourcePath);
      await writeBufferFile(join(directory, imagePath), buffer);
    }
  }

  private async exportMobImages(directory: string, mobImages: MobImageDefinition[], source: ArchiveSource): Promise<void> {
    const exportedPaths = new Set<string>();

    for (const mobImage of mobImages) {
      const variants =
        mobImage.variants.length > 0
          ? mobImage.variants
          : [
              {
                id: mobImage.localId,
                sourcePath: mobImage.sourcePath,
                imagePath: mobImage.imagePath,
                origin: mobImage.origin,
                role: mobImage.origin === "generated" ? "generated" : "base",
              },
            ];

      for (const variant of variants) {
        if (exportedPaths.has(variant.imagePath)) {
          continue;
        }

        const buffer = variant.sourcePath
          ? await source.readBuffer(variant.sourcePath)
          : createMobPlaceholderImage(mobImage.localId);
        await writeBufferFile(join(directory, variant.imagePath), buffer);
        exportedPaths.add(variant.imagePath);
      }
    }
  }
}

function toTimestampPathSegment(value: string): string {
  return value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function createMobPlaceholderImage(localId: string): Buffer {
  const width = 16;
  const height = 16;
  const hash = hashString(localId);
  const background = deriveColor(hash, 0.18, 160);
  const foreground = deriveColor(hash >>> 5, 0.62, 72);
  const accent = deriveColor(hash >>> 11, 0.82, 40);
  const pixels: RgbColor[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let color = background;
      const gridX = Math.floor((x - 3) / 2);
      const gridY = Math.floor((y - 3) / 2);
      const mirroredX = gridX >= 0 && gridX < 5 ? Math.min(gridX, 4 - gridX) : -1;

      if (gridX >= 0 && gridX < 5 && gridY >= 0 && gridY < 5) {
        const bitIndex = gridY * 3 + Math.max(0, mirroredX);
        const useAccent = ((hash >>> (bitIndex + 9)) & 1) === 1;
        const fill = ((hash >>> bitIndex) & 1) === 1;
        color = fill ? (useAccent ? accent : foreground) : background;
      }

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        color = accent;
      }

      pixels.push(color);
    }
  }

  return encodePng(width, height, pixels);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function deriveColor(hash: number, saturation: number, floor: number): RgbColor {
  const red = floor + ((hash >>> 0) & 0x3f);
  const green = floor + ((hash >>> 6) & 0x3f);
  const blue = floor + ((hash >>> 12) & 0x3f);

  return [
    clampColor(red * saturation + 255 * (1 - saturation)),
    clampColor(green * saturation + 255 * (1 - saturation)),
    clampColor(blue * saturation + 255 * (1 - saturation)),
  ];
}

function clampColor(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
