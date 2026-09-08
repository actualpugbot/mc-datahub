import { join } from "node:path";

export interface WorkspacePaths {
  root: string;
  cacheDir: string;
  versionsDir: string;
  datasetsDir: string;
  diffsDir: string;
  toolsDir: string;
  stateFile: string;
}

export function createWorkspacePaths(root: string): WorkspacePaths {
  return {
    root,
    cacheDir: join(root, "cache"),
    versionsDir: join(root, "versions"),
    datasetsDir: join(root, "datasets"),
    diffsDir: join(root, "diffs"),
    toolsDir: join(root, "tools"),
    stateFile: join(root, "state.json"),
  };
}

/**
 * A version id names exactly one directory under `versions/` and `datasets/`, so it must be a single
 * path segment. Mojang ids are unusually shaped (`26.3-pre-1`, `26w14a`, `1.RV-Pre1`, `3D Shareware
 * v1.34`), so this rejects traversal rather than allow-listing a format that would drop real versions.
 */
export function isSafeVersionSegment(version: string): boolean {
  return (
    version.length > 0 &&
    version !== "." &&
    version !== ".." &&
    !version.includes("/") &&
    !version.includes("\\") &&
    !version.includes("\0")
  );
}

/** Throws unless `version` is a single path segment, so a caller can never `join` its way out of the workspace. */
export function assertSafeVersionSegment(version: string): string {
  if (!isSafeVersionSegment(version)) {
    throw new Error(`Invalid version id: ${JSON.stringify(version)}`);
  }

  return version;
}

export function versionRoot(paths: WorkspacePaths, version: string): string {
  return join(paths.versionsDir, assertSafeVersionSegment(version));
}

export function versionDownloadsDir(paths: WorkspacePaths, version: string): string {
  return join(versionRoot(paths, version), "downloads");
}

export function versionMappingsDir(paths: WorkspacePaths, version: string): string {
  return join(versionRoot(paths, version), "mappings");
}

export function versionRemappedDir(paths: WorkspacePaths, version: string): string {
  return join(versionRoot(paths, version), "remapped");
}

export function versionDecompiledDir(paths: WorkspacePaths, version: string): string {
  return join(versionRoot(paths, version), "decompiled");
}

export function datasetVersionDir(paths: WorkspacePaths, version: string): string {
  return join(paths.datasetsDir, assertSafeVersionSegment(version));
}
