#!/usr/bin/env node

import { join, resolve } from "node:path";
import { Command } from "commander";
import { ZipArchiveSource } from "./archive/zipArchiveSource.js";
import { buildApiServer } from "./api/server.js";
import { fileExists, readJsonFile, writeJsonFile } from "./core/fs.js";
import { datasetVersionDir, versionDownloadsDir } from "./core/paths.js";
import type { VersionDataset, VersionMetadata } from "./domain/types.js";
import { buildBanners } from "./extraction/banners.js";
import { createDefaultContext } from "./index.js";

const COLLECTION_GETTERS: Record<string, (dataset: VersionDataset) => unknown> = {
  blocks: (dataset) => dataset.blocks,
  items: (dataset) => dataset.items,
  "item-stats": (dataset) => dataset.itemStats,
  "block-properties": (dataset) => dataset.blockProperties,
  recipes: (dataset) => dataset.recipes,
  models: (dataset) => dataset.models,
  textures: (dataset) => dataset.textures,
  enchantments: (dataset) => dataset.enchantments,
  tags: (dataset) => dataset.tags,
  "loot-tables": (dataset) => dataset.lootTables,
  advancements: (dataset) => dataset.advancements,
  translations: (dataset) => dataset.translations,
  palettes: (dataset) => dataset.palettes,
  biomes: (dataset) => dataset.biomes,
  "sulfur-cube": (dataset) => dataset.sulfurCube ?? null,
  banners: (dataset) => dataset.banners ?? { patterns: [], colors: [] },
  "mob-images": (dataset) => dataset.mobImages,
  "mob-models": (dataset) => dataset.mobModels,
  "mob-profiles": (dataset) => dataset.mobProfiles ?? [],
  "mob-animations": (dataset) => dataset.mobAnimations ?? [],
  "mob-sounds": (dataset) => dataset.mobSounds,
  "render-data": (dataset) => dataset.renderData,
  blockstates: (dataset) => dataset.renderData?.blockstates ?? [],
  "block-models": (dataset) => dataset.renderData?.blockModels ?? [],
  "item-models": (dataset) => dataset.renderData?.itemModels ?? [],
  "item-displays": (dataset) => dataset.renderData?.itemDisplays ?? [],
  "render-layers": (dataset) => dataset.renderData?.renderLayers ?? [],
  tints: (dataset) => dataset.renderData?.tints ?? [],
  entities: (dataset) => dataset.renderData?.entities ?? [],
  "entity-models": (dataset) => dataset.renderData?.entityModels ?? [],
  "entity-renderers": (dataset) => dataset.renderData?.entityRenderers ?? [],
  "special-renderers": (dataset) => dataset.renderData?.specialRenderers ?? [],
  dataset: (dataset) => dataset,
};
import { dumpBanners } from "./orchestrators/dumpBanners.js";
import { buildMobAudioDumpPayload, dumpMobAudioFiles } from "./orchestrators/dumpMobAudio.js";
import { buildRecipeDumpPayload } from "./orchestrators/dumpRecipes.js";
import { validateRenderDataset } from "./validation/renderValidation.js";

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an integer but received ${value}.`);
  }

  return parsed;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("mc-datahub")
    .description("Track Minecraft Java Edition versions and extract normalized data.")
    .option("--verbose", "Enable verbose logging", false);

  const fetchCommand = program.command("fetch").description("Watch for new Minecraft version posts.");
  fetchCommand
    .command("latest")
    .description("Resolve the latest release and/or snapshot from Mojang's manifest and optionally process them.")
    .option("--kind <kind>", "release, snapshot, or any", "any")
    .option("--limit <number>", "Maximum latest versions to inspect", parseInteger, 2)
    .option("--mappings <provider>", "mojang or yarn", "mojang")
    .option("--skip-decompile", "Skip the decompile pipeline", false)
    .option("--force", "Ignore cached processing fingerprints", false)
    .option("--no-process", "Only detect versions without processing the pipeline")
    .action(async (options) => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const result = await context.fetchLatest.run({
        kind: options.kind,
        limit: options.limit,
        process: options.process,
        mappingProvider: options.mappings,
        skipDecompile: options.skipDecompile,
        force: options.force,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  const processCommand = program.command("process").description("Run pipeline steps for a specific version.");
  processCommand
    .command("version")
    .argument("<version>", "Minecraft version id or alias such as latest-release or latest-snapshot")
    .option("--mappings <provider>", "mojang or yarn", "mojang")
    .option("--skip-decompile", "Skip the decompile pipeline", false)
    .option("--force", "Ignore cached processing fingerprints", false)
    .action(async (version, options) => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const result = await context.processVersion.run(version, {
        mappingProvider: options.mappings,
        skipDecompile: options.skipDecompile,
        force: options.force,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  const toolchainCommand = program.command("toolchain").description("Inspect external toolchain configuration.");
  toolchainCommand
    .command("doctor")
    .description("Show detected decompile tooling and how it was resolved.")
    .action(async () => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      console.log(
        JSON.stringify(
          {
            workspaceRoot: context.config.workspace.root,
            toolchain: {
              tinyRemapper: {
                configured: Boolean(context.config.toolchain.tinyRemapperCommand),
                command: context.config.toolchain.tinyRemapperCommand ?? null,
                message: context.config.toolchain.tinyRemapperCommand
                  ? "Using MCDATAHUB_TINY_REMAPPER_CMD from the environment."
                  : "Set MCDATAHUB_TINY_REMAPPER_CMD to enable remapping before decompilation.",
              },
              vineflower: {
                configured: Boolean(context.config.toolchain.vineflowerCommand),
                command: context.config.toolchain.vineflowerCommand ?? null,
                source: context.config.toolchain.vineflower.source,
                location: context.config.toolchain.vineflower.location ?? null,
                message: context.config.toolchain.vineflower.message,
                searchedPaths: context.config.toolchain.vineflower.searchedPaths,
              },
            },
          },
          null,
          2,
        ),
      );
    });

  const diffCommand = program.command("diff").description("Compare two processed Minecraft versions.");
  diffCommand
    .command("versions")
    .argument("<fromVersion>", "Base version")
    .argument("<toVersion>", "Comparison version")
    .action(async (fromVersion, toVersion) => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const from = await context.datasetStore.loadDataset(fromVersion);
      const to = await context.datasetStore.loadDataset(toVersion);
      const diff = context.diffEngine.compare(from, to);
      const outputPath = await context.datasetStore.saveDiff(diff);
      console.log(
        JSON.stringify(
          {
            outputPath,
            diffSummary: {
              blocks: summarizeCollection(diff.blocks),
              items: summarizeCollection(diff.items),
              itemStats: summarizeCollection(diff.itemStats),
              blockProperties: summarizeCollection(diff.blockProperties),
              recipes: summarizeCollection(diff.recipes),
              textures: summarizeCollection(diff.textures),
              models: summarizeCollection(diff.models),
              palettes: summarizeCollection(diff.palettes),
              enchantments: summarizeCollection(diff.enchantments),
              tags: summarizeCollection(diff.tags),
              lootTables: summarizeCollection(diff.lootTables),
              advancements: summarizeCollection(diff.advancements),
              translations: summarizeCollection(diff.translations),
              biomes: summarizeCollection(diff.biomes),
              mobImages: summarizeCollection(diff.mobImages),
              mobSounds: summarizeCollection(diff.mobSounds),
            },
          },
          null,
          2,
        ),
      );
    });

  const versionsCommand = program.command("versions").description("Inspect locally processed datasets.");
  versionsCommand
    .command("list")
    .description("List versions that have a processed dataset on disk.")
    .action(async () => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const versions = await context.datasetStore.listVersions();
      console.log(JSON.stringify({ count: versions.length, versions }, null, 2));
    });

  const dumpCommand = program.command("dump").description("Dump extracted data as JSON.");
  dumpCommand
    .command("collection")
    .argument("<collection>", `One of: ${Object.keys(COLLECTION_GETTERS).join(", ")}`)
    .argument("<version>", "Minecraft version id with a processed dataset")
    .option("--output <path>", "Write JSON to a file instead of stdout")
    .action(async (collection, version, options) => {
      const getter = COLLECTION_GETTERS[collection];
      if (!getter) {
        throw new Error(`Unknown collection "${collection}". Expected one of: ${Object.keys(COLLECTION_GETTERS).join(", ")}.`);
      }

      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const dataset = await context.datasetStore.loadDataset(version);
      const payload = getter(dataset);

      if (options.output) {
        const outputPath = resolve(process.cwd(), options.output);
        await writeJsonFile(outputPath, payload);
        console.log(
          JSON.stringify(
            {
              version,
              collection,
              count: Array.isArray(payload) ? payload.length : undefined,
              outputPath,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(JSON.stringify(payload, null, 2));
    });

  dumpCommand
    .command("recipes")
    .argument("<version>", "Minecraft version id with a processed dataset or downloaded client/server jars")
    .option("--output <path>", "Write JSON to a file instead of stdout")
    .action(async (version, options) => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const payload = await buildRecipeDumpPayload(version, {
        loadDataset: (datasetVersion) => context.datasetStore.loadDataset(datasetVersion),
        extractDataset: async (datasetVersion) => {
          const downloadsDir = versionDownloadsDir(context.config.workspace, datasetVersion);
          const sources = [];
          const clientJarPath = join(downloadsDir, "client.jar");
          const serverJarPath = join(downloadsDir, "server.jar");

          if (await fileExists(clientJarPath)) {
            sources.push(new ZipArchiveSource(clientJarPath));
          }

          if (await fileExists(serverJarPath)) {
            sources.push(new ZipArchiveSource(serverJarPath));
          }

          if (sources.length === 0) {
            throw new Error(
              `No processed dataset or downloaded client.jar/server.jar was found for ${datasetVersion}. Looked in ${downloadsDir}.`,
            );
          }

          return context.extractor.extract(datasetVersion, sources);
        },
      });

      if (options.output) {
        const outputPath = resolve(process.cwd(), options.output);
        await writeJsonFile(outputPath, payload);
        console.log(
          JSON.stringify(
            {
              version: payload.version,
              recipeCount: payload.recipes.length,
              source: payload.source,
              outputPath,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(JSON.stringify(payload, null, 2));
    });

  dumpCommand
    .command("mob-audio")
    .argument("<version>", "Minecraft version id with a processed dataset or downloaded client/server jars")
    .option("--output <path>", "Write mob audio files to a directory instead of the default dataset output")
    .action(async (version, options) => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const payload = await buildMobAudioDumpPayload(version, {
        load: async (datasetVersion) => {
          const dataset = await context.datasetStore.loadDataset(datasetVersion);
          if (dataset.mobSounds.length === 0) {
            const error = new Error(`Dataset ${datasetVersion} does not include mob sound metadata.`);
            (error as NodeJS.ErrnoException).code = "ENOENT";
            throw error;
          }

          return {
            version: dataset.version,
            mobSounds: dataset.mobSounds,
          };
        },
        extract: async (datasetVersion) => {
          const downloadsDir = versionDownloadsDir(context.config.workspace, datasetVersion);
          const versionRoot = join(context.config.workspace.versionsDir, datasetVersion);
          const sources = [];
          const clientJarPath = join(downloadsDir, "client.jar");
          const serverJarPath = join(downloadsDir, "server.jar");

          if (await fileExists(clientJarPath)) {
            sources.push(new ZipArchiveSource(clientJarPath));
          }

          if (await fileExists(serverJarPath)) {
            sources.push(new ZipArchiveSource(serverJarPath));
          }

          if (sources.length === 0) {
            throw new Error(
              `No processed dataset or downloaded client.jar/server.jar was found for ${datasetVersion}. Looked in ${downloadsDir}.`,
            );
          }

          const metadataPath = join(versionRoot, "metadata.json");
          if (!(await fileExists(metadataPath))) {
            throw new Error(
              `No processed dataset or downloaded metadata.json was found for ${datasetVersion}. Looked in ${metadataPath}.`,
            );
          }

          const metadata = await readJsonFile<VersionMetadata>(metadataPath);
          const decompiledClientRoot = join(versionRoot, "decompiled", "client");
          const mobSoundData = await context.mobSoundExtractor.extract(datasetVersion, metadata, sources, decompiledClientRoot);

          return {
            version: datasetVersion,
            mobSounds: mobSoundData.mobSounds,
          };
        },
      });

      const outputDirectory = options.output
        ? resolve(process.cwd(), options.output)
        : join(context.config.workspace.datasetsDir, payload.version, "mob-audio");
      const result = await dumpMobAudioFiles(payload, outputDirectory, context.http);
      console.log(JSON.stringify(result, null, 2));
    });

  dumpCommand
    .command("banners")
    .argument("<version>", "Minecraft version id with a processed dataset")
    .option("--output <path>", "Write banners.json + textures/ to a directory instead of stdout JSON")
    .action(async (version, options) => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const dataset = await context.datasetStore.loadDataset(version);
      // Prefer the stored banner dataset; fall back to deriving it from the
      // dataset's translations + textures so the command also works on datasets
      // processed before banner extraction existed.
      const banners =
        dataset.banners && dataset.banners.patterns.length > 0
          ? dataset.banners
          : buildBanners(
              dataset.translations,
              dataset.textures.map((texture) => texture.sourcePath),
            );
      const payload = { version: dataset.version, generatedAt: dataset.generatedAt, banners };

      if (!options.output) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      const outputDirectory = resolve(process.cwd(), options.output);
      const bannerImagesDir = join(datasetVersionDir(context.config.workspace, version), "images", "entity", "banner");
      const result = await dumpBanners(payload, bannerImagesDir, outputDirectory);
      console.log(JSON.stringify(result, null, 2));
    });

  const validateCommand = program.command("validate").description("Validate processed datasets.");
  validateCommand
    .command("render")
    .argument("<version>", "Minecraft version id with processed render data")
    .option("--output <path>", "Write validation report JSON to a file")
    .action(async (version, options) => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      const dataset = await context.datasetStore.loadDataset(version);
      if (!dataset.renderData) {
        throw new Error(`Dataset ${version} does not include render data. Re-run process version for this version.`);
      }

      const report = validateRenderDataset(dataset.renderData);
      if (options.output) {
        const outputPath = resolve(process.cwd(), options.output);
        await writeJsonFile(outputPath, report);
        console.log(JSON.stringify({ version, status: report.status, errorCount: report.counts.errors, outputPath }, null, 2));
        return;
      }

      console.log(JSON.stringify(report, null, 2));
      if (report.status === "failed") {
        process.exitCode = 1;
      }
    });

  const apiCommand = program.command("api").description("Serve extracted datasets over HTTP.");
  apiCommand
    .command("serve")
    .option("--host <host>", "Bind host")
    .option("--port <port>", "Bind port", parseInteger)
    .action(async (options) => {
      const context = createDefaultContext(process.cwd(), program.opts<{ verbose: boolean }>().verbose);
      if (options.host) {
        context.config.api.host = options.host;
      }
      if (options.port) {
        context.config.api.port = options.port;
      }

      const server = buildApiServer(context.config, context.datasetStore, context.diffEngine);
      await server.listen({
        host: context.config.api.host,
        port: context.config.api.port,
      });
      console.log(`mc-datahub API listening on http://${context.config.api.host}:${context.config.api.port}`);
    });

  await program.parseAsync();
}

function summarizeCollection(collection: { added: unknown[]; removed: unknown[]; changed: unknown[]; unchangedCount: number }) {
  return {
    added: collection.added.length,
    removed: collection.removed.length,
    changed: collection.changed.length,
    unchanged: collection.unchangedCount,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
