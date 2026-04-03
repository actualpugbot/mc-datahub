import type { ArchiveSource } from "../archive/archiveSource.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJsonFile, writeBufferFile, writeJsonFile } from "../core/fs.js";
import type { Logger } from "../core/logger.js";
import { datasetVersionDir, type WorkspacePaths } from "../core/paths.js";
import type {
  BlockPropertyDefinition,
  ItemStatDefinition,
  MobSoundDefinition,
  PaletteDefinition,
  ResourcePackDefinition,
  TextureDefinition,
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
      writeJsonFile(join(directory, "mob-sounds.json"), {
        version: dataset.version,
        generatedAt: dataset.generatedAt,
        resourcePack: dataset.resourcePack,
        mobs: dataset.mobSounds,
      }),
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
        mobSounds?: MobSoundDefinition[];
        resourcePack?: ResourcePackDefinition;
      }
    >(
      join(datasetVersionDir(this.paths, version), "dataset.json"),
    );

    return {
      ...dataset,
      textures: dataset.textures.map((texture) => ({
        ...texture,
        imagePath: texture.imagePath ?? `images/${texture.sourcePath.slice("assets/minecraft/textures/".length)}`,
      })),
      palettes: dataset.palettes ?? [],
      itemStats: dataset.itemStats ?? [],
      blockProperties: dataset.blockProperties ?? [],
      mobSounds: dataset.mobSounds ?? [],
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

  private async exportTextureImages(directory: string, textures: TextureDefinition[], source: ArchiveSource): Promise<void> {
    for (const texture of textures) {
      const imagePath = texture.imagePath ?? `images/${texture.sourcePath.slice("assets/minecraft/textures/".length)}`;
      texture.imagePath = imagePath;
      const buffer = await source.readBuffer(texture.sourcePath);
      await writeBufferFile(join(directory, imagePath), buffer);
    }
  }
}
