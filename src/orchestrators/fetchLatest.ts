import type { Logger } from "../core/logger.js";
import type { MappingProvider } from "../domain/types.js";
import type { StateStore } from "../state/stateStore.js";
import type { VersionManifestResolver } from "../versions/manifestResolver.js";
import type { MinecraftNewsWatcher } from "../watcher/newsWatcher.js";
import type { ProcessVersionWorkflow } from "./processVersion.js";

export interface FetchLatestOptions {
  kind: "release" | "snapshot" | "any";
  limit: number;
  process: boolean;
  mappingProvider: MappingProvider;
  skipDecompile: boolean;
  force: boolean;
}

export class FetchLatestWorkflow {
  constructor(
    private readonly newsWatcher: MinecraftNewsWatcher,
    private readonly manifestResolver: VersionManifestResolver,
    private readonly processVersion: ProcessVersionWorkflow,
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
  ) {}

  async run(options: FetchLatestOptions) {
    const posts = await this.newsWatcher.scan();
    const unseen = [];

    for (const post of posts) {
      if (options.kind !== "any" && post.kind !== options.kind) {
        continue;
      }

      if (await this.stateStore.hasProcessedNewsPost(post.id)) {
        continue;
      }

      const validVersions: string[] = [];
      for (const versionId of post.versionIds) {
        try {
          await this.manifestResolver.resolve(versionId);
          validVersions.push(versionId);
        } catch (error) {
          this.logger.debug(`Ignoring unresolved version ${versionId}: ${(error as Error).message}`);
        }
      }

      if (validVersions.length === 0) {
        continue;
      }

      unseen.push({
        ...post,
        versionIds: validVersions,
      });

      if (unseen.length >= options.limit) {
        break;
      }
    }

    const processed = [];
    for (const post of unseen) {
      if (options.process) {
        for (const versionId of post.versionIds) {
          processed.push(
            await this.processVersion.run(versionId, {
              mappingProvider: options.mappingProvider,
              skipDecompile: options.skipDecompile,
              force: options.force,
            }),
          );
        }
      }

      await this.stateStore.markNewsPostProcessed(post);
    }

    return {
      scannedAt: new Date().toISOString(),
      posts: unseen,
      processed,
    };
  }
}
