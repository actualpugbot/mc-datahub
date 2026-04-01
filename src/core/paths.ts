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

export function versionRoot(paths: WorkspacePaths, version: string): string {
  return join(paths.versionsDir, version);
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
  return join(paths.datasetsDir, version);
}
