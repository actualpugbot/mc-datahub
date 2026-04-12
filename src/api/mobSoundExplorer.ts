import { join } from "node:path";
import { readJsonFile } from "../core/fs.js";
import { stableJsonHash } from "../core/hash.js";
import { datasetVersionDir, type WorkspacePaths } from "../core/paths.js";
import type { DatasetStore } from "../datasets/datasetStore.js";
import type {
  MinecraftWikiMobSoundAlignment,
  MinecraftWikiMobSoundCategoryAlignment,
  MinecraftWikiMobSoundFile,
  MinecraftWikiMobSoundLocalOnlyMob,
  MinecraftWikiMobSoundSnapshot,
  MobSoundDefinition,
  VersionDataset,
} from "../domain/types.js";

export interface MobSoundExplorerRequest {
  version?: string;
  compareToVersion?: string;
}

export type MobSoundExplorerDiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface MobSoundExplorerWikiCategory extends MinecraftWikiMobSoundCategoryAlignment {
  files: MinecraftWikiMobSoundFile[];
}

export interface MobSoundExplorerRow {
  id: string;
  displayName: string;
  status: MobSoundExplorerDiffStatus;
  current?: MobSoundDefinition;
  compareTo?: MobSoundDefinition;
  diff?: {
    addedEventIds: string[];
    removedEventIds: string[];
    addedSoundPaths: string[];
    removedSoundPaths: string[];
    metadataChanged: boolean;
  };
  wiki?: MobSoundExplorerWikiCategory;
}

export interface MobSoundExplorerDiffSummary {
  addedMobCount: number;
  removedMobCount: number;
  changedMobCount: number;
  unchangedMobCount: number;
  addedSoundEventCount: number;
  removedSoundEventCount: number;
  addedSoundVariantCount: number;
  removedSoundVariantCount: number;
}

export interface MobSoundExplorerPayload {
  availableVersions: string[];
  version: string;
  compareToVersion?: string;
  wikiSnapshotFetchedAt?: string;
  summary: {
    mobCount: number;
    soundEventCount: number;
    soundVariantCount: number;
    wikiCategoryCount: number;
    exactCategoryCount: number;
    partialCategoryCount: number;
    wikiOnlyCategoryCount: number;
    localOnlyMobCount: number;
    diff?: MobSoundExplorerDiffSummary;
  };
  localOnlyMobs: MinecraftWikiMobSoundLocalOnlyMob[];
  wikiOnlyCategories: MobSoundExplorerWikiCategory[];
  rows: MobSoundExplorerRow[];
}

export class ApiRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function buildMobSoundExplorerPayload(
  datasetStore: DatasetStore,
  workspace: WorkspacePaths,
  request: MobSoundExplorerRequest,
): Promise<MobSoundExplorerPayload> {
  const availableVersions = await datasetStore.listVersions();
  if (availableVersions.length === 0) {
    throw new ApiRequestError(404, "No processed datasets are available yet.");
  }

  const datasetCache = new Map<string, Promise<VersionDataset>>();
  const loadDataset = (version: string) => {
    const existing = datasetCache.get(version);
    if (existing) {
      return existing;
    }

    const pending = datasetStore.loadDataset(version);
    datasetCache.set(version, pending);
    return pending;
  };

  const version = await resolveRequestedVersion(request.version, availableVersions, loadDataset);
  const compareToVersion = resolveCompareToVersion(request.compareToVersion, version, availableVersions);
  const current = await loadDataset(version);
  const compareTo = compareToVersion ? await loadDataset(compareToVersion) : undefined;
  const snapshot = await loadMinecraftWikiSnapshot(workspace, version, current.mobSoundMinecraftWiki);
  const wikiByLocalId = buildWikiCategoryMap(current.mobSoundMinecraftWiki, snapshot);
  const rows = buildRows(current.mobSounds, compareTo?.mobSounds ?? [], wikiByLocalId, Boolean(compareTo));
  const wikiOnlyCategories = Array.from(wikiByLocalId.values())
    .filter((category) => category.matchType === "wiki-only")
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  return {
    availableVersions,
    version,
    compareToVersion,
    wikiSnapshotFetchedAt: snapshot?.fetchedAt,
    summary: {
      mobCount: current.mobSounds.length,
      soundEventCount: current.mobSounds.reduce((count, mob) => count + mob.soundEventCount, 0),
      soundVariantCount: current.mobSounds.reduce((count, mob) => count + mob.soundVariantCount, 0),
      wikiCategoryCount: current.mobSoundMinecraftWiki?.categoryCount ?? 0,
      exactCategoryCount: current.mobSoundMinecraftWiki?.exactCategoryCount ?? 0,
      partialCategoryCount: current.mobSoundMinecraftWiki?.partialCategoryCount ?? 0,
      wikiOnlyCategoryCount: current.mobSoundMinecraftWiki?.wikiOnlyCategoryCount ?? 0,
      localOnlyMobCount: current.mobSoundMinecraftWiki?.localOnlyMobs.length ?? 0,
      diff: compareTo ? summarizeDiff(rows) : undefined,
    },
    localOnlyMobs: current.mobSoundMinecraftWiki?.localOnlyMobs ?? [],
    wikiOnlyCategories,
    rows,
  };
}

