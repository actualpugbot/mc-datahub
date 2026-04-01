import { ensureDir, fileExists, readJsonFile, writeJsonFile } from "./fs.js";
import { sha1String } from "./hash.js";

interface CacheEnvelope<T> {
  fetchedAt: string;
  value: T;
}

export class FileCache {
  constructor(private readonly cacheDir: string) {}

  async remember<T>(key: string, maxAgeMs: number, loader: () => Promise<T>): Promise<T> {
    await ensureDir(this.cacheDir);

    const cachePath = this.toPath(key);
    if (await fileExists(cachePath)) {
      const envelope = await readJsonFile<CacheEnvelope<T>>(cachePath);
      if (Date.now() - new Date(envelope.fetchedAt).getTime() <= maxAgeMs) {
        return envelope.value;
      }
    }

    const value = await loader();
    await writeJsonFile(cachePath, {
      fetchedAt: new Date().toISOString(),
      value,
    } satisfies CacheEnvelope<T>);
    return value;
  }

  private toPath(key: string): string {
    return `${this.cacheDir}/${sha1String(key)}.json`;
  }
}
