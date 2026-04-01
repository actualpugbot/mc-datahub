import { FileCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import type { Logger } from "../core/logger.js";
import type { AppConfig } from "../config.js";
import type { VersionManifestEntry, VersionManifestResponse, VersionMetadata } from "../domain/types.js";

type VersionAlias = "latest" | "latest-release" | "latest-snapshot";

export class VersionManifestResolver {
  constructor(
    private readonly http: HttpClient,
    private readonly cache: FileCache,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async getManifest(): Promise<VersionManifestResponse> {
    return this.cache.remember("mojang-version-manifest", 10 * 60 * 1000, async () =>
      this.http.getJson<VersionManifestResponse>(this.config.urls.versionManifest),
    );
  }

  async resolve(versionOrAlias: string): Promise<{ manifestEntry: VersionManifestEntry; metadata: VersionMetadata }> {
    const manifest = await this.getManifest();
    const requestedVersion = this.resolveAlias(manifest, versionOrAlias);
    const manifestEntry = manifest.versions.find((entry) => entry.id === requestedVersion);

    if (!manifestEntry) {
      throw new Error(`Version ${requestedVersion} was not found in the Mojang version manifest.`);
    }

    const metadata = await this.cache.remember(`version-metadata:${requestedVersion}`, 10 * 60 * 1000, async () =>
      this.http.getJson<VersionMetadata>(manifestEntry.url),
    );

    this.logger.debug(`Resolved version ${requestedVersion} from Mojang manifest.`);
    return { manifestEntry, metadata };
  }

  private resolveAlias(manifest: VersionManifestResponse, versionOrAlias: string): string {
    const normalized = versionOrAlias.toLowerCase() as VersionAlias;
    if (normalized === "latest") {
      return manifest.latest.release;
    }

    if (normalized === "latest-release") {
      return manifest.latest.release;
    }

    if (normalized === "latest-snapshot") {
      return manifest.latest.snapshot;
    }

    return versionOrAlias;
  }
}