async function resolveRequestedVersion(
  requestedVersion: string | undefined,
  availableVersions: string[],
  loadDataset: (version: string) => Promise<{ mobSounds: MobSoundDefinition[] }>,
): Promise<string> {
  if (requestedVersion) {
    if (!availableVersions.includes(requestedVersion)) {
      throw new ApiRequestError(404, `Unknown version: ${requestedVersion}`);
    }

    return requestedVersion;
  }

  for (const version of [...availableVersions].reverse()) {
    const dataset = await loadDataset(version);
    if (dataset.mobSounds.length > 0) {
      return version;
    }
  }

  return availableVersions[availableVersions.length - 1]!;
}

function resolveCompareToVersion(
  requestedCompareToVersion: string | undefined,
  selectedVersion: string,
  availableVersions: string[],
): string | undefined {
  if (requestedCompareToVersion === "") {
    return undefined;
  }

  if (requestedCompareToVersion) {
    if (requestedCompareToVersion === selectedVersion) {
      return undefined;
    }

    if (!availableVersions.includes(requestedCompareToVersion)) {
      throw new ApiRequestError(404, `Unknown comparison version: ${requestedCompareToVersion}`);
    }

    return requestedCompareToVersion;
  }

  const selectedIndex = availableVersions.indexOf(selectedVersion);
  if (selectedIndex <= 0) {
    return undefined;
  }

  return availableVersions[selectedIndex - 1];
}

