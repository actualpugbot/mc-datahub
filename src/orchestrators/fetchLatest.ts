import type { Logger } from "../core/logger.js";
import type { MinecraftNewsPost } from "../domain/types.js";
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

type LatestAlias = "latest-release" | "latest-snapshot";

interface LatestTarget {
  alias: LatestAlias;
  kind: "release" | "snapshot";
  versionId: string;
  articleIds: string[];
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
    const latestTargets = await this.resolveLatestTargets(options);
    const matchedPosts = new Map<string, MinecraftNewsPost>();
    for (const target of latestTargets) {
      for (const post of posts) {
        if (post.versionIds.includes(target.versionId)) {
          target.articleIds.push(post.id);
          matchedPosts.set(post.id, post);
        }
      }
    }

    const processed = [];
    for (const target of latestTargets) {
      if (options.process) {
        processed.push(
          await this.processVersion.run(target.versionId, {
            mappingProvider: options.mappingProvider,
            skipDecompile: options.skipDecompile,
            force: options.force,
          }),
        );
      }
    }

    for (const post of matchedPosts.values()) {
      if (!(await this.stateStore.hasProcessedNewsPost(post.id))) {
        await this.stateStore.markNewsPostProcessed(post);
      }
    }

    return {
      scannedAt: new Date().toISOString(),
      latest: latestTargets,
      posts: Array.from(matchedPosts.values()),
      processed,
    };
  }

  private async resolveLatestTargets(options: FetchLatestOptions): Promise<LatestTarget[]> {
    const aliases = this.requestedAliases(options.kind).slice(0, Math.max(0, options.limit));
    const targets: LatestTarget[] = [];
    const seenVersions = new Set<string>();

    for (const { alias, kind } of aliases) {
      const { manifestEntry } = await this.manifestResolver.resolve(alias);
      if (seenVersions.has(manifestEntry.id)) {
        continue;
      }

      seenVersions.add(manifestEntry.id);
      targets.push({
        alias,
        kind,
        versionId: manifestEntry.id,
        articleIds: [],
      });
    }

    return targets;
  }

  private requestedAliases(kind: FetchLatestOptions["kind"]): Array<{ alias: LatestAlias; kind: "release" | "snapshot" }> {
    if (kind === "release") {
      return [{ alias: "latest-release", kind: "release" }];
    }

    if (kind === "snapshot") {
      return [{ alias: "latest-snapshot", kind: "snapshot" }];
    }

    return [
      { alias: "latest-release", kind: "release" },
      { alias: "latest-snapshot", kind: "snapshot" },
    ];
  }
}
