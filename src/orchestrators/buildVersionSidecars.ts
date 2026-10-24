import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { fileExists, readTextFile, writeJsonFile } from "../core/fs.js";
import { datasetVersionDir, versionDecompiledDir, versionDownloadsDir, type WorkspacePaths } from "../core/paths.js";
import type { VersionDataset } from "../domain/types.js";
import { ZipArchiveSource } from "../archive/zipArchiveSource.js";
import { buildBlockSounds, parseBlockSoundSetData } from "../extraction/blockSoundsExtractor.js";

const execFileAsync = promisify(execFile);

/** Generate the additional source-derived files required by the site exporter. */
export async function buildVersionSidecars(workspace: WorkspacePaths, version: string, dataset: VersionDataset): Promise<void> {
  const result = await buildBlockSoundsSidecar(workspace, version, dataset);
  if (result.skippedSoundTypes.length || result.unknownSoundTypes.length || result.unresolvedSetTypes.length) {
    throw new Error(
      `Block sounds unresolved for ${version}: ${result.skippedSoundTypes.length} sets, ${result.unknownSoundTypes.length} blocks, ${result.unresolvedSetTypes.length} set types.`,
    );
  }
  const root = new URL("../../", import.meta.url);
  const env = { ...process.env, MCDATAHUB_WORKSPACE_ROOT: workspace.root };
  for (const script of ["build-mob-riders.mjs", "build-note-block-sounds.mjs"]) {
    await execFileAsync(process.execPath, [new URL(`scripts/${script}`, root).pathname, version], {
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
  }
}

export async function buildBlockSoundsSidecar(workspace: WorkspacePaths, version: string, dataset: VersionDataset) {
  const decompiled = versionDecompiledDir(workspace, version);
  const blockDir = join(decompiled, "client/net/minecraft/world/level/block");
  const soundTypePath = join(blockDir, "SoundType.java");
  const soundEventsPath = join(decompiled, "client/net/minecraft/sounds/SoundEvents.java");
  const blockSetTypePath = join(blockDir, "state/properties/BlockSetType.java");
  const woodTypePath = join(blockDir, "state/properties/WoodType.java");
  const blocksPath = join(blockDir, "Blocks.java");
  const soundTypeSource = (await fileExists(soundTypePath)) ? await readTextFile(soundTypePath) : "";
  let registrySoundTypes;
  if (!soundTypeSource) {
    const clientJar = join(versionDownloadsDir(workspace, version), "client.jar");
    if (!(await fileExists(clientJar))) throw new Error(`Missing client.jar for ${version}`);
    const archive = new ZipArchiveSource(clientJar);
    const paths = (await archive.listPaths()).filter((path) => /^data\/minecraft\/block_sound_set\/[a-z0-9_]+\.json$/.test(path));
    if (paths.length === 0) throw new Error(`No SoundType.java or block sound set resources for ${version}`);
    const entries = await Promise.all(
      paths.map(async (path) => ({
        path,
        raw: JSON.parse(await archive.readText(path)) as Record<string, unknown>,
      })),
    );
    registrySoundTypes = parseBlockSoundSetData(entries);
  }
  for (const path of [soundEventsPath, blockSetTypePath, woodTypePath, blocksPath]) {
    if (!(await fileExists(path))) throw new Error(`Missing decompiled source for ${version}: ${path}`);
  }
  const blockClassSources = new Map<string, string>();
  for (const entry of await readdir(blockDir)) {
    if (entry.endsWith(".java")) {
      blockClassSources.set(entry.slice(0, -5), await readTextFile(join(blockDir, entry)));
    }
  }
  const result = buildBlockSounds(
    version,
    soundTypeSource,
    await readTextFile(soundEventsPath),
    dataset.blockProperties,
    dataset.blocks.map((block) => block.id),
    {
      blockSetTypeSource: await readTextFile(blockSetTypePath),
      woodTypeSource: await readTextFile(woodTypePath),
      blocksSource: await readTextFile(blocksPath),
      blockClassSources,
    },
    registrySoundTypes,
  );
  await writeJsonFile(join(datasetVersionDir(workspace, version), "block-sounds.json"), result.dataset);
  return result;
}
