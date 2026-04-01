import type { MinecraftNewsPost, StoredState } from "../domain/types.js";
import { ensureDir, readJsonFile, writeJsonFile } from "../core/fs.js";
import { dirname } from "node:path";

const EMPTY_STATE: StoredState = {
  processedNewsPosts: {},
  processedVersions: {},
};

export class StateStore {
  private state: StoredState | null = null;

  constructor(private readonly stateFile: string) {}

  async hasProcessedNewsPost(id: string): Promise<boolean> {
    const state = await this.load();
    return id in state.processedNewsPosts;
  }

  async markNewsPostProcessed(post: MinecraftNewsPost): Promise<void> {
    const state = await this.load();
    state.processedNewsPosts[post.id] = {
      processedAt: new Date().toISOString(),
      versions: post.versionIds,
    };
    await this.save(state);
  }

  async getProcessedVersionFingerprint(version: string): Promise<string | undefined> {
    const state = await this.load();
    return state.processedVersions[version]?.fingerprint;
  }

  async markVersionProcessed(version: string, fingerprint: string, datasetPath: string, metadataPath: string): Promise<void> {
    const state = await this.load();
    state.processedVersions[version] = {
      processedAt: new Date().toISOString(),
      fingerprint,
      datasetPath,
      metadataPath,
    };
    await this.save(state);
  }

  private async load(): Promise<StoredState> {
    if (this.state) {
      return this.state;
    }

    await ensureDir(dirname(this.stateFile));
    this.state = await readJsonFile<StoredState>(this.stateFile, EMPTY_STATE);
    return this.state;
  }

  private async save(state: StoredState): Promise<void> {
    this.state = state;
    await writeJsonFile(this.stateFile, state);
  }
}
