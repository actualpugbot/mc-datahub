import { join } from "node:path";
import { FileCache } from "../core/cache.js";
import { ensureDir, fileExists, writeTextFile } from "../core/fs.js";
import type { HttpClient } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import { versionMappingsDir } from "../core/paths.js";
import type { AppConfig } from "../config.js";
import type { MappingArtifact, MappingProvider, VersionMetadata } from "../domain/types.js";
import { ZipArchiveSource } from "../archive/zipArchiveSource.js";

interface YarnVersionRecord {
  gameVersion?: string;
  version?: string;
  build?: number;
}

export class MappingResolver {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: FileCache,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async resolve(version: string, metadata: VersionMetadata, provider: MappingProvider): Promise<MappingArtifact[]> {
    if (provider === "yarn") {
      return this.resolveYarn(version);
    }

    return this.resolveMojang(version, metadata);
  }

  private async resolveMojang(version: string, metadata: VersionMetadata): Promise<MappingArtifact[]> {
    const mappingsDir = join(versionMappingsDir(this.config.workspace, version), "mojang");
    await ensureDir(mappingsDir);

    const artifacts: MappingArtifact[] = [];
    for (const [kind, descriptor] of Object.entries(metadata.downloads)) {
      if (!descriptor || (kind !== "client_mappings" && kind !== "server_mappings")) {
        continue;
      }

      const outputPath = join(mappingsDir, `${kind}.txt`);
      const result = await this.http.downloadFile(descriptor.url, outputPath, {
        expectedSha1: descriptor.sha1,
      });
      this.logger.debug(`Resolved Mojang ${kind} for ${version} at ${outputPath}.`);

      artifacts.push({
        provider: "mojang",
        kind: kind === "client_mappings" ? "client" : "server",
        format: "proguard",
        path: outputPath,
        url: descriptor.url,
      });

      if (!result.downloaded && !(await fileExists(outputPath))) {
        throw new Error(`Expected Mojang mappings at ${outputPath} but the file was not found.`);
      }
    }

    return artifacts;
  }

  private async resolveYarn(version: string): Promise<MappingArtifact[]> {
    const manifestUrl = `${this.config.urls.yarnManifestBase}/${encodeURIComponent(version)}`;
    const available = await this.cache.remember(`yarn-manifest:${version}`, 10 * 60 * 1000, async () =>
      this.http.getJson<YarnVersionRecord[]>(manifestUrl),
    );

    const selected = available.find((entry) => entry.version) ?? available[0];
    if (!selected) {
      throw new Error(`No Yarn mappings were published for ${version}.`);
    }

    const yarnVersion = selected.version ?? (selected.build ? `${version}+build.${selected.build}` : undefined);
    if (!yarnVersion) {
      throw new Error(`Could not determine the Yarn mapping version for ${version}.`);
    }

    const mappingsDir = join(versionMappingsDir(this.config.workspace, version), "yarn");
    await ensureDir(mappingsDir);

    const jarUrl = `${this.config.urls.yarnMavenBase}/${encodeURIComponent(yarnVersion)}/yarn-${yarnVersion}-v2.jar`;
    const jarPath = join(mappingsDir, `yarn-${yarnVersion}-v2.jar`);
    await this.http.downloadFile(jarUrl, jarPath);

    const archive = new ZipArchiveSource(jarPath);
    const tinyPath = await this.extractTinyMappings(archive, join(mappingsDir, "mappings.tiny"));

    return [
      {
        provider: "yarn",
        kind: "merged",
        format: "tiny-v2",
        path: tinyPath,
        url: jarUrl,
        sourceArchivePath: jarPath,
      },
    ];
  }

  private async extractTinyMappings(archive: ZipArchiveSource, outputPath: string): Promise<string> {
    const paths = await archive.listPaths();
    const tinyFile = paths.find((path) => path.endsWith(".tiny"));
    if (!tinyFile) {
      throw new Error("The downloaded Yarn archive did not include a .tiny mappings file.");
    }

    const contents = await archive.readText(tinyFile);
    await writeTextFile(outputPath, contents);
    return outputPath;
  }
}
