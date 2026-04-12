import { join } from "node:path";
import type { DownloadFileResult } from "../core/http.js";
import type { MobSoundDefinition, MobSoundVariantDefinition } from "../domain/types.js";

export interface MobAudioDumpDataset {
  version: string;
  mobSounds: MobSoundDefinition[];
}

export interface MobAudioDumpPayload extends MobAudioDumpDataset {
  source: "dataset" | "archives";
}

export interface MobAudioDumpLoader {
  load(version: string): Promise<MobAudioDumpDataset>;
  extract(version: string): Promise<MobAudioDumpDataset>;
}

export interface MobAudioDumpDownloader {
  downloadFile(url: string, outputPath: string, options?: { expectedSha1?: string }): Promise<DownloadFileResult>;
}

export interface MobAudioDumpResult {
  version: string;
  source: "dataset" | "archives";
  outputDirectory: string;
  mobCount: number;
  soundEventCount: number;
  soundVariantCount: number;
  fileCount: number;
  downloadedCount: number;
  reusedCount: number;
  totalBytes: number;
}

interface MobAudioFilePlan {
  assetPath: string;
  relativePath: string;
  url: string;
  hash: string;
}

export async function buildMobAudioDumpPayload(
  version: string,
  loader: MobAudioDumpLoader,
): Promise<MobAudioDumpPayload> {
  try {
    const dataset = await loader.load(version);
    return {
      version: dataset.version,
      mobSounds: dataset.mobSounds,
      source: "dataset",
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const dataset = await loader.extract(version);
  return {
    version: dataset.version,
    mobSounds: dataset.mobSounds,
    source: "archives",
  };
}

export async function dumpMobAudioFiles(
  payload: MobAudioDumpPayload,
  outputDirectory: string,
  downloader: MobAudioDumpDownloader,
): Promise<MobAudioDumpResult> {
  const plans = collectMobAudioFilePlans(payload.mobSounds);
  let downloadedCount = 0;
  let reusedCount = 0;
  let totalBytes = 0;

  for (const plan of plans) {
    const result = await downloader.downloadFile(plan.url, join(outputDirectory, plan.relativePath), {
      expectedSha1: plan.hash,
    });
    totalBytes += result.bytes;

    if (result.downloaded) {
      downloadedCount += 1;
    } else {
      reusedCount += 1;
    }
  }

  return {
    version: payload.version,
    source: payload.source,
    outputDirectory,
    mobCount: payload.mobSounds.length,
    soundEventCount: payload.mobSounds.reduce((count, mob) => count + mob.soundEvents.length, 0),
    soundVariantCount: payload.mobSounds.reduce((count, mob) => count + mob.soundVariantCount, 0),
    fileCount: plans.length,
    downloadedCount,
    reusedCount,
    totalBytes,
  };
}

function collectMobAudioFilePlans(mobSounds: MobSoundDefinition[]): MobAudioFilePlan[] {
  const plansByRelativePath = new Map<string, MobAudioFilePlan>();

  for (const mobSound of mobSounds) {
    for (const soundEvent of mobSound.soundEvents) {
      for (const variant of soundEvent.variants) {
        const relativePath = toRelativeOutputPath(variant);
        const existing = plansByRelativePath.get(relativePath);
        if (existing) {
          assertMatchingPlan(existing, variant, relativePath);
          continue;
        }

        plansByRelativePath.set(relativePath, {
          assetPath: variant.assetPath,
          relativePath,
          url: variant.url,
          hash: variant.hash,
        });
      }
    }
  }

  return Array.from(plansByRelativePath.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function toRelativeOutputPath(variant: MobSoundVariantDefinition): string {
  const prefix = "minecraft/sounds/";
  return variant.assetPath.startsWith(prefix) ? variant.assetPath.slice(prefix.length) : variant.assetPath;
}

function assertMatchingPlan(existing: MobAudioFilePlan, variant: MobSoundVariantDefinition, relativePath: string): void {
  if (existing.assetPath === variant.assetPath && existing.url === variant.url && existing.hash === variant.hash) {
    return;
  }

  throw new Error(
    `Conflicting mob audio definitions were found for ${relativePath}: ${existing.assetPath} and ${variant.assetPath}.`,
  );
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
