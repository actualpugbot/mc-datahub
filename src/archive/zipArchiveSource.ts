import unzipper from "unzipper";
import type { JsonValue } from "../domain/types.js";
import type { ArchiveSource } from "./archiveSource.js";

export class ZipArchiveSource implements ArchiveSource {
  private directoryPromise: Promise<unzipper.CentralDirectory>;

  constructor(private readonly filePath: string) {
    this.directoryPromise = unzipper.Open.file(filePath);
  }

  async listPaths(): Promise<string[]> {
    const directory = await this.directoryPromise;
    return directory.files
      .filter((entry) => entry.type === "File")
      .map((entry) => entry.path)
      .sort();
  }

  async has(path: string): Promise<boolean> {
    const directory = await this.directoryPromise;
    return directory.files.some((entry) => entry.path === path);
  }

  async readText(path: string): Promise<string> {
    const buffer = await this.readBuffer(path);
    return buffer.toString("utf8");
  }

  async readJson<T extends JsonValue>(path: string): Promise<T> {
    return JSON.parse(await this.readText(path)) as T;
  }

  async readBuffer(path: string): Promise<Buffer> {
    const directory = await this.directoryPromise;
    const entry = directory.files.find((candidate) => candidate.path === path);
    if (!entry) {
      throw new Error(`Archive path not found in ${this.filePath}: ${path}`);
    }

    return entry.buffer();
  }
}
