import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { DownloadedArtifact, VersionArtifacts, VersionMetadata } from "../domain/types.js";
import type { HttpClient } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import { ensureDir, writeJsonFile } from "../core/fs.js";
import { versionDownloadsDir, versionRoot } from "../core/paths.js";

const ARTIFACT_KINDS = ["client", "server", "client_mappings", "server_mappings"] as const;

export class VersionDownloader {
  constructor(
    private readonly http: HttpClient,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async download(version: string, metadata: VersionMetadata): Promise<VersionArtifacts> {
    const rootDir = versionRoot(this.config.workspace, version);
    const downloadsDir = versionDownloadsDir(this.config.workspace, version);

    await ensureDir(downloadsDir);
    const metadataPath = join(rootDir, "metadata.json");
    await writeJsonFile(metadataPath, metadata);

    const downloads: VersionArtifacts["downloads"] = {};
    for (const kind of ARTIFACT_KINDS) {
      const descriptor = metadata.downloads[kind];
      if (!descriptor) {
        continue;
      }

      const extension = kind.endsWith("mappings") ? "txt" : "jar";
      const outputPath = join(downloadsDir, `${kind}.${extension}`);
      this.logger.debug(`Downloading ${kind} for ${version} to ${outputPath}.`);
      const result = await this.http.downloadFile(descriptor.url, outputPath, {
        expectedSha1: descriptor.sha1,
      });

      downloads[kind] = {
        kind,
        path: outputPath,
        url: descriptor.url,
        sha1: result.sha1,
        bytes: result.bytes,
        downloaded: result.downloaded,
      } satisfies DownloadedArtifact;
    }

    return {
      version,
      rootDir,
      metadataPath,
      downloads,
    };
  }
}
