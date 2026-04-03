import { loadConfig, type AppConfig } from "./config.js";
import { FileCache } from "./core/cache.js";
import { FetchHttpClient } from "./core/http.js";
import type { Logger } from "./core/logger.js";
import { createConsoleLogger } from "./core/logger.js";
import { DatasetStore } from "./datasets/datasetStore.js";
import { DecompilePipeline } from "./decompile/decompilePipeline.js";
import { DiffEngine } from "./diff/diffEngine.js";
import { VersionDownloader } from "./download/versionDownloader.js";
import { MinecraftDataExtractor } from "./extraction/dataExtractor.js";
import { MobImageExtractor } from "./extraction/mobImageExtractor.js";
import { MobSoundExtractor } from "./extraction/mobSoundExtractor.js";
import { DecompiledSourceExtractor } from "./extraction/sourceDerivedExtractor.js";
import { MappingResolver } from "./mappings/mappingResolver.js";
import { FetchLatestWorkflow } from "./orchestrators/fetchLatest.js";
import { ProcessVersionWorkflow } from "./orchestrators/processVersion.js";
import { StateStore } from "./state/stateStore.js";
import { VersionManifestResolver } from "./versions/manifestResolver.js";
import { MinecraftNewsWatcher } from "./watcher/newsWatcher.js";

export function createApplicationContext(config: AppConfig, logger: Logger) {
  const http = new FetchHttpClient(logger);
  const cache = new FileCache(config.workspace.cacheDir);
  const state = new StateStore(config.workspace.stateFile);
  const manifestResolver = new VersionManifestResolver(http, cache, config, logger);
  const versionDownloader = new VersionDownloader(http, config, logger);
  const mappingResolver = new MappingResolver(http, cache, config, logger);
  const decompilePipeline = new DecompilePipeline(config, logger);
  const extractor = new MinecraftDataExtractor(logger);
  const mobImageExtractor = new MobImageExtractor(logger);
  const mobSoundExtractor = new MobSoundExtractor(http, cache, logger);
  const sourceExtractor = new DecompiledSourceExtractor(logger);
  const datasetStore = new DatasetStore(config.workspace, logger);
  const diffEngine = new DiffEngine();
  const newsWatcher = new MinecraftNewsWatcher(http, cache, config, logger);
  const processVersion = new ProcessVersionWorkflow(
    manifestResolver,
    versionDownloader,
    mappingResolver,
    decompilePipeline,
    extractor,
    mobImageExtractor,
    mobSoundExtractor,
    sourceExtractor,
    datasetStore,
    state,
    config,
    logger,
  );
  const fetchLatest = new FetchLatestWorkflow(newsWatcher, manifestResolver, processVersion, state, logger);

  return {
    config,
    logger,
    http,
    cache,
    state,
    manifestResolver,
    versionDownloader,
    mappingResolver,
    decompilePipeline,
    extractor,
    mobImageExtractor,
    mobSoundExtractor,
    sourceExtractor,
    datasetStore,
    diffEngine,
    newsWatcher,
    processVersion,
    fetchLatest,
  };
}

export function createDefaultContext(projectRoot = process.cwd(), verbose = false) {
  const config = loadConfig(projectRoot);
  const logger = createConsoleLogger(verbose);
  return createApplicationContext(config, logger);
}
