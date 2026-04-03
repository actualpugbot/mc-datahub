import { stableJsonHash } from "../core/hash.js";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { DecompilePipeline } from "../decompile/decompilePipeline.js";
import type { DatasetStore } from "../datasets/datasetStore.js";
import type { MappingResolver } from "../mappings/mappingResolver.js";
import type { StateStore } from "../state/stateStore.js";
import type { VersionManifestResolver } from "../versions/manifestResolver.js";
import type { VersionDownloader } from "../download/versionDownloader.js";
import type { Logger } from "../core/logger.js";
import type { MappingProvider } from "../domain/types.js";
import { MergedArchiveSource } from "../archive/archiveSource.js";
import { ZipArchiveSource } from "../archive/zipArchiveSource.js";
import type { MinecraftDataExtractor } from "../extraction/dataExtractor.js";
import type { MobImageExtractor } from "../extraction/mobImageExtractor.js";
import type { MobSoundExtractor } from "../extraction/mobSoundExtractor.js";
import type { DecompiledSourceExtractor } from "../extraction/sourceDerivedExtractor.js";

export interface ProcessVersionOptions {
  mappingProvider: MappingProvider;
  skipDecompile: boolean;
  force: boolean;
}

export class ProcessVersionWorkflow {
  constructor(
    private readonly manifestResolver: VersionManifestResolver,
    private readonly downloader: VersionDownloader,
    private readonly mappingResolver: MappingResolver,
    private readonly decompilePipeline: DecompilePipeline,
    private readonly extractor: MinecraftDataExtractor,
    private readonly mobImageExtractor: MobImageExtractor,
    private readonly mobSoundExtractor: MobSoundExtractor,
    private readonly sourceExtractor: DecompiledSourceExtractor,
    private readonly datasetStore: DatasetStore,
    private readonly stateStore: StateStore,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async run(versionOrAlias: string, options: ProcessVersionOptions) {
    const { manifestEntry, metadata } = await this.manifestResolver.resolve(versionOrAlias);
    const fingerprint = stableJsonHash({
      version: manifestEntry.id,
      provider: options.mappingProvider,
      downloads: metadata.downloads,
    });

    const previousFingerprint = await this.stateStore.getProcessedVersionFingerprint(manifestEntry.id);
    if (!options.force && previousFingerprint === fingerprint) {
      this.logger.info(`Skipping ${manifestEntry.id}; dataset fingerprint is unchanged.`);
      return {
        version: manifestEntry.id,
        skipped: true,
      };
    }

    const artifacts = await this.downloader.download(manifestEntry.id, metadata);
    const mappings = await this.mappingResolver.resolve(manifestEntry.id, metadata, options.mappingProvider);
    const decompileReport = options.skipDecompile
      ? {
          version: manifestEntry.id,
          mappingProvider: options.mappingProvider,
          generatedAt: new Date().toISOString(),
          client: { status: "skipped" as const, reason: "skipDecompile was set." },
          server: { status: "skipped" as const, reason: "skipDecompile was set." },
        }
      : await this.decompilePipeline.run(manifestEntry.id, artifacts, mappings, options.mappingProvider);

    const sources = [];
    if (artifacts.downloads.client?.path) {
      sources.push(new ZipArchiveSource(artifacts.downloads.client.path));
    }
    if (artifacts.downloads.server?.path) {
      sources.push(new ZipArchiveSource(artifacts.downloads.server.path));
    }

    if (sources.length === 0) {
      throw new Error(`No client or server JAR was available for ${manifestEntry.id}.`);
    }

    const decompiledClientRoot = join(this.config.workspace.versionsDir, manifestEntry.id, "decompiled", "client");
    const dataset = await this.extractor.extract(manifestEntry.id, sources);
    const mobSoundData = await this.mobSoundExtractor.extract(manifestEntry.id, metadata, sources, decompiledClientRoot);
    const mobImages = await this.mobImageExtractor.extract(mobSoundData.mobSounds, sources, decompiledClientRoot);
    const sourceDerived = await this.sourceExtractor.extract(decompiledClientRoot);
    dataset.provenance.mappingProvider = options.mappingProvider;
    dataset.itemStats = sourceDerived.itemStats;
    dataset.blockProperties = sourceDerived.blockProperties;
    dataset.mobImages = mobImages;
    dataset.mobSounds = mobSoundData.mobSounds;
    dataset.resourcePack = mobSoundData.resourcePack;
    const datasetPath = await this.datasetStore.saveDataset(dataset, new MergedArchiveSource(sources));
    await this.stateStore.markVersionProcessed(manifestEntry.id, fingerprint, datasetPath, artifacts.metadataPath);

    return {
      version: manifestEntry.id,
      skipped: false,
      datasetPath,
      decompileReport,
      workspaceRoot: this.config.workspace.root,
    };
  }
}
