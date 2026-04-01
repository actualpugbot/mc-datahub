import { resolve } from "node:path";
import { createWorkspacePaths, type WorkspacePaths } from "./core/paths.js";

export interface AppConfig {
  projectRoot: string;
  workspace: WorkspacePaths;
  urls: {
    minecraftArticles: string;
    versionManifest: string;
    yarnManifestBase: string;
    yarnMavenBase: string;
  };
  api: {
    host: string;
    port: number;
  };
  toolchain: {
    tinyRemapperCommand?: string;
    vineflowerCommand?: string;
  };
}

export function loadConfig(projectRoot = process.cwd()): AppConfig {
  const workspaceRoot = process.env.MCDATAHUB_WORKSPACE_ROOT
    ? resolve(process.env.MCDATAHUB_WORKSPACE_ROOT)
    : resolve(projectRoot, "workspace");

  return {
    projectRoot,
    workspace: createWorkspacePaths(workspaceRoot),
    urls: {
      minecraftArticles: process.env.MCDATAHUB_ARTICLES_URL ?? "https://www.minecraft.net/en-us/articles",
      versionManifest:
        process.env.MCDATAHUB_VERSION_MANIFEST_URL ?? "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
      yarnManifestBase: process.env.MCDATAHUB_YARN_MANIFEST_BASE_URL ?? "https://meta.fabricmc.net/v2/versions/yarn",
      yarnMavenBase: process.env.MCDATAHUB_YARN_MAVEN_BASE_URL ?? "https://maven.fabricmc.net/net/fabricmc/yarn",
    },
    api: {
      host: process.env.MCDATAHUB_API_HOST ?? "127.0.0.1",
      port: Number(process.env.MCDATAHUB_API_PORT ?? 4000),
    },
    toolchain: {
      tinyRemapperCommand: process.env.MCDATAHUB_TINY_REMAPPER_CMD,
      vineflowerCommand: process.env.MCDATAHUB_VINEFLOWER_CMD,
    },
  };
}
