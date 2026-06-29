import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeJsonFile } from "../core/fs.js";
import type { BannerDataset } from "../domain/types.js";

export interface BannerDumpPayload {
  version: string;
  generatedAt: string;
  banners: BannerDataset;
}

export interface BannerDumpResult {
  version: string;
  outputDirectory: string;
  bannersPath: string;
  texturesDirectory: string;
  patternCount: number;
  colorCount: number;
  copiedTextureCount: number;
  missingTextures: string[];
}

/**
 * Write the banner dataset JSON and copy the textures it references — the
 * `base` fill plus every overlay pattern PNG — from a processed dataset's
 * extracted `images/entity/banner/` into
 * `<outputDirectory>/{banners.json, textures/<assetId>.png}`. This is the
 * self-contained handoff a downstream tool (pugtools Banner Studio) commits,
 * mirroring `dump mob-audio` → mob-dub.
 */
export async function dumpBanners(
  payload: BannerDumpPayload,
  bannerImagesDir: string,
  outputDirectory: string,
): Promise<BannerDumpResult> {
  const bannersPath = join(outputDirectory, "banners.json");
  await writeJsonFile(bannersPath, {
    version: payload.version,
    generatedAt: payload.generatedAt,
    patterns: payload.banners.patterns,
    colors: payload.banners.colors,
  });

  const texturesDirectory = join(outputDirectory, "textures");
  await ensureDir(texturesDirectory);

  const assetIds = ["base", ...payload.banners.patterns.map((pattern) => pattern.assetId)];
  const seen = new Set<string>();
  let copiedTextureCount = 0;
  const missingTextures: string[] = [];

  for (const assetId of assetIds) {
    if (seen.has(assetId)) {
      continue;
    }
    seen.add(assetId);

    const sourcePath = join(bannerImagesDir, `${assetId}.png`);
    try {
      await fs.copyFile(sourcePath, join(texturesDirectory, `${assetId}.png`));
      copiedTextureCount += 1;
    } catch (error) {
      if (isMissingFileError(error)) {
        missingTextures.push(`${assetId}.png`);
      } else {
        throw error;
      }
    }
  }

  return {
    version: payload.version,
    outputDirectory,
    bannersPath,
    texturesDirectory,
    patternCount: payload.banners.patterns.length,
    colorCount: payload.banners.colors.length,
    copiedTextureCount,
    missingTextures,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
