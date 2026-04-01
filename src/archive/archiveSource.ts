import type { JsonValue } from "../domain/types.js";

export interface ArchiveSource {
  listPaths(): Promise<string[]>;
  has(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readJson<T extends JsonValue>(path: string): Promise<T>;
  readBuffer(path: string): Promise<Buffer>;
}

export class InMemoryArchiveSource implements ArchiveSource {
  private readonly entries: Map<string, Buffer>;

  constructor(entries: Record<string, string | Buffer>) {
    this.entries = new Map(
      Object.entries(entries).map(([path, value]) => [path, typeof value === "string" ? Buffer.from(value, "utf8") : value]),
    );
  }

  async listPaths(): Promise<string[]> {
    return Array.from(this.entries.keys()).sort();
  }

  async has(path: string): Promise<boolean> {
    return this.entries.has(path);
  }

  async readText(path: string): Promise<string> {
    const buffer = this.entries.get(path);
    if (!buffer) {
      throw new Error(`Archive path not found: ${path}`);
    }

    return buffer.toString("utf8");
  }

  async readJson<T extends JsonValue>(path: string): Promise<T> {
    return JSON.parse(await this.readText(path)) as T;
  }

  async readBuffer(path: string): Promise<Buffer> {
    const buffer = this.entries.get(path);
    if (!buffer) {
      throw new Error(`Archive path not found: ${path}`);
    }

    return Buffer.from(buffer);
  }
}

export class MergedArchiveSource implements ArchiveSource {
  constructor(private readonly sources: ArchiveSource[]) {}

  async listPaths(): Promise<string[]> {
    const lists = await Promise.all(this.sources.map((source) => source.listPaths()));
    return Array.from(new Set(lists.flat())).sort();
  }

  async has(path: string): Promise<boolean> {
    for (const source of this.sources) {
      if (await source.has(path)) {
        return true;
      }
    }

    return false;
  }

  async readText(path: string): Promise<string> {
    for (const source of this.sources) {
      if (await source.has(path)) {
        return source.readText(path);
      }
    }

    throw new Error(`Archive path not found: ${path}`);
  }

  async readJson<T extends JsonValue>(path: string): Promise<T> {
    for (const source of this.sources) {
      if (await source.has(path)) {
        return source.readJson<T>(path);
      }
    }

    throw new Error(`Archive path not found: ${path}`);
  }

  async readBuffer(path: string): Promise<Buffer> {
    for (const source of this.sources) {
      if (await source.has(path)) {
        return source.readBuffer(path);
      }
    }

    throw new Error(`Archive path not found: ${path}`);
  }
}
