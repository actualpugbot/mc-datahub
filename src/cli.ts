#!/usr/bin/env node

import { join, resolve } from "node:path";
import { Command } from "commander";
import { ZipArchiveSource } from "./archive/zipArchiveSource.js";
import { buildApiServer } from "./api/server.js";
import { fileExists, writeJsonFile } from "./core/fs.js";
import { versionDownloadsDir } from "./core/paths.js";
import { createDefaultContext } from "./index.js";
import { buildRecipeDumpPayload } from "./orchestrators/dumpRecipes.js";

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
              recipes: summarizeCollection(diff.recipes),
              textures: summarizeCollection(diff.textures),
              models: summarizeCollection(diff.models),
              palettes: summarizeCollection(diff.palettes),
            },
          },
          null,
          2,
        ),
      );
    });

  const dumpCommand = program.command("dump").description("Dump extracted data as JSON.");
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

      const server = buildApiServer(context.config, context.datasetStore);
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
