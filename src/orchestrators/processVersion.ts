import { join } from "node:path";
import { stableJsonHash } from "../core/hash.js";
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
import { MinecraftWikiMobSoundSource, buildMinecraftWikiMobSoundAlignment } from "../extraction/minecraftWikiMobSoundSource.js";
import type { MobImageExtractor } from "../extraction/mobImageExtractor.js";
import type { MobModelExtractor } from "../extraction/mobModelExtractor.js";
import type { MobSoundExtractor } from "../extraction/mobSoundExtractor.js";
import type { MobSoundDefinition } from "../domain/types.js";
import type { RenderDataExtractor } from "../extraction/renderDataExtractor.js";
import type { AnvilMechanicsExtractor } from "../extraction/anvilMechanicsExtractor.js";
import type { SulfurCubeExtractor } from "../extraction/sulfurCubeExtractor.js";
import type { DecompiledSourceExtractor } from "../extraction/sourceDerivedExtractor.js";
import { validateRenderDataset } from "../validation/renderValidation.js";

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
    private readonly mobModelExtractor: MobModelExtractor,
    private readonly mobSoundExtractor: MobSoundExtractor,
    private readonly renderDataExtractor: RenderDataExtractor,
    private readonly mobSoundMinecraftWiki: MinecraftWikiMobSoundSource,
    private readonly sourceExtractor: DecompiledSourceExtractor,
    private readonly anvilMechanicsExtractor: AnvilMechanicsExtractor,
    private readonly sulfurCubeExtractor: SulfurCubeExtractor,
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
      const refreshedDataset = await this.refreshMobSoundMinecraftWikiArtifacts(manifestEntry.id, fingerprint);
      if (refreshedDataset) {
        return refreshedDataset;
      }

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
    const mobModels = await this.mobModelExtractor.extract(mobSoundData.mobSounds, decompiledClientRoot);
    const blockEntityModels = await this.mobModelExtractor.extractBlockEntityModels(decompiledClientRoot);
    const sourceDerived = await this.sourceExtractor.extract(decompiledClientRoot);
    dataset.provenance.mappingProvider = options.mappingProvider;
    dataset.itemStats = sourceDerived.itemStats;
    dataset.blockProperties = sourceDerived.blockProperties;
    dataset.anvilMechanics = await this.anvilMechanicsExtractor.extract(decompiledClientRoot);
    dataset.sulfurCube = await this.sulfurCubeExtractor.extract(decompiledClientRoot);
    dataset.mobImages = mobImages;
    dataset.mobSounds = mobSoundData.mobSounds;
    dataset.mobModels = mobModels;
    dataset.blockEntityModels = blockEntityModels;
    dataset.renderData = await this.renderDataExtractor.extract(manifestEntry.id, sources, {
      translations: dataset.translations,
      blocks: dataset.blocks,
      mobModels,
      decompiledClientRoot,
    });
    dataset.renderData.validation = validateRenderDataset(dataset.renderData);
    dataset.textures = dataset.renderData.textures;
    dataset.resourcePack = mobSoundData.resourcePack;
    const mobSoundMinecraftWiki = await this.buildMobSoundMinecraftWikiArtifacts(manifestEntry.id, dataset.mobSounds);
    if (mobSoundMinecraftWiki) {
      dataset.mobSoundMinecraftWiki = mobSoundMinecraftWiki.alignment;
    }
    const datasetPath = await this.datasetStore.saveDataset(dataset, new MergedArchiveSource(sources));
    await this.stateStore.markVersionProcessed(manifestEntry.id, fingerprint, datasetPath, artifacts.metadataPath);

    return {
      version: manifestEntry.id,
      skipped: false,
      datasetPath,
      decompileReport,
      mobSoundMinecraftWikiSnapshotPath: mobSoundMinecraftWiki?.snapshotPath,
      workspaceRoot: this.config.workspace.root,
    };
  }

  private async refreshMobSoundMinecraftWikiArtifacts(version: string, fingerprint: string) {
    if (await this.datasetStore.hasMobSoundMinecraftWikiArtifacts(version)) {
      return undefined;
    }

    let dataset;
    try {
      dataset = await this.datasetStore.loadDataset(version);
    } catch {
      return undefined;
    }

    if (dataset.mobSounds.length === 0) {
      return undefined;
    }

    const mobSoundMinecraftWiki = await this.buildMobSoundMinecraftWikiArtifacts(version, dataset.mobSounds);
    if (!mobSoundMinecraftWiki) {
      return undefined;
    }

    this.logger.info(`Refreshing minecraft.wiki mob sound references for ${version}.`);
    dataset.mobSoundMinecraftWiki = mobSoundMinecraftWiki.alignment;
    const datasetPath = await this.datasetStore.saveDataset(dataset);
    await this.stateStore.markVersionProcessed(
      version,
      fingerprint,
      datasetPath,
      join(this.config.workspace.versionsDir, version, "metadata.json"),
    );

    return {
      version,
      skipped: false,
      datasetPath,
      mobSoundMinecraftWikiSnapshotPath: mobSoundMinecraftWiki.snapshotPath,
      refreshedMobSoundMinecraftWiki: true,
      workspaceRoot: this.config.workspace.root,
    };
  }

  private async buildMobSoundMinecraftWikiArtifacts(version: string, mobSounds: MobSoundDefinition[]) {
    if (mobSounds.length === 0) {
      return undefined;
    }

    try {
      const snapshot = await this.mobSoundMinecraftWiki.fetchSnapshot();
      const savedSnapshot = await this.datasetStore.saveMobSoundMinecraftWikiSnapshot(version, snapshot);
      const alignment = buildMinecraftWikiMobSoundAlignment(mobSounds, snapshot);
      alignment.snapshotRelativePath = savedSnapshot.relativePath;

      return {
        alignment,
        snapshotPath: savedSnapshot.path,
      };
    } catch (error) {
      this.logger.warn(
        `Unable to fetch minecraft.wiki mob sound reference data for ${version}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}
