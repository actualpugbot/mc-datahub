import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { toPrettyJson } from "./json.js";

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(path: string, fallback?: T): Promise<T> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }

    throw error;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, toPrettyJson(value), "utf8");
}

export async function writeTextFile(path: string, value: string): Promise<void> {
  await writeFileAtomically(path, value, "utf8");
}

export async function writeBufferFile(path: string, value: Buffer): Promise<void> {
  await ensureDir(dirname(path));
  await fs.writeFile(path, value);
}

async function writeFileAtomically(path: string, value: string, encoding: BufferEncoding): Promise<void> {
  await ensureDir(dirname(path));
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(temporaryPath, value, encoding);
    await fs.rename(temporaryPath, path);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