async function loadMinecraftWikiSnapshot(
  workspace: WorkspacePaths,
  version: string,
  alignment?: MinecraftWikiMobSoundAlignment,
): Promise<MinecraftWikiMobSoundSnapshot | undefined> {
  if (!alignment?.snapshotRelativePath) {
    return undefined;
  }

  try {
    return await readJsonFile<MinecraftWikiMobSoundSnapshot>(
      join(datasetVersionDir(workspace, version), alignment.snapshotRelativePath),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function buildWikiCategoryMap(
  alignment: MinecraftWikiMobSoundAlignment | undefined,
  snapshot: MinecraftWikiMobSoundSnapshot | undefined,
): Map<string, MobSoundExplorerWikiCategory> {
  const result = new Map<string, MobSoundExplorerWikiCategory>();
  if (!alignment) {
    return result;
  }

  const snapshotFilesByCategoryId = new Map(
    (snapshot?.categories ?? []).map((category) => [category.id, category.files] as const),
  );

  for (const category of alignment.categories) {
    const enrichedCategory: MobSoundExplorerWikiCategory = {
      ...category,
      files: snapshotFilesByCategoryId.get(category.id) ?? [],
    };

    if (category.matchType === "wiki-only") {
      result.set(`wiki-only:${category.id}`, enrichedCategory);
      continue;
    }

    for (const mobId of category.mappedMobIds) {
      result.set(mobId, enrichedCategory);
    }
  }

  return result;
}

function buildRows(
  currentMobSounds: MobSoundDefinition[],
  compareToMobSounds: MobSoundDefinition[],
  wikiByLocalId: Map<string, MobSoundExplorerWikiCategory>,
  includeDiff: boolean,
): MobSoundExplorerRow[] {
  const currentByLocalId = new Map(currentMobSounds.map((mob) => [mob.localId, mob]));
  const compareToByLocalId = new Map(compareToMobSounds.map((mob) => [mob.localId, mob]));
  const keys = new Set<string>([...currentByLocalId.keys(), ...compareToByLocalId.keys()]);

  return Array.from(keys)
    .map((localId) => {
      const current = currentByLocalId.get(localId);
      const compareTo = compareToByLocalId.get(localId);
      const diff = includeDiff ? buildRowDiff(current, compareTo) : undefined;
      const status = diff ? resolveRowStatus(current, compareTo, diff) : "unchanged";

      return {
        id: localId,
        displayName: current?.displayName ?? compareTo?.displayName ?? localId,
        status,
        current,
        compareTo,
        diff,
        wiki: current ? wikiByLocalId.get(current.localId) : undefined,
      } satisfies MobSoundExplorerRow;
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function buildRowDiff(current: MobSoundDefinition | undefined, compareTo: MobSoundDefinition | undefined) {
  const currentEventIds = collectEventIds(current);
  const compareToEventIds = collectEventIds(compareTo);
  const currentSoundPaths = collectSoundPaths(current);
  const compareToSoundPaths = collectSoundPaths(compareTo);

  return {
    addedEventIds: subtractValues(currentEventIds, compareToEventIds),
    removedEventIds: subtractValues(compareToEventIds, currentEventIds),
    addedSoundPaths: subtractValues(currentSoundPaths, compareToSoundPaths),
    removedSoundPaths: subtractValues(compareToSoundPaths, currentSoundPaths),
    metadataChanged:
      Boolean(current && compareTo) &&
      stableJsonHash(current) !== stableJsonHash(compareTo),
  };
}

function resolveRowStatus(
  current: MobSoundDefinition | undefined,
  compareTo: MobSoundDefinition | undefined,
  diff: NonNullable<MobSoundExplorerRow["diff"]>,
): MobSoundExplorerDiffStatus {
  if (current && !compareTo) {
    return "added";
  }

  if (!current && compareTo) {
    return "removed";
  }

  if (
    diff.addedEventIds.length > 0 ||
    diff.removedEventIds.length > 0 ||
    diff.addedSoundPaths.length > 0 ||
    diff.removedSoundPaths.length > 0 ||
    diff.metadataChanged
  ) {
    return "changed";
  }

  return "unchanged";
}

function summarizeDiff(rows: MobSoundExplorerRow[]): MobSoundExplorerDiffSummary {
  return rows.reduce<MobSoundExplorerDiffSummary>(
    (summary, row) => {
      if (row.status === "added") {
        summary.addedMobCount += 1;
      } else if (row.status === "removed") {
        summary.removedMobCount += 1;
      } else if (row.status === "changed") {
        summary.changedMobCount += 1;
      } else {
        summary.unchangedMobCount += 1;
      }

      summary.addedSoundEventCount += row.diff?.addedEventIds.length ?? 0;
      summary.removedSoundEventCount += row.diff?.removedEventIds.length ?? 0;
      summary.addedSoundVariantCount += row.diff?.addedSoundPaths.length ?? 0;
      summary.removedSoundVariantCount += row.diff?.removedSoundPaths.length ?? 0;
      return summary;
    },
    {
      addedMobCount: 0,
      removedMobCount: 0,
      changedMobCount: 0,
      unchangedMobCount: 0,
      addedSoundEventCount: 0,
      removedSoundEventCount: 0,
      addedSoundVariantCount: 0,
      removedSoundVariantCount: 0,
    },
  );
}

function collectEventIds(mob: MobSoundDefinition | undefined): string[] {
  if (!mob) {
    return [];
  }

  return mob.soundEvents.map((soundEvent) => soundEvent.id).sort();
}

function collectSoundPaths(mob: MobSoundDefinition | undefined): string[] {
  if (!mob) {
    return [];
  }

  return Array.from(
    new Set(
      mob.soundEvents.flatMap((soundEvent) => soundEvent.variants.map((variant) => variant.soundPath)),
    ),
  ).sort();
}

function subtractValues(source: string[], excluded: string[]): string[] {
  const excludedSet = new Set(excluded);
  return source.filter((value) => !excludedSet.has(value));
}
